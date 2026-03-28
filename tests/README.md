# Тесты HTTP-клиента ClickHouse (DAG Airflow)

Юнит-тесты мокают `requests` и не требуют Docker. Интеграционный тест — опционально, с реальным ClickHouse.

## Установка

Из корня `architecture-bionicpro` (Python 3.11):

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r airflow/requirements-dev.txt
```

## Запуск

```bash
pytest
```

Исключить интеграцию (по умолчанию маркер `integration` не обязателен, но тест с `--strict-markers` может требовать регистрации — см. `pytest.ini`):

```bash
pytest -m "not integration"
```

С реальным ClickHouse (порт проброшен из `docker compose`, например `8123:8123`):

```bash
set CLICKHOUSE_HTTP=http://localhost:8123
pytest -m integration
```

Путь к модулям DAG задаётся в [`pytest.ini`](../pytest.ini) (`pythonpath = airflow/dags`).
