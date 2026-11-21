CREATE TABLE IF NOT EXISTS app_metadata (
  key text PRIMARY KEY,
  value text NOT NULL
);

INSERT INTO app_metadata (key, value) VALUES ('surface', 'tickets-d1')
ON CONFLICT (key) DO NOTHING;
