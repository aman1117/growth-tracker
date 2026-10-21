package repository

import (
	"testing"
	"time"

	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func photoIDs(photos []models.ActivityPhoto) []uint {
	ids := make([]uint, len(photos))
	for i, p := range photos {
		ids[i] = p.ID
	}
	return ids
}

func setViewedAt(t *testing.T, db *gorm.DB, viewerID, photoID uint, at time.Time) {
	t.Helper()
	require.NoError(t, db.Exec("UPDATE story_views SET viewed_at = ? WHERE viewer_id = ? AND photo_id = ?", at, viewerID, photoID).Error)
}

func setLikedAt(t *testing.T, db *gorm.DB, likerID, photoID uint, at time.Time) {
	t.Helper()
	require.NoError(t, db.Exec("UPDATE story_likes SET liked_at = ? WHERE liker_id = ? AND photo_id = ?", at, likerID, photoID).Error)
}

func TestActivityPhotoRepository_GetDB(t *testing.T) {
	db := testutil.DB(t)
	assert.Same(t, db, NewActivityPhotoRepository(db).GetDB())
}

func TestActivityPhotoRepository_CreateAndGetByID(t *testing.T) {
	db := testutil.DB(t)
	repo := NewActivityPhotoRepository(db)
	user := testutil.CreateUser(t, db)
	photo := &models.ActivityPhoto{
		UserID:        user.ID,
		ActivityName:  "custom:3f2b8c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
		PhotoDate:     day,
		PhotoURL:      "https://blob.example.com/p.jpg",
		ThumbnailURL:  "https://blob.example.com/p_thumb.jpg",
		ActivityIcon:  testutil.Ptr("flower"),
		ActivityColor: testutil.Ptr("#00ff00"),
		ActivityLabel: testutil.Ptr("Yoga 🧘"),
	}

	require.NoError(t, repo.Create(photo))
	require.NotZero(t, photo.ID)

	got, err := repo.GetByID(photo.ID)
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, photo.PhotoURL, got.PhotoURL)
	assert.Equal(t, photo.ThumbnailURL, got.ThumbnailURL)
	assert.Equal(t, "2026-03-09", got.PhotoDate.Format(dateLayout))
	assert.Equal(t, photo.ActivityIcon, got.ActivityIcon)
	assert.Equal(t, photo.ActivityColor, got.ActivityColor)
	assert.Equal(t, photo.ActivityLabel, got.ActivityLabel)
	assert.WithinDuration(t, time.Now(), got.CreatedAt, time.Minute)

	duplicate := *photo
	duplicate.ID = 0
	assert.Error(t, repo.Create(&duplicate), "one photo per activity per day")

	got, err = repo.GetByID(9999)
	assert.NoError(t, err)
	assert.Nil(t, got)
}

func TestActivityPhotoRepository_ByUserAndDate(t *testing.T) {
	db := testutil.DB(t)
	repo := NewActivityPhotoRepository(db)
	user, other := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	mar8, mar10, mar12 := day.AddDate(0, 0, -1), day.AddDate(0, 0, 1), day.AddDate(0, 0, 3)
	workout := createPhoto(t, db, user.ID, "workout", day, t0)
	study := createPhoto(t, db, user.ID, "study", day, t0)
	earlier := createPhoto(t, db, user.ID, "sleep", mar8, t0)
	later := createPhoto(t, db, user.ID, "eating", mar10, t0)
	createPhoto(t, db, user.ID, "reels", mar12, t0)
	createPhoto(t, db, other.ID, "study", day, t0)

	got, err := repo.GetByUserAndDate(user.ID, day)
	require.NoError(t, err)
	assert.Equal(t, []uint{study.ID, workout.ID}, photoIDs(got), "ordered by activity name")

	got, err = repo.GetByUserAndDateRange(user.ID, mar8, mar10)
	require.NoError(t, err)
	assert.Equal(t, []uint{later.ID, study.ID, workout.ID, earlier.ID}, photoIDs(got),
		"inclusive range, newest day first then by activity name")

	got, err = repo.GetByUserAndDate(user.ID, day.AddDate(0, 0, 30))
	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestActivityPhotoRepository_ActivityNameOperations(t *testing.T) {
	db := testutil.DB(t)
	repo := NewActivityPhotoRepository(db)
	user, other := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	const tile = "custom:3f2b8c4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f"
	older := createPhoto(t, db, user.ID, tile, day.AddDate(0, 0, -2), t0)
	newer := createPhoto(t, db, user.ID, tile, day, t0)
	unrelated := createPhoto(t, db, user.ID, "study", day, t0)
	othersTile := createPhoto(t, db, other.ID, tile, day, t0)

	got, err := repo.GetByActivityName(user.ID, tile)
	require.NoError(t, err)
	assert.Equal(t, []uint{newer.ID, older.ID}, photoIDs(got), "newest first, own photos only")

	require.NoError(t, repo.UpdateLabelByActivityName(user.ID, tile, "Meditation"))
	got, err = repo.GetByActivityName(user.ID, tile)
	require.NoError(t, err)
	for _, p := range got {
		require.NotNil(t, p.ActivityLabel)
		assert.Equal(t, "Meditation", *p.ActivityLabel)
	}
	stillUnlabelled, err := repo.GetByID(othersTile.ID)
	require.NoError(t, err)
	assert.Nil(t, stillUnlabelled.ActivityLabel, "other users' photos keep their label")

	require.NoError(t, repo.DeleteByUserAndActivity(user.ID, tile))
	got, err = repo.GetByActivityName(user.ID, tile)
	require.NoError(t, err)
	assert.Empty(t, got)
	for _, id := range []uint{unrelated.ID, othersTile.ID} {
		p, err := repo.GetByID(id)
		require.NoError(t, err)
		assert.NotNil(t, p, "photo %d survives", id)
	}
}

func TestActivityPhotoRepository_ExistsAndGetExisting(t *testing.T) {
	db := testutil.DB(t)
	repo := NewActivityPhotoRepository(db)
	user := testutil.CreateUser(t, db)
	photo := createPhoto(t, db, user.ID, "study", day, t0)

	exists, err := repo.Exists(user.ID, "study", day)
	require.NoError(t, err)
	assert.True(t, exists)
	got, err := repo.GetExisting(user.ID, "study", day)
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, photo.ID, got.ID)

	for _, tc := range []struct {
		activity string
		date     time.Time
	}{{"sleep", day}, {"study", day.AddDate(0, 0, 1)}} {
		exists, err := repo.Exists(user.ID, tc.activity, tc.date)
		require.NoError(t, err)
		assert.False(t, exists)
		got, err := repo.GetExisting(user.ID, tc.activity, tc.date)
		require.NoError(t, err)
		assert.Nil(t, got)
	}
}

func TestActivityPhotoRepository_DeleteRemovesViewsAndLikes(t *testing.T) {
	db := testutil.DB(t)
	repo := NewActivityPhotoRepository(db)
	owner, viewer := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	photo := createPhoto(t, db, owner.ID, "study", day, t0)
	kept := createPhoto(t, db, owner.ID, "sleep", day, t0)
	require.NoError(t, repo.RecordView(viewer.ID, photo.ID))
	require.NoError(t, repo.LikePhoto(viewer.ID, photo.ID))

	require.NoError(t, repo.Delete(photo.ID))

	got, err := repo.GetByID(photo.ID)
	require.NoError(t, err)
	assert.Nil(t, got)
	got, err = repo.GetByID(kept.ID)
	require.NoError(t, err)
	assert.NotNil(t, got)
	views, err := repo.GetViewCount(photo.ID)
	require.NoError(t, err)
	assert.Zero(t, views, "views cascade")
	likes, err := repo.GetPhotoLikeCount(photo.ID)
	require.NoError(t, err)
	assert.Zero(t, likes, "likes cascade")
}

// storyFixture: viewer follows a and b (ACTIVE), has a pending request to c and does not
// follow d. a uploaded two photos on day, b one; everyone uploads something else too.
type storyFixture struct {
	viewer, a, b, c, d         *models.User
	a1, a2, b1, cPhoto, dPhoto *models.ActivityPhoto
	aOtherDay, viewerOwnPhoto  *models.ActivityPhoto
}

func newStoryFixture(t *testing.T, db *gorm.DB) storyFixture {
	t.Helper()
	f := storyFixture{
		viewer: testutil.CreateUser(t, db),
		a:      testutil.CreateUser(t, db, withAvatar),
		b:      testutil.CreateUser(t, db),
		c:      testutil.CreateUser(t, db, private),
		d:      testutil.CreateUser(t, db),
	}
	follow(t, db, f.viewer.ID, f.a.ID, models.FollowStateActive, t0)
	follow(t, db, f.viewer.ID, f.b.ID, models.FollowStateActive, t0)
	follow(t, db, f.viewer.ID, f.c.ID, models.FollowStatePending, t0)
	f.a1 = createPhoto(t, db, f.a.ID, "study", day, t0.Add(1*time.Minute))
	f.b1 = createPhoto(t, db, f.b.ID, "workout", day, t0.Add(2*time.Minute))
	f.a2 = createPhoto(t, db, f.a.ID, "sleep", day, t0.Add(3*time.Minute))
	f.cPhoto = createPhoto(t, db, f.c.ID, "study", day, t0.Add(4*time.Minute))
	f.dPhoto = createPhoto(t, db, f.d.ID, "study", day, t0.Add(5*time.Minute))
	f.aOtherDay = createPhoto(t, db, f.a.ID, "reels", day.AddDate(0, 0, -1), t0.Add(6*time.Minute))
	f.viewerOwnPhoto = createPhoto(t, db, f.viewer.ID, "study", day, t0.Add(7*time.Minute))
	return f
}

func TestActivityPhotoRepository_GetFollowingPhotos(t *testing.T) {
	db := testutil.DB(t)
	repo := NewActivityPhotoRepository(db)
	f := newStoryFixture(t, db)

	got, err := repo.GetFollowingPhotos(f.viewer.ID, day, 10, 0)
	require.NoError(t, err)
	assert.Equal(t, []uint{f.a2.ID, f.b1.ID, f.a1.ID}, photoIDs(got),
		"only accepted follows on that day, newest upload first")
	assert.Equal(t, f.a2.PhotoURL, got[0].PhotoURL)

	got, err = repo.GetFollowingPhotos(f.viewer.ID, day, 1, 1)
	require.NoError(t, err)
	assert.Equal(t, []uint{f.b1.ID}, photoIDs(got), "limit and offset")

	got, err = repo.GetFollowingPhotos(f.d.ID, day, 10, 0)
	require.NoError(t, err)
	assert.Empty(t, got, "users who follow nobody see nothing")
}

func TestActivityPhotoRepository_GetFollowingPhotosGrouped(t *testing.T) {
	db := testutil.DB(t)
	repo := NewActivityPhotoRepository(db)
	f := newStoryFixture(t, db)
	require.NoError(t, repo.RecordView(f.viewer.ID, f.a1.ID))
	require.NoError(t, repo.RecordView(f.viewer.ID, f.b1.ID))

	groups, err := repo.GetFollowingPhotosGrouped(f.viewer.ID, day, 10)

	require.NoError(t, err)
	require.Len(t, groups, 2)
	first, second := groups[0], groups[1]
	assert.Equal(t, f.a.ID, first.UserID, "users with the most recent upload come first")
	assert.Equal(t, f.a.Username, first.Username)
	assert.Equal(t, f.a.ProfilePic, first.ProfilePic)
	assert.Equal(t, f.a.ProfilePicThumb, first.ProfilePicThumb)
	require.Len(t, first.Photos, 2)
	assert.Equal(t, f.a1.ID, first.Photos[0].ID, "oldest photo first within a story")
	assert.True(t, first.Photos[0].Viewed)
	assert.Equal(t, f.a2.ID, first.Photos[1].ID)
	assert.False(t, first.Photos[1].Viewed)
	assert.True(t, first.HasUnseen)

	assert.Equal(t, f.b.ID, second.UserID)
	assert.Nil(t, second.ProfilePic)
	require.Len(t, second.Photos, 1)
	assert.True(t, second.Photos[0].Viewed)
	assert.False(t, second.HasUnseen, "every photo was viewed")

	groups, err = repo.GetFollowingPhotosGrouped(f.viewer.ID, day, 1)
	require.NoError(t, err)
	require.Len(t, groups, 1)
	assert.Equal(t, f.a.ID, groups[0].UserID)

	groups, err = repo.GetFollowingPhotosGrouped(f.viewer.ID, day.AddDate(0, 0, 5), 10)
	require.NoError(t, err)
	assert.Empty(t, groups)
}

func TestActivityPhotoRepository_GetFollowingPhotosGrouped_QueryFailures(t *testing.T) {
	db := testutil.DB(t)
	f := newStoryFixture(t, db)

	t.Run("story owners lookup fails", func(t *testing.T) {
		repo := NewActivityPhotoRepository(faultyDB(t, sqlContains("latest_upload")))
		groups, err := repo.GetFollowingPhotosGrouped(f.viewer.ID, day, 10)
		assert.ErrorIs(t, err, errInjected)
		assert.Nil(t, groups)
	})

	t.Run("a user lookup fails", func(t *testing.T) {
		repo := NewActivityPhotoRepository(faultyDB(t, nth(1, sqlContains("FROM users WHERE id"))))
		groups, err := repo.GetFollowingPhotosGrouped(f.viewer.ID, day, 10)
		require.NoError(t, err)
		require.Len(t, groups, 1, "the failing user's story is skipped")
		assert.Equal(t, f.b.ID, groups[0].UserID)
	})

	t.Run("a photos lookup fails", func(t *testing.T) {
		repo := NewActivityPhotoRepository(faultyDB(t, nth(2, on("query", "activity_photos"))))
		groups, err := repo.GetFollowingPhotosGrouped(f.viewer.ID, day, 10)
		require.NoError(t, err)
		require.Len(t, groups, 1)
		assert.Equal(t, f.a.ID, groups[0].UserID)
	})
}

// ==================== Views ====================

func TestActivityPhotoRepository_Views(t *testing.T) {
	db := testutil.DB(t)
	repo := NewActivityPhotoRepository(db)
	owner := testutil.CreateUser(t, db)
	alice := namedUser(t, db, "alice", withAvatar)
	bob := namedUser(t, db, "bob")
	carol := namedUser(t, db, "carol")
	photo := createPhoto(t, db, owner.ID, "study", day, t0)
	other := createPhoto(t, db, owner.ID, "sleep", day, t0)

	for _, u := range []*models.User{alice, bob, carol} {
		require.NoError(t, repo.RecordView(u.ID, photo.ID))
	}
	require.NoError(t, repo.RecordView(alice.ID, photo.ID), "repeat views are ignored")
	require.NoError(t, repo.RecordView(bob.ID, other.ID))
	setViewedAt(t, db, alice.ID, photo.ID, t0.Add(3*time.Minute))
	setViewedAt(t, db, bob.ID, photo.ID, t0.Add(1*time.Minute))
	setViewedAt(t, db, carol.ID, photo.ID, t0.Add(2*time.Minute))

	viewed, err := repo.HasViewed(alice.ID, photo.ID)
	require.NoError(t, err)
	assert.True(t, viewed)
	viewed, err = repo.HasViewed(carol.ID, other.ID)
	require.NoError(t, err)
	assert.False(t, viewed)

	count, err := repo.GetViewCount(photo.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(3), count, "each viewer counts once")

	viewers, total, err := repo.GetViewers(photo.ID, 2, 0)
	require.NoError(t, err)
	assert.Equal(t, int64(3), total)
	require.Len(t, viewers, 2)
	assert.Equal(t, models.PhotoViewer{
		UserID: alice.ID, Username: "alice", ProfilePic: alice.ProfilePic, ProfilePicThumb: alice.ProfilePicThumb,
		ViewedAt: viewers[0].ViewedAt,
	}, viewers[0])
	assert.True(t, viewers[0].ViewedAt.Equal(t0.Add(3*time.Minute)), "most recent first")
	assert.Equal(t, carol.ID, viewers[1].UserID)

	viewers, total, err = repo.GetViewers(photo.ID, 2, 2)
	require.NoError(t, err)
	assert.Equal(t, int64(3), total)
	require.Len(t, viewers, 1)
	assert.Equal(t, bob.ID, viewers[0].UserID)

	ids, err := repo.GetViewedPhotoIDs(bob.ID, []uint{photo.ID, other.ID, 9999})
	require.NoError(t, err)
	assert.ElementsMatch(t, []uint{photo.ID, other.ID}, ids)
	ids, err = repo.GetViewedPhotoIDs(carol.ID, []uint{other.ID})
	require.NoError(t, err)
	assert.Empty(t, ids)
	ids, err = repo.GetViewedPhotoIDs(carol.ID, nil)
	require.NoError(t, err)
	assert.NotNil(t, ids)
	assert.Empty(t, ids)
}

// ==================== Likes ====================

func TestActivityPhotoRepository_Likes(t *testing.T) {
	db := testutil.DB(t)
	repo := NewActivityPhotoRepository(db)
	owner := testutil.CreateUser(t, db)
	alice, bob := namedUser(t, db, "alice", withAvatar), namedUser(t, db, "bob")
	photo := createPhoto(t, db, owner.ID, "study", day, t0)
	other := createPhoto(t, db, owner.ID, "sleep", day, t0)

	require.NoError(t, repo.LikePhoto(alice.ID, photo.ID))
	require.NoError(t, repo.LikePhoto(alice.ID, photo.ID), "liking twice is not an error")
	require.NoError(t, repo.LikePhoto(bob.ID, photo.ID))
	require.NoError(t, repo.LikePhoto(bob.ID, other.ID))
	setLikedAt(t, db, alice.ID, photo.ID, t0.Add(1*time.Minute))
	setLikedAt(t, db, bob.ID, photo.ID, t0.Add(2*time.Minute))

	count, err := repo.GetPhotoLikeCount(photo.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), count)

	liked, err := repo.HasLikedPhoto(alice.ID, photo.ID)
	require.NoError(t, err)
	assert.True(t, liked)
	liked, err = repo.HasLikedPhoto(alice.ID, other.ID)
	require.NoError(t, err)
	assert.False(t, liked)

	likers, total, err := repo.GetPhotoLikers(photo.ID, 10, 0)
	require.NoError(t, err)
	assert.Equal(t, int64(2), total)
	require.Len(t, likers, 2)
	assert.Equal(t, bob.ID, likers[0].UserID, "most recent first")
	assert.Equal(t, models.PhotoLiker{
		UserID: alice.ID, Username: "alice", ProfilePic: alice.ProfilePic, ProfilePicThumb: alice.ProfilePicThumb,
		LikedAt: likers[1].LikedAt,
	}, likers[1])
	assert.True(t, likers[1].LikedAt.Equal(t0.Add(time.Minute)))

	likers, total, err = repo.GetPhotoLikers(photo.ID, 1, 1)
	require.NoError(t, err)
	assert.Equal(t, int64(2), total)
	require.Len(t, likers, 1)
	assert.Equal(t, alice.ID, likers[0].UserID)

	ids, err := repo.GetLikedPhotoIDs(bob.ID, []uint{photo.ID, other.ID})
	require.NoError(t, err)
	assert.ElementsMatch(t, []uint{photo.ID, other.ID}, ids)
	ids, err = repo.GetLikedPhotoIDs(alice.ID, nil)
	require.NoError(t, err)
	assert.NotNil(t, ids)
	assert.Empty(t, ids)

	require.NoError(t, repo.UnlikePhoto(alice.ID, photo.ID))
	require.NoError(t, repo.UnlikePhoto(alice.ID, photo.ID), "unliking twice is not an error")
	liked, err = repo.HasLikedPhoto(alice.ID, photo.ID)
	require.NoError(t, err)
	assert.False(t, liked)
	count, err = repo.GetPhotoLikeCount(photo.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(1), count)
}

func TestActivityPhotoRepository_LikePhoto_MissingPhoto(t *testing.T) {
	db := testutil.DB(t)
	repo := NewActivityPhotoRepository(db)
	user := testutil.CreateUser(t, db)

	assert.Error(t, repo.LikePhoto(user.ID, 9999), "only duplicate likes are swallowed")
}

func TestActivityPhotoRepository_GetPhotoInteractions(t *testing.T) {
	db := testutil.DB(t)
	repo := NewActivityPhotoRepository(db)
	owner := testutil.CreateUser(t, db)
	viewer, liker, both := namedUser(t, db, "viewer"), namedUser(t, db, "liker", withAvatar), namedUser(t, db, "both")
	photo := createPhoto(t, db, owner.ID, "study", day, t0)
	other := createPhoto(t, db, owner.ID, "sleep", day, t0)

	require.NoError(t, repo.RecordView(viewer.ID, photo.ID))
	setViewedAt(t, db, viewer.ID, photo.ID, t0.Add(1*time.Minute))
	require.NoError(t, repo.LikePhoto(liker.ID, photo.ID))
	setLikedAt(t, db, liker.ID, photo.ID, t0.Add(3*time.Minute))
	require.NoError(t, repo.RecordView(both.ID, photo.ID))
	setViewedAt(t, db, both.ID, photo.ID, t0.Add(2*time.Minute))
	require.NoError(t, repo.LikePhoto(both.ID, photo.ID))
	setLikedAt(t, db, both.ID, photo.ID, t0.Add(4*time.Minute))
	require.NoError(t, repo.RecordView(owner.ID, other.ID))

	got, total, err := repo.GetPhotoInteractions(photo.ID, 10, 0)

	require.NoError(t, err)
	assert.Equal(t, int64(3), total, "distinct users who viewed or liked")
	require.Len(t, got, 3)
	assert.Equal(t, both.ID, got[0].UserID, "ordered by latest interaction")
	assert.Equal(t, "both", got[0].InteractionType)
	assert.True(t, got[0].ViewedAt.Equal(t0.Add(2*time.Minute)))
	assert.True(t, got[0].LikedAt.Equal(t0.Add(4*time.Minute)))

	assert.Equal(t, liker.ID, got[1].UserID)
	assert.Equal(t, "like", got[1].InteractionType)
	assert.Equal(t, "liker", got[1].Username)
	assert.Equal(t, liker.ProfilePic, got[1].ProfilePic)
	assert.True(t, got[1].ViewedAt.IsZero(), "never viewed")

	assert.Equal(t, viewer.ID, got[2].UserID)
	assert.Equal(t, "view", got[2].InteractionType)
	assert.True(t, got[2].LikedAt.IsZero(), "never liked")

	got, total, err = repo.GetPhotoInteractions(photo.ID, 1, 1)
	require.NoError(t, err)
	assert.Equal(t, int64(3), total)
	require.Len(t, got, 1)
	assert.Equal(t, liker.ID, got[0].UserID)
}

func TestActivityPhotoRepository_DatabaseErrors(t *testing.T) {
	repo := NewActivityPhotoRepository(testutil.BrokenDB(t))

	ids, err := repo.GetViewedPhotoIDs(1, nil)
	assert.NoError(t, err, "no query for an empty list")
	assert.Empty(t, ids)
	ids, err = repo.GetLikedPhotoIDs(1, nil)
	assert.NoError(t, err)
	assert.Empty(t, ids)

	calls := map[string]func() error{
		"Create": func() error {
			return repo.Create(&models.ActivityPhoto{UserID: 1, ActivityName: "study", PhotoDate: day, PhotoURL: "u", ThumbnailURL: "t"})
		},
		"GetByID":                   func() error { _, err := repo.GetByID(1); return err },
		"GetByUserAndDate":          func() error { _, err := repo.GetByUserAndDate(1, day); return err },
		"GetByUserAndDateRange":     func() error { _, err := repo.GetByUserAndDateRange(1, day, day); return err },
		"UpdateLabelByActivityName": func() error { return repo.UpdateLabelByActivityName(1, "study", "x") },
		"GetByActivityName":         func() error { _, err := repo.GetByActivityName(1, "study"); return err },
		"GetFollowingPhotos":        func() error { _, err := repo.GetFollowingPhotos(1, day, 10, 0); return err },
		"GetFollowingPhotosGrouped": func() error { _, err := repo.GetFollowingPhotosGrouped(1, day, 10); return err },
		"Delete":                    func() error { return repo.Delete(1) },
		"DeleteByUserAndActivity":   func() error { return repo.DeleteByUserAndActivity(1, "study") },
		"Exists":                    func() error { _, err := repo.Exists(1, "study", day); return err },
		"GetExisting":               func() error { _, err := repo.GetExisting(1, "study", day); return err },
		"RecordView":                func() error { return repo.RecordView(1, 1) },
		"HasViewed":                 func() error { _, err := repo.HasViewed(1, 1); return err },
		"GetViewers":                func() error { _, _, err := repo.GetViewers(1, 10, 0); return err },
		"GetViewCount":              func() error { _, err := repo.GetViewCount(1); return err },
		"GetViewedPhotoIDs":         func() error { _, err := repo.GetViewedPhotoIDs(1, []uint{1}); return err },
		"LikePhoto":                 func() error { return repo.LikePhoto(1, 1) },
		"UnlikePhoto":               func() error { return repo.UnlikePhoto(1, 1) },
		"HasLikedPhoto":             func() error { _, err := repo.HasLikedPhoto(1, 1); return err },
		"GetPhotoLikers":            func() error { _, _, err := repo.GetPhotoLikers(1, 10, 0); return err },
		"GetPhotoLikeCount":         func() error { _, err := repo.GetPhotoLikeCount(1); return err },
		"GetLikedPhotoIDs":          func() error { _, err := repo.GetLikedPhotoIDs(1, []uint{1}); return err },
		"GetPhotoInteractions":      func() error { _, _, err := repo.GetPhotoInteractions(1, 10, 0); return err },
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) { assert.Error(t, call()) })
	}
}
