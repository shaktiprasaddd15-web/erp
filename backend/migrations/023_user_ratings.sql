-- Performance reviews: a 1–5 star rating a reviewer (admin, HR, or the
-- director of the employee's department) gives to an employee. One current
-- rating per reviewer per employee (upserted); the employee's review score is
-- the average across reviewers. Work-update consistency and attendance (a day
-- counts as present when a work update was pushed) remain computed from
-- work_entries; the engagement score column is kept as-is for now.
CREATE TABLE IF NOT EXISTS user_ratings (
    id           SERIAL PRIMARY KEY,
    employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    reviewer_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    stars        SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (employee_id, reviewer_id)
);
CREATE INDEX IF NOT EXISTS idx_user_ratings_emp ON user_ratings(employee_id);
