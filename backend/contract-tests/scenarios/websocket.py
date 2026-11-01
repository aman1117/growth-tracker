"""WebSocket notifications: GET /api/ws/notifications?token=<jwt>."""

from __future__ import annotations

from harness.runner import Ctx, scenario


@scenario("websocket", "websocket", requires=("db",))
def websocket(t: Ctx) -> None:
    """Handshake errors (426/401), connected message, live notifications on every tab, 5-connection limit."""
    alice, bob = t.users("alice", "bob")
    t.get(alice, f"/api/ws/notifications?token={alice.token}", "plain GET without Upgrade", auth=False)
    t.ws(alice, "upgrade without token", token=None)
    t.ws(alice, "upgrade with an empty token", token="")
    t.ws(alice, "upgrade with a malformed token", token="not-a-jwt")
    t.ws(alice, "upgrade with an expired token", token=t.forge_token(alice.id, alice.username, ttl=-60))
    t.ws(alice, "upgrade with a token signed by another key",
         token=t.forge_token(alice.id, alice.username, secret="other-secret"))

    ws1 = t.ws(alice, "alice connects")
    assert ws1 is not None, "WebSocket handshake failed"
    ws1.recv("connected message")
    t.wait_ws_subscribed(alice, 1)
    t.post(bob, "/api/like-day", "bob likes alice's day", json={"username": "alice", "date": t.day(0)})
    ws1.recv("live notification pushed to alice")

    ws2 = t.ws(alice, "alice opens a second tab")
    assert ws2 is not None
    ws2.recv("connected message on the second tab")
    t.wait_ws_subscribed(alice, 2)
    t.post(bob, "/api/like-day", "bob likes another day", json={"username": "alice", "date": t.day(-3)})
    ws1.recv("first tab receives it")
    ws2.recv("second tab receives it")
    ws1.send('{"type":"pong"}')
    ws1.send("not json")

    extra = []
    for i in range(3, 6):
        s = t.ws(alice, f"alice opens tab {i}")
        assert s is not None
        s.recv(f"connected message on tab {i}")
        extra.append(s)
    s6 = t.ws(alice, "alice opens a sixth tab (limit is 5)")
    if s6 is not None:
        s6.recv("sixth tab gets an error message")
        s6.recv("sixth tab is closed by the server")
        s6.close()

    bob_ws = t.ws(bob, "bob connects (limits are per user)")
    assert bob_ws is not None
    bob_ws.recv("bob's connected message")
    t.wait_ws_subscribed(bob, 1)
    t.wait_ws_subscribed(alice, 5)
    t.post(alice, "/api/like-day", "alice likes bob's day", json={"username": "bob", "date": t.day(0)})
    bob_ws.recv("bob receives his notification")
    t.get(alice, "/api/notifications", "the pushed notifications are also listed")
    for s in [ws1, ws2, *extra, bob_ws]:
        s.close()
