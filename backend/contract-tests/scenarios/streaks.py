"""Streaks (POST /api/get-streak) and badges (GET /api/badges, POST /api/badges/user).

The midnight cron job that opens each day's streak row is simulated by inserting rows directly.
"""

from __future__ import annotations

from harness.runner import Ctx, scenario


@scenario("streaks", "streaks", requires=("db",))
def streaks(t: Ctx) -> None:
    """First streak, validation, privacy, future-dated activities."""
    alice, bob, carol = t.users("alice", "bob", "carol")
    today = t.day(0)
    t.post(alice, "/api/get-streak", "invalid JSON", raw="{", content_type="application/json")
    t.post(alice, "/api/get-streak", "missing date", json={"username": "alice"})
    t.post(alice, "/api/get-streak", "bad date", json={"username": "alice", "date": "01/02/2026"})
    t.post(alice, "/api/get-streak", "unknown user", json={"username": "ghost", "date": today})
    t.post(alice, "/api/get-streak", "no streak yet", json={"username": "alice", "date": today})
    t.get(alice, "/api/badges", "no badges yet")

    t.activity(alice, "study", 1, today)
    t.post(alice, "/api/get-streak", "first streak awards the first badge", json={"username": "alice", "date": today})
    t.post(alice, "/api/get-streak", "asking again: no new badges", json={"username": "alice", "date": today})
    t.activity(alice, "sleep", 7, today, name="second activity on the same day")
    t.post(alice, "/api/get-streak", "streak unchanged by a second activity", json={"username": "alice", "date": today})
    t.post(bob, "/api/get-streak", "another user's streak (no badge check)", json={"username": "alice", "date": today})
    t.post(alice, "/api/get-streak", "a past date without streak", json={"username": "alice", "date": t.day(-3)})
    t.activity(alice, "study", 2, t.day(-4), name="past activity does not touch streaks")
    t.post(alice, "/api/get-streak", "still no streak for the past date", json={"username": "alice", "date": t.day(-4)})
    t.activity(alice, "study", 2, t.day(2), name="future activity creates a streak row")
    t.post(alice, "/api/get-streak", "future streak row", json={"username": "alice", "date": t.day(2)})
    t.get(bob, f"/api/users/{alice.id}/profile", "last_logged_at is the latest active streak date")

    t.set_private(carol)
    t.activity(carol, "workout", 1, today)
    t.post(bob, "/api/get-streak", "private account, not following", json={"username": "carol", "date": today})
    t.post(carol, "/api/get-streak", "private account, owner", json={"username": "carol", "date": today})
    t.get(bob, "/api/badges", "badges of a user without streaks")
    t.post(bob, "/api/badges/user", "badges of alice", json={"username": "alice"})
    t.post(bob, "/api/badges/user", "badges of private carol (not following)", json={"username": "carol"})
    t.post(bob, "/api/badges/user", "badges: unknown user", json={"username": "ghost"})
    t.post(bob, "/api/badges/user", "badges: missing username", json={})
    t.post(bob, "/api/badges/user", "badges: invalid JSON", raw="[", content_type="application/json")


@scenario("streak_badges", "streaks", requires=("db",))
def streak_badges(t: Ctx) -> None:
    """A 7-day streak (seeded history + cron row for today) awards spark_starter; next badge progress."""
    alice, = t.users("alice")
    for offset in range(-6, 0):
        t.sql("INSERT INTO streaks (user_id, current, longest, activity_date) VALUES (%s, %s, %s, %s)",
              (alice.id, offset + 7, offset + 7, t.day(offset)))
    t.sql("INSERT INTO streaks (user_id, current, longest, activity_date) VALUES (%s, 0, 6, %s)", (alice.id, t.day(0)))
    t.post(alice, "/api/get-streak", "yesterday's 6-day streak (own: awards first_step from longest)", json={"username": "alice", "date": t.day(-1)})
    t.post(alice, "/api/get-streak", "cron-opened row for today", json={"username": "alice", "date": t.day(0)})
    t.get(alice, "/api/badges", "badges before the streak continues")
    t.activity(alice, "study", 3, t.day(0), name="activity continues the streak")
    t.post(alice, "/api/get-streak", "7-day streak awards first_step and spark_starter",
           json={"username": "alice", "date": t.day(0)})
    t.get(alice, "/api/badges", "badges with next badge progress")
    t.get(alice, f"/api/users/{alice.id}/profile", "own public profile with last_logged_at")

    # A longer seeded history: longest 32 -> four badges at once, next is diamond_mind
    bob, = t.users("bob")
    t.sql("INSERT INTO streaks (user_id, current, longest, activity_date) VALUES (%s, 32, 32, %s)", (bob.id, t.day(-1)))
    t.sql("INSERT INTO streaks (user_id, current, longest, activity_date) VALUES (%s, 0, 32, %s)", (bob.id, t.day(0)))
    t.activity(bob, "office", 8, t.day(0))
    t.post(bob, "/api/get-streak", "33-day streak awards four badges", json={"username": "bob", "date": t.day(0)})
    t.post(alice, "/api/badges/user", "alice views bob's badges", json={"username": "bob"})
