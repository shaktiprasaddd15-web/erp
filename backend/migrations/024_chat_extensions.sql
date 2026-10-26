-- Chat, round two: edit/delete, reactions, and a real report queue.
--
-- Deletes are soft. The thread endpoint pages with `?after=<id>`, so hard-
-- deleting a row would leave a hole the client's cursor can skip past; keeping
-- the row (with the body scrubbed by the route) preserves ordering and lets the
-- UI render a "message deleted" tombstone. edited_at stays NULL until the first
-- edit, which is how 019_remark_edits.sql marks edited remarks.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at  TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_by INTEGER REFERENCES employees(id) ON DELETE SET NULL;

-- The conversation list's last-message preview and the unread counts both need
-- to skip tombstones, and both filter on (conversation_id, deleted_at) before
-- ordering by created_at.
CREATE INDEX IF NOT EXISTS idx_messages_conv_live
    ON messages(conversation_id, created_at)
    WHERE deleted_at IS NULL;

-- One row per (message, person, emoji): a person may react with several
-- different emoji to the same message, but the same emoji only once. The PK
-- gives us that uniqueness and makes the toggle a plain INSERT ... ON CONFLICT
-- DO NOTHING / DELETE pair.
CREATE TABLE IF NOT EXISTS message_reactions (
    message_id  BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    emoji       VARCHAR(16) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, employee_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_message_reactions_msg ON message_reactions(message_id);

-- Reports previously went only to audit_log, which is an append-only trail with
-- no state — admins got a push notification and nothing to work from. This is
-- the queue: one open report per person per message, resolvable.
CREATE TABLE IF NOT EXISTS message_reports (
    id           SERIAL PRIMARY KEY,
    message_id   BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    reporter_id  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    reason       TEXT,
    status       VARCHAR(12) NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'reviewed', 'dismissed')),
    resolved_by  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    resolved_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (message_id, reporter_id)
);
-- The admin queue reads open reports oldest-first.
CREATE INDEX IF NOT EXISTS idx_message_reports_open
    ON message_reports(created_at)
    WHERE status = 'open';
