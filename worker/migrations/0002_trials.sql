ALTER TABLE orders ADD COLUMN ip_hash TEXT;

CREATE TABLE IF NOT EXISTS trials (
  id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  client_name TEXT,
  sub_url TEXT,
  links TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS trials_ip_idx ON trials(ip_hash);
CREATE INDEX IF NOT EXISTS trials_created_idx ON trials(created_at);
