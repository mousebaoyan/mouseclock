"""Log lines as one JSON object each on stdout, the way the website writes them, so `docker logs`
output can be filtered with jq (development §4)."""

import json
import logging
from contextvars import ContextVar
from datetime import UTC, datetime

# The source and start of the round a line comes from, which find its crawl run on the dashboard.
# Each round runs in its own task, so the value stays with that round's lines.
crawl_round: ContextVar[tuple[int, int] | None] = ContextVar("crawl_round", default=None)

_RECORD_ATTRIBUTES = frozenset(vars(logging.makeLogRecord({}))) | {"message"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, object] = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "msg": record.getMessage(),
        }
        if (current := crawl_round.get()) is not None:
            entry["source_id"], entry["started_at"] = current
        # What the call passed as `extra`.
        entry |= {
            key: value for key, value in vars(record).items() if key not in _RECORD_ATTRIBUTES
        }
        if record.exc_info:
            entry["stack"] = self.formatException(record.exc_info)
        return json.dumps(entry, ensure_ascii=False, default=str)
