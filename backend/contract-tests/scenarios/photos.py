"""Profile pictures and activity photos (stories). Needs the Azure Blob emulator (Azurite).

Uploaded images are generated PNGs; the stored blobs are fetched back from the emulator and
their format and dimensions are recorded (re-encoded JPEG bytes are not compared).
"""

from __future__ import annotations

from harness.images import png
from harness.runner import Ctx, scenario

BIG = png(1600, 900)
SMALL = png(40, 30, (250, 200, 10))
NOT_AN_IMAGE = b"this is not an image"
U1 = Ctx.uuid(1)


@scenario("profile_picture", "photos", requires=("azurite", "db"))
def profile_picture(t: Ctx) -> None:
    """Upload (validation, resize, thumbnail, replace deletes old blobs) and delete the profile picture."""
    alice, = t.users("alice")
    up = "/api/profile/upload-picture"
    t.post(alice, up, "upload: JSON body instead of multipart", json={"image": "x"})
    t.post(alice, up, "upload: multipart without image", form={"other": "1"})
    t.post(alice, up, "upload: .gif extension", files={"image": ("pic.gif", BIG, "image/gif")})
    t.post(alice, up, "upload: not an image", files={"image": ("pic.png", NOT_AN_IMAGE, "image/png")})
    r = t.post(alice, up, "upload a 1600x900 PNG", files={"image": ("me.png", BIG, "image/png")})
    first_full, first_thumb = r.get("profile_pic"), r.get("profile_pic_thumb")
    t.observe_blob("stored full-size picture", first_full)
    t.observe_blob("stored thumbnail", first_thumb)
    t.get(alice, "/api/profile", "profile has picture URLs")
    r = t.post(alice, up, "replace with a small PNG (upper-case extension)",
               files={"image": ("SMALL.PNG", SMALL, "image/png")})
    t.observe_blob("old full-size picture was deleted", first_full)
    t.observe_blob("old thumbnail was deleted", first_thumb)
    t.observe_blob("new full-size picture (not upscaled)", r.get("profile_pic"))
    t.observe_blob("new thumbnail", r.get("profile_pic_thumb"))
    bob, = t.users("bob")
    t.get(bob, f"/api/users/{alice.id}/profile", "public profile shows the picture")
    t.get(bob, "/api/autocomplete/users?q=alice", "autocomplete shows the picture")
    t.post(bob, "/api/users", "search shows the picture", json={"username": "alice"})
    last = r.get("profile_pic")
    t.delete(alice, "/api/profile/picture", "delete the picture")
    t.observe_blob("deleted picture is gone", last)
    t.get(alice, "/api/profile", "profile without picture")
    t.delete(alice, "/api/profile/picture", "delete again")


@scenario("activity_photos", "photos", requires=("azurite", "db"))
def activity_photos(t: Ctx) -> None:
    """Upload/list/stories/views/likes/interactions/delete of activity photos, label cascade, debounced notification."""
    alice, bob, carol, dave = t.users("alice", "bob", "carol", "dave")
    t.set_private(carol)
    t.follow(bob, alice)
    t.follow(dave, alice)
    today = t.day(0)
    up = "/api/activity-photo"

    def upload(actor, name, fields, image=("photo.png", BIG, "image/png")):
        files = {"image": image} if image else None
        return t.post(actor, up, name, form=fields, files=files)

    upload(alice, "upload: missing activity_name", {"photo_date": today})
    upload(alice, "upload: missing photo_date", {"activity_name": "study"})
    upload(alice, "upload: invalid date", {"activity_name": "study", "photo_date": "today"})
    upload(alice, "upload: no image", {"activity_name": "study", "photo_date": today}, image=None)
    upload(alice, "upload: future date", {"activity_name": "study", "photo_date": t.day(1)})
    upload(alice, "upload: 8 days ago", {"activity_name": "study", "photo_date": t.day(-8)})
    upload(alice, "upload: not an image", {"activity_name": "study", "photo_date": today},
           image=("x.png", NOT_AN_IMAGE, "image/png"))
    r = upload(alice, "alice uploads a study photo for today", {"activity_name": "study", "photo_date": today})
    p1 = r.need("photo.id")
    t.observe_blob("stored photo", r.get("photo.photo_url"))
    t.observe_blob("stored photo thumbnail", r.get("photo.thumbnail_url"))
    upload(alice, "same activity and date again (conflict)", {"activity_name": "study", "photo_date": today})
    t.post(alice, "/api/tile-config", "alice defines a custom tile", json={"config": {
        "order": ["custom:" + U1], "customTiles": [{"id": U1, "name": "Guitar", "icon": "Music", "color": "#FF8800"}]}})
    r = upload(alice, "photo for a custom tile with metadata", {
        "activity_name": "custom:" + U1, "photo_date": t.day(-7), "activity_icon": "Music",
        "activity_color": "#FF8800", "activity_label": "Guitar"}, image=("g.png", SMALL, "image/png"))
    p2 = r.get("photo.id")
    upload(carol, "carol (private) uploads a photo", {"activity_name": "workout", "photo_date": today})

    photos = "/api/activity-photos"
    t.get(alice, photos, "list: missing params")
    t.get(alice, f"{photos}?user_id=abc&date={today}", "list: invalid user_id")
    t.get(alice, f"{photos}?user_id={alice.id}&date=bad", "list: invalid date")
    t.get(alice, f"{photos}?user_id={alice.id}&date={today}", "own photos of today")
    t.get(bob, f"{photos}?user_id={alice.id}&date={today}", "follower bob lists alice's photos")
    t.get(carol, f"{photos}?user_id={alice.id}&date={today}", "non-follower carol lists public alice's photos")
    t.get(bob, f"{photos}?user_id={carol.id}&date={today}", "bob lists private carol's photos (not following)")
    t.get(bob, f"{photos}?user_id=999999&date={today}", "photos of an unknown user")

    stories = "/api/activity-photos/following"
    t.get(bob, stories, "stories: missing date")
    t.get(bob, f"{stories}?date=bad", "stories: invalid date")
    t.get(bob, f"{stories}?date={today}", "bob's stories from people he follows")
    t.get(bob, f"{stories}?date={today}&limit=1", "stories with limit 1")
    t.get(bob, f"{stories}?date={today}&limit=abc", "stories with a non-numeric limit")
    t.get(carol, f"{stories}?date={today}", "carol follows nobody")

    t.post(bob, f"/api/activity-photo/{p1}/view", "bob views alice's photo")
    t.post(bob, f"/api/activity-photo/{p1}/view", "bob views it again")
    t.post(alice, f"/api/activity-photo/{p1}/view", "alice views her own photo")
    t.post(dave, f"/api/activity-photo/{p1}/view", "dave views it")
    t.post(bob, "/api/activity-photo/abc/view", "view: invalid id")
    t.post(bob, "/api/activity-photo/999999/view", "view: unknown photo")
    t.get(bob, f"{stories}?date={today}", "stories show what bob has viewed")

    t.post(bob, f"/api/activity-photo/{p1}/like", "bob likes alice's photo")
    t.post(bob, f"/api/activity-photo/{p1}/like", "bob likes it again")
    t.post(alice, f"/api/activity-photo/{p1}/like", "alice likes her own photo")
    t.post(carol, f"/api/activity-photo/{p1}/like", "carol (not following) likes alice's photo")
    t.post(bob, "/api/activity-photo/abc/like", "like: invalid id")
    t.post(bob, "/api/activity-photo/999999/like", "like: unknown photo")
    t.quiesce()
    t.get(bob, f"/api/activity-photo/{p1}/like-status", "like status for bob")
    t.get(dave, f"/api/activity-photo/{p1}/like-status", "like status for dave")
    t.get(dave, "/api/activity-photo/abc/like-status", "like status: invalid id")
    t.get(dave, "/api/activity-photo/999999/like-status", "like status: unknown photo")

    t.get(alice, f"/api/activity-photo/{p1}/viewers", "viewers (owner)")
    t.get(alice, f"/api/activity-photo/{p1}/viewers?limit=1&offset=1", "viewers limit/offset")
    t.get(bob, f"/api/activity-photo/{p1}/viewers", "viewers: not the owner")
    t.get(alice, "/api/activity-photo/999999/viewers", "viewers: unknown photo")
    t.get(alice, "/api/activity-photo/abc/viewers", "viewers: invalid id")
    t.get(alice, f"/api/activity-photo/{p1}/interactions", "interactions (views + likes)")
    t.get(alice, f"/api/activity-photo/{p1}/interactions?limit=1", "interactions limit 1")
    t.get(bob, f"/api/activity-photo/{p1}/interactions", "interactions: not the owner")
    t.get(alice, "/api/activity-photo/999999/interactions", "interactions: unknown photo")

    t.delete(bob, f"/api/activity-photo/{p1}/like", "bob unlikes")
    t.delete(bob, f"/api/activity-photo/{p1}/like", "bob unlikes again")
    t.delete(bob, "/api/activity-photo/abc/like", "unlike: invalid id")
    t.delete(bob, "/api/activity-photo/999999/like", "unlike: unknown photo")
    t.get(bob, f"/api/activity-photo/{p1}/like-status", "like status after unlike")
    t.get(alice, "/api/notifications", "alice's story-like notification")

    # Renaming a custom tile renames the label stored on its photos
    t.post(alice, "/api/tile-config", "alice renames the custom tile", json={"config": {
        "order": ["custom:" + U1], "customTiles": [{"id": U1, "name": "Piano", "icon": "Music", "color": "#FF8800"}]}})
    t.get(alice, f"{photos}?user_id={alice.id}&date={t.day(-7)}", "the photo label follows the tile name")

    # Followers are notified about new photos after a 30s debounce window
    t.wait_sql("photo-uploaded notification for bob",
               "SELECT count(*) FROM notifications WHERE user_id = %s AND type = 'photo_uploaded'", (bob.id,),
               until=lambda v: v is not None and v >= 1, timeout=45)
    t.quiesce()
    t.get(bob, "/api/notifications", "bob is told that alice posted photos")

    t.delete(bob, f"/api/activity-photo/{p1}", "delete: not the owner")
    t.delete(alice, "/api/activity-photo/abc", "delete: invalid id")
    t.delete(alice, "/api/activity-photo/999999", "delete: unknown photo")
    t.delete(alice, f"/api/activity-photo/{p1}", "alice deletes her photo")
    t.delete(alice, f"/api/activity-photo/{p1}", "delete it again")
    t.get(alice, f"{photos}?user_id={alice.id}&date={today}", "photos after deletion")
    if p2:
        t.get(alice, f"/api/activity-photo/{p2}/like-status", "like status of the other photo")
