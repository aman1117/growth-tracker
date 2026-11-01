"""In-app notifications (list, unread count, mark read, read-all, delete) and Web Push settings."""

from __future__ import annotations

from harness.runner import Ctx, scenario


@scenario("notifications", "notifications", requires=("db",))
def notifications(t: Ctx) -> None:
    """List with page/page_size, unread count, mark read (no ownership check), read-all, delete."""
    alice, bob, carol = t.users("alice", "bob", "carol")
    t.get(alice, "/api/notifications", "no notifications yet")
    t.get(alice, "/api/notifications/unread-count", "unread count 0")
    # Like notifications are created synchronously: one per liker and day
    for offset in (-6, -5, -4):
        t.post(bob, "/api/like-day", f"bob likes alice's day {offset}", json={"username": "alice", "date": t.day(offset)})
    t.post(carol, "/api/like-day", "carol likes alice's day -4", json={"username": "alice", "date": t.day(-4)})
    t.get(alice, "/api/notifications/unread-count", "unread count 4")
    r = t.get(alice, "/api/notifications", "all notifications (newest first)")
    ids = [n["id"] for n in (r.get("notifications") or [])]
    t.get(alice, "/api/notifications?page=1&page_size=2", "page 1 of size 2")
    t.get(alice, "/api/notifications?page=2&page_size=2", "page 2 of size 2")
    t.get(alice, "/api/notifications?page=3&page_size=2", "page beyond the end")
    t.get(alice, "/api/notifications?page=0&page_size=0", "page=0 and page_size=0 fall back to defaults")
    t.get(alice, "/api/notifications?page=-1&page_size=-5", "negative values fall back to defaults")
    t.get(alice, "/api/notifications?page_size=51", "page_size above 50 is capped")
    t.get(alice, "/api/notifications?page=abc&page_size=xyz", "non-numeric values fall back to defaults")

    t.call(alice, "PATCH", "/api/notifications/abc/read", "mark read: invalid id")
    t.call(alice, "PATCH", "/api/notifications/-1/read", "mark read: negative id")
    t.call(alice, "PATCH", f"/api/notifications/{ids[0]}/read", "mark the newest as read")
    t.call(alice, "PATCH", f"/api/notifications/{ids[0]}/read", "mark it read again (idempotent)")
    t.call(alice, "PATCH", "/api/notifications/999999/read", "mark read: unknown id (still 200)")
    t.call(bob, "PATCH", f"/api/notifications/{ids[1]}/read", "bob marks alice's notification (no effect)")
    t.get(alice, "/api/notifications/unread-count", "unread count after marking one")
    t.get(alice, "/api/notifications?page_size=2", "read_at is set on the first")

    t.delete(alice, "/api/notifications/abc", "delete: invalid id")
    t.delete(alice, "/api/notifications/999999", "delete: unknown id")
    t.delete(bob, f"/api/notifications/{ids[1]}", "delete: someone else's notification")
    t.delete(alice, f"/api/notifications/{ids[1]}", "delete an unread notification")
    t.delete(alice, f"/api/notifications/{ids[1]}", "delete it again")
    t.get(alice, "/api/notifications/unread-count", "unread count after deleting one")

    t.call(alice, "PATCH", "/api/notifications/read-all", "mark all as read")
    t.call(alice, "PATCH", "/api/notifications/read-all", "mark all as read again")
    t.get(alice, "/api/notifications/unread-count", "unread count after read-all")
    t.get(alice, "/api/notifications", "everything read")
    t.call(bob, "PATCH", "/api/notifications/read-all", "read-all with no notifications")
    t.get(bob, "/api/notifications", "bob has no notifications")
    t.post(alice, "/api/notifications/read-all", "POST on a PATCH route")


@scenario("push_settings", "notifications")
def push_settings(t: Ctx) -> None:
    """VAPID key, subscription register/unregister, preferences, maintenance cleanup."""
    alice, bob = t.users("alice", "bob")
    anon = t.anon()
    t.get(anon, "/api/push/vapid-public-key", "VAPID public key (no auth needed)", auth=False)

    sub = "/api/push/subscriptions"
    endpoint = "https://fcm.googleapis.com/fcm/send/parity-endpoint-1"
    keys = {"p256dh": "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
            "auth": "tBHItJI5svbpez7KI4CCXg"}
    t.post(alice, sub, "register: invalid JSON", raw="{", content_type="application/json")
    t.post(alice, sub, "register: missing endpoint", json={"subscription": {"keys": keys}})
    t.post(alice, sub, "register: missing keys", json={"subscription": {"endpoint": endpoint}})
    t.post(alice, sub, "register: http endpoint", json={"subscription": {"endpoint": "http://push.example.com/x", "keys": keys}})
    t.post(alice, sub, "register: endpoint too long",
           json={"subscription": {"endpoint": "https://e.example/" + "a" * 2040, "keys": keys}})
    t.post(alice, sub, "register: success", json={
        "keyId": "parity-key-1", "subscription": {"endpoint": endpoint, "keys": keys},
        "device": {"userAgent": "Mozilla/5.0 (parity)", "platform": "windows", "browser": "chrome"}})
    t.post(alice, sub, "register the same endpoint again (upsert)", json={
        "keyId": "old-key", "subscription": {"endpoint": endpoint, "keys": keys}, "device": {"platform": "p" * 80}})
    t.post(bob, sub, "bob registers alice's endpoint (conflict)", json={"subscription": {"endpoint": endpoint, "keys": keys}})
    t.delete(alice, sub, "unregister: invalid JSON", raw="{", content_type="application/json")
    t.delete(alice, sub, "unregister: missing endpoint", json={})
    t.delete(bob, sub, "bob unregisters alice's endpoint (no-op)", json={"endpoint": endpoint})
    t.delete(alice, sub, "unregister", json={"endpoint": endpoint})
    t.delete(alice, sub, "unregister again", json={"endpoint": endpoint})
    t.post(bob, sub, "bob can register the endpoint now", json={"subscription": {"endpoint": endpoint, "keys": keys}})

    pref = "/api/push/preferences"
    t.get(alice, pref, "default preferences")
    t.put(alice, pref, "preferences: invalid JSON", raw="{", content_type="application/json")
    t.put(alice, pref, "preferences: unknown notification type", json={"preferences": {"new_follower": False}})
    t.put(alice, pref, "preferences: bad quiet_start", json={"quiet_start": "7:00"})
    t.put(alice, pref, "preferences: quiet_end out of range", json={"quiet_end": "24:00"})
    t.put(alice, pref, "preferences: invalid timezone", json={"timezone": "Mars/Olympus"})
    t.put(alice, pref, "preferences: empty timezone", json={"timezone": ""})
    t.put(alice, pref, "preferences: quiet hours without times", json={"quiet_hours_enabled": True})
    t.put(alice, pref, "preferences: full update", json={
        "push_enabled": False, "preferences": {"like_received": False, "streak_at_risk": True},
        "quiet_hours_enabled": True, "quiet_start": "22:30", "quiet_end": "07:15", "timezone": "America/New_York"})
    t.get(alice, pref, "preferences after the update")
    t.put(alice, pref, "preferences: partial update keeps the rest", json={"preferences": {"badge_unlocked": False}})
    t.put(alice, pref, "preferences: empty body changes nothing", json={})
    t.put(alice, pref, "preferences: timezone 'Local' is accepted", json={"timezone": "Local"})
    t.put(alice, pref, "preferences: re-enable", json={"push_enabled": True, "quiet_hours_enabled": False})

    cleanup = "/api/push/cleanup"
    t.post(alice, cleanup, "cleanup without the maintenance key")
    t.post(alice, cleanup, "cleanup with a wrong key", headers={"X-Maintenance-Key": "nope"})
    t.post(alice, cleanup, "cleanup with the right key", headers={"X-Maintenance-Key": "parity-maintenance-key"})
    t.post(anon, cleanup, "cleanup without a token (auth runs first)", auth=False,
           headers={"X-Maintenance-Key": "parity-maintenance-key"})


@scenario("push_unconfigured", "notifications", env={"MAINTENANCE_API_KEY": None, "VAPID_PUBLIC_KEY": None,
                                                    "VAPID_KEY_ID": None})
def push_unconfigured(t: Ctx) -> None:
    """Without VAPID keys / maintenance key configured."""
    alice, = t.users("alice")
    t.get(t.anon(), "/api/push/vapid-public-key", "VAPID key not configured", auth=False)
    t.post(alice, "/api/push/cleanup", "maintenance endpoints disabled",
           headers={"X-Maintenance-Key": "parity-maintenance-key"})
    t.post(alice, "/api/push/subscriptions", "register without a configured key id", json={
        "keyId": "anything", "subscription": {"endpoint": "https://push.example.com/abc", "keys": {"p256dh": "k", "auth": "a"}}})
