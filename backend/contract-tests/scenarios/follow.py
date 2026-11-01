"""Follow system: follow/unfollow, requests, follower management, lists with cursors, counts, lookup."""

from __future__ import annotations

from harness.runner import Ctx, scenario


@scenario("follow_public_private", "follow", requires=("db",))
def follow_public_private(t: Ctx) -> None:
    """Follow a public user (active) and a private user (request), accept/decline/cancel, unfollow, remove."""
    alice, bob, carol, dave, erin = t.users("alice", "bob", "carol", "dave", "erin")
    t.set_private(carol)

    t.post(bob, "/api/users/abc/follow", "follow: non-numeric id")
    t.post(bob, f"/api/users/{bob.id}/follow", "follow: yourself")
    t.post(bob, "/api/users/999999/follow", "follow: unknown user")
    t.post(bob, "/api/users/0/follow", "follow: id 0")
    t.follow(bob, alice, "bob follows public alice")
    t.follow(bob, alice, "bob follows alice again (idempotent)")
    t.get(alice, "/api/notifications", "alice got a new-follower notification")
    t.get(alice, f"/api/users/{alice.id}/follow-counts", "alice's own counts (pending count omitted when 0)")
    t.get(bob, f"/api/users/{bob.id}/follow-counts", "bob's own counts")

    t.follow(bob, carol, "bob requests to follow private carol")
    t.follow(bob, carol, "bob requests again (still pending)")
    t.follow(dave, carol, "dave requests to follow carol")
    t.follow(erin, carol, "erin requests to follow carol")
    t.get(carol, "/api/notifications", "carol got follow-request notifications")
    t.get(carol, f"/api/users/{carol.id}/follow-counts", "carol's counts include pending requests")
    t.get(alice, f"/api/users/{carol.id}/follow-counts", "carol's counts seen by alice (no pending count)")
    t.get(carol, "/api/me/follow-requests/incoming", "carol's incoming requests (newest first)")
    t.get(bob, f"/api/users/{carol.id}/profile", "bob sees REQUESTED")

    t.post(carol, "/api/me/follow-requests/abc/accept", "accept: invalid id")
    t.post(carol, f"/api/me/follow-requests/{alice.id}/accept", "accept: no pending request")
    t.accept(carol, bob, "carol accepts bob")
    t.post(carol, f"/api/me/follow-requests/{bob.id}/accept", "accept again: no pending request")
    t.get(bob, "/api/notifications", "bob got a request-accepted notification")
    t.post(carol, "/api/me/follow-requests/abc/decline", "decline: invalid id")
    t.post(carol, f"/api/me/follow-requests/{dave.id}/decline", "carol declines dave")
    t.quiesce()
    t.post(carol, f"/api/me/follow-requests/{dave.id}/decline", "decline again: no pending request")
    t.get(dave, f"/api/users/{carol.id}/profile", "dave is back to NONE")
    t.post(erin, "/api/follow-requests/abc/cancel", "cancel: invalid id")
    t.post(erin, f"/api/follow-requests/{carol.id}/cancel", "erin cancels her request")
    t.quiesce()
    t.post(erin, f"/api/follow-requests/{carol.id}/cancel", "cancel again: no pending request")
    t.post(erin, f"/api/follow-requests/{alice.id}/cancel", "cancel a request that never existed")
    t.get(carol, "/api/me/follow-requests/incoming", "no incoming requests left")
    t.get(carol, f"/api/users/{carol.id}/follow-counts", "carol's counts after handling requests")
    t.get(carol, "/api/notifications", "follow-request notifications after handling them")

    t.delete(bob, "/api/users/abc/follow", "unfollow: invalid id")
    t.delete(bob, f"/api/users/{alice.id}/follow", "bob unfollows alice")
    t.delete(bob, f"/api/users/{alice.id}/follow", "unfollow again: not following")
    t.delete(bob, f"/api/users/{dave.id}/follow", "unfollow someone never followed")
    t.follow(bob, alice, "bob follows alice again")
    t.get(alice, "/api/notifications", "no second new-follower notification (dedupe)")

    t.delete(carol, "/api/me/followers/abc", "remove follower: invalid id")
    t.delete(carol, f"/api/me/followers/{dave.id}", "remove follower: not a follower")
    t.delete(carol, f"/api/me/followers/{bob.id}", "carol removes bob")
    t.quiesce()
    t.delete(carol, f"/api/me/followers/{bob.id}", "remove bob again")
    t.get(bob, f"/api/users/{carol.id}/profile", "bob no longer follows carol")
    t.get(carol, f"/api/users/{carol.id}/follow-counts", "carol's counts after removing bob")
    t.get(bob, f"/api/users/{bob.id}/follow-counts", "bob's counts after being removed")

    t.set_private(carol, False)
    t.follow(dave, carol, "dave follows carol after she went public")
    t.set_private(alice)
    t.follow(erin, alice, "erin requests alice after she went private")
    t.get(alice, "/api/me/follow-requests/incoming", "alice's incoming requests")
    t.set_private(alice, False)
    t.get(alice, "/api/me/follow-requests/incoming", "pending requests survive going public")
    t.get(erin, f"/api/users/{alice.id}/profile", "erin's relationship after alice went public")


@scenario("follow_lists", "follow", requires=("db",))
def follow_lists(t: Ctx) -> None:
    """Followers/following/mutuals lists with limit and cursor pagination, privacy, invalid params."""
    star, alice, bob, carol, dave, erin = t.users("star", "alice", "bob", "carol", "dave", "erin")
    for fan in (alice, bob, carol, dave, erin):
        t.follow(fan, star)
        t.settle(0.01)
    t.follow(star, alice)
    t.follow(star, carol)
    t.follow(alice, bob)
    t.follow(alice, carol)
    t.follow(bob, carol)

    base = f"/api/users/{star.id}"
    t.get(bob, f"{base}/followers", "followers of star (default limit)")
    r = t.get(bob, f"{base}/followers?limit=2", "followers page 1 (limit=2)")
    cur = r.get("next_cursor")
    r = t.get(bob, f"{base}/followers?limit=2&cursor={cur}", "followers page 2")
    cur = r.get("next_cursor")
    t.get(bob, f"{base}/followers?limit=2&cursor={cur}", "followers page 3 (last)")
    t.get(bob, f"{base}/followers?limit=0", "limit=0 uses the default")
    t.get(bob, f"{base}/followers?limit=101", "limit above the maximum uses the default")
    t.get(bob, f"{base}/followers?limit=abc", "non-numeric limit")
    t.get(bob, f"{base}/followers?limit=2&cursor=not-base64!", "invalid cursor starts from the beginning")
    t.get(bob, f"{base}/followers?cursor=e30=", "cursor with an empty JSON object")
    t.get(bob, "/api/users/abc/followers", "followers: invalid id")
    t.get(bob, "/api/users/999999/followers", "followers of an unknown user")
    t.get(bob, f"/api/users/{erin.id}/followers", "followers of a user without followers")

    t.get(bob, f"/api/users/{alice.id}/following", "alice's following")
    t.get(bob, f"/api/users/{alice.id}/following?limit=1", "following page 1 (limit=1)")
    t.get(bob, "/api/users/abc/following", "following: invalid id")
    t.get(bob, "/api/users/999999/following", "following of an unknown user")

    t.get(alice, f"{base}/mutuals", "alice: who of the people she follows also follow star")
    t.get(alice, f"{base}/mutuals?limit=1", "mutuals page 1 (limit=1)")
    t.get(star, f"/api/users/{carol.id}/mutuals", "star: mutual connections with carol")
    t.get(alice, "/api/users/abc/mutuals", "mutuals: invalid id")
    t.get(alice, "/api/users/999999/mutuals", "mutuals of an unknown user")
    t.get(alice, f"/api/users/{alice.id}/mutuals", "mutuals with yourself")

    t.set_private(star)
    t.get(erin, f"{base}/followers", "private star: follower erin can see followers")
    t.delete(star, f"/api/me/followers/{erin.id}", "star removes erin")
    t.quiesce()
    t.get(erin, f"{base}/followers", "private star: non-follower erin is blocked")
    t.get(erin, f"{base}/following", "private star: following blocked too")
    t.get(erin, f"{base}/mutuals", "private star: mutuals blocked too")
    t.get(erin, f"{base}/follow-counts", "counts of a private user are visible")
    t.get(star, f"{base}/followers", "owner sees own followers")
    t.get(erin, "/api/users/abc/follow-counts", "follow-counts: invalid id")
    t.get(erin, "/api/users/999999/follow-counts", "follow-counts of an unknown user")


@scenario("follow_counts_and_lookup", "follow", requires=("db",))
def follow_counts_and_lookup(t: Ctx) -> None:
    """Counter reconciliation and the batch relationship lookup."""
    alice, bob, carol, dave = t.users("alice", "bob", "carol", "dave")
    t.set_private(dave)
    t.follow(alice, bob)
    t.follow(bob, alice)
    t.follow(alice, dave, "alice requests dave")
    t.follow(carol, alice)

    lookup = "/api/relationships/lookup"
    t.post(alice, lookup, "lookup: invalid JSON", raw="{", content_type="application/json")
    t.post(alice, lookup, "lookup: empty list", json={"target_ids": []})
    t.post(alice, lookup, "lookup: missing field", json={})
    t.post(alice, lookup, "lookup: wrong element type", json={"target_ids": ["2"]})
    t.post(alice, lookup, "lookup: negative id", json={"target_ids": [-1]})
    t.post(alice, lookup, "lookup: mixed states",
           json={"target_ids": [bob.id, carol.id, dave.id, alice.id, 999999]})
    t.post(alice, lookup, "lookup: duplicates", json={"target_ids": [bob.id, bob.id]})
    t.post(alice, lookup, "lookup: 101 ids", json={"target_ids": list(range(1, 102))})
    t.post(alice, lookup, "lookup: exactly 100 ids", json={"target_ids": list(range(1, 101))})
    t.post(dave, lookup, "lookup from the private user's side", json={"target_ids": [alice.id, bob.id]})

    t.get(alice, f"/api/users/{alice.id}/follow-counts", "alice's counts")
    t.sql("UPDATE follow_counters SET followers_count = 42, following_count = 7, pending_requests_count = 3 "
          "WHERE user_id = %s", (alice.id,))
    t.get(alice, f"/api/users/{alice.id}/follow-counts", "counts are served from the cache")
    t.post(alice, "/api/me/follow-counts/reconcile", "reconcile alice's counters")
    t.get(alice, f"/api/users/{alice.id}/follow-counts", "counts after reconciling")
    t.get(alice, "/api/profile", "profile counts after reconciling")
    t.post(dave, "/api/me/follow-counts/reconcile", "reconcile for a user with a pending request")
    t.get(dave, f"/api/users/{dave.id}/follow-counts", "dave's counts after reconciling")
    t.post(carol, "/api/me/follow-counts/reconcile", "reconcile is idempotent")
    t.post(carol, "/api/me/follow-counts/reconcile", "reconcile again")
