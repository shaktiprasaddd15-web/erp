-- Personal details captured from each employee on first login after this
-- feature ships: date of birth, joining date and internship tenure. The
-- popup that collects them is gated on personal_details_done, so each person
-- is asked exactly once (an admin can still edit the values later).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS date_of_birth        DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS joining_date         DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS internship_tenure    VARCHAR(120);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS personal_details_done BOOLEAN NOT NULL DEFAULT false;
