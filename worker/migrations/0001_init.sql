CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  short TEXT NOT NULL,
  tariff_id TEXT NOT NULL,
  tariff_label TEXT NOT NULL,
  days INTEGER NOT NULL,
  rub INTEGER NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  usdt TEXT,
  invoice_id TEXT,
  invoice_url TEXT,
  client_name TEXT,
  sub_url TEXT,
  links TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
