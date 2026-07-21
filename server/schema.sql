CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  name          text NOT NULL DEFAULT '',
  username      text UNIQUE,
  timezone      text NOT NULL DEFAULT 'America/Chicago',
  welcome_note  text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  timezone   text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- weekly recurring rules; multiple ranges per weekday allowed
CREATE TABLE IF NOT EXISTS schedule_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  weekday     int NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=Sunday
  start_min   int NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min     int NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  CHECK (end_min > start_min)
);

-- date override replaces weekly rules for that date; null range = blocked all day
CREATE TABLE IF NOT EXISTS date_overrides (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  date        date NOT NULL,
  start_min   int,
  end_min     int
);
CREATE INDEX IF NOT EXISTS idx_overrides_sched_date ON date_overrides(schedule_id, date);

CREATE TABLE IF NOT EXISTS event_types (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             text NOT NULL,
  slug              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  duration_min      int NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 5 AND 720),
  color             text NOT NULL DEFAULT '#2B3EE5',
  locations         jsonb NOT NULL DEFAULT '["Google Meet"]',
  buffer_before_min int NOT NULL DEFAULT 0,
  buffer_after_min  int NOT NULL DEFAULT 0,
  min_notice_min    int NOT NULL DEFAULT 240,
  window_days       int NOT NULL DEFAULT 30,
  slot_interval_min int,                            -- null = use duration
  daily_cap         int,                            -- null = unlimited
  questions         jsonb NOT NULL DEFAULT '[]',
  hidden            boolean NOT NULL DEFAULT false,
  schedule_id       uuid REFERENCES schedules(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);

CREATE TABLE IF NOT EXISTS calendar_connections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL CHECK (provider IN ('google','microsoft','icloud')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','connected','needs_reauth','error')),
  account_email text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, account_email)
);
ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS enc_access_token  text;
ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS enc_refresh_token text;
ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS access_expires_at timestamptz;
ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS scopes            text NOT NULL DEFAULT '';
ALTER TABLE calendar_connections ADD COLUMN IF NOT EXISTS is_destination    boolean NOT NULL DEFAULT false;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS external_refs jsonb NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS bookings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type_id uuid NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- host (denormalized for exclusion)
  start_at      timestamptz NOT NULL,
  end_at        timestamptz NOT NULL,
  invitee_name  text NOT NULL,
  invitee_email text NOT NULL,
  answers       jsonb NOT NULL DEFAULT '{}',
  location      text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending','confirmed','cancelled','no_show','attended')),
  origin        text NOT NULL DEFAULT 'human',
  agent_name    text,
  principal     text,
  cancel_token  text NOT NULL DEFAULT encode(gen_random_bytes(16),'hex'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at)
);
-- the backstop: no two confirmed bookings for one host may overlap
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS no_double_booking;
ALTER TABLE bookings ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (user_id WITH =, tstzrange(start_at, end_at) WITH &&)
  WHERE (status IN ('pending','confirmed'));
CREATE INDEX IF NOT EXISTS idx_bookings_host_time ON bookings(user_id, start_at);

CREATE TABLE IF NOT EXISTS holds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type_id uuid NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_at      timestamptz NOT NULL,
  end_at        timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_holds_host_time ON holds(user_id, start_at, expires_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        text PRIMARY KEY,
  response   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE event_types ALTER COLUMN color SET DEFAULT '#2B3EE5';
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_prefs jsonb NOT NULL DEFAULT '{"booked":true,"cancelled":true,"digest":false}';
ALTER TABLE event_types ADD COLUMN IF NOT EXISTS allow_reschedule boolean NOT NULL DEFAULT true;
ALTER TABLE event_types ADD COLUMN IF NOT EXISTS allow_cancel     boolean NOT NULL DEFAULT true;
ALTER TABLE event_types ADD COLUMN IF NOT EXISTS cancel_policy    text NOT NULL DEFAULT '';
