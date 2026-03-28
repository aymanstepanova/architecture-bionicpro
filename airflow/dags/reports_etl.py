from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Tuple

import psycopg2
import requests
from airflow.decorators import dag, task


CLICKHOUSE_HTTP = os.environ.get("CLICKHOUSE_HTTP", "http://clickhouse:8123")
CRM_DSN = os.environ.get(
    "CRM_DSN", "postgresql://crm_user:crm_password@crm_db:5432/crm_db"
)
TELEMETRY_DSN = os.environ.get(
    "TELEMETRY_DSN",
    "postgresql://telemetry_user:telemetry_password@telemetry_db:5432/telemetry_db",
)


def ch_query(sql: str) -> str:
    resp = requests.post(f"{CLICKHOUSE_HTTP}/", params={"query": sql})
    resp.raise_for_status()
    return resp.text


def ch_query_json(sql: str) -> List[Dict[str, Any]]:
    resp = requests.post(
        f"{CLICKHOUSE_HTTP}/",
        params={"query": sql, "default_format": "JSONEachRow"},
        headers={"content-type": "text/plain; charset=utf-8"},
    )
    resp.raise_for_status()
    lines = [ln for ln in resp.text.splitlines() if ln.strip()]
    return [json.loads(ln) for ln in lines]


def get_watermark(source: str) -> datetime:
    rows = ch_query_json(
        f"""
        SELECT watermark_to
        FROM reports.etl_watermarks
        WHERE source = {json.dumps(source)}
        ORDER BY updated_at DESC
        LIMIT 1
        """
    )
    if not rows:
        return datetime(1970, 1, 1, tzinfo=timezone.utc)
    # ClickHouse returns as string, e.g. "2026-02-23 00:00:00"
    return datetime.fromisoformat(rows[0]["watermark_to"].replace(" ", "T")).replace(
        tzinfo=timezone.utc
    )


def set_watermark(source: str, watermark_to: datetime) -> None:
    now = datetime.now(tz=timezone.utc)
    sql = f"""
    INSERT INTO reports.etl_watermarks (source, watermark_to, updated_at)
    VALUES (
      {json.dumps(source)},
      toDateTime({json.dumps(watermark_to.strftime('%Y-%m-%d %H:%M:%S'))}),
      toDateTime({json.dumps(now.strftime('%Y-%m-%d %H:%M:%S'))})
    )
    """
    ch_query(sql)


def pg_fetch(dsn: str, sql: str, params: Tuple[Any, ...]) -> List[Dict[str, Any]]:
    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            cols = [d.name for d in cur.description]
            out = []
            for row in cur.fetchall():
                out.append({cols[i]: row[i] for i in range(len(cols))})
            return out
    finally:
        conn.close()


def day_key(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).date().isoformat()


@dag(
    schedule="0 * * * *",
    start_date=datetime(2026, 1, 1),
    catchup=False,
    default_args={
        "retries": 3,
        "retry_delay": timedelta(seconds=30),
    },
    tags=["reports", "etl"],
)
def reports_etl():
    @task
    def extract_crm_incremental() -> List[Dict[str, Any]]:
        try:
            wm = get_watermark("crm")
            return pg_fetch(
                CRM_DSN,
                """
                SELECT user_id, email, country, prosthesis_id, prosthesis_type, updated_at
                FROM crm_users
                WHERE updated_at > %s
                """,
                (wm,),
            )
        except Exception as e:
            raise RuntimeError(
                "extract_crm_incremental: нужны ClickHouse (watermark) и PostgreSQL crm_db, таблица crm_users. "
                f"{type(e).__name__}: {e}"
            ) from e

    @task
    def extract_telemetry_incremental() -> List[Dict[str, Any]]:
        try:
            wm = get_watermark("telemetry")
            return pg_fetch(
                TELEMETRY_DSN,
                """
                SELECT user_id, prosthesis_id, event_time, event_type, latency_ms
                FROM telemetry_events
                WHERE event_time > %s
                """,
                (wm,),
            )
        except Exception as e:
            raise RuntimeError(
                "extract_telemetry_incremental: нужны ClickHouse (watermark) и PostgreSQL telemetry_db, "
                "таблица telemetry_events. Проверьте, что БД полностью поднята (pg_isready), не только контейнер. "
                f"{type(e).__name__}: {e}"
            ) from e

    @task
    def transform_join_aggregate(
        crm_rows: List[Dict[str, Any]], telemetry_rows: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        # Build CRM lookup (latest by user_id)
        crm_by_user: Dict[str, Dict[str, Any]] = {}
        for r in crm_rows:
            uid = r["user_id"]
            if uid not in crm_by_user or r["updated_at"] > crm_by_user[uid]["updated_at"]:
                crm_by_user[uid] = r

        agg: Dict[Tuple[str, str, str], Dict[str, Any]] = defaultdict(
            lambda: {
                "movements": 0,
                "errors": 0,
                "low_battery_events": 0,
                "lat_sum": 0,
                "lat_cnt": 0,
            }
        )

        max_event_time = datetime(1970, 1, 1, tzinfo=timezone.utc)
        for e in telemetry_rows:
            uid = e["user_id"]
            pid = e["prosthesis_id"]
            et: datetime = e["event_time"]
            if et.tzinfo is None:
                et = et.replace(tzinfo=timezone.utc)
            if et > max_event_time:
                max_event_time = et

            d = day_key(et)
            key = (uid, pid, d)
            a = agg[key]
            t = e["event_type"]
            if t == "movement":
                a["movements"] += 1
                if e["latency_ms"] is not None:
                    a["lat_sum"] += int(e["latency_ms"])
                    a["lat_cnt"] += 1
            elif t == "error":
                a["errors"] += 1
            elif t == "low_battery":
                a["low_battery_events"] += 1

        rows_out = []
        processed_at = datetime.now(tz=timezone.utc)
        watermark_to = max_event_time

        for (uid, pid, d), a in agg.items():
            crm = crm_by_user.get(uid, {})
            # Совпадение с Keycloak: в API фильтр по email из сессии, не по sub (UUID)
            out_uid = (crm.get("email") or "").strip() or uid
            avg_latency = float(a["lat_sum"] / a["lat_cnt"]) if a["lat_cnt"] else 0.0
            rows_out.append(
                {
                    "user_id": out_uid,
                    "prosthesis_id": pid,
                    "event_date": d,
                    "movements": a["movements"],
                    "errors": a["errors"],
                    "low_battery_events": a["low_battery_events"],
                    "avg_latency_ms": avg_latency,
                    "country": crm.get("country", "UNKNOWN"),
                    "prosthesis_type": crm.get("prosthesis_type", "UNKNOWN"),
                    "processed_at": processed_at.strftime("%Y-%m-%d %H:%M:%S"),
                    "watermark_to": watermark_to.strftime("%Y-%m-%d %H:%M:%S"),
                }
            )

        return {"rows": rows_out, "watermark_to": watermark_to.strftime("%Y-%m-%d %H:%M:%S")}

    @task
    def load_reporting_mart_clickhouse(payload: Dict[str, Any]) -> int:
        rows = payload["rows"]
        if not rows:
            return 0

        # Insert via JSONEachRow
        data = "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n"
        resp = requests.post(
            f"{CLICKHOUSE_HTTP}/",
            params={"query": "INSERT INTO reports.reporting_mart_daily FORMAT JSONEachRow"},
            data=data.encode("utf-8"),
            headers={"content-type": "application/json"},
        )
        resp.raise_for_status()
        return len(rows)

    @task
    def data_quality_checks(inserted_rows: int) -> None:
        # Minimal checks; for demo we accept inserted_rows==0 (no new increments)
        if inserted_rows < 0:
            raise ValueError("inserted_rows must be >= 0")

    @task
    def update_watermark(payload: Dict[str, Any], crm_rows: List[Dict[str, Any]]) -> None:
        wm_to = datetime.fromisoformat(payload["watermark_to"].replace(" ", "T")).replace(
            tzinfo=timezone.utc
        )
        if wm_to.year == 1970:
            return

        # Telemetry watermark to max event_time processed
        set_watermark("telemetry", wm_to)

        # CRM watermark to max updated_at in this run, if present
        if crm_rows:
            max_upd = max(r["updated_at"] for r in crm_rows)
            if max_upd.tzinfo is None:
                max_upd = max_upd.replace(tzinfo=timezone.utc)
            set_watermark("crm", max_upd)

        # For API checks: global available_to
        set_watermark("reports_available_to", wm_to)

    crm_rows = extract_crm_incremental()
    telemetry_rows = extract_telemetry_incremental()
    payload = transform_join_aggregate(crm_rows, telemetry_rows)
    inserted = load_reporting_mart_clickhouse(payload)
    data_quality_checks(inserted)
    update_watermark(payload, crm_rows)


reports_etl()

