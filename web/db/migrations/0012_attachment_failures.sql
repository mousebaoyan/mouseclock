-- An attachment whose words aren't in the snapshot says why, and the round that couldn't read it
-- lists it (design §7.4, §7.5). Those stored before now didn't keep why: they stay as they were.
ALTER TABLE attachments
  ADD COLUMN failure text CHECK (failure IN ('download_failed', 'too_large', 'unreadable')),
  ADD COLUMN detail text NOT NULL DEFAULT '',
  ADD CHECK (failure IS NULL OR (text = '' AND NOT read_from_pictures));
-- A round can fail on thousands of attachments, mostly for one reason: it lists the first few.
ALTER TABLE crawl_runs
  ADD COLUMN attachment_failures jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN attachment_failure_count integer NOT NULL DEFAULT 0;
