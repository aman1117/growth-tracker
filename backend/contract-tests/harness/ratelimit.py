"""Rate-limit window tracking (mirrors the limiter wiring in backend/internal/routes/routes.go).

Fiber's limiter uses fixed windows that start with the first request of a key. On a slow
machine a scenario can outlive a window, after which `X-RateLimit-Remaining` restarts from
the limit - at a time-dependent step. To keep the comparison exact but not flaky, every
response that went through a limiter is annotated with
  {"key": "<limiter>:<who>", "window": <n-th window of that key>, "hits": <requests in it>}
(`who` = actor name for user-keyed limiters, `ip#<n>` for IP-keyed ones). The comparator only
accepts a different `X-RateLimit-Remaining` when the two runs are in a different window for
that key *and* the live value is exactly `limit - hits` for its own window.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# limiter -> (keyed by user when authenticated?, window seconds)
LIMITERS: dict[str, tuple[bool, int]] = {
    "auth": (False, 60),
    "password": (False, 900),
    "api": (True, 60),
    "autocomplete": (True, 60),
    "upload": (True, 60),
    "follow": (True, 60),
    "comment": (True, 60),
    "comment_like": (True, 60),
    "challenge": (True, 60),
}

_ROUTES: list[tuple[str, str, str]] = [
    ("POST", r"/api/(register|login|change-password|auth/resend-verification)", "auth"),
    ("POST", r"/api/auth/(forgot-password|reset-password)", "password"),
    ("GET", r"/api/auth/reset-password/validate", "password"),
    ("GET", r"/api/(autocomplete/users|search/suggestions)", "autocomplete"),
    ("POST", r"/api/profile/upload-picture", "upload"),
    ("POST", r"/api/activity-photo", "upload"),
    ("POST|DELETE", r"/api/users/[^/]+/follow", "follow"),
    ("POST", r"/api/days/[^/]+/[^/]+/comments(/[^/]+/replies)?", "comment"),
    ("PUT", r"/api/comments/[^/]+", "comment"),
    ("POST|DELETE", r"/api/comments/[^/]+/like", "comment_like"),
    ("POST", r"/api/challenges", "challenge"),
    ("DELETE", r"/api/challenges/[^/]+", "challenge"),
    ("POST", r"/api/challenges/[^/]+/(leave|cheers|invites)", "challenge"),
    ("POST", r"/api/challenge-codes/[^/]+/join", "challenge"),
]
_COMPILED = [(re.compile(f"(?:{m})"), re.compile(f"{p}/?"), name) for m, p, name in _ROUTES]


def limiter_for(method: str, path: str) -> str:
    """The limiter a request passes through (every other limited route uses the API limiter)."""
    bare = path.split("?", 1)[0]
    for m_re, p_re, name in _COMPILED:
        if m_re.fullmatch(method) and p_re.fullmatch(bare):
            return name
    return "api"


@dataclass
class _Window:
    number: int
    hits: int
    last_reset: int | None
    last_time: float
    started: float


class RateLimitTracker:
    """Follows the windows of every limiter key seen in one scenario run."""

    def __init__(self) -> None:
        self._windows: dict[str, _Window] = {}
        self._ips: dict[str, int] = {}

    def _who(self, limiter: str, user: str | None, ip: str) -> str:
        by_user, _ = LIMITERS[limiter]
        if by_user and user:
            return user
        if ip not in self._ips:
            self._ips[ip] = len(self._ips) + 1
        return f"ip#{self._ips[ip]}"

    def observe(self, method: str, path: str, status: int, headers: dict[str, str], user: str | None, ip: str,
                at: float) -> dict[str, object] | None:
        """Account one response; returns the annotation, or None when no limiter was involved."""
        has_limit = "x-ratelimit-limit" in headers
        if not has_limit and status != 429:
            return None
        limiter = limiter_for(method, path)
        key = f"{limiter}:{self._who(limiter, user, ip)}"
        raw_reset = headers.get("x-ratelimit-reset") or headers.get("retry-after")
        reset = int(raw_reset) if raw_reset and raw_reset.isdigit() else None
        window_s = LIMITERS[limiter][1]
        w = self._windows.get(key)
        if w is None:
            w = self._windows[key] = _Window(0, 0, reset, at, at)
        else:
            new_window = (reset is not None and w.last_reset is not None and reset > w.last_reset) or (
                at - w.last_time >= window_s - 1 and reset is not None and reset >= window_s - 1)
            if new_window:
                w.number += 1
                w.hits = 0
                w.started = at
        w.hits += 1
        w.last_reset = reset if reset is not None else w.last_reset
        w.last_time = at
        note: dict[str, object] = {"key": key, "window": w.number, "hits": w.hits}
        retry_after = headers.get("retry-after", "")
        if status == 429 and retry_after.isdigit():
            # Retry-After counts down from the window start: add the window's age so that the
            # value no longer depends on how long the scenario took to reach the limit
            note["retry_after_plus_age"] = int(retry_after) + int(round(at - w.started))
        return note
