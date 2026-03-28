from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List

import requests


def clickhouse_http_base() -> str:
    """Базовый URL ClickHouse HTTP без завершающего слэша (переменная CLICKHOUSE_HTTP)."""
    return os.environ.get("CLICKHOUSE_HTTP", "http://clickhouse:8123").rstrip("/")


def ch_sql_string_literal(value: str) -> str:
    """Строковый литерал ClickHouse (одинарные кавычки; в CH двойные — для идентификаторов)."""
    return "'" + value.replace("'", "''") + "'"


def ch_query(sql: str) -> str:
    # Тело POST, не query-string: длинный SQL и переносы строк иначе дают HTTP 404/ошибки у CH HTTP.
    q = sql.strip()
    resp = requests.post(
        f"{clickhouse_http_base()}/",
        data=q.encode("utf-8"),
        headers={"Content-Type": "text/plain; charset=utf-8"},
    )
    if not resp.ok:
        raise RuntimeError(
            f"ClickHouse HTTP {resp.status_code}: {resp.text[:800]}"
        ) from None
    return resp.text


def ch_query_json(sql: str) -> List[Dict[str, Any]]:
    # Только тело POST: не использовать default_format в URL — иначе CH может отдать 404,
    # если тело не принято (особенности HTTP-интерфейса 24.x).
    q = sql.strip().rstrip(";")
    upper = q.upper()
    if "FORMAT" not in upper:
        q = f"{q}\nFORMAT JSONEachRow"
    resp = requests.post(
        f"{clickhouse_http_base()}/",
        data=q.encode("utf-8"),
        headers={"Content-Type": "text/plain; charset=utf-8"},
    )
    if not resp.ok:
        raise RuntimeError(
            f"ClickHouse HTTP {resp.status_code}: {resp.text[:800]}"
        ) from None
    lines = [ln for ln in resp.text.splitlines() if ln.strip()]
    return [json.loads(ln) for ln in lines]


def get_watermark(source: str) -> datetime:
    rows = ch_query_json(
        f"""
        SELECT watermark_to
        FROM reports.etl_watermarks
        WHERE source = {ch_sql_string_literal(source)}
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
      {ch_sql_string_literal(source)},
      toDateTime({ch_sql_string_literal(watermark_to.strftime('%Y-%m-%d %H:%M:%S'))}),
      toDateTime({ch_sql_string_literal(now.strftime('%Y-%m-%d %H:%M:%S'))})
    )
    """
    ch_query(sql)
