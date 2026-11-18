-- Messages on the site and the emails some of them go out as (design §11.1, §11.2). A kind is
-- what reminders/kinds.ts lists, kept as text so a feature adding one needs no migration here.

CREATE TABLE messages (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     integer     NOT NULL REFERENCES users (id),
  kind        text        NOT NULL,
  title       text        NOT NULL,
  body        text        NOT NULL,
  link        text        NOT NULL,              -- a path on this site
  created_at  timestamptz NOT NULL DEFAULT now(),
  seen_at     timestamptz
);
CREATE INDEX messages_user ON messages (user_id, id);
CREATE INDEX messages_unseen ON messages (user_id) WHERE seen_at IS NULL;

-- The owner's rule for a kind; a kind with none keeps the default in reminders/kinds.ts.
CREATE TABLE email_rules (
  kind  text PRIMARY KEY,
  rule  text NOT NULL CHECK (rule IN ('default_on', 'default_off', 'never'))
);

-- A member's own switch for a kind; none follows the owner's rule.
CREATE TABLE email_settings (
  user_id  integer NOT NULL REFERENCES users (id),
  kind     text    NOT NULL,
  enabled  boolean NOT NULL,
  PRIMARY KEY (user_id, kind)
);

-- One email per message, written with it; whether it still goes is decided when it is sent.
CREATE TABLE emails (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     integer     NOT NULL REFERENCES users (id),
  message_id  integer     NOT NULL UNIQUE REFERENCES messages (id),
  subject     text        NOT NULL,
  body        text        NOT NULL,
  html        text        NOT NULL,
  attempts    smallint    NOT NULL DEFAULT 0,
  next_at     timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  dropped_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (sent_at IS NULL OR dropped_at IS NULL)
);
CREATE INDEX emails_due ON emails (next_at) WHERE sent_at IS NULL AND dropped_at IS NULL;
CREATE INDEX emails_user ON emails (user_id, created_at);

-- Mailboxes to send from, in order. The password is encrypted with APP_SECRET.
CREATE TABLE mail_accounts (
  id        integer  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sort      smallint NOT NULL UNIQUE,
  host      text     NOT NULL,
  port      integer  NOT NULL,
  username  text     NOT NULL UNIQUE,
  password  text     NOT NULL
);

-- The email rules and the mailboxes are settings, with no row of their own to point at.
ALTER TABLE audit_log ALTER COLUMN target_id DROP NOT NULL;
