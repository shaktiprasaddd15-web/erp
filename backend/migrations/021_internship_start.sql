-- Internship start date (so the HR board can compute % complete from a real
-- internship window: start -> last date), and a one-time "asked" flag so
-- existing users are re-prompted exactly once for their internship dates.
-- Admins (CEO etc.) are never asked. Anyone already flagged keeps their setting.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS internship_start_date DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS internship_asked BOOLEAN NOT NULL DEFAULT false;

-- Admins never need the internship prompt — mark them asked up front.
UPDATE employees SET internship_asked = true WHERE access_role = 'admin';
