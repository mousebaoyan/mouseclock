"""The words the LLM read in attachments, kept by the attachment's address (design §7.4). Read
again, the same picture may come out in different words, and the notice would look changed."""

import sqlite3
import time
from collections.abc import Callable
from pathlib import Path

# Files no notice has used for this long are dropped.
KEEP = 30 * 24 * 60 * 60


class Readings:
    def __init__(self, path: Path, clock: Callable[[], float] = time.time) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, autocommit=True)
        self.clock = clock
        self.db.execute(
            "CREATE TABLE IF NOT EXISTS readings"
            " (url TEXT PRIMARY KEY, data BLOB NOT NULL, text TEXT NOT NULL, used_at REAL NOT NULL)"
        )

    def text(self, url: str, data: bytes) -> str | None:
        """The words read from the file at this address, if it is still byte for byte the same."""
        row = self.db.execute(
            "UPDATE readings SET used_at = ? WHERE url = ? AND data = ? RETURNING text",
            (self.clock(), url, data),
        ).fetchone()
        return None if row is None else row[0]

    def keep(self, url: str, data: bytes, text: str) -> None:
        now = self.clock()
        self.db.execute("DELETE FROM readings WHERE used_at < ?", (now - KEEP,))
        self.db.execute(
            "INSERT OR REPLACE INTO readings VALUES (?, ?, ?, ?)", (url, data, text, now)
        )

    def close(self) -> None:
        self.db.close()
