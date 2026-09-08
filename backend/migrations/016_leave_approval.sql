-- Leave approval workflow: a filed leave is 'pending' until the chosen HR or an
-- admin approves it; only approved leaves are counted (e.g. on the calendar).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'leave_requests' AND column_name = 'status'
  ) THEN
    ALTER TABLE leave_requests
      ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'approved', 'rejected'));
    -- Leaves filed before this feature existed were always counted, so treat
    -- them as already approved (runs once, only when the column is first added).
    UPDATE leave_requests SET status = 'approved';
  END IF;
END $$;

ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS decided_by INTEGER REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status);
