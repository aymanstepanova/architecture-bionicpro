from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
import requests

from ch_clickhouse import ch_query, ch_query_json, clickhouse_http_base


def test_ch_query_uses_post_body_no_params():
    mock_resp = MagicMock()
    mock_resp.text = "ok\n"
    mock_resp.raise_for_status = MagicMock()

    with patch("ch_clickhouse.requests.post", return_value=mock_resp) as post:
        out = ch_query("  SELECT 1  ")

    assert out == "ok\n"
    post.assert_called_once()
    args, kwargs = post.call_args
    assert "params" not in kwargs
    assert args[0] == "http://clickhouse:8123/"
    assert kwargs["data"] == b"SELECT 1"
    assert kwargs["headers"]["Content-Type"] == "text/plain; charset=utf-8"


def test_ch_query_json_appends_format_when_missing():
    mock_resp = MagicMock()
    mock_resp.text = '{"a":1}\n{"a":2}\n'
    mock_resp.raise_for_status = MagicMock()

    with patch("ch_clickhouse.requests.post", return_value=mock_resp) as post:
        rows = ch_query_json("SELECT 1")

    assert rows == [{"a": 1}, {"a": 2}]
    body = post.call_args.kwargs["data"].decode("utf-8")
    assert "FORMAT JSONEachRow" in body
    assert body.strip().startswith("SELECT 1")


def test_ch_query_json_does_not_duplicate_format():
    mock_resp = MagicMock()
    mock_resp.text = '{"x":0}\n'
    mock_resp.raise_for_status = MagicMock()

    sql = "SELECT x FORMAT JSONEachRow"
    with patch("ch_clickhouse.requests.post", return_value=mock_resp) as post:
        ch_query_json(sql)

    body = post.call_args.kwargs["data"].decode("utf-8")
    assert body.count("FORMAT") == 1


def test_ch_query_json_raises_on_http_error():
    mock_resp = MagicMock()
    mock_resp.ok = False
    mock_resp.status_code = 404
    mock_resp.text = "Code: 47. DB::Exception: ..."

    with patch("ch_clickhouse.requests.post", return_value=mock_resp):
        with pytest.raises(RuntimeError, match="ClickHouse HTTP 404"):
            ch_query_json("SELECT 1")


def test_clickhouse_http_base_respects_env(monkeypatch):
    monkeypatch.setenv("CLICKHOUSE_HTTP", "http://example:9000/")
    assert clickhouse_http_base() == "http://example:9000"


@pytest.mark.integration
def test_ch_query_select_one_live(monkeypatch):
    """При поднятом ClickHouse: CLICKHOUSE_HTTP=http://localhost:8123 pytest -m integration"""
    base = clickhouse_http_base()
    try:
        text = ch_query("SELECT 1 AS x FORMAT TabSeparated")
    except requests.RequestException as e:
        pytest.skip(f"ClickHouse недоступен по {base}: {e}")
    assert "1" in text.strip()

