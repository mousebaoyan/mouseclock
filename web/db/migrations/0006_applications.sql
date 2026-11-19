-- One's own record of applying to a program (design §9.4), seen by no one else.
CREATE TABLE applications (
  user_id     integer     NOT NULL REFERENCES users (id),
  program_id  integer     NOT NULL REFERENCES programs (id),
  stage       text        NOT NULL CHECK (stage IN ('want', 'applied', 'submitted', 'admitted', 'excellent', 'failed', 'gave_up')),
  note        text        NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, program_id)
);
CREATE INDEX applications_program ON applications (program_id);
