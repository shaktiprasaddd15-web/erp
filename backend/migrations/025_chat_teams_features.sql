-- Teams-like chat enhancements: replies / quotes, pinned messages, and employee presence.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id BIGINT REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_pinned   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_at   TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_by   INTEGER REFERENCES employees(id) ON DELETE SET NULL;

-- Presence / online status: updated on authenticated API requests
ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_id);
CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(conversation_id) WHERE is_pinned = true;
