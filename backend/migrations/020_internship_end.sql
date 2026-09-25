-- Structured internship end (last) date, so the HR board can show a real
-- "last date" and compute how much of the internship period is completed
-- (start = joining_date). The free-text internship_tenure column is kept for
-- display / backward compatibility.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS internship_end_date DATE;
