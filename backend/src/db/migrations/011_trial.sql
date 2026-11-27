-- v53: 7-day full-access trial per account, recorded server-side.
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ;
