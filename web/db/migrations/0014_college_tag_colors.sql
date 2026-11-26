-- Each preset in a color the admins pick, so tags are told apart at a glance (design §9.3). The
-- ones there are take different colors in their order.
ALTER TABLE college_tags ADD COLUMN color text;
UPDATE college_tags AS t
SET color = (ARRAY['green', 'orange', 'blue', 'violet', 'teal', 'sky', 'amber', 'pink', 'red'])
  [(o.n - 1) % 9 + 1]
FROM (SELECT id, row_number() OVER (ORDER BY sort) AS n FROM college_tags) AS o
WHERE o.id = t.id;
ALTER TABLE college_tags
  ALTER COLUMN color SET NOT NULL,
  ADD CONSTRAINT college_tags_color_check CHECK (color IN ('red', 'orange', 'amber', 'green',
    'teal', 'sky', 'blue', 'violet', 'pink', 'gray'));
