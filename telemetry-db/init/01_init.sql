CREATE TABLE IF NOT EXISTS telemetry_events (
  event_id bigserial PRIMARY KEY,
  user_id text NOT NULL,
  prosthesis_id text NOT NULL,
  event_time timestamptz NOT NULL,
  event_type text NOT NULL,
  latency_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seed: a couple of days of events
INSERT INTO telemetry_events (user_id, prosthesis_id, event_time, event_type, latency_ms)
VALUES
  ('demo-user-1', 'prosthesis-001', now() - interval '36 hours', 'movement', 82),
  ('demo-user-1', 'prosthesis-001', now() - interval '35 hours', 'movement', 95),
  ('demo-user-1', 'prosthesis-001', now() - interval '34 hours', 'low_battery', null),
  ('demo-user-1', 'prosthesis-001', now() - interval '33 hours', 'error', null),
  ('demo-user-2', 'prosthesis-002', now() - interval '36 hours', 'movement', 110),
  ('demo-user-2', 'prosthesis-002', now() - interval '35 hours', 'movement', 101),
  ('demo-user-2', 'prosthesis-002', now() - interval '34 hours', 'movement', 98)
ON CONFLICT DO NOTHING;

