-- Allow remarks left on a user to be edited (fixing a remark given in haste or
-- by miscommunication). updated_at is stamped only when a remark is edited, so
-- the person always sees the latest corrected wording, marked as edited.
ALTER TABLE user_remarks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
