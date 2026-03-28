# Траблшутинг — типичные проблемы

Решения и диагностика для локального стенда BionicPRO. Инструкции запуска и таблица URL — в [README.md](README.md).

## Логи сервисов

```bash
docker compose logs bionicpro-auth --tail 80
docker compose logs reports-api --tail 80
docker compose logs keycloak --tail 80
docker compose logs frontend --tail 40
docker compose logs airflow-scheduler --tail 100
docker compose logs openldap --tail 80
```

## Переменные окружения и секреты

- Секреты **не хранятся в коде**: `bionicpro-auth` и `reports-api` требуют переменные (см. `.env.example` в соответствующих каталогах). В Docker они задаются в `docker-compose.yaml`.
- Фронтенд собирается с `REACT_APP_*` на этапе **`docker compose build`** (см. `build.args` у сервиса `frontend`); без этого в бандле пустые URL и страница может вести себя некорректно.

## Фронтенд: долго «Loading…», Login не уходит в Keycloak

1. Убедитесь, что при сборке образа переданы `REACT_APP_*` (`frontend/Dockerfile` + `build.args` в compose).
2. Запрос к `/me` не должен висеть бесконечно — в коде фронта есть таймаут и проверка JSON; при сбоях auth смотрите логи `bionicpro-auth`.

## Keycloak: `LOGIN_ERROR`, `user_not_found` в realm **master**

В админ-консоль (`/admin/master/...`) входят учёткой **`admin` / `admin`**, не тестовыми пользователями из `reports-realm` (`user1` и т.д.).

## Keycloak: ошибки импорта реалма (`Unrecognized field "providerType"` и др.)

Реалм: `keycloak/realm-export.json`. Для Keycloak 21 формат компонентов без устаревших полей; при ошибках смотрите логи контейнера `keycloak` при старте.

## OpenLDAP

Образ запускается с **`command: --copy-service`** и монтированием одного LDIF-файла; иначе возможны ошибки `chown` / `Device or resource busy`. При сбоях: `docker compose logs openldap`.

## Сессия: «Signed in as unknown»

Нужны корректные **email / имя / sub** в сессии после callback OIDC. В **bionicpro-auth** профиль собирается из ответа Keycloak (в т.ч. разбор `id_token`), данные пишутся в сессию и при необходимости в БД профилей.

## ClickHouse: `HTTPError: 404` / `RuntimeError: ClickHouse HTTP 404` при ETL в Airflow (`reports.etl`, watermark)

В HTTP-интерфейсе ClickHouse **код 404 часто означает ошибку выполнения запроса**, а не «адрес не найден». Смотрите **тело ответа** в логе задачи: строки вида `Code: 60` (нет таблицы), `Code: 47` (неверный идентификатор) и т.д. В `airflow/dags/ch_clickhouse.py` при не-OK ответе поднимается `RuntimeError` с началом текста от ClickHouse — ориентируйтесь на него, а не только на URL.

### 1. Нет схемы / таблиц (`Code: 60` и похожие)

**Причина:** в ClickHouse не созданы БД/таблицы из `clickhouse/init/*.sql`. Скрипты в `/docker-entrypoint-initdb.d` в официальном образе **не всегда** выполняются: если каталог данных уже существовал, init мог быть пропущен — витрина и `etl_watermarks` не создались.

**Что сделать:**

1. В `docker-compose` для сервиса `clickhouse` задано **`CLICKHOUSE_ALWAYS_RUN_INITDB_SCRIPTS=1`**, чтобы SQL из `./clickhouse/init` прогонялся при старте (`CREATE … IF NOT EXISTS` безопасен). Перезапуск:  
   `docker compose up -d clickhouse`
2. Либо вручную один раз выполнить скрипты:  
   `Get-Content clickhouse/init/01_schema.sql,clickhouse/init/02_cdc_schema.sql | docker compose exec -T clickhouse clickhouse-client --multiquery`  
   (в bash: `cat clickhouse/init/*.sql | docker compose exec -T clickhouse clickhouse-client --multiquery`)
3. Запросы из DAG идут **POST с телом**; формат задаётся **`FORMAT JSONEachRow` в тексте SQL**, без `?default_format=…` в URL (иначе возможен **404** на `http://clickhouse:8123/?default_format=JSONEachRow`).

Проверка:  
`docker compose exec clickhouse clickhouse-client --query "EXISTS TABLE reports.etl_watermarks"` — должно вернуть `1`.

Если после правок compose по-прежнему ошибки — пересоздайте контейнер и дождитесь **healthy**:  
`docker compose up -d --force-recreate clickhouse`  
затем `docker compose ps` (у `clickhouse` — `(healthy)`).

### 2. Ошибка в SQL: строки и кавычки (`Code: 47 UNKNOWN_IDENTIFIER` → часто HTTP 404)

**Причина:** в ClickHouse **строковые литералы только в одинарных кавычках** (`'crm'`). **Двойные кавычки** — для **идентификаторов** (имена колонок/БД). Если в запросе для `WHERE source = …` подставить строку в стиле JSON (`"crm"`), сервер воспринимает это как имя `crm`, а не строку — получается `Unknown identifier` и тот же **404** по HTTP.

В проекте литералы для SQL собираются через **`ch_sql_string_literal`** в `airflow/dags/ch_clickhouse.py` (watermark и INSERT). Не подставляйте в SQL строки через `json.dumps` — это даёт двойные кавычки.

**Диагностика:** если `EXISTS TABLE reports.etl_watermarks` уже `1`, а `extract_*` всё равно падает с 404, проверьте **тот же запрос**, что в `get_watermark` (с `WHERE source = 'crm'` / `'telemetry'`), а не только `SELECT count()` по таблице — простой `count()` ошибку кавычек не проявляет.

### Тесты

Юнит-тесты `tests/test_ch_clickhouse.py` мокают HTTP; регресс по кавычкам отлавливает проверка тела запроса к `get_watermark` или интеграционный прогон к живому ClickHouse (`pytest -m integration` при поднятом compose и `CLICKHOUSE_HTTP`, см. `pytest.ini`).

## Пустой отчёт после логина

Цепочка данных: **CRM** (`crm_db`) + **телеметрия** (`telemetry_db`) → DAG **`reports_etl`** в Airflow → **`reports.reporting_mart_daily`** в ClickHouse. В API фильтр по пользователю идёт по **email из сессии** (как в CRM), а не по UUID Keycloak.

Проверка строк во витрине:

```bash
docker compose exec clickhouse clickhouse-client --query "SELECT count(), user_id FROM reports.reporting_mart_daily GROUP BY user_id"
```

Если строк нет или нужен пересчёт после смены логики ETL — см. раздел ниже.

## Пустая витрина отчётов, пересборка seed

```bash
docker compose exec clickhouse clickhouse-client --query "TRUNCATE TABLE reports.reporting_mart_daily"
docker compose exec clickhouse clickhouse-client --query "TRUNCATE TABLE reports.etl_watermarks"
```

Затем в Airflow вручную запустите DAG **`reports_etl`** и дождитесь успеха.

## Airflow: `extract_telemetry_incremental` / `extract_crm_incremental` → `failed`

Задача читает **watermark** из ClickHouse и строки из **PostgreSQL** (`telemetry_events` или `crm_users`). Типичные причины: ClickHouse или Postgres ещё не готовы (контейнер стартовал, а `init`-скрипты БД не закончились), нет сети до `telemetry_db` / `clickhouse`. В `docker-compose` для Airflow задано ожидание **`service_healthy`** для `clickhouse`, `crm_db`, `telemetry_db`. После правок: `docker compose up -d`. В логе задачи (Airflow UI → Log) смотрите текст исключения и исходную ошибку `psycopg2` / `requests`.

Если в логе **404 к ClickHouse** при чтении watermark — см. раздел **«ClickHouse: HTTPError: 404 / RuntimeError…»** выше: отличайте отсутствие таблиц от ошибки SQL (кавычки в литералах).

## Airflow: `upstream_failed`

Так помечаются задачи, **которые не запускались**, потому что упала **одна из задач выше по графу** (часто `extract_*`).

1. Откройте Graph или список задач у запуска DAG **`reports_etl`** и найдите задачу со статусом **`failed`** (не `upstream_failed`) — в её логе причина.
2. Часто при первом старте БД ещё не готовы — в compose для `airflow-webserver` и `airflow-scheduler` задано ожидание зависимостей; выполните `docker compose up -d` после правок.
3. Логи планировщика: `docker compose logs airflow-scheduler --tail 100`

## Airflow: ошибка миграции БД (`InFailedSqlTransaction`, `SET LOCK_TIMEOUT`)

Одновременный запуск **`airflow db migrate`** в двух контейнерах (webserver и scheduler) даёт гонку в PostgreSQL. В compose одноразовый сервис **`airflow-init`** выполняет миграции один раз; webserver и scheduler стартуют после его успешного завершения.

Если база Airflow в неконсистентном состоянии:

```bash
docker compose down -v   # удаляет том airflow_pg_data (метаданные Airflow)
docker compose up -d --build
```

Затем при необходимости снова запустите DAG.

## Airflow: логи задачи в UI — `403 FORBIDDEN`, «Could not read served logs»

Webserver запрашивает лог у **scheduler** (порт **8793**). Нужен **одинаковый** `AIRFLOW__WEBSERVER__SECRET_KEY` у `airflow-webserver` и `airflow-scheduler` (задано в `docker-compose`). После смены ключа перезапустите оба сервиса. Обходной путь: `docker compose logs airflow-scheduler`.

## Логи telemetry_db при старте

Сообщения вроде `logical replication launcher ... exited with exit code 1` при **перезапуске** Postgres внутри entrypoint после `init` — обычно норма. Важна строка **`database system is ready to accept connections`**.
