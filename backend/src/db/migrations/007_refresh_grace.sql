-- v45: refresh-token grace window.
-- The refresh protocol rotates on every use. If the phone dies between the
-- server rotating the token and the answer being saved, the next refresh
-- replays the PREVIOUS token, which used to be refused - signing the person
-- out for good. These columns remember the token rotated away (and when), so
-- a replay inside a short grace window re-rotates normally. PgUserRepo holds
-- the window length; the columns only carry what it needs to check it.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS prev_refresh_hash TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS prev_refresh_at BIGINT;
