-- Colleges members follow for their new notices (design §11.4).
CREATE TABLE follows (
  user_id     integer     NOT NULL REFERENCES users (id),
  college_id  integer     NOT NULL REFERENCES colleges (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, college_id)
);
CREATE INDEX follows_college ON follows (college_id);

-- A notice is told of once to each college's followers: not again once its text changes, or when
-- a round is reported twice, or once a held program of it is accepted on the review page.
CREATE TABLE announced_notices (
  notice_id   integer NOT NULL REFERENCES notices (id),
  college_id  integer NOT NULL REFERENCES colleges (id),
  PRIMARY KEY (notice_id, college_id)
);
-- Those on the table before anyone could follow are no news.
INSERT INTO announced_notices
SELECT DISTINCT snapshots.notice_id, programs.college_id
FROM program_versions
JOIN snapshots ON snapshots.id = program_versions.snapshot_id
JOIN programs ON programs.id = program_versions.program_id;
