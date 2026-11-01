"""Date helpers: everything is relative to "today" in Asia/Kolkata (IST, UTC+05:30, no DST)."""

from __future__ import annotations

import datetime as dt
import time

IST = dt.timezone(dt.timedelta(hours=5, minutes=30), "IST")


def now_ist() -> dt.datetime:
    return dt.datetime.now(IST)


def today_ist() -> dt.date:
    return now_ist().date()


def monday_of(day: dt.date) -> dt.date:
    return day - dt.timedelta(days=day.weekday())


def iso(day: dt.date) -> str:
    return day.isoformat()


# Server-side clock boundaries that change API output: IST midnight (date rollover, 00:00 streak
# cron, 00:05 challenge cron), 22:00 IST (streak reminder cron creates notifications) and UTC
# midnight (05:30 IST, the "today" used by the streak service and RFC3339 midnight timestamps).
_UNSAFE_WINDOWS_IST = [
    (dt.time(23, 58, 0), dt.time(23, 59, 59, 999999)),
    (dt.time(0, 0, 0), dt.time(0, 7, 0)),
    (dt.time(21, 58, 0), dt.time(22, 2, 0)),
    (dt.time(5, 28, 0), dt.time(5, 32, 0)),
]


def seconds_until_safe(now: dt.datetime | None = None, horizon_s: float = 0.0) -> float:
    """Seconds to wait so that [now, now + horizon] avoids every unsafe window (0 if already safe)."""
    now = now or now_ist()
    wait = 0.0
    for _ in range(8):
        start = now + dt.timedelta(seconds=wait)
        end = start + dt.timedelta(seconds=horizon_s)
        moved = False
        for lo, hi in _UNSAFE_WINDOWS_IST:
            for day in {start.date(), end.date()}:
                w_lo = dt.datetime.combine(day, lo, IST)
                w_hi = dt.datetime.combine(day, hi, IST)
                if start <= w_hi and end >= w_lo:
                    wait = (w_hi - now).total_seconds() + 1.0
                    moved = True
        if not moved:
            return max(wait, 0.0)
    return max(wait, 0.0)


def wait_for_safe_window(horizon_s: float, log=print) -> None:
    secs = seconds_until_safe(horizon_s=horizon_s)
    if secs > 0:
        log(f"  [clock] waiting {secs:.0f}s to stay clear of a server clock boundary (cron / date rollover)")
        time.sleep(secs)
