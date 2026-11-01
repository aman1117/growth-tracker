"""Day likes: POST /api/like-day, /api/unlike-day, /api/get-likes (+ like notifications)."""

from __future__ import annotations

from harness.runner import Ctx, scenario


@scenario("day_likes", "likes", requires=("db",))
def day_likes(t: Ctx) -> None:
    """Like/unlike/get-likes: validation, idempotency, own day, private accounts, notification dedupe."""
    alice, bob, carol, dave = t.users("alice", "bob", "carol", "dave")
    today, past = t.day(0), t.day(-3)
    t.activity(alice, "study", 2, today)

    def like(actor, name, body, path="/api/like-day"):
        return t.post(actor, path, name, json=body)

    t.post(bob, "/api/like-day", "like: invalid JSON", raw="{", content_type="application/json")
    like(bob, "like: missing date", {"username": "alice"})
    like(bob, "like: missing username", {"date": today})
    like(bob, "like: bad date", {"username": "alice", "date": "yesterday"})
    like(bob, "like: unknown user", {"username": "ghost", "date": today})
    like(bob, "bob likes alice's day", {"username": "alice", "date": today})
    like(bob, "bob likes it again (idempotent, no error)", {"username": "alice", "date": today})
    like(carol, "carol likes alice's day", {"username": "alice", "date": today})
    t.settle(0.05)  # liked_at ordering
    like(dave, "dave likes alice's day", {"username": "alice", "date": today})
    like(alice, "alice likes her own day", {"username": "alice", "date": today})
    like(bob, "a day without activities can be liked", {"username": "alice", "date": past})
    like(bob, "a future day can be liked", {"username": "alice", "date": t.day(5)})
    t.get(alice, "/api/notifications", "alice's like notifications (deduped, not for her own like)")

    t.post(alice, "/api/get-likes", "get-likes: invalid JSON", raw="{", content_type="application/json")
    like(alice, "get-likes: missing date", {"username": "alice"}, "/api/get-likes")
    like(alice, "get-likes: bad date", {"username": "alice", "date": "2026-13-01"}, "/api/get-likes")
    like(alice, "get-likes: unknown user", {"username": "ghost", "date": today}, "/api/get-likes")
    like(alice, "get-likes: today (newest first)", {"username": "alice", "date": today}, "/api/get-likes")
    like(bob, "get-likes as bob", {"username": "alice", "date": today}, "/api/get-likes")
    like(bob, "get-likes: past day", {"username": "alice", "date": past}, "/api/get-likes")
    like(bob, "get-likes: day without likes", {"username": "alice", "date": t.day(-20)}, "/api/get-likes")

    t.post(bob, "/api/unlike-day", "unlike: invalid JSON", raw="{", content_type="application/json")
    like(bob, "unlike: missing username", {"date": today}, "/api/unlike-day")
    like(bob, "unlike: bad date", {"username": "alice", "date": "x"}, "/api/unlike-day")
    like(bob, "unlike: unknown user", {"username": "ghost", "date": today}, "/api/unlike-day")
    like(bob, "bob unlikes", {"username": "alice", "date": today}, "/api/unlike-day")
    like(bob, "bob unlikes again", {"username": "alice", "date": today}, "/api/unlike-day")
    like(alice, "get-likes after unlike", {"username": "alice", "date": today}, "/api/get-likes")
    like(bob, "bob likes again (notification dedupe)", {"username": "alice", "date": today})
    t.get(alice, "/api/notifications/unread-count", "no second notification for the same like")

    t.set_private(carol)
    t.activity(carol, "sleep", 8, today)
    like(bob, "like a private account's day (not following)", {"username": "carol", "date": today})
    like(bob, "get-likes of a private account (not following)", {"username": "carol", "date": today}, "/api/get-likes")
    like(bob, "unlike on a private account (not following)", {"username": "carol", "date": today}, "/api/unlike-day")
    t.follow(bob, carol, "bob requests to follow carol")
    like(bob, "like while the request is pending", {"username": "carol", "date": today})
    t.accept(carol, bob)
    like(bob, "like a private account's day (following)", {"username": "carol", "date": today})
    like(bob, "get-likes of a private account (following)", {"username": "carol", "date": today}, "/api/get-likes")
    like(carol, "owner sees likes on her private day", {"username": "carol", "date": today}, "/api/get-likes")
