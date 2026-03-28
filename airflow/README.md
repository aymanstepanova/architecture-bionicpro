# Airflow (DAG и образ)

Здесь лежат:

- **`dags/`** — DAG `reports_etl` и модуль [`dags/ch_clickhouse.py`](dags/ch_clickhouse.py) (HTTP-клиент ClickHouse без зависимости от Airflow).
- **`Dockerfile`** — образ сервисов `airflow-webserver`, `airflow-scheduler`, `airflow-init` в `docker-compose`.
- **`requirements.txt`** — зависимости образа.
- **`requirements-dev.txt`** — зависимости для локального запуска тестов на хосте (pytest и т.д.).

## Тесты

Юнит-тесты для `ch_clickhouse` и опциональный интеграционный smoke к ClickHouse живут в каталоге **[`../tests/`](../tests/)**. Подробные команды установки и запуска — в **[`../tests/README.md`](../tests/README.md)**.

Кратко из корня `architecture-bionicpro` (Python 3.11):

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r airflow/requirements-dev.txt
pytest
```

Только юнит-тесты (без маркера `integration`):

```bash
pytest -m "not integration"
```

С реальным ClickHouse (порт проброшен, например `8123`):

```bash
set CLICKHOUSE_HTTP=http://localhost:8123
pytest -m integration
```

Конфигурация pytest: [`../pytest.ini`](../pytest.ini).
