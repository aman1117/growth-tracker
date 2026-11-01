"""Own profile, privacy, bio, public profiles of other users, user search and autocomplete."""

from __future__ import annotations

from harness.runner import Ctx, scenario


@scenario("profile_settings", "profile")
def profile_settings(t: Ctx) -> None:
    """GET /api/profile, privacy and bio settings with validation."""
    alice, = t.users("alice")
    t.get(alice, "/api/profile", "fresh profile")
    t.get(alice, "/api/get-privacy", "privacy defaults to public")
    t.get(alice, "/api/get-bio", "bio defaults to null")

    t.post(alice, "/api/update-privacy", "privacy: invalid JSON", raw="{", content_type="application/json")
    t.post(alice, "/api/update-privacy", "privacy: wrong type", json={"is_private": "yes"})
    t.post(alice, "/api/update-privacy", "privacy: set private", json={"is_private": True})
    t.get(alice, "/api/get-privacy", "privacy is private")
    t.post(alice, "/api/update-privacy", "privacy: set private again (idempotent)", json={"is_private": True})
    t.post(alice, "/api/update-privacy", "privacy: missing field means public", json={})
    t.get(alice, "/api/get-privacy", "privacy is public again")

    t.post(alice, "/api/update-bio", "bio: invalid JSON", raw="nope", content_type="application/json")
    t.post(alice, "/api/update-bio", "bio: wrong type", json={"bio": 12})
    t.post(alice, "/api/update-bio", "bio: 151 characters", json={"bio": "b" * 151})
    t.post(alice, "/api/update-bio", "bio: exactly 150 characters", json={"bio": "a" * 150})
    t.post(alice, "/api/update-bio", "bio: 150 multi-byte characters", json={"bio": "\u00e9" * 150})
    t.post(alice, "/api/update-bio", "bio: emoji and surrounding whitespace",
           json={"bio": "  Learning Rust \U0001F980 | runner \U0001F3C3\u200d\u2640\ufe0f  "})
    t.get(alice, "/api/get-bio", "bio after update")
    t.post(alice, "/api/update-bio", "bio: newlines and tabs", json={"bio": "line one\n\n\n\nline two\ttabbed"})
    t.post(alice, "/api/update-bio", "bio: html is kept as text", json={"bio": "<b>bold</b> & \"quotes\""})
    t.get(alice, "/api/profile", "profile shows bio")
    t.post(alice, "/api/update-bio", "bio: whitespace only clears it", json={"bio": "   "})
    t.get(alice, "/api/get-bio", "bio after clearing")
    t.post(alice, "/api/update-bio", "bio: missing field clears it", json={})
    t.get(alice, "/api/profile", "profile after clearing bio")


@scenario("profile_public_view", "profile", requires=("db",))
def profile_public_view(t: Ctx) -> None:
    """GET /api/users/:id/profile for self, public and private users, before and after following."""
    alice, bob, carol = t.users("alice", "bob", "carol")
    t.post(bob, "/api/update-bio", "bob sets a bio", json={"bio": "bob's bio"})
    t.post(carol, "/api/update-bio", "carol sets a bio", json={"bio": "carol's secret bio"})
    t.set_private(carol)
    t.activity(bob, "study", 2, t.day(0))
    t.activity(carol, "workout", 1.5, t.day(0))

    t.get(alice, f"/api/users/{alice.id}/profile", "own profile via public endpoint")
    t.get(alice, f"/api/users/{bob.id}/profile", "public user: bio and last_logged_at visible")
    t.get(alice, f"/api/users/{carol.id}/profile", "private user, not following: bio hidden")
    t.get(alice, "/api/users/999999/profile", "unknown user id")
    t.get(alice, "/api/users/0/profile", "user id 0")
    t.get(alice, "/api/users/-1/profile", "negative user id")
    t.get(alice, "/api/users/4294967296/profile", "user id overflowing uint32")
    t.get(alice, "/api/users/1e3/profile", "user id in exponent notation")

    t.follow(alice, carol, "alice requests to follow carol")
    t.get(alice, f"/api/users/{carol.id}/profile", "private user, request pending")
    t.accept(carol, alice)
    t.get(alice, f"/api/users/{carol.id}/profile", "private user, following: bio visible")
    t.get(carol, f"/api/users/{alice.id}/profile", "carol views her follower alice")
    t.follow(alice, bob)
    t.get(alice, f"/api/users/{bob.id}/profile", "public user, following")
    t.get(bob, f"/api/users/{alice.id}/profile", "bob views alice (follows him)")
    t.wait_sql("recent searches of alice", "SELECT count(*) FROM recent_searches WHERE user_id = %s", (alice.id,),
               until=lambda v: v == 2)


@scenario("user_search", "profile")
def user_search(t: Ctx) -> None:
    """POST /api/users: substring search (ILIKE without escaping), private users, is_following flag."""
    alice = t.user("alice")
    t.signup(alice)
    others = [t.user(n) for n in ("alicia", "bob_ali", "mal.ice", "zed_1", "x_y")]
    t.signup(*others)
    alicia, bob_ali, malice, zed, xy = others
    t.set_private(alicia)
    t.set_private(malice)
    t.follow(alice, malice, "alice requests to follow mal.ice")
    t.accept(malice, alice)

    t.post(alice, "/api/users", "search: invalid JSON", raw="{", content_type="application/json")
    t.post(alice, "/api/users", "search: empty query", json={"username": ""})
    t.post(alice, "/api/users", "search: whitespace query", json={"username": "   "})
    t.post(alice, "/api/users", "search: missing field", json={})
    t.post(alice, "/api/users", "search: 'ali' (includes private users and self)", json={"username": "ali"})
    t.post(alice, "/api/users", "search: case-insensitive", json={"username": "ALI"})
    t.post(alice, "/api/users", "search: '_' is a wildcard", json={"username": "_"})
    t.post(alice, "/api/users", "search: '%' is a wildcard", json={"username": "%"})
    t.post(alice, "/api/users", "search: no match", json={"username": "qqqq"})
    t.post(alice, "/api/users", "search: dot", json={"username": "l.i"})
    t.post(bob_ali, "/api/users", "search by a user who follows nobody", json={"username": "ice"})
    t.post(alice, "/api/users", "search: leading space is not trimmed", json={"username": " ali"})


@scenario("user_autocomplete", "profile", requires=("db",))
def user_autocomplete(t: Ctx) -> None:
    """GET /api/autocomplete/users: validation, ranking (exact > prefix > trigram, then followers), limit, cache."""
    me = t.user("me", "searcher")
    t.signup(me)
    names = ["sam", "samantha", "sammy_k", "samuel.r", "asam", "xsamx", "tom"]
    actors = [t.user(n) for n in names]
    t.signup(*actors)
    # distinct follower counts so that ties never depend on heap order
    for i, a in enumerate(actors):
        t.sql("INSERT INTO follow_counters (user_id, followers_count, following_count, pending_requests_count, updated_at) "
              "VALUES (%s, %s, 0, 0, NOW()) ON CONFLICT (user_id) DO UPDATE SET followers_count = EXCLUDED.followers_count",
              (a.id, 10 + 7 * ((i * 3) % len(actors))))
    t.sql("UPDATE users SET is_verified = true WHERE id = %s", (actors[2].id,))
    t.set_private(actors[3])

    t.get(me, "/api/autocomplete/users", "missing q")
    t.get(me, "/api/autocomplete/users?q=%20%20", "blank q")
    t.get(me, "/api/autocomplete/users?q=sam", "q=sam: exact match first, then prefix matches")
    t.get(me, "/api/autocomplete/users?q=SAM", "q=SAM is served from the cache (query echoes the cached text)")
    t.get(me, "/api/autocomplete/users?q=sam&limit=1", "cached result ignores limit")
    t.get(me, "/api/autocomplete/users?q=samm&limit=1", "limit=1")
    t.get(me, "/api/autocomplete/users?q=samu&limit=0", "limit=0 falls back to the default")
    t.get(me, "/api/autocomplete/users?q=sama&limit=21", "limit=21 falls back to the default")
    t.get(me, "/api/autocomplete/users?q=samx&limit=abc", "non-numeric limit falls back to the default")
    t.get(me, "/api/autocomplete/users?q=amue", "trigram similarity match")
    t.get(me, "/api/autocomplete/users?q=s_m", "underscore is escaped for prefix matching")
    t.get(me, "/api/autocomplete/users?q=%25", "percent sign")
    t.get(me, "/api/autocomplete/users?q=nobodyhere", "no match")
    t.get(me, "/api/autocomplete/users?q=" + "s" * 85, "query longer than 80 characters is truncated")
    t.get(me, "/api/autocomplete/users?q=%C3%A9t%C3%A9", "non-ASCII query")
    t.get(me, "/api/autocomplete/users?q=+tom+", "query is trimmed")
