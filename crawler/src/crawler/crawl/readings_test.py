from pathlib import Path

from crawler.crawl.readings import KEEP, Readings


def test_words_are_kept_for_the_same_file_at_the_same_address(tmp_path: Path) -> None:
    now = 1_800_000_000.0
    readings = Readings(tmp_path / "readings.sqlite3", lambda: now)
    readings.keep("http://a/1.png", b"png 1", "报名截止9月20日")

    assert readings.text("http://a/1.png", b"png 1") == "报名截止9月20日"
    assert readings.text("http://a/1.png", b"png 2") is None
    assert readings.text("http://a/2.png", b"png 1") is None


def test_files_unused_for_a_while_are_dropped(tmp_path: Path) -> None:
    now = 1_800_000_000.0
    readings = Readings(tmp_path / "readings.sqlite3", lambda: now)
    readings.keep("http://a/old.png", b"old", "旧")
    readings.keep("http://a/used.png", b"used", "常用")
    now += KEEP - 1
    assert readings.text("http://a/used.png", b"used") == "常用"
    now += 2
    readings.keep("http://a/new.png", b"new", "新")

    assert readings.text("http://a/old.png", b"old") is None
    assert readings.text("http://a/used.png", b"used") == "常用"
