-- MOCH1YAKI v76 Cloudflare D1 schema. Run once in the D1 Console.
CREATE TABLE IF NOT EXISTS queue_days (
 day TEXT PRIMARY KEY,
 paused INTEGER NOT NULL DEFAULT 1,
 current_id TEXT
);
CREATE TABLE IF NOT EXISTS queue_counters (
 day TEXT PRIMARY KEY,
 last_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS queue_tickets (
 id TEXT PRIMARY KEY,
 day TEXT NOT NULL,
 seq INTEGER NOT NULL,
 name TEXT NOT NULL,
 access_token TEXT NOT NULL UNIQUE,
 line_code TEXT NOT NULL UNIQUE,
 wants_line INTEGER NOT NULL DEFAULT 0,
 line_user_id TEXT,
 status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','calling','called','done','cancelled')),
 created_at TEXT NOT NULL,
 called_at TEXT,
 bound_at TEXT,
 sent_at TEXT,
 notification TEXT,
 UNIQUE(day,seq)
);
CREATE INDEX IF NOT EXISTS idx_queue_day ON queue_tickets(day,seq);
CREATE INDEX IF NOT EXISTS idx_queue_line ON queue_tickets(line_code);
CREATE TABLE IF NOT EXISTS queue_limits (
 bucket TEXT PRIMARY KEY,
 count INTEGER NOT NULL DEFAULT 0
);
