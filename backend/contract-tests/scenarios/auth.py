"""Registration, login, password change, username change, password reset, email verification.

The auth limiter (5 req/min per IP) is shared by register, login, change-password and
resend-verification; the password-reset limiter (5 per 15 min per IP) by forgot, reset and
validate. Probes therefore use several anonymous clients, each with its own source IP.
"""

from __future__ import annotations

from harness.runner import Ctx, scenario


@scenario("auth_register", "auth")
def auth_register(t: Ctx) -> None:
    """POST /api/register: happy paths, body parsing errors, validation errors, duplicates, sanitizing."""
    a = t.anon("probe-a")
    t.post(a, "/api/register", "invalid JSON body", auth=False, raw="{not json", content_type="application/json")
    t.post(a, "/api/register", "empty body with JSON content type", auth=False, raw="", content_type="application/json")
    t.post(a, "/api/register", "missing username and password", auth=False, json={"email": "x@parity.test"})
    t.post(a, "/api/register", "text/plain content type", auth=False, raw='{"email":"a@b.c"}', content_type="text/plain")
    t.post(a, "/api/register", "password too short", auth=False,
           json={"email": "short@parity.test", "username": "shorty", "password": "abc123"})

    b = t.anon("probe-b")
    t.post(b, "/api/register", "whitespace-only password", auth=False,
           json={"email": "ws@parity.test", "username": "wsuser", "password": "          "})
    t.post(b, "/api/register", "username too short", auth=False,
           json={"email": "ab@parity.test", "username": "ab", "password": "Passw0rd123"})
    t.post(b, "/api/register", "username too long (21 chars)", auth=False,
           json={"email": "long@parity.test", "username": "a" * 21, "password": "Passw0rd123"})
    t.post(b, "/api/register", "username with invalid characters", auth=False,
           json={"email": "bad@parity.test", "username": "bad name!", "password": "Passw0rd123"})
    t.post(b, "/api/register", "mixed-case username is lower-cased", auth=False,
           json={"email": "Alice@Parity.test", "username": "Alice_01", "password": "Passw0rd123"})

    c = t.anon("probe-c")
    t.post(c, "/api/register", "duplicate username", auth=False,
           json={"email": "other@parity.test", "username": "alice_01", "password": "Passw0rd123"})
    t.post(c, "/api/register", "duplicate email", auth=False,
           json={"email": "Alice@Parity.test", "username": "alice_02", "password": "Passw0rd123"})
    t.post(c, "/api/register", "surrounding whitespace is trimmed", auth=False,
           json={"email": "  bob@parity.test  ", "username": "  Bob.Smith  ", "password": "Passw0rd123"})
    t.post(c, "/api/register", "unknown extra fields are ignored", auth=False,
           json={"email": "carol@parity.test", "username": "carol", "password": "Passw0rd123", "admin": True})
    t.post(c, "/api/register", "wrong JSON types", auth=False,
           json={"email": 42, "username": ["x"], "password": True})

    d = t.anon("probe-d")
    t.post(d, "/api/register", "21-char multi-byte username", auth=False,
           json={"email": "uni@parity.test", "username": "é" * 21, "password": "Passw0rd123"})
    t.post(d, "/api/register", "8-char multi-byte password", auth=False,
           json={"email": "uni2@parity.test", "username": "unicode_pw", "password": "ééééééé1"})
    t.post(d, "/api/register", "username with dots and digits", auth=False,
           json={"email": "dots@parity.test", "username": "a.b_c.123", "password": "Passw0rd123"})

    e = t.anon("probe-e")
    t.post(e, "/api/login", "login: invalid JSON", auth=False, raw="nope", content_type="application/json")
    t.post(e, "/api/login", "login: missing password", auth=False, json={"identifier": "alice_01"})
    t.post(e, "/api/login", "login: unknown user", auth=False, json={"identifier": "nobody", "password": "Passw0rd123"})
    t.post(e, "/api/login", "login: wrong password", auth=False, json={"identifier": "alice_01", "password": "wrong-pass1"})
    t.post(e, "/api/login", "login by username", auth=False, json={"identifier": "alice_01", "password": "Passw0rd123"})

    f = t.anon("probe-f")
    t.post(f, "/api/login", "login by email (as registered)", auth=False,
           json={"identifier": "Alice@Parity.test", "password": "Passw0rd123"})
    t.post(f, "/api/login", "login by email with different case", auth=False,
           json={"identifier": "alice@parity.test", "password": "Passw0rd123"})
    t.post(f, "/api/login", "login by upper-case username", auth=False,
           json={"identifier": "ALICE_01", "password": "Passw0rd123"})
    t.post(f, "/api/login", "login by trimmed email of bob", auth=False,
           json={"identifier": "bob@parity.test", "password": "Passw0rd123"})
    t.post(f, "/api/login", "login with padded identifier", auth=False,
           json={"identifier": " bob.smith", "password": "Passw0rd123"})

    g = t.anon("probe-g")
    r = t.post(g, "/api/login", "login of the sanitized username", auth=False,
               json={"identifier": "bob.smith", "password": "Passw0rd123"})
    token = r.get("access_token")
    t.get(g, "/api/profile", "profile of the sanitized registration", auth=f"Bearer {token}")


@scenario("auth_password_and_username", "auth")
def auth_password_and_username(t: Ctx) -> None:
    """POST /api/change-password and /api/update-username, including stale-token behaviour."""
    alice = t.user("alice")
    bob = t.user("bob")
    t.signup(alice, bob)

    # alice's IP has used 2 of 5 auth-limiter requests (register + login)
    t.post(alice, "/api/change-password", "change-password: missing fields", json={"current_password": "Passw0rd123"})
    t.post(alice, "/api/change-password", "change-password: new password too short",
           json={"current_password": "Passw0rd123", "new_password": "short1"})
    t.post(alice, "/api/change-password", "change-password: wrong current password",
           json={"current_password": "Wrong-pass1", "new_password": "NewPassw0rd1"})
    t.new_ip(alice)
    old_token = alice.token
    t.post(alice, "/api/change-password", "change-password: invalid JSON", raw="{", content_type="application/json")
    t.post(alice, "/api/change-password", "change-password: success",
           json={"current_password": "Passw0rd123", "new_password": "NewPassw0rd1"})
    t.login(alice, "login with the old password fails", password="Passw0rd123", require=False)
    alice.password = "NewPassw0rd1"
    t.login(alice, "login with the new password")
    t.get(alice, "/api/profile", "token issued before the change still works", auth=f"Bearer {old_token}")
    t.post(alice, "/api/change-password", "change-password: 5th auth-limited request from this IP",
           json={"new_password": "Another1pass"})
    t.post(alice, "/api/change-password", "change-password: 6th auth-limited request from this IP is rejected",
           json={"current_password": "NewPassw0rd1", "new_password": "Another1pass"})

    t.post(bob, "/api/update-username", "update-username: invalid JSON", raw="[", content_type="application/json")
    t.post(bob, "/api/update-username", "update-username: empty", json={"new_username": "   "})
    t.post(bob, "/api/update-username", "update-username: missing field", json={})
    t.post(bob, "/api/update-username", "update-username: too short", json={"new_username": "bo"})
    t.post(bob, "/api/update-username", "update-username: invalid characters", json={"new_username": "bob smith"})
    t.post(bob, "/api/update-username", "update-username: taken by alice", json={"new_username": "alice"})
    t.post(bob, "/api/update-username", "update-username: same as current", json={"new_username": "bob"})
    t.post(bob, "/api/update-username", "update-username: mixed case is lower-cased", json={"new_username": "  Robert.B  "})
    t.get(bob, "/api/profile", "profile shows the new username")
    t.post(bob, "/api/create-activity", "old token (old username claim) cannot log for the new username",
           json={"username": "robert.b", "activity": "study", "hours": 1, "date": t.day(0)})
    t.post(bob, "/api/create-activity", "old token can still log for the old username",
           json={"username": "bob", "activity": "study", "hours": 1, "date": t.day(0)})
    bob.username = "robert.b"
    t.new_ip(bob)
    t.login(bob, "login with the new username")
    t.new_ip(alice)
    t.login(alice, "login of alice by email", identifier="alice@parity.test")
    t.post(bob, "/api/create-activity", "new token logs for the new username",
           json={"username": "robert.b", "activity": "sleep", "hours": 7, "date": t.day(0)})
    t.post(bob, "/api/get-activities", "activities stay with the account after rename",
           json={"username": "robert.b", "start_date": t.day(0), "end_date": t.day(0)})
    t.post(alice, "/api/get-activities", "old username no longer resolves",
           json={"username": "bob", "start_date": t.day(0), "end_date": t.day(0)})


@scenario("auth_rate_limits", "auth")
def auth_rate_limits(t: Ctx) -> None:
    """429 responses: auth limiter (shared by register/login), password-reset limiter, autocomplete limiter."""
    x = t.anon("hammer")
    for i in range(1, 6):
        t.post(x, "/api/login", f"login attempt {i}/5 (missing password)", auth=False, json={"identifier": "nobody"})
    t.post(x, "/api/login", "6th login within a minute is rate limited", auth=False, json={"identifier": "nobody"})
    t.post(x, "/api/register", "register shares the auth limiter (still limited)", auth=False,
           json={"email": "late@parity.test", "username": "late", "password": "Passw0rd123"})
    t.post(t.anon("fresh"), "/api/login", "another IP is not limited", auth=False, json={"identifier": "nobody"})

    p = t.anon("reset-hammer")
    for i in range(1, 6):
        t.post(p, "/api/auth/forgot-password", f"forgot-password {i}/5", auth=False,
               json={"email": f"nobody{i}@parity.test"})
    t.get(p, "/api/auth/reset-password/validate?token=abc", "validate shares the reset limiter (limited)", auth=False)
    t.post(p, "/api/auth/reset-password", "reset shares the reset limiter (limited)", auth=False,
           json={"token": "abc", "new_password": "Passw0rd123", "confirm_password": "Passw0rd123"})
    t.post(p, "/api/login", "login uses a different limiter", auth=False, json={"identifier": "nobody"})

    alice, = t.users("alice")
    statuses = t.burst(alice, "GET", [f"/api/autocomplete/users?q=zz{i}" for i in range(59)])
    t.observe("statuses of 59 concurrent autocomplete requests", sorted(set(statuses)))
    t.get(alice, "/api/search/suggestions", "60th request of the autocomplete limiter (suggestions share it)")
    t.get(alice, "/api/autocomplete/users?q=ali", "61st request is rate limited")
    t.get(alice, "/api/profile", "API limiter is separate")


@scenario("password_reset", "auth", requires=("smtp",))
def password_reset(t: Ctx) -> None:
    """Forgot / validate / reset password with the token taken from the email."""
    alice, = t.users("alice")
    t.email_token(alice.email, count=1, subject_contains="verify")  # registration email (async) has arrived
    p1 = t.anon("reset-1")
    t.post(p1, "/api/auth/forgot-password", "forgot: invalid JSON still answers 200", auth=False,
           raw="{oops", content_type="application/json")
    t.post(p1, "/api/auth/forgot-password", "forgot: empty email", auth=False, json={"email": ""})
    t.post(p1, "/api/auth/forgot-password", "forgot: unknown email", auth=False, json={"email": "ghost@parity.test"})
    t.post(p1, "/api/auth/forgot-password", "forgot: alice", auth=False, json={"email": alice.email})
    token1 = t.email_token(alice.email, count=1, subject_contains="reset")
    t.get(p1, f"/api/auth/reset-password/validate?token={token1}", "validate: fresh token is valid", auth=False)
    t.observe("emails to unknown address", t.email_count("ghost@parity.test"))
    t.observe_emails("password reset email", alice.email, subject_contains="reset")

    p2 = t.anon("reset-2")
    t.get(p2, "/api/auth/reset-password/validate", "validate: missing token", auth=False)
    t.get(p2, "/api/auth/reset-password/validate?token=deadbeef", "validate: unknown token", auth=False)
    t.post(p2, "/api/auth/reset-password", "reset: missing token", auth=False,
           json={"new_password": "Brand1New", "confirm_password": "Brand1New"})
    t.post(p2, "/api/auth/reset-password", "reset: passwords do not match", auth=False,
           json={"token": token1, "new_password": "Brand1New", "confirm_password": "Brand2New"})
    t.post(p2, "/api/auth/reset-password", "reset: no digit", auth=False,
           json={"token": token1, "new_password": "OnlyLetters", "confirm_password": "OnlyLetters"})

    p3 = t.anon("reset-3")
    t.post(p3, "/api/auth/reset-password", "reset: too short", auth=False,
           json={"token": token1, "new_password": "ab1", "confirm_password": "ab1"})
    t.post(p3, "/api/auth/reset-password", "reset: no letter", auth=False,
           json={"token": token1, "new_password": "1234567890", "confirm_password": "1234567890"})
    t.post(p3, "/api/auth/reset-password", "reset: invalid JSON", auth=False, raw="[1,2", content_type="application/json")
    t.post(p3, "/api/auth/reset-password", "reset: unknown token", auth=False,
           json={"token": "0" * 64, "new_password": "Brand1New", "confirm_password": "Brand1New"})
    t.post(p3, "/api/auth/reset-password", "reset: success", auth=False,
           json={"token": token1, "new_password": "Brand1New", "confirm_password": "Brand1New"})

    p4 = t.anon("reset-4")
    t.post(p4, "/api/auth/reset-password", "reset: token is single-use", auth=False,
           json={"token": token1, "new_password": "Brand2New", "confirm_password": "Brand2New"})
    t.get(p4, f"/api/auth/reset-password/validate?token={token1}", "validate: consumed token", auth=False)
    t.login(alice, "login with the old password fails", require=False)
    alice.password = "Brand1New"
    t.new_ip(alice)
    t.login(alice, "login with the reset password")

    # Two outstanding tokens: both usable?
    t.post(p4, "/api/auth/forgot-password", "forgot again (token A)", auth=False, json={"email": alice.email})
    token_a = t.email_token(alice.email, count=2, subject_contains="reset")
    t.post(p4, "/api/auth/forgot-password", "forgot again (token B)", auth=False, json={"email": alice.email})
    token_b = t.email_token(alice.email, count=3, subject_contains="reset")
    p5 = t.anon("reset-5")
    t.get(p5, f"/api/auth/reset-password/validate?token={token_a}", "validate: older outstanding token", auth=False)
    t.get(p5, f"/api/auth/reset-password/validate?token={token_b}", "validate: newest token", auth=False)
    t.post(p5, "/api/auth/reset-password", "reset with the older token", auth=False,
           json={"token": token_a, "new_password": "Third3pass", "confirm_password": "Third3pass"})
    t.get(p5, f"/api/auth/reset-password/validate?token={token_b}", "validate: other token after a reset", auth=False)


@scenario("email_verification", "auth", requires=("smtp",))
def email_verification(t: Ctx) -> None:
    """Verification email on registration, verify-email, resend-verification with cooldown."""
    alice = t.user("alice")
    t.signup(alice)
    token1 = t.email_token(alice.email, count=1, subject_contains="verify")
    anon = t.anon()
    t.post(anon, "/api/auth/verify-email", "verify: invalid JSON", auth=False, raw="{", content_type="application/json")
    t.post(anon, "/api/auth/verify-email", "verify: missing token", auth=False, json={})
    t.post(anon, "/api/auth/verify-email", "verify: unknown token", auth=False, json={"token": "f" * 64})
    t.get(alice, "/api/profile", "email_verified is false before verifying")
    t.post(alice, "/api/auth/resend-verification", "resend: sends a new email")
    token2 = t.email_token(alice.email, count=2, subject_contains="verify")
    t.post(alice, "/api/auth/resend-verification", "resend: cooldown")
    t.post(anon, "/api/auth/verify-email", "verify with the first token", auth=False, json={"token": token1})
    t.get(alice, "/api/profile", "email_verified is true after verifying")
    t.post(anon, "/api/auth/verify-email", "verify with the second token: already verified", auth=False,
           json={"token": token2})
    t.post(anon, "/api/auth/verify-email", "first token was consumed", auth=False, json={"token": token1})
    t.post(alice, "/api/auth/resend-verification", "resend after verifying (5th auth-limited request)")
    t.post(alice, "/api/auth/resend-verification", "resend: 6th auth-limited request from this IP")
    t.observe_emails("verification emails", alice.email)
