-- What members make of a college, from presets the admins keep (design §9.3).
CREATE TABLE college_tags (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         text    NOT NULL UNIQUE,
  description  text    NOT NULL,
  sort         integer NOT NULL
);
-- A preset deleted takes its votes with it.
CREATE TABLE college_tag_votes (
  id          integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  college_id  integer     NOT NULL REFERENCES colleges (id),
  tag_id      integer     NOT NULL REFERENCES college_tags (id) ON DELETE CASCADE,
  user_id     integer     NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (college_id, tag_id, user_id)
);
CREATE INDEX college_tag_votes_tag ON college_tag_votes (tag_id);

INSERT INTO college_tags (name, description, sort) VALUES
  ('对双非友好', '往年有不少双非院校的同学入营、拿到优营', 1),
  ('卡本科出身', '往年入营、拿到优营的几乎都是 985、211 的同学', 2),
  ('看重科研', '考核看重论文和科研经历', 3),
  ('看重竞赛', '考核看重竞赛获奖', 4),
  ('有机试', '考核里有上机编程', 5);
