"""Search suggestions (recent + trending) and recent-search management."""

from __future__ import annotations

from harness.runner import Ctx, scenario

COUNTER_SQL = (
    "INSERT INTO follow_counters (user_id, followers_count, following_count, pending_requests_count, updated_at) "
    "VALUES (%s, %s, 0, 0, NOW()) ON CONFLICT (user_id) DO UPDATE SET followers_count = EXCLUDED.followers_count"
)


@scenario("search_suggestions", "search", requires=("db",))
def search_suggestions(t: Ctx) -> None:
    """GET /api/search/suggestions: global trending, personalized trending, recent searches, caching."""
    me, me2 = t.user("me", "searcher1"), t.user("me2", "searcher2")
    t.signup(me, me2)
    names = ["popular", "rising", "steady", "quiet", "hidden", "fan", "newbie", "verified"]
    actors = {n: t.user(n) for n in names}
    t.signup(*actors.values())
    t.set_private(actors["hidden"])
    t.sql("UPDATE users SET is_verified = true WHERE id = %s", (actors["verified"].id,))
    # distinct follower counts: the global ranking has no tie-breaker beyond followers_count
    for i, n in enumerate(names):
        t.sql(COUNTER_SQL, (actors[n].id, [500, 400, 300, 200, 900, 100, 50, 5][i]))
    t.sql(COUNTER_SQL, (me.id, 1000))

    t.get(me, "/api/search/suggestions", "global trending: verified first, then by followers, private excluded")
    t.follow(actors["fan"], me, "fan follows me")
    t.follow(actors["fan"], actors["newbie"], "my follower fan follows newbie (interaction)")
    t.get(me, "/api/search/suggestions", "trending is cached per user for 5 minutes")
    t.follow(actors["fan"], me2, "fan follows me2")
    t.get(me2, "/api/search/suggestions", "personalized trending first (interactions of my followers)")

    for n in ("quiet", "steady", "hidden"):
        t.get(me2, f"/api/users/{actors[n].id}/profile", f"view profile of {n} (saves a recent search)")
        _wait_recent(t, me2, actors[n])
    t.get(me2, f"/api/users/{me2.id}/profile", "viewing yourself is not recorded")
    t.get(me2, "/api/search/suggestions", "recent (newest first, private included) + cached trending without duplicates")
    t.get(me2, f"/api/users/{actors['quiet'].id}/profile", "viewing quiet again within 60s (throttled)")
    t.settle(0.3)
    t.get(me2, "/api/search/suggestions", "order unchanged because of the throttle")
    t.sql("UPDATE recent_searches SET searched_at = searched_at - INTERVAL '2 minutes' WHERE user_id = %s", (me2.id,))
    t.get(me2, f"/api/users/{actors['quiet'].id}/profile", "viewing quiet after the throttle window")
    t.wait_sql("quiet becomes the newest recent search",
               "SELECT searched_user_id FROM recent_searches WHERE user_id = %s ORDER BY searched_at DESC LIMIT 1",
               (me2.id,), until=lambda v: v == actors["quiet"].id)
    t.get(me2, "/api/search/suggestions", "quiet moved to the top")

    for n in ("popular", "rising", "verified"):
        t.get(me2, f"/api/users/{actors[n].id}/profile", f"view profile of {n}")
        _wait_recent(t, me2, actors[n])
    t.get(me2, "/api/search/suggestions", "6 recent searches: only the 5 newest, no room for trending")

    t.delete(me2, "/api/search/recent/abc", "delete recent: invalid id")
    t.delete(me2, "/api/search/recent/0", "delete recent: id 0")
    t.delete(me2, f"/api/search/recent/{actors['verified'].id}", "delete one recent search")
    t.delete(me2, f"/api/search/recent/{actors['verified'].id}", "delete it again (idempotent)")
    t.delete(me2, "/api/search/recent/999999", "delete a user never searched")
    t.get(me2, "/api/search/suggestions", "after deleting one recent search")
    t.delete(me2, "/api/search/recent", "clear all recent searches")
    t.delete(me2, "/api/search/recent", "clear again (idempotent)")
    t.get(me2, "/api/search/suggestions", "after clearing")
    t.get(actors["fan"], "/api/search/suggestions", "suggestions of a user who follows others")


def _wait_recent(t: Ctx, viewer, target) -> None:
    """Profile views save recent searches in a goroutine; wait for the row, then keep timestamps apart."""
    t.wait_sql(f"recent search of {target.name}",
               "SELECT count(*) FROM recent_searches WHERE user_id = %s AND searched_user_id = %s",
               (viewer.id, target.id), until=lambda v: v == 1)
    t.settle(0.02)
