-- Internal chat: direct messages + project / company channels.
CREATE TABLE IF NOT EXISTS conversations (
    id          SERIAL PRIMARY KEY,
    type        VARCHAR(10) NOT NULL CHECK (type IN ('dm', 'channel')),
    title       VARCHAR(160),                                   -- channel title / company channel name
    project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,  -- set for project channels
    is_company  BOOLEAN NOT NULL DEFAULT false,                 -- the single company-wide channel
    dm_key      VARCHAR(40) UNIQUE,                             -- 'minId-maxId' for DM dedup
    created_by  INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- one channel per project; one company channel
CREATE UNIQUE INDEX IF NOT EXISTS uniq_conv_project ON conversations(project_id) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_conv_company ON conversations(is_company) WHERE is_company = true;

CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    last_read_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_conv_members_emp ON conversation_members(employee_id);

CREATE TABLE IF NOT EXISTS messages (
    id              BIGSERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    body            TEXT NOT NULL,
    mentions        INTEGER[] NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
