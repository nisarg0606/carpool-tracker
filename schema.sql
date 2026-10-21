-- Carpool Tracker — Cloudflare D1 schema
-- Apply with:  wrangler d1 execute carpool-tracker --remote --file=./schema.sql
-- (or paste into the D1 console: Cloudflare dashboard > D1 > your database > Console)
--
-- Money is stored as integer cents (500 = $5.00) to avoid float rounding.
-- Settings are key/value JSON so everything stays custom without migrations.

CREATE TABLE IF NOT EXISTS people (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  can_drive  INTEGER NOT NULL DEFAULT 0, -- 1 = can be picked as a driver, 0 = rider only
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL -- JSON-encoded value, e.g. key='rate_cents' value='500'
                      -- key='office_days' value='[2,3,4]' (JS weekdays: 0=Sun..6=Sat, so 2=Tue,3=Wed,4=Thu)
);

CREATE TABLE IF NOT EXISTS rides (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,              -- YYYY-MM-DD (local carpool date)
  direction  TEXT NOT NULL CHECK (direction IN ('to_office', 'return')),
  driver_id  INTEGER NOT NULL REFERENCES people(id),
  rate_cents INTEGER NOT NULL DEFAULT 500, -- snapshot of the rate at log time:
                                             -- changing the rate later only applies going forward
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rides_date ON rides(date);

CREATE TABLE IF NOT EXISTS ride_riders (
  ride_id   INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people(id),
  PRIMARY KEY (ride_id, person_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_person_id  INTEGER NOT NULL REFERENCES people(id), -- who paid
  to_person_id    INTEGER NOT NULL REFERENCES people(id), -- who received it
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  date            TEXT NOT NULL, -- YYYY-MM-DD
  note            TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(date);

CREATE TABLE IF NOT EXISTS no_drive_days (
  date TEXT PRIMARY KEY -- YYYY-MM-DD marked "No drive today"
);

-- Default settings (the API also seeds these + the starting roster on first
-- /api/state call if the tables are empty, so these inserts are a belt-and-braces
-- convenience, not a requirement).
INSERT OR IGNORE INTO settings (key, value) VALUES ('rate_cents', '500');
INSERT OR IGNORE INTO settings (key, value) VALUES ('office_days', '[2,3,4]');

-- Starting roster (all editable in the app afterwards).
INSERT OR IGNORE INTO people (name, can_drive) VALUES ('Nisarg', 1);
INSERT OR IGNORE INTO people (name, can_drive) VALUES ('Apurva', 1);
INSERT OR IGNORE INTO people (name, can_drive) VALUES ('Chetan', 0);
INSERT OR IGNORE INTO people (name, can_drive) VALUES ('Sai', 0);
INSERT OR IGNORE INTO people (name, can_drive) VALUES ('Aakash', 0);
