CREATE TABLE IF NOT EXISTS crm_users (
  user_id text PRIMARY KEY,
  email text NOT NULL,
  country text NOT NULL,
  prosthesis_id text NOT NULL,
  prosthesis_type text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO crm_users (user_id, email, country, prosthesis_id, prosthesis_type, updated_at)
VALUES
  ('demo-user-1', 'user1@example.com', 'RU', 'prosthesis-001', 'arm-v1', now() - interval '2 days'),
  ('demo-user-2', 'user2@example.com', 'RU', 'prosthesis-002', 'arm-v1', now() - interval '2 days')
ON CONFLICT (user_id) DO NOTHING;

