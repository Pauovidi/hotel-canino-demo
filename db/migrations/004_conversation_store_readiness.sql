-- Conversation store readiness for EasyPanel/Postgres.
-- 001_init.sql already creates the conversation, message and event tables.
-- This migration is intentionally idempotent so it can harden existing databases.

CREATE TABLE IF NOT EXISTS hotel_conversations (
  id TEXT PRIMARY KEY,
  phone_e164 TEXT,
  phone_normalized TEXT,
  display_name TEXT,
  customer_name TEXT,
  mode TEXT NOT NULL DEFAULT 'bot',
  status TEXT NOT NULL DEFAULT 'open',
  unread_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS hotel_conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES hotel_conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  sender_type TEXT NOT NULL,
  external_message_sid TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS hotel_conversation_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES hotel_conversations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS hotel_conversations_updated_at_idx
  ON hotel_conversations(updated_at DESC);

CREATE INDEX IF NOT EXISTS hotel_conversations_phone_normalized_idx
  ON hotel_conversations(phone_normalized);

CREATE UNIQUE INDEX IF NOT EXISTS hotel_conversation_messages_external_sid_idx
  ON hotel_conversation_messages(external_message_sid)
  WHERE external_message_sid IS NOT NULL;
