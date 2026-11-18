-- A merged program's links lead to the one it went into (design §12.2).
ALTER TABLE programs
  ADD COLUMN merged_into integer REFERENCES programs (id),
  ADD CHECK (merged_into IS NULL OR deleted_at IS NOT NULL);

-- Programs merged before now, from the review items that merged them. One merged into a program
-- that was merged in turn leads to where that one went.
WITH RECURSIVE merge AS (
  SELECT i.program_id AS id, (a.detail ->> 'program_id')::integer AS kept
  FROM review_items AS i
  JOIN audit_log AS a ON a.target_type = 'review_item' AND a.target_id = i.id
  WHERE i.reason = 'possible_duplicate' AND a.action = 'accept' AND a.detail ? 'program_id'
), chain AS (
  SELECT id, kept FROM merge
  UNION ALL
  SELECT chain.id, merge.kept FROM chain JOIN merge ON merge.id = chain.kept
)
UPDATE programs SET merged_into = chain.kept
FROM chain
WHERE programs.id = chain.id AND chain.kept NOT IN (SELECT id FROM merge);
