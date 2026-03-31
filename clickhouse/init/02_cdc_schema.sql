-- CDC: ingest from Kafka (Debezium) and fill crm_cdc_mart

CREATE TABLE IF NOT EXISTS reports.kafka_crm_users_raw
(
  payload String
)
ENGINE = Kafka
SETTINGS
  kafka_broker_list = 'kafka:9092',
  kafka_topic_list = 'dbserver1.public.crm_users',
  kafka_group_name = 'clickhouse_cdc_crm',
  kafka_format = 'JSONAsString',
  kafka_num_consumers = 1,
  kafka_skip_broken_messages = 1;

-- Витрина: актуальное состояние строк CRM (по user_id), версия по ts_ms для дедупликации
CREATE TABLE IF NOT EXISTS reports.crm_cdc_mart
(
  user_id String,
  email String,
  country String,
  prosthesis_id String,
  prosthesis_type String,
  updated_at DateTime64(3),
  _source_ts_ms UInt64,
  _op String
)
ENGINE = ReplacingMergeTree(_source_ts_ms)
ORDER BY (user_id);

-- MaterializedView: парсинг Debezium envelope.
-- Рекомендуется value.converter.schemas.enable=false (плоский JSON: after, op, ts_ms на верхнем уровне).
CREATE MATERIALIZED VIEW IF NOT EXISTS reports.crm_cdc_mart_mv TO reports.crm_cdc_mart AS
SELECT
  coalesce(
    nullIf(JSONExtractString(payload, 'after', 'user_id'), ''),
    nullIf(JSONExtractString(payload, 'payload', 'after', 'user_id'), '')
  ) AS user_id,
  coalesce(
    nullIf(JSONExtractString(payload, 'after', 'email'), ''),
    nullIf(JSONExtractString(payload, 'payload', 'after', 'email'), '')
  ) AS email,
  coalesce(
    nullIf(JSONExtractString(payload, 'after', 'country'), ''),
    nullIf(JSONExtractString(payload, 'payload', 'after', 'country'), '')
  ) AS country,
  coalesce(
    nullIf(JSONExtractString(payload, 'after', 'prosthesis_id'), ''),
    nullIf(JSONExtractString(payload, 'payload', 'after', 'prosthesis_id'), '')
  ) AS prosthesis_id,
  coalesce(
    nullIf(JSONExtractString(payload, 'after', 'prosthesis_type'), ''),
    nullIf(JSONExtractString(payload, 'payload', 'after', 'prosthesis_type'), '')
  ) AS prosthesis_type,
  toDateTime64(
    parseDateTimeBestEffortOrNull(
      coalesce(
        nullIf(JSONExtractString(payload, 'after', 'updated_at'), ''),
        nullIf(JSONExtractString(payload, 'payload', 'after', 'updated_at'), '')
      )
    ),
    3
  ) AS updated_at,
  toUInt64OrZero(
    coalesce(
      nullIf(JSONExtractString(payload, 'ts_ms'), ''),
      nullIf(JSONExtractString(payload, 'payload', 'ts_ms'), '')
    )
  ) AS _source_ts_ms,
  coalesce(
    nullIf(JSONExtractString(payload, 'op'), ''),
    nullIf(JSONExtractString(payload, 'payload', 'op'), '')
  ) AS _op
FROM reports.kafka_crm_users_raw
WHERE _op IN ('c', 'u', 'r')
  AND length(user_id) > 0;
