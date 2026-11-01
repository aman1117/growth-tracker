"""Normalization applied identically to golden and live exchanges before comparing.

Only genuinely volatile values are replaced; everything else (key presence, null vs [] vs
missing, number literals, array order, status codes, messages, error codes) stays exact.

* JWTs                       -> "<JWT>"
* RFC3339 timestamps         -> "<TIME {zone}[ skew=+HH:MM]>"  (zone designator kept: "Z" or
                                "+05:30"; skew = offset from the wall clock at the time of the
                                response, rounded to 30 min, only shown when non-zero - catches
                                e.g. local times mislabelled as UTC, or a wrong token TTL)
                                Timestamps whose fractional part has trailing zeros (or a bare
                                ".") are reported as shape issues: Go trims them.
* midnight timestamps        -> date part made relative, e.g. "<TODAY-2>T00:00:00Z" (DATE columns)
* ISO dates inside strings   -> "<TODAY>", "<TODAY+3>", "<WEEK-7>" (relative to the scenario's
                                date anchor, so goldens stay valid on other days)
* "2 Jan, 2006" dates        -> "<TODAY-1:human>"
* random UUIDs               -> "<UUID#n>"  (harness-generated UUIDs are kept verbatim)
* invite codes               -> "<CODE#n>" ("<CODE#n:lower>" for the lower-case spelling)
* follow-list cursors        -> "<CURSOR#n>" (string `next_cursor` values)
* 64-hex tokens              -> "<TOKEN#n>" (password-reset / verification tokens)

Numbered placeholders are assigned in order of first appearance within a scenario, so a value
that is reused later (e.g. an invite code in a URL) maps to the same placeholder.
"""

from __future__ import annotations

import datetime as dt
import re
from typing import Any

from .jsonx import JNum

JWT_FULL_RE = re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
JWT_RE = re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*")
TS_RE = re.compile(r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(\.\d*)?(Z|[+-]\d\d:\d\d)")
UUID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
HARNESS_UUID_RE = re.compile(r"[0-9a-f]{8}-0000-4000-8000-[0-9a-f]{12}")
HEX64_RE = re.compile(r"(?<![0-9a-fA-F])[0-9a-f]{64}(?![0-9a-fA-F])")
ISO_DATE_RE = re.compile(r"(?<![\d])(\d{4})-(\d{2})-(\d{2})(?![\d])")
HUMAN_DATE_RE = re.compile(r"\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec), (\d{4})\b")
INVITE_CODE_RE = re.compile(r"[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}")

_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
_MAX_RELATIVE_DAYS = 400  # scenario dates stay within this window; fixed dates farther away are kept verbatim
_CODE_KEYS = {"invite_code"}
_CURSOR_KEYS = {"next_cursor"}


def harness_uuid(n: int) -> str:
    """Deterministic UUID-shaped id for scenario data (kept verbatim by the normalizer)."""
    return f"c0de{n:04x}-0000-4000-8000-{n:012x}"


class Normalizer:
    def __init__(self, anchors: dict[str, dt.date], primary: str):
        self.anchors = anchors
        self.primary = primary
        self.registry: dict[str, str] = {}
        self.counters: dict[str, int] = {}
        self.issues: list[str] = []

    # ---------------------------------------------------------------- placeholders
    def _placeholder(self, kind: str, raw: str) -> str:
        if raw in self.registry:
            return self.registry[raw]
        n = self.counters.get(kind, 0) + 1
        self.counters[kind] = n
        ph = f"<{kind}#{n}>"
        self.registry[raw] = ph
        return ph

    def register_code(self, code: str) -> str:
        ph = self._placeholder("CODE", code)
        self.registry.setdefault(code.lower(), ph[:-1] + ":lower>")
        return ph

    # ---------------------------------------------------------------- dates
    def rel_date(self, day: dt.date) -> str | None:
        anchor = self.anchors[self.primary]
        n = (day - anchor).days
        if abs(n) > _MAX_RELATIVE_DAYS:
            return None
        return f"<{self.primary}>" if n == 0 else f"<{self.primary}{n:+d}>"

    def _iso_sub(self, m: re.Match) -> str:
        try:
            day = dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return m.group(0)
        return self.rel_date(day) or m.group(0)

    def _human_sub(self, m: re.Match) -> str:
        try:
            day = dt.date(int(m.group(3)), _MONTHS.index(m.group(2)) + 1, int(m.group(1)))
        except ValueError:
            return m.group(0)
        rel = self.rel_date(day)
        return f"{rel[:-1]}:human>" if rel else m.group(0)

    # ---------------------------------------------------------------- timestamps
    def _timestamp(self, s: str, m: re.Match, now: dt.datetime, path: str) -> str:
        y, mo, d, hh, mi, ss, frac, zone = m.groups()
        if frac is not None and (frac == "." or frac.endswith("0")):
            self.issues.append(
                f"{path}: timestamp {s!r} has a non-canonical fractional part "
                "(Go's RFC3339Nano output never has trailing zeros or a bare '.')"
            )
        if hh == "00" and mi == "00" and ss == "00" and frac is None:
            rel = self.rel_date(dt.date(int(y), int(mo), int(d)))
            return f"{rel}T00:00:00{zone}" if rel else s
        if zone == "Z":
            tz = dt.timezone.utc
        else:
            sign = 1 if zone[0] == "+" else -1
            tz = dt.timezone(sign * dt.timedelta(hours=int(zone[1:3]), minutes=int(zone[4:6])))
        micros = int(((frac or ".")[1:] + "000000")[:6])
        try:
            instant = dt.datetime(int(y), int(mo), int(d), int(hh), int(mi), int(ss), micros, tzinfo=tz)
        except ValueError:
            return f"<TIME {zone} invalid>"
        skew_min = (instant - now).total_seconds() / 60.0
        if abs(skew_min) > 400 * 24 * 60:
            return f"<TIME {zone} skew={'far-future' if skew_min > 0 else 'far-past'}>"
        bucket = int(round(skew_min / 30.0)) * 30
        if bucket == 0:
            return f"<TIME {zone}>"
        sign = "+" if bucket > 0 else "-"
        return f"<TIME {zone} skew={sign}{abs(bucket) // 60:02d}:{abs(bucket) % 60:02d}>"

    # ---------------------------------------------------------------- strings
    def _substrings(self, s: str) -> str:
        out = JWT_RE.sub("<JWT>", s)
        for raw, ph in sorted(self.registry.items(), key=lambda kv: -len(kv[0])):
            if len(raw) >= 8 and raw in out:
                out = out.replace(raw, ph)
        out = UUID_RE.sub(
            lambda m: m.group(0) if HARNESS_UUID_RE.fullmatch(m.group(0)) else self._placeholder("UUID", m.group(0)),
            out,
        )
        out = HEX64_RE.sub(lambda m: self._placeholder("TOKEN", m.group(0)), out)
        out = ISO_DATE_RE.sub(self._iso_sub, out)
        out = HUMAN_DATE_RE.sub(self._human_sub, out)
        return out

    def string(self, s: str, now: dt.datetime, key: str | None = None, path: str = "$") -> str:
        if key in _CODE_KEYS and INVITE_CODE_RE.fullmatch(s):
            return self.register_code(s)
        if key in _CURSOR_KEYS and s:
            return self._placeholder("CURSOR", s)
        if JWT_FULL_RE.fullmatch(s):
            return "<JWT>"
        m = TS_RE.fullmatch(s)
        if m:
            return self._timestamp(s, m, now, path)
        if s in self.registry:
            return self.registry[s]
        return self._substrings(s)

    # ---------------------------------------------------------------- trees
    def value(self, v: Any, now: dt.datetime, key: str | None = None, path: str = "$") -> Any:
        if isinstance(v, dict):
            out: dict[str, Any] = {}
            for k in sorted(v):
                nk = ISO_DATE_RE.sub(self._iso_sub, k) if isinstance(k, str) else k  # e.g. daily-totals maps
                out[nk] = self.value(v[k], now, key=k, path=f"{path}.{k}")
            return out
        if isinstance(v, list):
            return [self.value(item, now, key=key, path=f"{path}[{i}]") for i, item in enumerate(v)]
        if isinstance(v, str):
            return self.string(v, now, key=key, path=path)
        if isinstance(v, (JNum, bool)) or v is None:
            return v
        if isinstance(v, (int, float)):
            return JNum(str(v))
        return v

    def take_issues(self) -> list[str]:
        issues, self.issues = self.issues, []
        return issues
