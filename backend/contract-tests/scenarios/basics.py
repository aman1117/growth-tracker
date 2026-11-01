"""Health check, routing, CORS and the JWT auth middleware."""

from __future__ import annotations

import time

from harness.runner import Ctx, make_jwt, scenario

CORS_HEADERS = (
    "access-control-allow-origin",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-expose-headers",
    "access-control-allow-credentials",
    "access-control-max-age",
    "vary",
)
GHOST_ID = 987654


@scenario("health_and_routing", "basics")
def health_and_routing(t: Ctx) -> None:
    """GET / health text, unknown routes (404), wrong methods (405), swagger, group middleware on unknown sub-paths."""
    anon = t.anon()
    t.get(anon, "/", "health check", auth=False)
    t.call(anon, "HEAD", "/", "HEAD health check", auth=False)
    t.call(anon, "DELETE", "/", "wrong method on health check", auth=False)
    t.get(anon, "/api/does-not-exist", "unknown API route", auth=False)
    t.post(anon, "/totally/unknown", "unknown non-API route (POST)", auth=False)
    t.get(anon, "/api/login", "GET on a POST-only route", auth=False)
    t.call(anon, "PUT", "/api/register", "PUT on a POST-only route", auth=False)
    t.call(anon, "PATCH", "/api/notifications/read-all", "PATCH read-all without auth", auth=False)
    t.get(anon, "/swagger/doc.json", "swagger doc.json (status/content-type only)", auth=False, body_mode="ignore")
    t.get(anon, "/swagger/index.html", "swagger UI (status/content-type only)", auth=False, body_mode="ignore")
    # Group-level middleware (auth + limiter) runs for any path under the group prefix
    t.get(anon, "/api/notifications/does-not-exist", "unknown notifications sub-route, no auth", auth=False)
    t.get(anon, "/api/profile/does-not-exist", "unknown profile sub-route, no auth", auth=False)
    t.get(anon, "/api/push/does-not-exist", "unknown push sub-route, no auth", auth=False)

    alice = t.user("alice")
    t.signup(alice)
    t.get(alice, "/api/notifications/does-not-exist", "unknown notifications sub-route, with auth")
    t.get(alice, "/api/profile/does-not-exist", "unknown profile sub-route, with auth")
    t.get(alice, "/api/profile/", "profile with trailing slash")
    t.post(alice, "/api/profile/upload-picture", "profile picture upload when blob storage is disabled")
    t.delete(alice, "/api/profile/picture", "profile picture delete when blob storage is disabled")
    t.get(alice, f"/api/activity-photos?user_id={alice.id}&date={t.day(0)}", "activity photos when blob storage is disabled")
    t.post(alice, "/api/activity-photo/1/like", "photo like when blob storage is disabled")
    t.get(alice, "/api/users/abc/profile", "non-numeric user id in path")
    t.get(alice, "/api/users//profile", "empty user id segment")


@scenario("cors", "basics")
def cors(t: Ctx) -> None:
    """CORS preflight and simple requests (AllowOrigins *, AllowMethods *, AllowHeaders *, ExposeHeaders *)."""
    anon = t.anon()
    origin = "http://localhost:5173"
    t.call(anon, "OPTIONS", "/api/login", "preflight for POST /api/login", auth=False,
           headers={"Origin": origin, "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "content-type,authorization"},
           extra_response_headers=CORS_HEADERS)
    t.call(anon, "OPTIONS", "/api/users/5/follow", "preflight for DELETE follow", auth=False,
           headers={"Origin": "https://growth.example.com", "Access-Control-Request-Method": "DELETE"},
           extra_response_headers=CORS_HEADERS)
    t.call(anon, "OPTIONS", "/api/nope", "preflight for an unknown route", auth=False,
           headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
           extra_response_headers=CORS_HEADERS)
    t.call(anon, "OPTIONS", "/api/login", "OPTIONS without preflight headers", auth=False,
           extra_response_headers=CORS_HEADERS)
    t.post(anon, "/api/login", "simple request with Origin (bad credentials)", auth=False,
           headers={"Origin": origin}, json={"identifier": "nobody", "password": "whatever1"},
           extra_response_headers=CORS_HEADERS)
    t.get(anon, "/", "health check with Origin", auth=False, headers={"Origin": origin},
          extra_response_headers=CORS_HEADERS)
    t.get(anon, "/", "health check without Origin", auth=False, extra_response_headers=CORS_HEADERS)
    t.get(anon, "/api/profile", "401 with Origin", auth=False, headers={"Origin": origin},
          extra_response_headers=CORS_HEADERS)


@scenario("auth_middleware", "basics")
def auth_middleware(t: Ctx) -> None:
    """Authorization header handling: missing, non-Bearer, malformed, expired, wrong key, alg=none, unknown user."""
    alice, = t.users("alice")
    anon = t.anon()
    now = int(time.time())

    bad_headers = [
        ("missing Authorization header", False),
        ("Basic scheme", "Basic YWxpY2U6c2VjcmV0"),
        ("lower-case bearer", "bearer " + alice.token),
        ("Bearer without space", "Bearer"),
        ("Bearer with empty token", "Bearer "),
        ("Bearer with garbage", "Bearer not-a-jwt"),
        ("Bearer with extra spaces", "Bearer    " + alice.token + "   "),
        ("expired token", "Bearer " + t.forge_token(alice.id, alice.username, ttl=-120)),
        ("token signed with another key", "Bearer " + t.forge_token(alice.id, alice.username, secret="wrong-secret")),
        ("alg=none token", "Bearer " + make_jwt("", {"user_id": alice.id, "username": alice.username,
                                                       "exp": now + 3600}, {"alg": "none", "typ": "JWT"})),
        ("HS512 token with the right key", "Bearer " + _hs512(t, alice.id, alice.username, now)),
    ]
    for label, header in bad_headers:
        t.get(anon, "/api/profile", f"GET /api/profile: {label}", auth=header)

    # The middleware runs before every protected route, whatever the limiter
    for method, path in [
        ("POST", "/api/create-activity"), ("GET", "/api/notifications"), ("POST", "/api/relationships/lookup"),
        ("GET", "/api/challenges"), ("DELETE", "/api/comments/1"), ("POST", "/api/auth/resend-verification"),
        ("PUT", "/api/push/preferences"), ("GET", "/api/autocomplete/users?q=al"), ("POST", "/api/users/1/follow"),
        ("GET", "/api/search/suggestions"), ("POST", "/api/change-password"), ("GET", "/api/me/follow-requests/incoming"),
        ("GET", f"/api/days/alice/{t.day(0)}/comments"), ("GET", "/api/challenge-codes/ABCDEFGH"),
    ]:
        t.call(anon, method, path, f"{method} {path.split('?')[0]} without token", auth=False)

    # Valid signature, user that does not exist
    ghost = "Bearer " + t.forge_token(GHOST_ID, "ghost")
    for method, path, body in [
        ("GET", "/api/profile", None),
        ("GET", "/api/get-privacy", None),
        ("GET", "/api/get-bio", None),
        ("GET", "/api/tile-config", None),
        ("GET", "/api/badges", None),
        ("GET", "/api/notifications", None),
        ("GET", "/api/notifications/unread-count", None),
        ("POST", "/api/auth/resend-verification", None),
        ("GET", "/api/challenges", None),
        ("GET", "/api/push/preferences", None),
        ("GET", "/api/search/suggestions", None),
        ("POST", "/api/update-bio", {"bio": "ghost bio"}),
        ("POST", "/api/get-activities", {"username": "alice", "start_date": t.day(-1), "end_date": t.day(0)}),
    ]:
        kw = {"json": body} if body is not None else {}
        t.call(anon, method, path, f"{method} {path} as a deleted/unknown user", auth=ghost, **kw)

    # Valid signature but claims disagree with the database
    renamed = "Bearer " + t.forge_token(alice.id, "mallory")
    t.post(anon, "/api/create-activity", "token username differs from the DB username", auth=renamed,
           json={"username": "alice", "activity": "study", "hours": 1, "date": t.day(0)})
    t.post(anon, "/api/create-activity", "token username used for the ownership check", auth=renamed,
           json={"username": "mallory", "activity": "study", "hours": 1, "date": t.day(0)})
    no_uid = "Bearer " + make_jwt(t.jwt_secret, {"username": "alice", "exp": now + 3600})
    t.get(anon, "/api/challenges", "token without user_id claim: challenges", auth=no_uid)
    t.get(anon, "/api/search/suggestions", "token without user_id claim: suggestions", auth=no_uid)
    t.get(anon, "/api/users/1/followers", "token without user_id claim: followers", auth=no_uid)
    t.get(alice, "/api/profile", "valid token still works")


# Every protected route (mirrors backend/internal/routes/routes.go). Blob routes are only
# registered when Azure storage is configured, so they get their own scenario.
PROTECTED_ROUTES = [
    ("POST", "/api/auth/resend-verification"), ("POST", "/api/users"), ("GET", "/api/autocomplete/users?q=al"),
    ("GET", "/api/search/suggestions"), ("DELETE", "/api/search/recent/2"), ("DELETE", "/api/search/recent"),
    ("POST", "/api/create-activity"), ("POST", "/api/get-activities"), ("POST", "/api/get-daily-totals"),
    ("POST", "/api/get-streak"), ("POST", "/api/get-week-analytics"), ("GET", "/api/tile-config"),
    ("POST", "/api/tile-config"), ("POST", "/api/tile-config/user"), ("POST", "/api/like-day"),
    ("POST", "/api/unlike-day"), ("POST", "/api/get-likes"), ("GET", "/api/badges"), ("POST", "/api/badges/user"),
    ("POST", "/api/update-username"), ("POST", "/api/update-privacy"), ("GET", "/api/get-privacy"),
    ("POST", "/api/update-bio"), ("GET", "/api/get-bio"), ("POST", "/api/change-password"), ("GET", "/api/profile"),
    ("GET", "/api/notifications"), ("GET", "/api/notifications/unread-count"), ("PATCH", "/api/notifications/1/read"),
    ("PATCH", "/api/notifications/read-all"), ("DELETE", "/api/notifications/1"), ("POST", "/api/push/subscriptions"),
    ("DELETE", "/api/push/subscriptions"), ("GET", "/api/push/preferences"), ("PUT", "/api/push/preferences"),
    ("POST", "/api/push/cleanup"), ("POST", "/api/users/2/follow"), ("DELETE", "/api/users/2/follow"),
    ("POST", "/api/follow-requests/2/cancel"), ("GET", "/api/me/follow-requests/incoming"),
    ("POST", "/api/me/follow-requests/2/accept"), ("POST", "/api/me/follow-requests/2/decline"),
    ("DELETE", "/api/me/followers/2"), ("GET", "/api/users/2/followers"), ("GET", "/api/users/2/following"),
    ("GET", "/api/users/2/mutuals"), ("GET", "/api/users/2/follow-counts"), ("POST", "/api/me/follow-counts/reconcile"),
    ("GET", "/api/users/2/profile"), ("POST", "/api/relationships/lookup"),
    ("POST", "/api/days/alice/2020-01-04/comments"), ("POST", "/api/days/alice/2020-01-04/comments/1/replies"),
    ("GET", "/api/days/alice/2020-01-04/comments"), ("GET", "/api/days/alice/2020-01-04/comments/count"),
    ("DELETE", "/api/comments/1"), ("PUT", "/api/comments/1"), ("POST", "/api/comments/1/like"),
    ("DELETE", "/api/comments/1/like"), ("GET", "/api/comments/1/replies"), ("GET", "/api/challenges"),
    ("POST", "/api/challenges"), ("GET", "/api/challenges/1"), ("DELETE", "/api/challenges/1"),
    ("POST", "/api/challenges/1/leave"), ("POST", "/api/challenges/1/cheers"),
    ("GET", "/api/challenges/1/invite-candidates"), ("POST", "/api/challenges/1/invites"),
    ("GET", "/api/challenge-codes/ABCDEFGH"), ("POST", "/api/challenge-codes/ABCDEFGH/join"),
]
BLOB_ROUTES = [
    ("POST", "/api/profile/upload-picture"), ("DELETE", "/api/profile/picture"), ("POST", "/api/activity-photo"),
    ("DELETE", "/api/activity-photo/1"), ("GET", "/api/activity-photos?user_id=1&date=2020-01-04"),
    ("GET", "/api/activity-photos/following?date=2020-01-04"), ("POST", "/api/activity-photo/1/view"),
    ("GET", "/api/activity-photo/1/viewers"), ("POST", "/api/activity-photo/1/like"),
    ("DELETE", "/api/activity-photo/1/like"), ("GET", "/api/activity-photo/1/like-status"),
    ("GET", "/api/activity-photo/1/interactions"),
]


def _unauthenticated_matrix(t: Ctx, routes: list[tuple[str, str]]) -> None:
    anon = t.anon()
    variants = [("no Authorization header", False), ("non-Bearer scheme", "Token abc.def.ghi"),
                ("invalid token", "Bearer not.a.valid-token")]
    for method, path in routes:
        for label, header in variants:
            t.call(anon, method, path, f"{method} {path.split('?')[0]}: {label}", auth=header)


@scenario("auth_required_all_routes", "basics")
def auth_required_all_routes(t: Ctx) -> None:
    """Every protected route answers 401 without a token, with a non-Bearer scheme and with an invalid token."""
    _unauthenticated_matrix(t, PROTECTED_ROUTES)


@scenario("auth_required_blob_routes", "basics", requires=("azurite",))
def auth_required_blob_routes(t: Ctx) -> None:
    """Blob-backed routes (registered only with Azure storage configured) require a token too."""
    _unauthenticated_matrix(t, BLOB_ROUTES)


def _hs512(t: Ctx, user_id: int, username: str, now: int) -> str:
    import base64
    import hashlib
    import hmac
    import json

    def b64(b: bytes) -> str:
        return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

    head = b64(json.dumps({"alg": "HS512", "typ": "JWT"}, separators=(",", ":")).encode())
    body = b64(json.dumps({"user_id": user_id, "username": username, "exp": now + 3600}, separators=(",", ":")).encode())
    sig = hmac.new(t.jwt_secret.encode(), f"{head}.{body}".encode(), hashlib.sha512).digest()
    return f"{head}.{body}.{b64(sig)}"
