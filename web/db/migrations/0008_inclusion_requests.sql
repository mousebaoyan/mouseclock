-- Colleges members want crawled (design §10.1). One picked from the list is its college_id
-- alone; one not in it is a name, under a school from the list or one named too. Each is asked
-- for once: asking again counts as a vote.
CREATE TABLE inclusion_requests (
  id            integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  college_id    integer     UNIQUE REFERENCES colleges (id),
  school_id     integer     REFERENCES schools (id),
  school_name   text,
  college_name  text,
  url_hint      text,
  note          text        NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  user_id       integer     NOT NULL REFERENCES users (id),
  status        text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'onboarding', 'included', 'unavailable')),
  reason        text        CHECK ((status = 'unavailable') = (reason IS NOT NULL)),
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz CHECK ((status IN ('included', 'unavailable')) = (resolved_at IS NOT NULL)),
  CHECK (
    college_id IS NOT NULL AND school_id IS NULL AND school_name IS NULL AND college_name IS NULL
    OR college_id IS NULL AND college_name IS NOT NULL AND (school_id IS NULL) <> (school_name IS NULL)
  ),
  -- Included is a college on the list being crawled.
  CHECK (status <> 'included' OR college_id IS NOT NULL),
  UNIQUE (school_id, college_name),
  UNIQUE (school_name, college_name)
);
-- The one who asked has a vote too.
CREATE TABLE inclusion_votes (
  request_id  integer     NOT NULL REFERENCES inclusion_requests (id) ON DELETE CASCADE,
  user_id     integer     NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, user_id)
);
