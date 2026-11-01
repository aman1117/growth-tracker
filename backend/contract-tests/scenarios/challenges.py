"""Challenges: create/list/get/delete/leave/cheer, invite candidates, invites, preview and join by code.

"today" is the IST date (as for the server). Ended challenges are simulated by moving a
challenge's dates into the past directly in the database.
"""

from __future__ import annotations

from harness.runner import Ctx, scenario


def _body(t: Ctx, **over: object) -> dict:
    body: dict = {"title": "Study 2h+ a day", "activity": "study", "goal_type": "at_least",
                  "target_hours": 2, "duration_days": 7, "start_date": t.day(0)}
    body.update(over)
    return {k: v for k, v in body.items() if v is not _DROP}


_DROP = object()


@scenario("challenge_create_validation", "challenges")
def challenge_create_validation(t: Ctx) -> None:
    """POST /api/challenges validation (spread over users: 30 writes/min per user)."""
    a, b = t.users("val_a", "val_b")
    t.post(a, "/api/challenges", "invalid JSON", raw="{", content_type="application/json")
    cases = [
        ("empty title", {"title": "   "}),
        ("61-character title", {"title": "t" * 61}),
        ("missing activity", {"activity": _DROP}),
        ("custom tile activity", {"activity": "custom:" + Ctx.uuid(1)}),
        ("unknown activity", {"activity": "coding"}),
        ("unknown goal type", {"goal_type": "exactly"}),
        ("missing target_hours", {"target_hours": _DROP}),
        ("target_hours not a multiple of 0.25", {"target_hours": 1.3}),
        ("at_least with 0 hours", {"target_hours": 0}),
        ("at_least with 24.25 hours", {"target_hours": 24.25}),
        ("at_most with 24 hours", {"goal_type": "at_most", "target_hours": 24}),
        ("negative target", {"goal_type": "at_most", "target_hours": -0.25}),
        ("missing duration", {"duration_days": _DROP}),
        ("duration 2 days", {"duration_days": 2}),
        ("duration 61 days", {"duration_days": 61}),
        ("missing start_date", {"start_date": _DROP}),
        ("start_date in the past", {"start_date": t.day(-2)}),
        ("start_date 31 days ahead", {"start_date": t.day(31)}),
        ("start_date with time", {"start_date": t.day(0) + "T00:00:00Z"}),
        ("duration as a string", {"duration_days": "7"}),
    ]
    for i, (label, over) in enumerate(cases):
        t.post(a if i % 2 else b, "/api/challenges", f"create: {label}", json=_body(t, **over))
    t.post(a, "/api/challenges", "title is trimmed, unicode counted in characters",
           json=_body(t, title="  " + "\u00e9" * 60 + "  ", activity="workout", goal_type="at_most",
                      target_hours=23.75, duration_days=60, start_date=t.day(30)))
    t.post(b, "/api/challenges", "minimal valid challenge (3 days, 0.25h, today)",
           json=_body(t, title="x", target_hours=0.25, duration_days=3))
    t.post(b, "/api/challenges", "at_most 0 hours (stay off reels)",
           json=_body(t, title="No reels", activity="reels", goal_type="at_most", target_hours=0, start_date=t.day(1)))
    t.get(b, "/api/challenges", "list of the creator")
    t.get(a, "/api/challenges", "list of the other creator")


@scenario("challenge_lifecycle", "challenges", requires=("db",))
def challenge_lifecycle(t: Ctx) -> None:
    """Create, preview/join by code, progress, cheers, invites, leave, delete, ended challenges."""
    alice, bob, carol, dave, erin = t.users("alice", "bob", "carol", "dave", "erin")
    t.get(alice, "/api/challenges", "no challenges yet")
    r = t.post(alice, "/api/challenges", "alice creates an active challenge (starts today)",
               json=_body(t, title="Daily study", target_hours=1.5, duration_days=5))
    cid = r.need("challenge.id")
    code = r.need("challenge.invite_code")
    r2 = t.post(alice, "/api/challenges", "alice creates an upcoming challenge",
                json=_body(t, title="Sleep well", activity="sleep", goal_type="at_least", target_hours=7.5,
                           duration_days=14, start_date=t.day(3)))
    up_id = r2.need("challenge.id")
    up_code = r2.need("challenge.invite_code")

    t.get(alice, f"/api/challenges/{cid}", "detail as the creator")
    t.get(bob, f"/api/challenges/{cid}", "detail as a non-participant (not found)")
    t.get(alice, "/api/challenges/abc", "detail: invalid id")
    t.get(alice, "/api/challenges/0", "detail: id 0")
    t.get(alice, "/api/challenges/999999", "detail: unknown id")

    t.get(bob, f"/api/challenge-codes/{code}", "preview by code")
    t.get(bob, f"/api/challenge-codes/{code.lower()}", "preview with a lower-case code")
    t.get(bob, f"/api/challenge-codes/%20{code}%20", "preview with surrounding spaces")
    t.get(bob, "/api/challenge-codes/ABC", "preview: code too short")
    t.get(bob, "/api/challenge-codes/ABCDEFG1", "preview: invalid character")
    t.get(bob, "/api/challenge-codes/ZZZZZZZZ", "preview: unknown code")
    t.post(bob, f"/api/challenge-codes/{code.lower()}/join", "bob joins by lower-case code")
    t.post(bob, f"/api/challenge-codes/{code}/join", "bob joins again (no-op)")
    t.post(bob, "/api/challenge-codes/ZZZZZZZZ/join", "join: unknown code")
    t.post(bob, "/api/challenge-codes/bad/join", "join: malformed code")
    t.get(carol, f"/api/challenge-codes/{code}", "preview by a third user (2 participants)")

    t.activity(alice, "study", 2, t.day(0), name="alice meets today's goal")
    t.activity(bob, "study", 1, t.day(0), name="bob logs less than the goal")
    t.get(alice, f"/api/challenges/{cid}", "detail with today's progress")
    t.get(bob, "/api/challenges", "bob's list")

    t.post(alice, f"/api/challenges/{cid}/cheers", "cheer: invalid JSON", raw="{", content_type="application/json")
    t.post(alice, f"/api/challenges/{cid}/cheers", "cheer: missing user_id", json={})
    t.post(alice, f"/api/challenges/{cid}/cheers", "cheer: yourself", json={"user_id": alice.id})
    t.post(alice, f"/api/challenges/{cid}/cheers", "cheer: not a participant", json={"user_id": carol.id})
    t.post(alice, f"/api/challenges/{cid}/cheers", "alice cheers bob", json={"user_id": bob.id})
    t.post(alice, f"/api/challenges/{cid}/cheers", "alice cheers bob again today", json={"user_id": bob.id})
    t.post(carol, f"/api/challenges/{cid}/cheers", "cheer by a non-participant", json={"user_id": bob.id})
    t.post(alice, "/api/challenges/abc/cheers", "cheer: invalid challenge id", json={"user_id": bob.id})
    t.get(bob, "/api/notifications", "bob's notifications (cheer)")
    t.get(alice, f"/api/challenges/{cid}", "detail shows cheered_today")

    # invites: candidates are users with an ACTIVE follow relationship (either direction)
    t.follow(carol, alice)
    t.follow(alice, dave)
    t.follow(alice, erin)
    t.get(alice, f"/api/challenges/{cid}/invite-candidates", "invite candidates")
    t.get(alice, f"/api/challenges/{cid}/invite-candidates?q=CA", "candidates filtered by prefix (case-insensitive)")
    t.get(alice, f"/api/challenges/{cid}/invite-candidates?limit=1", "candidates limit 1")
    t.get(alice, f"/api/challenges/{cid}/invite-candidates?limit=0", "candidates limit 0")
    t.get(alice, f"/api/challenges/{cid}/invite-candidates?limit=x", "candidates non-numeric limit")
    t.get(alice, f"/api/challenges/{cid}/invite-candidates?limit=500", "candidates limit above the maximum")
    t.get(carol, f"/api/challenges/{cid}/invite-candidates", "candidates for a non-participant")
    t.get(alice, "/api/challenges/abc/invite-candidates", "candidates: invalid id")

    inv = f"/api/challenges/{cid}/invites"
    t.post(alice, inv, "invite: invalid JSON", raw="{", content_type="application/json")
    t.post(alice, inv, "invite: empty list", json={"user_ids": []})
    t.post(alice, inv, "invite: 21 users", json={"user_ids": list(range(1, 22))})
    t.post(alice, inv, "invite carol, dave, self, bob (participant), unknown, duplicate",
           json={"user_ids": [carol.id, dave.id, alice.id, bob.id, 999999, carol.id]})
    t.post(bob, inv, "bob invites carol (already invited) and erin (no relationship with bob)",
           json={"user_ids": [carol.id, erin.id]})
    t.post(carol, inv, "invite by a non-participant", json={"user_ids": [erin.id]})
    t.get(alice, f"/api/challenges/{cid}/invite-candidates", "candidates after inviting (invited flag)")
    t.get(carol, "/api/notifications", "carol's invite notification")
    t.get(carol, "/api/challenges", "carol's list (pending invite)")
    t.post(carol, f"/api/challenge-codes/{code}/join", "carol joins with the code")
    t.get(alice, f"/api/challenges/{cid}", "detail with three participants")

    t.post(alice, f"/api/challenges/{cid}/leave", "creator cannot leave")
    t.post(dave, f"/api/challenges/{cid}/leave", "leave: not a participant")
    t.post(bob, "/api/challenges/abc/leave", "leave: invalid id")
    t.post(bob, f"/api/challenges/{cid}/leave", "bob leaves")
    t.post(bob, f"/api/challenges/{cid}/leave", "bob leaves again")
    t.get(bob, f"/api/challenges/{cid}", "bob can no longer see the challenge")

    t.delete(bob, f"/api/challenges/{up_id}", "delete: not a participant")
    t.post(bob, f"/api/challenge-codes/{up_code}/join", "bob joins the upcoming challenge")
    t.post(alice, f"/api/challenges/{up_id}/cheers", "cheer in an upcoming challenge", json={"user_id": bob.id})
    t.delete(bob, f"/api/challenges/{up_id}", "delete: participant but not the creator")
    t.delete(alice, f"/api/challenges/{cid}", "delete an active challenge with other participants")
    t.delete(alice, "/api/challenges/abc", "delete: invalid id")
    t.delete(alice, f"/api/challenges/{up_id}", "creator deletes the upcoming challenge")
    t.delete(alice, f"/api/challenges/{up_id}", "delete it again")
    t.get(bob, f"/api/challenge-codes/{up_code}", "preview of a deleted challenge")
    t.get(bob, "/api/challenges", "bob's list after the deletion")

    # Simulate the passage of time: the active challenge ended 3 days ago
    t.sql("UPDATE challenges SET start_date = start_date - 10, end_date = end_date - 10 WHERE id = %s", (cid,))
    t.sql("UPDATE challenge_participants SET joined_on = joined_on - 10, joined_at = joined_at - INTERVAL '10 days' "
          "WHERE challenge_id = %s", (cid,))
    t.get(alice, f"/api/challenges/{cid}", "detail of an ended challenge")
    t.get(alice, "/api/challenges", "ended challenges are listed as recent")
    t.post(dave, f"/api/challenge-codes/{code}/join", "join an ended challenge")
    t.get(dave, f"/api/challenge-codes/{code}", "preview of an ended challenge")
    t.post(carol, f"/api/challenges/{cid}/leave", "leave an ended challenge")
    t.post(alice, f"/api/challenges/{cid}/cheers", "cheer in an ended challenge", json={"user_id": carol.id})
    t.post(alice, f"/api/challenges/{cid}/invites", "invite to an ended challenge", json={"user_ids": [dave.id]})
    t.delete(alice, f"/api/challenges/{cid}", "delete an ended challenge")


@scenario("challenge_open_limit", "challenges", requires=("db",))
def challenge_open_limit(t: Ctx) -> None:
    """A user takes part in at most 10 upcoming/active challenges; deleting one frees a slot."""
    alice, bob = t.users("alice", "bob")
    first = None
    for i in range(1, 11):
        r = t.post(alice, "/api/challenges", f"create challenge {i}",
                   json=_body(t, title=f"Challenge {i}", duration_days=3 + i, start_date=t.day(i)))
        first = first or r.need("challenge.id")
    t.post(alice, "/api/challenges", "11th open challenge is rejected", json=_body(t, title="One too many"))
    r = t.post(bob, "/api/challenges", "bob creates one", json=_body(t, title="Bob's"))
    t.post(alice, f"/api/challenge-codes/{r.need('challenge.invite_code')}/join", "alice cannot join an 11th either")
    t.get(alice, "/api/challenges", "alice's list of ten upcoming challenges")
    t.delete(alice, f"/api/challenges/{first}", "delete one (upcoming)")
    t.post(alice, "/api/challenges", "creating works again", json=_body(t, title="Back in"))
