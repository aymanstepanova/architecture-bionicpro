# BionicPRO — локальный стенд

Монорепозиторий с фронтом, **bionicpro-auth** (OIDC/PKCE, cookie-сессия в Redis), **reports-api** (отчёты из ClickHouse, кэш CSV в MinIO, раздача через CDN-nginx), **Keycloak**, OLTP (CRM, телеметрия), **Airflow** (ETL витрины), **Kafka/Debezium** (CDC в ClickHouse).

## Требования

- [Docker](https://docs.docker.com/get-docker/) и Docker Compose v2
- Порты на хосте **свободны**: 3000, 389, 5433–5437, 6379, 8000, 8001, 8080, 8081, 8088, 8123, 9000, 9002, 9003, 9092–9093

## Запуск

```bash
cd architecture-bionicpro
docker compose up -d
```

Первый старт может занять несколько минут (Keycloak, Airflow, инициализация MinIO и т.д.).

Пересборка образов после правок кода:

```bash
docker compose build
docker compose up -d
```

Остановка:

```bash
docker compose down
```

## Сервисы и URL

| Назначение | URL |
|------------|-----|
| Фронтенд | http://localhost:3000 |
| bionicpro-auth | http://localhost:8000 |
| reports-api | http://localhost:8001 |
| Keycloak | http://localhost:8080 |
| Airflow UI | http://localhost:8081 |
| CDN (кэш отчётов поверх MinIO) | http://localhost:8088 |
| MinIO API | http://localhost:9002 |
| MinIO Console | http://localhost:9003 |
| ClickHouse HTTP | http://localhost:8123 |
| Kafka Connect | http://localhost:8083 |

Отдельно: PostgreSQL для Keycloak, CRM, телеметрии, профилей, Airflow — см. `docker-compose.yaml` (порты 5433–5437).

## Учётные записи

### Keycloak

- **Админ-консоль** (`/admin/master/...`): логин `admin`, пароль `admin` (realm **master**).
- **Realm `reports-realm`** (вход в приложение): тестовые пользователи заданы в `keycloak/realm-export.json`, например:
  - `user1` / `password123` (email `user1@example.com`)
  - `admin1` / `admin123`
  - пользователи `prothetic*` / `prothetic123`

В админку Keycloak заходить учёткой **admin**, не `user1`.

### Airflow

- http://localhost:8081 — `admin` / `admin`

### MinIO (консоль)

- Пользователь `minioadmin`, пароль `minioadmin123` (как в compose; для S3 в приложениях заданы через env).

## Минимальная проверка после запуска

```bash
docker compose ps
```

Ожидайте статус **Up** у нужных контейнеров. У одноразовых задач (например `minio-init`) статус **Exited 0** — норма.

```bash
curl -s http://localhost:8000/health
curl -s http://localhost:8001/health
```

Ожидается JSON с `"ok": true`.

Сценарий «открыть фронт → Login → скачать отчёт» и любые сбои — см. **[troubleshooting.md](troubleshooting.md)**.

## Локальная разработка без полного compose

Отдельные сервисы можно гонять через `npm start` / `node`, но понадобятся Redis, Keycloak, БД и переменные окружения — проще опираться на compose.

## Дополнительно

- Схемы ClickHouse: `clickhouse/init/`
- DAG ETL: `airflow/dags/reports_etl.py`
- Документация по спринту — в репозитории курса (`docs/` родительского проекта).
