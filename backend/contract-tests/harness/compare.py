"""Structural comparison of normalized golden vs live steps, producing readable diffs."""

from __future__ import annotations

from typing import Any

from .jsonx import JNum, compact

RETRY_AFTER_TOLERANCE_S = 3  # Retry-After (+ window age when known) may differ by Fiber's 1s clock tick and
# by request latency
MAX_LINES_PER_STEP = 30


def _kind(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, JNum):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, dict):
        return "object"
    if isinstance(v, list):
        return "array"
    return type(v).__name__


def diff_values(expected: Any, actual: Any, path: str, out: list[str]) -> None:
    ke, ka = _kind(expected), _kind(actual)
    if ke != ka:
        out.append(f"{path}: expected {ke} {compact(expected)}, got {ka} {compact(actual)}")
        return
    if ke == "object":
        for k in sorted(set(expected) | set(actual)):
            sub = f"{path}.{k}"
            if k not in actual:
                out.append(f"{sub}: missing in live response (golden: {compact(expected[k])})")
            elif k not in expected:
                out.append(f"{sub}: unexpected key in live response (value: {compact(actual[k])})")
            else:
                diff_values(expected[k], actual[k], sub, out)
        return
    if ke == "array":
        if len(expected) != len(actual):
            out.append(f"{path}: array length {len(actual)} != golden {len(expected)}")
        for i in range(min(len(expected), len(actual))):
            diff_values(expected[i], actual[i], f"{path}[{i}]", out)
        if len(actual) > len(expected):
            out.append(f"{path}: extra live items {compact(actual[len(expected):])}")
        elif len(expected) > len(actual):
            out.append(f"{path}: missing items {compact(expected[len(actual):])}")
        return
    if expected != actual:
        out.append(f"{path}: expected {compact(expected)}, got {compact(actual)}")


def _window_shift_explains(golden: dict[str, Any], live: dict[str, Any]) -> bool:
    """True when X-RateLimit-Remaining differs only because one run crossed a limiter window
    boundary that the other did not, and the live value is consistent with its own window."""
    g, l = golden.get("ratelimit"), live.get("ratelimit")
    if not g or not l or g.get("key") != l.get("key") or g.get("window") == l.get("window"):
        return False
    headers = live.get("response", {}).get("headers", {})
    limit, remaining = headers.get("x-ratelimit-limit", ""), headers.get("x-ratelimit-remaining", "")
    if not (limit.isdigit() and remaining.isdigit()):
        return False
    return int(remaining) == max(int(limit) - int(l.get("hits", 0)), 0)


def _diff_headers(expected: dict[str, str], actual: dict[str, str], out: list[str], ignore: set[str],
                  window_shift: bool = False, retry_age: tuple[Any, Any] | None = None) -> None:
    for k in sorted(set(expected) | set(actual)):
        if k in ignore:
            continue
        e, a = expected.get(k), actual.get(k)
        if e is None:
            out.append(f"header {k}: unexpected in live response ({a!r})")
        elif a is None:
            out.append(f"header {k}: missing in live response (golden {e!r})")
        elif k == "retry-after" and e.isdigit() and a.isdigit():
            if retry_age and retry_age[0] is not None and retry_age[1] is not None:
                # compare Retry-After + age of the limiter window (= the window length)
                ge, la = int(retry_age[0]), int(retry_age[1])
                if abs(ge - la) > RETRY_AFTER_TOLERANCE_S:
                    out.append(f"header {k}: {a} (+{la - int(a)}s window age = {la}) does not match the golden "
                               f"{e} (+{ge - int(e)}s = {ge})")
            elif abs(int(e) - int(a)) > RETRY_AFTER_TOLERANCE_S:
                out.append(f"header {k}: expected ~{e}, got {a}")
        elif k == "x-ratelimit-remaining" and e != a and window_shift:
            continue
        elif e != a:
            out.append(f"header {k}: expected {e!r}, got {a!r}")


def diff_step(golden: dict[str, Any], live: dict[str, Any], ignore_headers: set[str] | None = None) -> list[str]:
    out: list[str] = []
    gq, lq = golden.get("request", {}), live.get("request", {})
    if (gq.get("method"), gq.get("path")) != (lq.get("method"), lq.get("path")) or gq.get("body") != lq.get("body"):
        out.append(
            "request differs from the golden one (scenario code or date anchor changed? re-record): "
            f"golden {gq.get('method')} {gq.get('path')} {compact(gq.get('body'), 120)} | "
            f"live {lq.get('method')} {lq.get('path')} {compact(lq.get('body'), 120)}"
        )
    gr, lr = golden.get("response", {}), live.get("response", {})
    if gr.get("status") != lr.get("status"):
        out.append(f"status: expected {gr.get('status')}, got {lr.get('status')}")
    for key in ("ws_frame", "close_code"):
        if gr.get(key) != lr.get(key):
            out.append(f"{key}: expected {gr.get(key)!r}, got {lr.get(key)!r}")
    _diff_headers(gr.get("headers", {}), lr.get("headers", {}), out, ignore_headers or set(),
                  window_shift=_window_shift_explains(golden, live),
                  retry_age=((golden.get("ratelimit") or {}).get("retry_after_plus_age"),
                             (live.get("ratelimit") or {}).get("retry_after_plus_age")))
    if gr.get("body_type") != lr.get("body_type"):
        out.append(f"body type: expected {gr.get('body_type')}, got {lr.get('body_type')} "
                   f"(live body: {compact(lr.get('body'), 200)})")
    elif gr.get("body_type") != "ignored":
        diff_values(gr.get("body"), lr.get("body"), "$", out)
    for issue in live.get("issues", []):
        out.append(f"format: {issue}")
    if len(out) > MAX_LINES_PER_STEP:
        out = out[:MAX_LINES_PER_STEP] + [f"... {len(out) - MAX_LINES_PER_STEP} more difference(s)"]
    return out


def diff_scenario(golden_steps: list[dict[str, Any]], live_steps: list[dict[str, Any]],
                  ignore_headers: set[str] | None = None) -> list[tuple[dict[str, Any] | None, list[str]]]:
    """Returns (step, diff lines) for every mismatching step; step is None for count mismatches."""
    results: list[tuple[dict[str, Any] | None, list[str]]] = []
    for golden, live in zip(golden_steps, live_steps):
        lines = diff_step(golden, live, ignore_headers)
        if lines:
            results.append((live, lines))
    if len(live_steps) != len(golden_steps):
        extra = ""
        if len(live_steps) < len(golden_steps):
            nxt = golden_steps[len(live_steps)]
            extra = f"; first missing step: #{nxt['index']} {nxt['name']!r}"
        results.append((None, [f"step count: live run has {len(live_steps)} steps, golden has {len(golden_steps)}{extra}"]))
    return results
