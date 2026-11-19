-- Feedback on a program (design §12.1): a problem pointed out, or an edit asked for. `field` is a
-- field key, name, cohort or kind; none is the whole program, which only a problem can be about.
-- `old_value` is what that was when it was given, `proposed_value` none to clear it.
CREATE TABLE feedback (
  id              integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  program_id      integer     NOT NULL REFERENCES programs (id),
  user_id         integer     NOT NULL REFERENCES users (id),
  kind            text        NOT NULL CHECK (kind IN ('problem', 'edit')),
  field           text,
  old_value       jsonb,
  proposed_value  jsonb,
  reason          text        NOT NULL,
  basis           text,
  status          text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
  via             text        NOT NULL CHECK (via IN ('web', 'agent')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_by     integer     REFERENCES users (id),
  reviewed_at     timestamptz,
  review_note     text,
  CHECK (kind = 'problem' AND proposed_value IS NULL
         OR kind = 'edit' AND field IS NOT NULL AND basis IS NOT NULL),
  CHECK ((status IN ('accepted', 'rejected')) = (reviewed_at IS NOT NULL)
         AND (reviewed_at IS NULL) = (reviewed_by IS NULL)),
  -- A note only on one decided, and on every one rejected.
  CHECK (status <> 'rejected' OR review_note IS NOT NULL),
  CHECK (review_note IS NULL OR status IN ('accepted', 'rejected'))
);
-- One pending each for a person and a part of a program: giving it again replaces it.
CREATE UNIQUE INDEX feedback_pending ON feedback (program_id, user_id, field) NULLS NOT DISTINCT
  WHERE status = 'pending';
CREATE INDEX feedback_program ON feedback (program_id, created_at);
CREATE INDEX feedback_user ON feedback (user_id, id);
CREATE INDEX feedback_queue ON feedback (created_at) WHERE status = 'pending';

-- The edit an accepted edit request made.
ALTER TABLE edits ADD COLUMN feedback_id integer REFERENCES feedback (id);

-- A program several people found wrong, for an admin to look at (design §12.3); one open at a time.
CREATE TABLE disputes (
  id           integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  program_id   integer     NOT NULL REFERENCES programs (id),
  opened_at    timestamptz NOT NULL DEFAULT now(),
  resolved_by  integer     REFERENCES users (id),
  resolved_at  timestamptz,
  result       text        CHECK (result IN ('corrected', 'confirmed')),
  note         text,
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)
         AND (resolved_at IS NULL) = (result IS NULL)
         AND (resolved_at IS NULL) = (note IS NULL))
);
CREATE UNIQUE INDEX disputes_open ON disputes (program_id) WHERE resolved_at IS NULL;
CREATE INDEX disputes_program ON disputes (program_id, resolved_at);
