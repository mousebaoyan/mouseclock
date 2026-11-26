-- A list page a site keeps behind a login, its campus or a captcha (design §7.2).
ALTER TABLE crawl_runs
  DROP CONSTRAINT crawl_runs_failure_check,
  ADD CONSTRAINT crawl_runs_failure_check CHECK (failure IN ('timeout', 'unreachable',
    'too_many_redirects', 'http_status', 'no_items', 'restricted', 'error'));
