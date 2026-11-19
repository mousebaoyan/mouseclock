-- Personal tokens for one's own Agent (design §13), only their SHA-256 kept. `scope` is `read`, or
-- `personal`, which also subscribes, follows, records applications and gives feedback.
CREATE TABLE api_tokens (
  id            integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       integer     NOT NULL REFERENCES users (id),
  name          text        NOT NULL,
  token_hash    bytea       NOT NULL UNIQUE,
  scope         text        NOT NULL CHECK (scope IN ('read', 'personal')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,                     -- written at most hourly
  revoked_at    timestamptz
);
CREATE INDEX api_tokens_user ON api_tokens (user_id) WHERE revoked_at IS NULL;
