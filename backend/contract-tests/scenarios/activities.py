"""Activities: create/update (incl. custom tiles and notes), get-activities, daily totals, privacy.

Activities are only ever created for today or other dates that are not "IST yesterday": the
streak update compares the activity date with the *UTC* date, so whether a streak row is
created for IST-yesterday depends on the time of day (00:00-05:30 IST vs later).
"""

from __future__ import annotations

from harness.runner import Ctx, scenario

CUSTOM_A = "custom:" + Ctx.uuid(1)
CUSTOM_B = "custom:" + Ctx.uuid(2)


@scenario("activity_create", "activities")
def activity_create(t: Ctx) -> None:
    """POST /api/create-activity: validation, notes, custom tiles, updates, the 24h limit."""
    alice, bob = t.users("alice", "bob")
    today = t.day(0)

    def create(name: str, body: object, **kw: object):
        return t.post(alice, "/api/create-activity", name, json=body, **kw)

    t.post(alice, "/api/create-activity", "invalid JSON", raw="{", content_type="application/json")
    create("hours as a string", {"username": "alice", "activity": "study", "hours": "2", "date": today})
    create("missing username", {"activity": "study", "hours": 1, "date": today})
    create("missing activity", {"username": "alice", "hours": 1, "date": today})
    create("negative hours", {"username": "alice", "activity": "study", "hours": -1, "date": today})
    create("someone else's username", {"username": "bob", "activity": "study", "hours": 1, "date": today})
    create("unknown activity name", {"username": "alice", "activity": "coding", "hours": 1, "date": today})
    create("activity name is case-sensitive", {"username": "alice", "activity": "Study", "hours": 1, "date": today})
    create("custom tile with a malformed id", {"username": "alice", "activity": "custom:1234", "hours": 1, "date": today})
    create("custom tile with non-hex id",
           {"username": "alice", "activity": "custom:zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz", "hours": 1, "date": today})
    create("custom prefix only", {"username": "alice", "activity": "custom:", "hours": 1, "date": today})
    create("note longer than 500 characters", {"username": "alice", "activity": "study", "hours": 1, "date": today,
                                                "note": "n" * 501})
    create("missing date", {"username": "alice", "activity": "study", "hours": 1})
    create("date not zero-padded", {"username": "alice", "activity": "study", "hours": 1, "date": today.replace("-0", "-")})
    create("date with a time", {"username": "alice", "activity": "study", "hours": 1, "date": "2020-01-04T10:00:00Z"})
    create("impossible date", {"username": "alice", "activity": "study", "hours": 1, "date": "2026-02-30"})

    create("study 2.5h with a note", {"username": "alice", "activity": "study", "hours": 2.5, "date": today,
                                      "note": "  Read chapter 3 \U0001F4D6  "})
    create("sleep 7.75h", {"username": "alice", "activity": "sleep", "hours": 7.75, "date": today})
    create("workout 1.333h (float32 precision)", {"username": "alice", "activity": "workout", "hours": 1.333, "date": today})
    create("custom tile activity", {"username": "alice", "activity": CUSTOM_A, "hours": 0.5, "date": today,
                                    "note": "guitar"})
    create("upper-case custom tile id is a different activity", {"username": "alice", "activity": CUSTOM_B.upper().replace("CUSTOM:", "custom:"),
                                                                 "hours": 0.25, "date": today})
    create("zero hours", {"username": "alice", "activity": "reels", "hours": 0, "date": today})
    create("note of exactly 500 multi-byte characters", {"username": "alice", "activity": "family", "hours": 1,
                                                         "date": today, "note": "\u00e9" * 500})
    create("whitespace-only note", {"username": "alice", "activity": "rest", "hours": 0.5, "date": today, "note": "   "})
    t.post(alice, "/api/get-activities", "activities of today (own: notes included)",
           json={"username": "alice", "start_date": today, "end_date": today})

    create("update study without a note clears the note", {"username": "alice", "activity": "study", "hours": 3, "date": today})
    create("update custom tile with a new note", {"username": "alice", "activity": CUSTOM_A, "hours": 1, "date": today,
                                                      "note": "piano"})
    t.post(alice, "/api/get-activities", "after updates", json={"username": "alice", "start_date": today, "end_date": today})
    t.post(alice, "/api/get-daily-totals", "daily totals after updates",
           json={"username": "alice", "start_date": today, "end_date": today})

    create("exceeding 24h in total", {"username": "alice", "activity": "office", "hours": 10, "date": today})
    create("a single entry above 24h", {"username": "alice", "activity": "idle", "hours": 24.5, "date": t.day(3)})
    create("future date: exactly 24h", {"username": "alice", "activity": "sleep", "hours": 24, "date": t.day(3)})
    create("future date: replacing 24h by 23h", {"username": "alice", "activity": "sleep", "hours": 23, "date": t.day(3)})
    create("past date", {"username": "alice", "activity": "errand", "hours": 1.5, "date": t.day(-5)})
    create("leap day", {"username": "alice", "activity": "errand", "hours": 2, "date": "2024-02-29"})
    t.post(alice, "/api/get-activities", "range across past, today and future",
           json={"username": "alice", "start_date": t.day(-7), "end_date": t.day(7)})
    t.post(bob, "/api/get-activities", "another user sees no notes",
           json={"username": "alice", "start_date": t.day(-7), "end_date": t.day(7)})


@scenario("activity_read", "activities")
def activity_read(t: Ctx) -> None:
    """POST /api/get-activities and /api/get-daily-totals: validation, ranges, privacy."""
    alice, bob, carol = t.users("alice", "bob", "carol")
    for offset, act, hours in [(0, "study", 3), (0, "sleep", 8.5), (-2, "study", 1), (-3, "workout", 0.75),
                               (-3, "eating", 1.25), (-10, "friends", 4), (-40, "office", 9), (-95, "travelling", 2)]:
        t.activity(alice, act, hours, t.day(offset), note=f"note {act}" if act == "study" else None)

    for path in ("/api/get-activities", "/api/get-daily-totals"):
        short = path.rsplit("-", 1)[-1]
        t.post(bob, path, f"{short}: invalid JSON", raw="{", content_type="application/json")
        t.post(bob, path, f"{short}: missing start_date", json={"username": "alice", "end_date": t.day(0)})
        t.post(bob, path, f"{short}: bad end_date", json={"username": "alice", "start_date": t.day(0), "end_date": "tomorrow"})
        t.post(bob, path, f"{short}: start after end", json={"username": "alice", "start_date": t.day(0), "end_date": t.day(-1)})
        t.post(bob, path, f"{short}: unknown user", json={"username": "ghost", "start_date": t.day(-1), "end_date": t.day(0)})
        t.post(bob, path, f"{short}: missing username", json={"start_date": t.day(-1), "end_date": t.day(0)})
        t.post(bob, path, f"{short}: single day", json={"username": "alice", "start_date": t.day(0), "end_date": t.day(0)})
        t.post(bob, path, f"{short}: last 14 days", json={"username": "alice", "start_date": t.day(-13), "end_date": t.day(0)})
        t.post(bob, path, f"{short}: empty range", json={"username": "alice", "start_date": t.day(-30), "end_date": t.day(-20)})
        t.post(bob, path, f"{short}: 93 days", json={"username": "alice", "start_date": t.day(-93), "end_date": t.day(0)})
        t.post(bob, path, f"{short}: 94 days", json={"username": "alice", "start_date": t.day(-94), "end_date": t.day(0)})
        t.post(bob, path, f"{short}: user without activities", json={"username": "carol", "start_date": t.day(-1), "end_date": t.day(0)})

    t.set_private(alice)
    t.post(bob, "/api/get-activities", "private account, not following", json={"username": "alice", "start_date": t.day(-3), "end_date": t.day(0)})
    t.post(bob, "/api/get-daily-totals", "private totals, not following", json={"username": "alice", "start_date": t.day(-3), "end_date": t.day(0)})
    t.follow(bob, alice, "bob requests to follow alice")
    t.post(bob, "/api/get-activities", "private account, request pending", json={"username": "alice", "start_date": t.day(-3), "end_date": t.day(0)})
    t.accept(alice, bob)
    t.post(bob, "/api/get-activities", "private account, following", json={"username": "alice", "start_date": t.day(-3), "end_date": t.day(0)})
    t.post(bob, "/api/get-daily-totals", "private totals, following", json={"username": "alice", "start_date": t.day(-3), "end_date": t.day(0)})
    t.post(alice, "/api/get-activities", "owner sees own private activities with notes", json={"username": "alice", "start_date": t.day(-3), "end_date": t.day(0)})
    t.post(carol, "/api/get-daily-totals", "carol (not following) still blocked", json={"username": "alice", "start_date": t.day(-3), "end_date": t.day(0)})


@scenario("activity_day_completed", "activities", requires=("db",))
def activity_day_completed(t: Ctx) -> None:
    """Crossing 24 logged hours notifies followers (in a goroutine), only once per crossing."""
    alice, bob, carol = t.users("alice", "bob", "carol")
    t.follow(bob, alice)
    t.follow(carol, alice)
    t.wait_notifications(alice, 2)
    t.activity(alice, "sleep", 8, t.day(0))
    t.activity(alice, "office", 16, t.day(0), name="alice reaches exactly 24h")
    t.wait_notifications(bob, 1)
    t.wait_notifications(carol, 1)
    t.get(bob, "/api/notifications", "bob is notified that alice completed her day")
    t.activity(alice, "office", 15, t.day(0), name="alice drops below 24h")
    t.activity(alice, "office", 16, t.day(0), name="alice reaches 24h again")
    t.settle(0.5)
    t.get(bob, "/api/notifications/unread-count", "a second crossing on the same day")
    t.get(carol, "/api/notifications", "carol's notifications")
