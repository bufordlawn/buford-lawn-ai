-- ─── BUFORD LAWN CARE AI - SUPABASE SCHEMA ───────────────────────────────────
-- Run this in your Supabase SQL Editor to set up the database

-- Main calls table
CREATE TABLE IF NOT EXISTS calls (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  call_sid              TEXT UNIQUE NOT NULL,         -- Twilio Call SID
  caller_number         TEXT NOT NULL,                -- e.g. +17705551234
  start_time            TIMESTAMPTZ NOT NULL,
  end_time              TIMESTAMPTZ,
  duration_seconds      INTEGER,
  transcript            TEXT,                         -- Full conversation text
  gathered_info         JSONB,                        -- Structured intake data
  recording_drive_url   TEXT,                         -- Google Drive link to MP3
  transcript_drive_url  TEXT,                         -- Google Drive link to .txt
  recording_twilio_url  TEXT,                         -- Twilio direct recording URL
  created_at            TIMESTAMPTZ DEFAULT now()
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_calls_caller_number ON calls(caller_number);
CREATE INDEX IF NOT EXISTS idx_calls_start_time ON calls(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_calls_created_at ON calls(created_at DESC);

-- Optional: Row Level Security (enable when building your SaaS dashboard)
-- ALTER TABLE calls ENABLE ROW LEVEL SECURITY;

-- ─── EXAMPLE QUERY: View recent leads ────────────────────────────────────────
-- SELECT
--   caller_number,
--   start_time AT TIME ZONE 'America/New_York' AS call_time_et,
--   duration_seconds,
--   gathered_info->>'name' AS caller_name,
--   gathered_info->>'address' AS address,
--   gathered_info->'services' AS services,
--   gathered_info->>'callbackNumber' AS callback,
--   recording_drive_url
-- FROM calls
-- ORDER BY start_time DESC
-- LIMIT 50;
