-- Accounts: copies of mousehole accounts (design §6)

CREATE TABLE users (
  id               integer  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mousehole_id     integer  NOT NULL UNIQUE,
  display_name     text     NOT NULL,
  avatar_url       text,                     -- absolute, on the mousehole site
  level            smallint NOT NULL,
  role             text     NOT NULL CHECK (role IN ('user', 'moderator', 'admin', 'owner')),
  frozen           boolean  NOT NULL,        -- in no group: counts as a guest
  muted            boolean  NOT NULL,
  muted_until      timestamptz,              -- NULL while muted: for good
  qq               bigint,                   -- only to send mail to QQ号@qq.com, never shown
  mousehole_token  text     NOT NULL,        -- profile scope only, to refresh this copy hourly
  edit_revoked_at  timestamptz,              -- set: an admin took back editing here, not on mousehole
  synced_at        timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash    bytea   NOT NULL UNIQUE,
  user_id       integer NOT NULL REFERENCES users (id),
  user_agent    text    NOT NULL DEFAULT '',
  ip            inet,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(), -- written at most hourly
  expires_at    timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

-- Schools, colleges and sources (design §7.1, §9.1)

CREATE TABLE schools (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text    NOT NULL UNIQUE,
  short_name  text    NOT NULL DEFAULT '',     -- as people say it, for search: 电科
  tiers       text[]  NOT NULL DEFAULT '{}'
              CHECK (tiers <@ ARRAY['c9', '985', '211', 'double_first_class']),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE colleges (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  school_id   integer NOT NULL REFERENCES schools (id),
  name        text    NOT NULL,
  kind        text    NOT NULL CHECK (kind IN ('college', 'institute', 'graduate_school')),
  -- Where its students study: Shenzhen campuses and CAS institutes are not where their school is.
  region      text    NOT NULL,
  directions  text[]  NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
);

CREATE TABLE sources (
  id                  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  college_id          integer NOT NULL REFERENCES colleges (id),
  url                 text    NOT NULL UNIQUE,
  section             text    NOT NULL DEFAULT '', -- the list's name on the site, which helps screening
  browser             boolean NOT NULL DEFAULT false,
  config              jsonb,                       -- the crawler's; NULL: generic crawling
  unavailable_reason  text,                        -- set: not crawled
  crawled_at          timestamptz,                 -- end of the last round; NULL: the first round backfills
  leased_until        timestamptz,                 -- handed to the crawler, round not reported yet
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sources_college ON sources (college_id);

-- Crawling (design §7)

CREATE TABLE crawler_tokens (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text    NOT NULL,
  token_hash    bytea   NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,                   -- last time it asked for work
  revoked_at    timestamptz
);

CREATE TABLE crawl_runs (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id        integer NOT NULL REFERENCES sources (id),
  started_at       timestamptz NOT NULL,
  finished_at      timestamptz NOT NULL,
  failure          text    CHECK (failure IN ('timeout', 'unreachable', 'disallowed',
                     'too_many_redirects', 'http_status', 'no_items', 'error')), -- NULL: the list was read
  detail           text    NOT NULL DEFAULT '', -- what failed, as `HTTP 403`
  listed           integer NOT NULL,
  new_count        integer NOT NULL,
  useful_count     integer NOT NULL,            -- new notices extraction found programs in
  notice_failures  jsonb   NOT NULL DEFAULT '[]' -- [{url, failure, detail}]: notices not fetched
);
CREATE INDEX crawl_runs_started ON crawl_runs (started_at);
CREATE INDEX crawl_runs_source ON crawl_runs (source_id, started_at);

CREATE TABLE source_probes (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  url               text    NOT NULL,
  browser           boolean NOT NULL,
  config            jsonb,                     -- NULL: the crawler works one out
  requested_by      integer NOT NULL REFERENCES users (id),
  leased_until      timestamptz,
  finished_at       timestamptz,               -- NULL: waiting for the crawler
  items             jsonb   NOT NULL DEFAULT '[]', -- [{url, title, published_on}]
  suggested_config  jsonb,
  failure           text,
  detail            text    NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notices (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id        integer NOT NULL REFERENCES sources (id),
  url              text    NOT NULL,
  title            text    NOT NULL,
  published_on     date,                       -- as listed; NULL when the list shows no date
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  screening_score  real,                       -- NULL: not screened yet
  screened_in      boolean,                    -- the crawler's call against its threshold
  checked_at       timestamptz,                -- last fetched, for daily re-crawls
  leased_until     timestamptz,                -- re-crawl handed out, not reported yet
  removed_at       timestamptz,                -- the page answered 404 or 410
  UNIQUE (source_id, url),
  CHECK ((screening_score IS NULL) = (screened_in IS NULL))
);

-- Re-crawls compare text with the latest snapshot instead of hashing it (AGENTS.md).
CREATE TABLE snapshots (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notice_id     integer NOT NULL REFERENCES notices (id),
  fetched_at    timestamptz NOT NULL,
  html          text    NOT NULL,
  text          text    NOT NULL,
  extracted_at  timestamptz                    -- NULL: extraction not submitted yet
);
CREATE INDEX snapshots_notice ON snapshots (notice_id, id);

CREATE TABLE attachments (
  snapshot_id   integer  NOT NULL REFERENCES snapshots (id),
  position      smallint NOT NULL,             -- order on the page from 0; evidence refers to it
  name          text     NOT NULL,
  url           text     NOT NULL,
  content_type  text     NOT NULL,
  text          text     NOT NULL,             -- extracted, or recognised in images
  data          bytea,                         -- NULL until the crawler uploads the file
  PRIMARY KEY (snapshot_id, position)
);

CREATE TABLE model_calls (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purpose        text    NOT NULL CHECK (purpose IN ('screening', 'extraction', 'probe')),
  source_id      integer REFERENCES sources (id),       -- NULL for probes
  snapshot_id    integer REFERENCES snapshots (id),     -- extraction only
  probe_id       integer REFERENCES source_probes (id), -- probes only
  model          text    NOT NULL,
  input_tokens   integer NOT NULL,
  output_tokens  integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_calls_created ON model_calls (created_at);

-- Programs (design §8.2–8.4, §9)

CREATE TABLE programs (
  id              integer  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  college_id      integer  NOT NULL REFERENCES colleges (id),
  cohort          smallint NOT NULL,
  kind            text     NOT NULL
                  CHECK (kind IN ('winter_camp', 'summer_camp', 'pre_recommendation', 'september_round')),
  name            text     NOT NULL,
  -- Instants worked out from the apply field (design §8.2), for status, sorting and reminders.
  apply_start     timestamptz,
  apply_deadline  timestamptz,
  verified_by     integer  REFERENCES users (id),
  verified_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX programs_table ON programs (cohort, kind, apply_deadline) WHERE deleted_at IS NULL;
CREATE INDEX programs_college ON programs (college_id, cohort);

CREATE TABLE program_versions (
  id           integer  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  program_id   integer  NOT NULL REFERENCES programs (id),
  snapshot_id  integer  NOT NULL REFERENCES snapshots (id),
  number       smallint NOT NULL,              -- 1, 2, … within the program
  role         text     NOT NULL CHECK (role IN ('call', 'update', 'result')),
  fields       jsonb    NOT NULL,              -- what this notice said, as extracted
  changes      text[]   NOT NULL,              -- keys of the fields it changed
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, number),
  UNIQUE (program_id, snapshot_id)
);
CREATE INDEX program_versions_snapshot ON program_versions (snapshot_id);

CREATE TABLE edits (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  program_id  integer NOT NULL REFERENCES programs (id),
  field       text    NOT NULL,               -- a field key, or name, cohort, kind
  old_value   jsonb,                          -- NULL: was empty
  new_value   jsonb,                          -- NULL: cleared
  reason      text    NOT NULL,
  basis       text    NOT NULL,               -- a link to the original, or a screenshot
  user_id     integer NOT NULL REFERENCES users (id),
  via         text    NOT NULL CHECK (via IN ('web', 'agent')),
  reverts_id  integer REFERENCES edits (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX edits_program ON edits (program_id, id);
CREATE INDEX edits_user ON edits (user_id, id);
CREATE INDEX edits_recent ON edits (created_at);

-- Keys aren't checked here: the field list grows (design §8.2) and its schema lives in code.
CREATE TABLE program_fields (
  program_id  integer NOT NULL REFERENCES programs (id),
  key         text    NOT NULL,
  value       jsonb   NOT NULL,
  evidence    jsonb   NOT NULL,                -- [{quote, attachment?}]; [] when a person set it
  confidence  real,                            -- NULL when a person set it
  version_id  integer REFERENCES program_versions (id), -- the version the value came from
  edit_id     integer REFERENCES edits (id),   -- set: a person set it, so crawls don't overwrite it
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (program_id, key),
  CHECK ((version_id IS NULL) <> (edit_id IS NULL))
);

-- What people decide on the review page (design §8.3, §8.4, §12.2).
CREATE TABLE review_items (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reason       text    NOT NULL CHECK (reason IN (
                 -- a field held back from a version
                 'evidence_not_found', 'low_confidence', 'implausible', 'conflicts_edit',
                 -- a program from an extraction
                 'unknown_program', 'unknown_college', 'implausible_cohort',
                 'possible_duplicate', 'no_deadline')),
  snapshot_id  integer NOT NULL REFERENCES snapshots (id),
  program_id   integer REFERENCES programs (id),       -- NULL: the extraction's program was held back
  version_id   integer REFERENCES program_versions (id),
  key          text,                                    -- the field, for field reasons
  payload      jsonb   NOT NULL,                        -- the field or the program as extracted
  status       text    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  resolved_by  integer REFERENCES users (id),
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_items_pending ON review_items (id) WHERE status = 'pending';
CREATE INDEX review_items_program ON review_items (program_id);

CREATE TABLE audit_log (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      integer NOT NULL REFERENCES users (id),
  action       text    NOT NULL,
  target_type  text    NOT NULL,
  target_id    integer NOT NULL,
  detail       jsonb   NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created ON audit_log (created_at);
