CREATE DATABASE IF NOT EXISTS reports;

CREATE TABLE IF NOT EXISTS reports.reporting_mart_daily
(
  user_id String,
  prosthesis_id String,
  event_date Date,
  movements UInt32,
  errors UInt32,
  low_battery_events UInt32,
  avg_latency_ms Float32,
  country String,
  prosthesis_type String,
  processed_at DateTime,
  watermark_to DateTime
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (user_id, event_date, prosthesis_id);

CREATE TABLE IF NOT EXISTS reports.etl_watermarks
(
  source String,
  watermark_to DateTime,
  updated_at DateTime
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (source);

