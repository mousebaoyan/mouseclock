-- A list that posts only admissions notices: every new one goes to extraction, whatever its
-- screening score (design §8.1).
ALTER TABLE sources ADD COLUMN keep_all boolean NOT NULL DEFAULT false;
