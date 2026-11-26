-- The deadlines each member was reminded of on a program (design §11.3), kept past unsubscribing,
-- so subscribing again doesn't remind of one again. program_id references nothing: the minute's
-- reminders, holding subscriptions, would then wait on a program an admin is deleting or merging,
-- while the admin waits on those subscriptions. Programs are only ever marked deleted.
CREATE TABLE deadline_reminders (
  user_id     integer     NOT NULL REFERENCES users (id),
  program_id  integer     NOT NULL,
  deadline    timestamptz NOT NULL,
  PRIMARY KEY (user_id, program_id, deadline)
);
CREATE INDEX deadline_reminders_program ON deadline_reminders (program_id);
