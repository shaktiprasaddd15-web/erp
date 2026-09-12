-- Remarks: (1) general feedback admins/HR leave on a user, shown to that user;
-- (2) an HR remark on a specific leave request.

CREATE TABLE IF NOT EXISTS user_remarks (
    id           SERIAL PRIMARY KEY,
    employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, -- the person the remark is about
    author_id    INTEGER REFERENCES employees(id) ON DELETE SET NULL,          -- who wrote it (admin/HR)
    body         TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_remarks_emp ON user_remarks(employee_id);

-- HR's remark on a leave request.
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS hr_remark TEXT;
