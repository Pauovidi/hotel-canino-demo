CREATE TABLE IF NOT EXISTS hotel_scheduled_messages (
  id text PRIMARY KEY,
  type text NOT NULL,
  conversation_id text,
  reservation_id text,
  channel text NOT NULL DEFAULT 'whatsapp',
  external_user_id text,
  phone_hash text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  last_error_code text,
  dedupe_key text NOT NULL UNIQUE,
  dry_run boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE INDEX IF NOT EXISTS hotel_scheduled_messages_due_idx
  ON hotel_scheduled_messages (status, scheduled_at);

CREATE INDEX IF NOT EXISTS hotel_scheduled_messages_reservation_type_idx
  ON hotel_scheduled_messages (reservation_id, type);

CREATE INDEX IF NOT EXISTS hotel_scheduled_messages_conversation_idx
  ON hotel_scheduled_messages (conversation_id);
