-- Mail: let an employee choose which HR their leave goes to, and add @mentions
-- (tagging) to task comments.

-- 1) The HR a leave request was submitted to. NULL for older rows.
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS hr_id INTEGER REFERENCES employees(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_leave_requests_hr ON leave_requests(hr_id);

-- 2) People tagged in a task comment (employee ids), for better in-task
-- communication and notifications.
ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS mentions INTEGER[] NOT NULL DEFAULT '{}';
