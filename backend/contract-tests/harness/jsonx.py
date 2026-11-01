"""JSON helpers that keep number literals exactly as the server wrote them.

`2.5` vs `2.50` or `1` vs `1.0` are real format differences for the frontend, so numbers are
parsed into `JNum` objects holding the raw literal and compared by text, never by value.
"""

from __future__ import annotations

import json
import re
from typing import Any

_INT_RE = re.compile(r"-?\d+")


class JNum:
    """A JSON number kept as its raw literal text."""

    __slots__ = ("raw",)

    def __init__(self, raw: str):
        self.raw = raw

    def __eq__(self, other: object) -> bool:
        return isinstance(other, JNum) and other.raw == self.raw

    def __hash__(self) -> int:
        return hash(("JNum", self.raw))

    def __repr__(self) -> str:
        return self.raw

    __str__ = __repr__

    def plain(self) -> int | float:
        return int(self.raw) if _INT_RE.fullmatch(self.raw) else float(self.raw)

    def __int__(self) -> int:
        return int(self.plain())

    def __float__(self) -> float:
        return float(self.plain())


def loads(text: str | bytes) -> Any:
    """Parse JSON keeping every number as a JNum."""
    if isinstance(text, bytes):
        text = text.decode("utf-8")
    return json.loads(text, parse_int=JNum, parse_float=JNum, parse_constant=JNum)


def to_plain(value: Any) -> Any:
    """Convert a JNum tree into ordinary Python values (for scenario logic)."""
    if isinstance(value, JNum):
        return value.plain()
    if isinstance(value, dict):
        return {k: to_plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [to_plain(v) for v in value]
    return value


def _scalar(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, JNum):
        return value.raw
    if isinstance(value, (int, float)):
        return json.dumps(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    raise TypeError(f"not JSON serializable: {type(value).__name__}")


def dumps(value: Any, indent: int = 2) -> str:
    """Pretty-print with sorted keys, writing JNum literals verbatim."""
    out: list[str] = []

    def emit(v: Any, level: int) -> None:
        pad = " " * (indent * (level + 1))
        end_pad = " " * (indent * level)
        if isinstance(v, dict):
            if not v:
                out.append("{}")
                return
            out.append("{\n")
            items = sorted(v.items(), key=lambda kv: str(kv[0]))
            for i, (k, item) in enumerate(items):
                out.append(f"{pad}{json.dumps(str(k), ensure_ascii=False)}: ")
                emit(item, level + 1)
                out.append(",\n" if i < len(items) - 1 else "\n")
            out.append(f"{end_pad}}}")
        elif isinstance(v, (list, tuple)):
            if not v:
                out.append("[]")
                return
            out.append("[\n")
            for i, item in enumerate(v):
                out.append(pad)
                emit(item, level + 1)
                out.append(",\n" if i < len(v) - 1 else "\n")
            out.append(f"{end_pad}]")
        else:
            out.append(_scalar(v))

    emit(value, 0)
    return "".join(out) + "\n"


def compact(value: Any, limit: int = 300) -> str:
    """Single-line rendering used in diff output (truncated to `limit` characters)."""

    def render(v: Any) -> str:
        if isinstance(v, dict):
            inner = ", ".join(f"{json.dumps(str(k), ensure_ascii=False)}: {render(x)}" for k, x in sorted(v.items()))
            return "{" + inner + "}"
        if isinstance(v, (list, tuple)):
            return "[" + ", ".join(render(x) for x in v) + "]"
        return _scalar(v)

    text = render(value)
    return text if len(text) <= limit else text[: limit - 3] + "..."


def request_body_bytes(value: Any) -> bytes:
    """Serialize a request body compactly (key order kept, JNum literals written verbatim)."""

    def render(v: Any) -> str:
        if isinstance(v, dict):
            return "{" + ",".join(f"{json.dumps(str(k), ensure_ascii=False)}:{render(x)}" for k, x in v.items()) + "}"
        if isinstance(v, (list, tuple)):
            return "[" + ",".join(render(x) for x in v) + "]"
        return _scalar(v)

    return render(value).encode("utf-8")
