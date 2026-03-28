# Debezium — CDC для CRM (задание 4)

Конфигурация Debezium Postgres Connector для потока изменений из CRM DB в Kafka.

## Файлы

- **postgres-crm-connector.json** — конфиг коннектора (таблица `public.crm_users`, топик `dbserver1.public.crm_users`).
- **register-connector.sh** — ручная регистрация коннектора через REST API Kafka Connect.

## Авторегистрация

При `docker compose up` сервис **debezium-connector-init** регистрирует коннектор после старта **kafka-connect**. Ручной запуск не обязателен.

## Ручная регистрация

Если авторегистрация не сработала:

```bash
# После старта kafka-connect (порт 8083)
export KAFKA_CONNECT_URL=http://localhost:8083
./debezium/register-connector.sh
```

Проверка: `curl -s http://localhost:8083/connectors/postgres-crm-connector/status`

## Тест CDC и API

1. **Коннектор**: после старта `kafka-connect` и `debezium-connector-init` коннектор должен быть в состоянии RUNNING.
2. **Витрина**: в ClickHouse выполнить  
   `SELECT * FROM reports.crm_cdc_mart FINAL;`  
   Данные появятся после снимка и стриминга из CRM. Если пайплайн Kafka → ClickHouse не подтягивает сообщения (сеть/таймауты), можно вручную вставить строку для проверки API:  
   `INSERT INTO reports.crm_cdc_mart (user_id, email, country, prosthesis_id, prosthesis_type, updated_at, _source_ts_ms, _op) VALUES ('demo-user-1', 'user1@example.com', 'RU', 'prosthesis-001', 'arm-v1', now(), 1, 'c');`
3. **API**: без сессии запрос к выгрузке должен вернуть 401:  
   `curl -s http://localhost:8001/crm-export` → `{"error":"Not authenticated"}`  
   С авторизованной сессией (cookie `sid` после входа через фронт или bionicpro-auth) ответ содержит данные из витрины (`source: 'cdc_mart'`).
