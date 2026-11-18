-- Subscriptions and their reminders (design §11.3).
CREATE TABLE subscriptions (
  user_id         integer     NOT NULL REFERENCES users (id),
  program_id      integer     NOT NULL REFERENCES programs (id),
  -- The deadline as the member last heard of it: the program's apply_deadline, and the apply end
  -- as the notice wrote it, for 「原为」 once it changes. NULL: none.
  deadline        timestamptz,
  deadline_value  jsonb,
  -- When to remind them of that deadline; NULL once reminded, or without one.
  remind_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, program_id)
);
CREATE INDEX subscriptions_program ON subscriptions (program_id);

-- Mousehole turned the token down, so they were banned or took the access back: they get no
-- messages until they log in again (design §6.1).
ALTER TABLE users ADD COLUMN token_refused_at timestamptz;
