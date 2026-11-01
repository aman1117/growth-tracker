"""Dashboard tile configuration: GET/POST /api/tile-config and POST /api/tile-config/user."""

from __future__ import annotations

from harness.jsonx import JNum
from harness.runner import Ctx, scenario

U1, U2, U3, U4, U5, U6 = (Ctx.uuid(n) for n in range(1, 7))


def _tile(uid: str, name: str = "Guitar", icon: str = "Music", color: str = "#ff8800") -> dict:
    return {"id": uid, "name": name, "icon": icon, "color": color}


@scenario("tile_config", "tiles")
def tile_config(t: Ctx) -> None:
    """Save/get tile config (validation, JSONB round-trip of unknown keys and numbers), by username with privacy."""
    alice, bob, carol = t.users("alice", "bob", "carol")
    t.get(alice, "/api/tile-config", "no config yet (data null)")

    def save(name: str, config: object, actor=alice, **kw: object):
        return t.post(actor, "/api/tile-config", name, json={"config": config}, **kw)

    t.post(alice, "/api/tile-config", "invalid JSON", raw="{", content_type="application/json")
    t.post(alice, "/api/tile-config", "config is an array", json={"config": ["study"]})
    save("order is not an array", {"order": "study,sleep"})
    save("sizes has a non-string value", {"order": [], "sizes": {"study": 2}})
    save("six custom tiles", {"order": [], "customTiles": [_tile(u) for u in (U1, U2, U3, U4, U5, U6)]})
    save("custom tile without id", {"customTiles": [_tile("")]})
    save("custom tile with a non-UUID id", {"customTiles": [_tile("not-a-uuid")]})
    save("custom tile without name", {"customTiles": [_tile(U1, name="")]})
    save("custom tile name of 21 characters", {"customTiles": [_tile(U1, name="x" * 21)]})
    save("custom tile without icon", {"customTiles": [_tile(U1, icon="")]})
    save("custom tile with an invalid color", {"customTiles": [_tile(U1, color="orange")]})
    save("duplicate custom tile ids", {"customTiles": [_tile(U1), _tile(U1, name="Piano")]})
    save("invalid color override", {"order": ["study"], "colors": {"study": "#12345"}})
    save("empty color override", {"colors": {"study": ""}})

    full = {
        "order": ["study", "sleep", "custom:" + U1, "workout", "reels"],
        "sizes": {"study": "large", "sleep": "medium", "custom:" + U1: "small"},
        "hidden": ["reels"],
        "colors": {"study": "#0F0", "sleep": "#11223344"},
        "customTiles": [_tile(U1, name="Gitarre \U0001F3B8 \u00fcben", icon="Guitar", color="#ABCDEF"),
                        _tile(U2.upper(), name="x" * 20, icon="Star", color="#123")],
        "zExtra": {"nested": [1, JNum("2.50"), JNum("1e3"), JNum("12345678901234567890"), JNum("-0"), True, None],
                   "s": "kept"},
        "aFirst": 0.1,
    }
    save("full config with custom tiles and unknown keys", full)
    t.get(alice, "/api/tile-config", "config round-trip (key order, number formatting)")
    save("five custom tiles is the maximum", {"order": [], "customTiles": [_tile(u) for u in (U1, U2, U3, U4, U5)]})
    t.get(alice, "/api/tile-config", "after replacing the config")
    save("empty object", {})
    t.get(alice, "/api/tile-config", "after saving an empty object")
    save("null config", None)
    t.get(alice, "/api/tile-config", "after saving null")
    t.post(alice, "/api/tile-config", "missing config key", json={})
    t.get(alice, "/api/tile-config", "after saving without a config key")
    save("minimal config", {"order": ["sleep", "study"], "sizes": {}})

    t.post(bob, "/api/tile-config/user", "by username: invalid JSON", raw="{", content_type="application/json")
    t.post(bob, "/api/tile-config/user", "by username: missing username", json={})
    t.post(bob, "/api/tile-config/user", "by username: unknown user", json={"username": "ghost"})
    t.post(bob, "/api/tile-config/user", "by username: alice", json={"username": "alice"})
    t.post(bob, "/api/tile-config/user", "by username: user without config", json={"username": "carol"})
    t.post(bob, "/api/tile-config/user", "by username: own config", json={"username": "bob"})
    t.set_private(alice)
    t.post(bob, "/api/tile-config/user", "by username: private, not following", json={"username": "alice"})
    t.follow(bob, alice, "bob requests to follow alice")
    t.accept(alice, bob)
    t.post(bob, "/api/tile-config/user", "by username: private, following", json={"username": "alice"})
    t.post(carol, "/api/tile-config/user", "by username: upper-case username", json={"username": "ALICE"})
