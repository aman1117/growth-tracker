"""Day comments: create, replies, mentions, dedupe/idempotency, listing, count, edit, delete, likes."""

from __future__ import annotations

from harness.runner import Ctx, scenario


@scenario("comments_crud", "comments", requires=("db",))
def comments_crud(t: Ctx) -> None:
    """Create/reply/list/count/edit/delete with validation, mentions, duplicate detection, edit window."""
    alice, bob, carol, dave, erin = t.users("alice", "bob", "carol", "dave", "erin")
    day = t.day(0)
    base = f"/api/days/alice/{day}/comments"

    def comment(actor, name, body, path=base, **kw):
        r = t.post(actor, path, name, json={"body": body} if body is not None else {}, **kw)
        t.quiesce()  # comment / mention notifications are created in goroutines
        return r

    t.post(erin, base, "create: invalid JSON", raw="{", content_type="application/json")
    comment(erin, "create: missing body", None)
    comment(erin, "create: whitespace body", "   \n ")
    comment(erin, "create: 201 characters", "x" * 201)
    comment(erin, "create: unknown day owner", "hi", path=f"/api/days/ghost/{day}/comments")
    comment(erin, "create: invalid date", "hi", path="/api/days/alice/2026-13-40/comments")
    comment(erin, "create: upper-case username in path", "hi", path=f"/api/days/ALICE/{day}/comments")
    r1 = comment(bob, "bob comments on alice's day", "  Great work today! \U0001F525  ")
    c1 = r1.get("comment.id")
    comment(bob, "same body again within 60s (duplicate)", "Great work today! \U0001F525")
    r2 = comment(carol, "carol mentions bob and dave", "@bob @dave @ghost @bob look at this! @ALICE")
    c2 = r2.get("comment.id")
    comment(alice, "alice comments on her own day", "Thanks everyone")
    comment(dave, "exactly 200 characters", "y" * 200)
    comment(bob, "comment on a day without activities", "empty day?", path=f"/api/days/alice/{t.day(-9)}/comments")
    comment(carol, "eleven mentions", " ".join(f"@user{i:02d}" for i in range(11)))

    t.get(bob, f"{base}/count", "comment count")
    t.get(bob, f"/api/days/alice/{t.day(-1)}/comments/count", "count for a day without comments")
    t.get(bob, f"/api/days/ghost/{day}/comments/count", "count: unknown user")
    t.get(bob, "/api/days/alice/bad-date/comments/count", "count: invalid date")
    t.get(bob, base, "list (top)")
    t.get(bob, f"{base}?sort=newest", "list (newest)")
    t.get(bob, f"{base}?sort=weird", "list with an unknown sort")
    r = t.get(bob, f"{base}?sort=newest&limit=2", "list newest, limit 2")
    cursor = r.get("next_cursor")
    if cursor is not None:
        t.get(bob, f"{base}?sort=newest&limit=2&cursor={cursor}", "list newest, page 2")
    t.get(bob, f"{base}?limit=0", "limit=0")
    t.get(bob, f"{base}?limit=51", "limit above the maximum")
    t.get(bob, f"{base}?cursor=abc", "non-numeric cursor")
    t.get(bob, f"/api/days/ghost/{day}/comments", "list: unknown user")
    t.get(bob, "/api/days/alice/2026-02-30/comments", "list: invalid date")

    replies = f"{base}/{c1}/replies"
    t.post(alice, replies, "reply: invalid JSON", raw="{", content_type="application/json")
    comment(alice, "reply: empty body", "", path=replies)
    comment(alice, "reply: unknown parent", "hi", path=f"{base}/999999/replies")
    comment(alice, "reply: invalid parent id", "hi", path=f"{base}/abc/replies")
    comment(alice, "reply: parent on another day", "hi", path=f"/api/days/alice/{t.day(-9)}/comments/{c1}/replies")
    rr1 = comment(alice, "alice replies to bob", "Thanks @bob!", path=replies)
    comment(carol, "carol replies to bob", "+1", path=replies)
    comment(dave, "reply to a reply", "nested?", path=f"{base}/{rr1.get('comment.id')}/replies")
    t.get(bob, f"/api/comments/{c1}/replies", "replies of bob's comment")
    t.get(bob, f"/api/comments/{c1}/replies?limit=1", "replies limit 1")
    t.get(bob, f"/api/comments/{c1}/replies?cursor={rr1.get('comment.id')}", "replies after a cursor")
    t.get(bob, "/api/comments/abc/replies", "replies: invalid id")
    t.get(bob, "/api/comments/999999/replies", "replies: unknown comment")
    t.get(bob, base, "list shows reply counts")

    t.put(bob, f"/api/comments/{c1}", "edit: invalid JSON", raw="{", content_type="application/json")
    t.put(bob, f"/api/comments/{c1}", "edit: empty body", json={"body": " "})
    t.put(bob, f"/api/comments/{c1}", "edit: too long", json={"body": "z" * 201})
    t.put(carol, f"/api/comments/{c1}", "edit: not the author", json={"body": "hijack"})
    t.put(alice, f"/api/comments/{c1}", "edit: day owner cannot edit others' comments", json={"body": "owner edit"})
    t.put(bob, "/api/comments/abc", "edit: invalid id", json={"body": "x"})
    t.put(bob, "/api/comments/999999", "edit: unknown comment", json={"body": "x"})
    t.put(bob, f"/api/comments/{c1}", "bob edits his comment and mentions carol", json={"body": "Edited: great work @carol"})
    t.quiesce()
    t.sql("UPDATE comments SET created_at = created_at - INTERVAL '2 hours' WHERE id = %s", (c2,))
    t.put(carol, f"/api/comments/{c2}", "edit after the 1h window", json={"body": "too late"})

    t.delete(dave, f"/api/comments/{c1}", "delete: neither author nor day owner")
    t.delete(bob, "/api/comments/abc", "delete: invalid id")
    t.delete(bob, "/api/comments/999999", "delete: unknown comment")
    t.delete(bob, f"/api/comments/{c1}", "author deletes a comment that has replies")
    t.delete(bob, f"/api/comments/{c1}", "delete it again")
    t.put(bob, f"/api/comments/{c1}", "edit a deleted comment", json={"body": "revive"})
    comment(dave, "reply to a deleted comment", "anyone?", path=replies)
    t.get(bob, f"/api/comments/{c1}/replies", "replies of a deleted comment")
    t.delete(alice, f"/api/comments/{c2}", "day owner deletes carol's comment")
    t.get(bob, base, "list after deletions")
    t.get(bob, f"{base}/count", "count after deletions")
    t.get(bob, "/api/notifications", "bob's notifications (comment reply, mention)")
    t.get(alice, "/api/notifications", "alice's notifications (comments on her day)")


@scenario("comments_privacy_likes", "comments", requires=("db",))
def comments_privacy_likes(t: Ctx) -> None:
    """Comment likes, idempotency keys, private days before/after following."""
    alice, bob, carol = t.users("alice", "bob", "carol")
    day = t.day(-2)
    base = f"/api/days/alice/{day}/comments"
    r = t.post(bob, base, "bob comments", json={"body": "first!"})
    cid = r.get("comment.id")
    t.quiesce()

    t.post(carol, f"/api/comments/{cid}/like", "carol likes the comment")
    t.post(carol, f"/api/comments/{cid}/like", "carol likes it again")
    t.post(alice, f"/api/comments/{cid}/like", "alice likes the comment")
    t.post(bob, f"/api/comments/{cid}/like", "bob likes his own comment")
    t.quiesce()
    t.post(carol, "/api/comments/abc/like", "like: invalid id")
    t.post(carol, "/api/comments/999999/like", "like: unknown comment")
    t.get(carol, base, "list as carol (liked_by_me)")
    t.get(bob, base, "list as bob")
    t.delete(carol, f"/api/comments/{cid}/like", "carol unlikes")
    t.delete(carol, f"/api/comments/{cid}/like", "carol unlikes again")
    t.delete(carol, "/api/comments/abc/like", "unlike: invalid id")
    t.delete(carol, "/api/comments/999999/like", "unlike: unknown comment")
    t.get(carol, base, "list after unlike")
    t.get(bob, "/api/notifications", "bob's comment-like notifications")

    key = {"X-Idempotency-Key": "parity-key-0001"}
    t.post(carol, base, "create with an idempotency key", json={"body": "idempotent"}, headers=key)
    t.quiesce()
    t.post(carol, base, "same key again (replay)", json={"body": "idempotent"}, headers=key)
    t.post(carol, base, "same key, different body (replay)", json={"body": "something else"}, headers=key)
    t.post(bob, base, "another user with the same key", json={"body": "bob's idempotent"}, headers=key)
    t.quiesce()
    t.get(carol, f"{base}/count", "count after idempotent creates")

    t.set_private(alice)
    t.post(carol, base, "comment on a private day (not following)", json={"body": "let me in"})
    t.get(carol, base, "list on a private day (not following)")
    t.get(carol, f"{base}/count", "count on a private day (not following)")
    t.get(carol, f"/api/comments/{cid}/replies", "replies on a private day (not following)")
    t.post(carol, f"{base}/{cid}/replies", "reply on a private day (not following)", json={"body": "hi"})
    t.post(carol, f"/api/comments/{cid}/like", "like on a private day (not following)")
    t.get(bob, base, "bob (not following) cannot list his own comment on a private day")
    t.get(alice, base, "owner lists comments on her private day")
    t.follow(carol, alice, "carol requests alice")
    t.accept(alice, carol)
    t.get(carol, base, "list as an accepted follower")
    t.post(carol, base, "comment as an accepted follower", json={"body": "thanks for accepting"})
    t.quiesce()
