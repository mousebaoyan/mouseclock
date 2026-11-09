ALTER TABLE review_items DROP CONSTRAINT review_items_reason_check;
ALTER TABLE review_items ADD CONSTRAINT review_items_reason_check CHECK (reason IN (
  'evidence_not_found', 'low_confidence', 'implausible', 'conflicts_edit',
  'unknown_program', 'unknown_college', 'implausible_cohort',
  'possible_duplicate', 'no_deadline', 'unparsed_date'
));
