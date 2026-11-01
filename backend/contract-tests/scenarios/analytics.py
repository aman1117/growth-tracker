"""Week analytics (POST /api/get-week-analytics).

Dates are relative to WEEK (Monday of the current IST week). Past activities are logged on
WEEK-14 .. WEEK-2 only (never IST-yesterday, see activities.py), the current week only on
WEEK+6 (always today or later). Hours are distinct per day and per activity because the server
sorts with an unstable sort over a Go map.
"""

from __future__ import annotations

from harness.runner import Ctx, scenario


@scenario("week_analytics", "analytics", anchor="WEEK", requires=("db",))
def week_analytics(t: Ctx) -> None:
    """Current, previous and arbitrary weeks: totals, float32 percentages, daily breakdown, summary, streak, privacy."""
    alice, bob = t.users("alice", "bob")
    w = t.wday
    # previous-previous week (W-14 .. W-8) and previous week (W-7 .. W-2)
    for offset, act, hours in [
        (-14, "study", 2), (-13, "study", 3.5), (-13, "sleep", 7), (-10, "workout", 1),
        (-7, "study", 4), (-7, "sleep", 8), (-7, "reels", 0.5), (-6, "office", 9.25), (-6, "eating", 1.75),
        (-5, "sleep", 6.5), (-4, "friends", 2.25), (-3, "creative", 1.1), (-2, "study", 0.333), (-2, "rest", 0),
    ]:
        t.activity(alice, act, hours, w(offset))
    t.activity(alice, "sleep", 7.5, w(6), name="activity on the last day of the current week")

    def analytics(actor, name, week_start, username="alice"):
        return t.post(actor, "/api/get-week-analytics", name, json={"username": username, "week_start": week_start})

    t.post(alice, "/api/get-week-analytics", "invalid JSON", raw="{", content_type="application/json")
    analytics(alice, "missing week_start", "")
    analytics(alice, "bad week_start", "2026/01/05")
    analytics(alice, "unknown user", w(0), username="ghost")
    analytics(alice, "previous week vs the week before and the current week", w(-7))
    analytics(alice, "two weeks ago (no earlier data: +100%)", w(-14))
    analytics(alice, "current week", w(0))
    analytics(alice, "a week without any data", w(-35))
    analytics(alice, "window starting on a Wednesday", w(-12))
    analytics(bob, "another user views alice's analytics", w(-7))
    analytics(bob, "bob's own empty analytics", w(-7), username="bob")
    t.set_private(alice)
    analytics(bob, "private account, not following", w(-7))
    analytics(alice, "private account, owner", w(-7))
