package services

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	pkgredis "github.com/aman1117/backend/pkg/redis"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

const photoContainer = "profile-pictures"

// photoDeps selects the database behind each repository of an ActivityPhotoService.
type photoDeps struct{ photos, users, follows, notifs *gorm.DB }

func allPhotoDeps(db *gorm.DB) photoDeps { return photoDeps{db, db, db, db} }

func newPhotoService(t *testing.T, db *gorm.DB, store *fakeBlobStore) *ActivityPhotoService {
	t.Helper()
	return newPhotoServiceFrom(t, allPhotoDeps(db), store)
}

// newPhotoServiceFrom builds an ActivityPhotoService (with blob storage on store, if any) and
// makes sure no debounced notification fires after the test.
func newPhotoServiceFrom(t *testing.T, deps photoDeps, store *fakeBlobStore) *ActivityPhotoService {
	t.Helper()
	cfg := &config.AzureStorageConfig{AccountName: "growthacct", ContainerName: photoContainer}
	if store != nil {
		cfg.ConnectionString = store.connectionString(t)
	}
	svc, err := NewActivityPhotoService(
		repository.NewActivityPhotoRepository(deps.photos),
		repository.NewUserRepository(deps.users),
		repository.NewFollowRepository(deps.follows),
		newNotificationService(deps.notifs),
		cfg,
	)
	require.NoError(t, err)
	t.Cleanup(func() { stopPhotoTimers(t, svc) })
	return svc
}

// stopPhotoTimers waits for scheduling goroutines, then stops every pending debounce timer.
func stopPhotoTimers(t *testing.T, svc *ActivityPhotoService) {
	waitForAsync(t)
	svc.notificationMutex.Lock()
	defer svc.notificationMutex.Unlock()
	for id, pending := range svc.pendingNotifications {
		pending.timer.Stop()
		delete(svc.pendingNotifications, id)
	}
}

func pendingFor(svc *ActivityPhotoService, uploaderID uint) (pendingPhotoNotification, bool) {
	svc.notificationMutex.Lock()
	defer svc.notificationMutex.Unlock()
	p, ok := svc.pendingNotifications[uploaderID]
	if !ok {
		return pendingPhotoNotification{}, false
	}
	return *p, true
}

func photoURL(userID uint, date time.Time, activity, file string) string {
	return fmt.Sprintf("http://localhost:10000/%s/%s/activity-photos/%d/%s/%s/%s",
		blobAccount, photoContainer, userID, date.Format(constants.DateFormat), activity, file)
}

func photoBlob(userID uint, date time.Time, activity, file string) string {
	return fmt.Sprintf("activity-photos/%d/%s/%s/%s", userID, date.Format(constants.DateFormat), activity, file)
}

func seedPhoto(t *testing.T, db *gorm.DB, userID uint, activity string, date time.Time) *models.ActivityPhoto {
	t.Helper()
	p := &models.ActivityPhoto{
		UserID:       userID,
		ActivityName: activity,
		PhotoDate:    date,
		PhotoURL:     photoURL(userID, date, activity, "full.jpg"),
		ThumbnailURL: photoURL(userID, date, activity, "thumb.jpg"),
	}
	require.NoError(t, db.Create(p).Error)
	return p
}

func methodsAndNames(calls []blobCall) []string {
	var out []string
	for _, c := range calls {
		out = append(out, c.Method+" "+c.Name)
	}
	return out
}

func TestNewActivityPhotoService(t *testing.T) {
	cfg := &config.AzureStorageConfig{ContainerName: photoContainer, AccountName: "acct"}
	svc, err := NewActivityPhotoService(nil, nil, nil, nil, cfg)
	require.NoError(t, err)
	assert.Nil(t, svc.blobClient, "blob storage is optional")
	assert.Equal(t, photoContainer, svc.container)
	assert.Equal(t, "acct", svc.accountName)

	store := newFakeBlobStore(t, photoContainer)
	cfg.ConnectionString = store.connectionString(t)
	svc, err = NewActivityPhotoService(nil, nil, nil, nil, cfg)
	require.NoError(t, err)
	assert.NotNil(t, svc.blobClient)

	cfg.ConnectionString = "not-a-connection-string"
	_, err = NewActivityPhotoService(nil, nil, nil, nil, cfg)
	assert.ErrorContains(t, err, "failed to create blob client")
}

func TestActivityPhotoService_ValidatePhotoDate(t *testing.T) {
	svc := &ActivityPhotoService{}
	today := todayIST()
	assert.NoError(t, svc.validatePhotoDate(today))
	assert.NoError(t, svc.validatePhotoDate(today.AddDate(0, 0, -7)), "seven days back is still allowed")
	assert.EqualError(t, svc.validatePhotoDate(today.AddDate(0, 0, -8)), "can only upload photos for the last 7 days")
	assert.EqualError(t, svc.validatePhotoDate(today.AddDate(0, 0, 1)), "cannot upload photo for future date")
}

func TestActivityPhotoService_BlobURLs(t *testing.T) {
	svc := &ActivityPhotoService{container: photoContainer, accountName: "growthacct"}
	assert.Equal(t, "http://localhost:10000/devstoreaccount1/profile-pictures/a/b.jpg", svc.generateBlobURL("a/b.jpg"))

	previous := config.AppConfig
	t.Cleanup(func() { config.AppConfig = previous })
	prod := *previous
	prod.Env = "production"
	config.AppConfig = &prod
	assert.Equal(t, "https://growthacct.blob.core.windows.net/profile-pictures/a/b.jpg", svc.generateBlobURL("a/b.jpg"))
	config.AppConfig = nil
	assert.Equal(t, "https://growthacct.blob.core.windows.net/profile-pictures/a/b.jpg", svc.generateBlobURL("a/b.jpg"))

	assert.Equal(t, "activity-photos/1/x.jpg",
		svc.extractBlobName("https://growthacct.blob.core.windows.net/profile-pictures/activity-photos/1/x.jpg"))
	assert.Empty(t, svc.extractBlobName("https://elsewhere.example.com/x.jpg"))
}

func TestActivityPhotoService_Upload(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	store := newFakeBlobStore(t, photoContainer)
	svc := newPhotoService(t, db, store)
	user := newUser(t, db)
	today := todayIST()
	img := jpegBytes(t, 64, 48)

	photo, err := svc.Upload(ctx, user.ID, "study", today, newMemFile(img), fileHeader("desk.jpg", len(img)), "", "", "")
	require.NoError(t, err)
	assert.NotZero(t, photo.ID)
	prefix := photoURL(user.ID, today, "study", "")
	assert.True(t, strings.HasPrefix(photo.PhotoURL, prefix), photo.PhotoURL)
	assert.True(t, strings.HasSuffix(photo.PhotoURL, ".jpg"))
	assert.Equal(t, strings.TrimSuffix(photo.PhotoURL, ".jpg")+"_thumb.jpg", photo.ThumbnailURL)
	assert.Nil(t, photo.ActivityIcon)
	assert.Nil(t, photo.ActivityColor)
	assert.Nil(t, photo.ActivityLabel)

	calls := store.recorded()
	require.Len(t, calls, 2)
	assert.Equal(t, svc.extractBlobName(photo.PhotoURL), calls[0].Name)
	assert.Equal(t, svc.extractBlobName(photo.ThumbnailURL), calls[1].Name)
	for _, c := range calls {
		assert.Equal(t, "PUT", c.Method)
		assert.Equal(t, "image/jpeg", c.ContentType)
		assert.Positive(t, c.Size)
	}

	stored, err := svc.GetByID(ctx, photo.ID)
	require.NoError(t, err)
	assert.Equal(t, photo.PhotoURL, stored.PhotoURL)
	assert.Equal(t, today.Format(constants.DateFormat), stored.PhotoDate.Format(constants.DateFormat))

	custom := "custom:3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b"
	png := pngBytes(t, 20, 30)
	tile, err := svc.Upload(ctx, user.ID, custom, today.AddDate(0, 0, -7), newMemFile(png), fileHeader("art.PNG", len(png)),
		"Palette", "#ff8800", "Painting")
	require.NoError(t, err)
	require.NotNil(t, tile.ActivityIcon)
	assert.Equal(t, "Palette", *tile.ActivityIcon)
	assert.Equal(t, "#ff8800", *tile.ActivityColor)
	assert.Equal(t, "Painting", *tile.ActivityLabel)

	waitForAsync(t)
	pending, ok := pendingFor(svc, user.ID)
	require.True(t, ok, "followers are notified after a debounce window")
	assert.Equal(t, 2, pending.photoCount, "uploads within the window are batched")
	assert.Equal(t, user.Username, pending.uploaderUsername)

	_, err = svc.Upload(ctx, user.ID, "study", today, newMemFile(img), fileHeader("again.jpg", len(img)), "", "", "")
	assert.EqualError(t, err, "photo already exists for this activity on this date")
	assert.Len(t, store.recorded(), 4, "nothing is uploaded for a duplicate")
}

func TestActivityPhotoService_Upload_Rejections(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	store := newFakeBlobStore(t, photoContainer)
	svc := newPhotoService(t, db, store)
	user := newUser(t, db)
	today := todayIST()
	img := jpegBytes(t, 16, 16)
	upload := func(s *ActivityPhotoService, date time.Time, data []byte, header string, size int) error {
		_, err := s.Upload(ctx, user.ID, "study", date, newMemFile(data), fileHeader(header, size), "", "", "")
		return err
	}

	assert.EqualError(t, upload(svc, today.AddDate(0, 0, 1), img, "a.jpg", len(img)), "cannot upload photo for future date")
	assert.EqualError(t, upload(svc, today.AddDate(0, 0, -8), img, "a.jpg", len(img)), "can only upload photos for the last 7 days")
	assert.EqualError(t, upload(svc, today, img, "a.jpg", constants.MaxProfilePicSize+1), "image size must be less than 5MB")
	assert.ErrorContains(t, upload(svc, today, []byte("definitely not an image"), "a.jpg", 23), "failed to process image")
	assert.ErrorContains(t, upload(svc, today, img, "a.gif", len(img)), "unsupported file extension")

	broken := newPhotoServiceFrom(t, photoDeps{testutil.BrokenDB(t), db, db, db}, store)
	assert.ErrorContains(t, upload(broken, today, img, "a.jpg", len(img)), "failed to check existing photo")

	unconfigured := newPhotoService(t, db, nil)
	assert.EqualError(t, upload(unconfigured, today, img, "a.jpg", len(img)), "blob storage is not configured")

	assert.Empty(t, store.recorded())
	assert.Zero(t, countRows(t, db, &models.ActivityPhoto{}))
}

func TestActivityPhotoService_Upload_StorageFailures(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	user := newUser(t, db)
	today := todayIST()
	img := jpegBytes(t, 16, 16)
	isThumb := func(name string) bool { return strings.HasSuffix(name, "_thumb.jpg") }

	t.Run("full image upload fails", func(t *testing.T) {
		store := newFakeBlobStore(t, photoContainer)
		store.setFailures(func(name string) bool { return !isThumb(name) }, nil)
		_, err := newPhotoService(t, db, store).Upload(ctx, user.ID, "study", today, newMemFile(img), fileHeader("a.jpg", len(img)), "", "", "")
		assert.ErrorContains(t, err, "failed to upload full image")
		assert.Len(t, store.recorded(), 1)
	})

	t.Run("thumbnail upload fails and the full image is removed", func(t *testing.T) {
		store := newFakeBlobStore(t, photoContainer)
		store.setFailures(isThumb, nil)
		_, err := newPhotoService(t, db, store).Upload(ctx, user.ID, "study", today, newMemFile(img), fileHeader("a.jpg", len(img)), "", "", "")
		assert.ErrorContains(t, err, "failed to upload thumbnail")
		calls := store.recorded()
		require.Len(t, calls, 3)
		assert.Equal(t, "DELETE "+calls[0].Name, methodsAndNames(calls)[2])
	})

	t.Run("database failure removes both blobs", func(t *testing.T) {
		store := newFakeBlobStore(t, photoContainer)
		svc := newPhotoServiceFrom(t, photoDeps{faultyDB(t, failingOn("create", "activity_photos")), db, db, db}, store)
		_, err := svc.Upload(ctx, user.ID, "study", today, newMemFile(img), fileHeader("a.jpg", len(img)), "", "", "")
		require.ErrorIs(t, err, errInjected)
		assert.Contains(t, err.Error(), "failed to save photo")
		calls := methodsAndNames(store.recorded())
		require.Len(t, calls, 4)
		assert.Equal(t, []string{"DELETE " + strings.TrimPrefix(calls[0], "PUT "), "DELETE " + strings.TrimPrefix(calls[1], "PUT ")}, calls[2:])
	})

	assert.Zero(t, countRows(t, db, &models.ActivityPhoto{}))
}

func TestActivityPhotoService_Delete(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	store := newFakeBlobStore(t, photoContainer)
	svc := newPhotoService(t, db, store)
	owner := newUser(t, db)
	other := newUser(t, db)
	day := todayIST()

	t.Run("owner deletes the photo and its blobs", func(t *testing.T) {
		photo := seedPhoto(t, db, owner.ID, "study", day)
		require.NoError(t, svc.Delete(ctx, photo.ID, owner.ID))
		assert.Equal(t, []string{
			"DELETE " + photoBlob(owner.ID, day, "study", "full.jpg"),
			"DELETE " + photoBlob(owner.ID, day, "study", "thumb.jpg"),
		}, methodsAndNames(store.recorded()))
		got, err := svc.GetByID(ctx, photo.ID)
		require.NoError(t, err)
		assert.Nil(t, got)
	})

	t.Run("rules", func(t *testing.T) {
		photo := seedPhoto(t, db, owner.ID, "workout", day)
		assert.EqualError(t, svc.Delete(ctx, photo.ID, other.ID), "not authorized to delete this photo")
		assert.EqualError(t, svc.Delete(ctx, 999999, owner.ID), "photo not found")
		broken := newPhotoServiceFrom(t, photoDeps{testutil.BrokenDB(t), db, db, db}, store)
		assert.ErrorContains(t, broken.Delete(ctx, photo.ID, owner.ID), "failed to get photo")
	})

	t.Run("blob delete failures do not block the delete", func(t *testing.T) {
		photo := seedPhoto(t, db, owner.ID, "reels", day)
		store.setFailures(nil, func(string) bool { return true })
		t.Cleanup(func() { store.setFailures(nil, nil) })
		require.NoError(t, svc.Delete(ctx, photo.ID, owner.ID))
		got, err := svc.GetByID(ctx, photo.ID)
		require.NoError(t, err)
		assert.Nil(t, got)
	})

	t.Run("foreign URLs are not touched", func(t *testing.T) {
		photo := seedPhoto(t, db, owner.ID, "family", day)
		require.NoError(t, db.Model(photo).Updates(map[string]any{
			"photo_url": "https://cdn.example.com/a.jpg", "thumbnail_url": "https://cdn.example.com/b.jpg",
		}).Error)
		before := len(store.recorded())
		require.NoError(t, svc.Delete(ctx, photo.ID, owner.ID))
		assert.Len(t, store.recorded(), before)
	})

	t.Run("database delete failure", func(t *testing.T) {
		photo := seedPhoto(t, db, owner.ID, "eating", day)
		broken := newPhotoServiceFrom(t, photoDeps{faultyDB(t, failingOn("delete", "activity_photos")), db, db, db}, store)
		assert.ErrorContains(t, broken.Delete(ctx, photo.ID, owner.ID), "failed to delete photo")
	})
}

func TestActivityPhotoService_DeleteByActivity(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	store := newFakeBlobStore(t, photoContainer)
	svc := newPhotoService(t, db, store)
	user := newUser(t, db)
	custom := "custom:0b6f8d1e-2c3a-4b5d-9e7f-1a2b3c4d5e6f"
	day := todayIST()
	seedPhoto(t, db, user.ID, custom, day)
	seedPhoto(t, db, user.ID, custom, day.AddDate(0, 0, -1))
	keep := seedPhoto(t, db, user.ID, "study", day)

	require.NoError(t, svc.DeleteByActivity(ctx, user.ID, custom))
	assert.Len(t, store.recorded(), 4)
	for _, c := range store.recorded() {
		assert.Equal(t, "DELETE", c.Method)
		assert.Contains(t, c.Name, custom)
	}
	remaining, err := svc.GetByUserAndDate(ctx, user.ID, day)
	require.NoError(t, err)
	require.Len(t, remaining, 1)
	assert.Equal(t, keep.ID, remaining[0].ID)

	brokenRead := newPhotoServiceFrom(t, photoDeps{testutil.BrokenDB(t), db, db, db}, store)
	assert.ErrorContains(t, brokenRead.DeleteByActivity(ctx, user.ID, "study"), "failed to get photos")
	brokenDelete := newPhotoServiceFrom(t, photoDeps{faultyDB(t, failingOn("delete", "activity_photos")), db, db, db}, store)
	assert.ErrorContains(t, brokenDelete.DeleteByActivity(ctx, user.ID, "study"), "failed to delete photos")
}

func TestActivityPhotoService_StoriesAndViews(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newPhotoService(t, db, nil)
	viewer := newUser(t, db)
	friend := newUser(t, db)
	stranger := newUser(t, db)
	day := todayIST()
	makeFollow(t, db, viewer.ID, friend.ID, models.FollowStateActive)
	first := seedPhoto(t, db, friend.ID, "study", day)
	second := seedPhoto(t, db, friend.ID, "workout", day)
	seedPhoto(t, db, stranger.ID, "study", day)

	can, err := svc.CanViewStories(ctx, viewer.ID, viewer.ID)
	require.NoError(t, err)
	assert.True(t, can)
	can, err = svc.CanViewStories(ctx, viewer.ID, friend.ID)
	require.NoError(t, err)
	assert.True(t, can)
	can, err = svc.CanViewStories(ctx, viewer.ID, stranger.ID)
	require.NoError(t, err)
	assert.False(t, can)

	require.NoError(t, svc.RecordView(ctx, viewer.ID, first.ID))
	require.NoError(t, svc.RecordView(ctx, viewer.ID, first.ID), "views are recorded once")
	require.NoError(t, svc.RecordView(ctx, friend.ID, first.ID), "own views are ignored")
	assert.EqualError(t, svc.RecordView(ctx, viewer.ID, 999999), "photo not found")

	count, err := svc.GetViewCount(ctx, first.ID)
	require.NoError(t, err)
	assert.EqualValues(t, 1, count)

	stories, err := svc.GetFollowingStories(ctx, viewer.ID, day, 10)
	require.NoError(t, err)
	require.Len(t, stories, 1)
	assert.Equal(t, friend.ID, stories[0].UserID)
	require.Len(t, stories[0].Photos, 2)
	viewed := map[uint]bool{}
	for _, p := range stories[0].Photos {
		viewed[p.ID] = p.Viewed
	}
	assert.Equal(t, map[uint]bool{first.ID: true, second.ID: false}, viewed)
	assert.True(t, stories[0].HasUnseen)

	viewers, total, err := svc.GetViewers(ctx, first.ID, friend.ID, 10, 0)
	require.NoError(t, err)
	assert.EqualValues(t, 1, total)
	require.Len(t, viewers, 1)
	assert.Equal(t, viewer.Username, viewers[0].Username)

	_, _, err = svc.GetViewers(ctx, first.ID, viewer.ID, 10, 0)
	assert.EqualError(t, err, "not authorized to view photo viewers")
	_, _, err = svc.GetViewers(ctx, 999999, friend.ID, 10, 0)
	assert.EqualError(t, err, "photo not found")

	broken := newPhotoServiceFrom(t, photoDeps{testutil.BrokenDB(t), db, testutil.BrokenDB(t), db}, nil)
	assert.Error(t, broken.RecordView(ctx, viewer.ID, first.ID))
	_, _, err = broken.GetViewers(ctx, first.ID, friend.ID, 10, 0)
	assert.Error(t, err)
	_, err = broken.CanViewStories(ctx, viewer.ID, friend.ID)
	assert.Error(t, err)
}

func TestActivityPhotoService_Likes(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	mr := startRedis(t)
	publisher := installPushPublisher(t, 10)
	svc := newPhotoService(t, db, nil)
	owner := newUser(t, db)
	fan := newUser(t, db, func(u *models.User) { u.ProfilePic = testutil.Ptr("https://img/fan.jpg") })
	stranger := newUser(t, db)
	makeFollow(t, db, fan.ID, owner.ID, models.FollowStateActive)
	day := testutil.Day(2026, time.April, 2)
	photo := seedPhoto(t, db, owner.ID, "study", day)
	mr.Set(pkgredis.StoryLikeCountCacheKey(photo.ID), "2")

	require.NoError(t, svc.LikePhoto(ctx, fan.ID, photo.ID))
	waitForAsync(t)

	liked, err := svc.HasLikedPhoto(ctx, fan.ID, photo.ID)
	require.NoError(t, err)
	assert.True(t, liked)
	cachedCount, err := mr.Get(pkgredis.StoryLikeCountCacheKey(photo.ID))
	require.NoError(t, err)
	assert.Equal(t, "3", cachedCount, "the cached count is incremented")
	viewCount, err := svc.GetViewCount(ctx, photo.ID)
	require.NoError(t, err)
	assert.EqualValues(t, 1, viewCount, "liking counts as viewing")

	notifs := notificationsOf(t, db, owner.ID)
	require.Len(t, notifs, 1)
	assert.Equal(t, models.NotifTypeStoryLiked, notifs[0].Type)
	assert.Equal(t, fan.Username+" liked your story", notifs[0].Body)
	assert.EqualValues(t, photo.ID, notifs[0].Metadata["photo_id"])
	assert.Equal(t, "2026-04-02", notifs[0].Metadata["photo_date"])
	assert.Equal(t, "https://img/fan.jpg", notifs[0].Metadata["liker_avatar"])
	pushes := queuedPushes(t, publisher)
	require.Len(t, pushes, 1)
	assert.Equal(t, fmt.Sprintf("story_liked:%d:%d:%d", owner.ID, fan.ID, photo.ID), pushes[0].DedupeKey)
	assert.Equal(t, fmt.Sprintf("/user/%s?date=2026-04-02", fan.Username), pushes[0].DeepLink)
	assert.Equal(t, 14400, pushes[0].TTLSeconds)

	require.NoError(t, svc.LikePhoto(ctx, fan.ID, photo.ID), "liking twice is a no-op")
	require.NoError(t, svc.UnlikePhoto(ctx, fan.ID, photo.ID))
	liked, err = svc.HasLikedPhoto(ctx, fan.ID, photo.ID)
	require.NoError(t, err)
	assert.False(t, liked)
	count, err := svc.GetPhotoLikeCount(ctx, photo.ID)
	require.NoError(t, err)
	assert.EqualValues(t, 2, count, "the cached count is decremented")

	require.NoError(t, svc.LikePhoto(ctx, fan.ID, photo.ID), "re-like after unlike")
	waitForAsync(t)
	assert.Len(t, notificationsOf(t, db, owner.ID), 1, "the owner is notified only once per liker and photo")
	assert.Empty(t, queuedPushes(t, publisher))

	likers, total, err := svc.GetPhotoLikers(ctx, photo.ID, owner.ID, 10, 0)
	require.NoError(t, err)
	assert.EqualValues(t, 1, total)
	require.Len(t, likers, 1)
	assert.Equal(t, fan.ID, likers[0].UserID)

	interactions, total, err := svc.GetPhotoInteractions(ctx, photo.ID, owner.ID, 10, 0)
	require.NoError(t, err)
	assert.EqualValues(t, 1, total)
	require.Len(t, interactions, 1)
	assert.Equal(t, "both", interactions[0].InteractionType)

	assert.EqualError(t, svc.LikePhoto(ctx, owner.ID, photo.ID), "cannot like own photo")
	assert.EqualError(t, svc.LikePhoto(ctx, stranger.ID, photo.ID), "must follow user to like their photos")
	assert.EqualError(t, svc.LikePhoto(ctx, fan.ID, 999999), "photo not found")
	assert.EqualError(t, svc.UnlikePhoto(ctx, fan.ID, 999999), "photo not found")
	_, _, err = svc.GetPhotoLikers(ctx, photo.ID, fan.ID, 10, 0)
	assert.EqualError(t, err, "not authorized to view photo likers")
	_, _, err = svc.GetPhotoLikers(ctx, 999999, owner.ID, 10, 0)
	assert.EqualError(t, err, "photo not found")
	_, _, err = svc.GetPhotoInteractions(ctx, photo.ID, fan.ID, 10, 0)
	assert.EqualError(t, err, "not authorized to view photo interactions")
	_, _, err = svc.GetPhotoInteractions(ctx, 999999, owner.ID, 10, 0)
	assert.EqualError(t, err, "photo not found")
}

func TestActivityPhotoService_LikeFailures(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	owner := newUser(t, db)
	fan := newUser(t, db)
	makeFollow(t, db, fan.ID, owner.ID, models.FollowStateActive)
	photo := seedPhoto(t, db, owner.ID, "study", todayIST())
	hasLikes := func(t *testing.T) bool {
		var n int64
		require.NoError(t, db.Model(&models.StoryLike{}).Where("photo_id = ?", photo.ID).Count(&n).Error)
		return n > 0
	}

	t.Run("photo lookup", func(t *testing.T) {
		broken := newPhotoServiceFrom(t, photoDeps{testutil.BrokenDB(t), db, db, db}, nil)
		assert.ErrorContains(t, broken.LikePhoto(ctx, fan.ID, photo.ID), "failed to get photo")
		assert.ErrorContains(t, broken.UnlikePhoto(ctx, fan.ID, photo.ID), "failed to get photo")
		_, _, err := broken.GetPhotoLikers(ctx, photo.ID, owner.ID, 10, 0)
		assert.Error(t, err)
		_, _, err = broken.GetPhotoInteractions(ctx, photo.ID, owner.ID, 10, 0)
		assert.Error(t, err)
		_, err = broken.HasLikedPhoto(ctx, fan.ID, photo.ID)
		assert.Error(t, err)
		_, err = broken.GetPhotoLikeCount(ctx, photo.ID)
		assert.Error(t, err)
	})

	t.Run("permission lookup", func(t *testing.T) {
		broken := newPhotoServiceFrom(t, photoDeps{db, db, testutil.BrokenDB(t), db}, nil)
		assert.ErrorContains(t, broken.LikePhoto(ctx, fan.ID, photo.ID), "failed to check permissions")
	})

	t.Run("like insert", func(t *testing.T) {
		broken := newPhotoServiceFrom(t, photoDeps{faultyDB(t, failingOn("create", "story_likes")), db, db, db}, nil)
		assert.ErrorContains(t, broken.LikePhoto(ctx, fan.ID, photo.ID), "failed to like photo")
		assert.False(t, hasLikes(t))
	})

	t.Run("unlike delete", func(t *testing.T) {
		broken := newPhotoServiceFrom(t, photoDeps{faultyDB(t, failingOn("delete", "story_likes")), db, db, db}, nil)
		assert.ErrorContains(t, broken.UnlikePhoto(ctx, fan.ID, photo.ID), "failed to unlike photo")
	})

	t.Run("like-status and view failures are tolerated", func(t *testing.T) {
		svc := newPhotoServiceFrom(t, photoDeps{faultyDB(t, func(s stmtInfo) bool {
			_, isCount := s.Dest.(*int64)
			return (s.is("query", "story_likes") && isCount) || s.is("create", "story_views")
		}), db, db, db}, nil)
		require.NoError(t, svc.LikePhoto(ctx, fan.ID, photo.ID))
		waitForAsync(t)
		assert.True(t, hasLikes(t))
		count, err := newPhotoService(t, db, nil).GetViewCount(ctx, photo.ID)
		require.NoError(t, err)
		assert.Zero(t, count)
		assert.Len(t, notificationsOf(t, db, owner.ID), 1)
	})
}

func TestActivityPhotoService_LikeCache(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newPhotoService(t, db, nil)
	owner := newUser(t, db)
	fan := newUser(t, db)
	photo := seedPhoto(t, db, owner.ID, "study", todayIST())
	require.NoError(t, db.Create(&models.StoryLike{LikerID: fan.ID, PhotoID: photo.ID}).Error)

	t.Run("without Redis", func(t *testing.T) {
		liked, err := svc.HasLikedPhoto(ctx, fan.ID, photo.ID)
		require.NoError(t, err)
		assert.True(t, liked)
		count, err := svc.GetPhotoLikeCount(ctx, photo.ID)
		require.NoError(t, err)
		assert.EqualValues(t, 1, count)
	})

	t.Run("misses fill the cache and hits are served from it", func(t *testing.T) {
		mr := startRedis(t)
		liked, err := svc.HasLikedPhoto(ctx, owner.ID, photo.ID)
		require.NoError(t, err)
		assert.False(t, liked)
		cached, err := mr.Get(pkgredis.StoryLikedByCacheKey(photo.ID, owner.ID))
		require.NoError(t, err)
		assert.Equal(t, "0", cached)

		count, err := svc.GetPhotoLikeCount(ctx, photo.ID)
		require.NoError(t, err)
		assert.EqualValues(t, 1, count)
		cached, err = mr.Get(pkgredis.StoryLikeCountCacheKey(photo.ID))
		require.NoError(t, err)
		assert.Equal(t, "1", cached)

		mr.Set(pkgredis.StoryLikedByCacheKey(photo.ID, owner.ID), "1")
		mr.Set(pkgredis.StoryLikeCountCacheKey(photo.ID), "12")
		liked, err = svc.HasLikedPhoto(ctx, owner.ID, photo.ID)
		require.NoError(t, err)
		assert.True(t, liked)
		count, err = svc.GetPhotoLikeCount(ctx, photo.ID)
		require.NoError(t, err)
		assert.EqualValues(t, 12, count)
	})

	t.Run("Redis failures fall back to the database", func(t *testing.T) {
		mr := startRedis(t)
		mr.SetError("boom")
		liked, err := svc.HasLikedPhoto(ctx, fan.ID, photo.ID)
		require.NoError(t, err)
		assert.True(t, liked)
		count, err := svc.GetPhotoLikeCount(ctx, photo.ID)
		require.NoError(t, err)
		assert.EqualValues(t, 1, count)
	})
}

func TestActivityPhotoService_SendLikeNotification(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	owner := newUser(t, db)
	fan := newUser(t, db)
	photo := seedPhoto(t, db, owner.ID, "study", todayIST())

	newPhotoService(t, db, nil).sendLikeNotification(ctx, 999999, photo)
	assert.Empty(t, notificationsOf(t, db, owner.ID), "unknown liker")

	broken := newPhotoServiceFrom(t, photoDeps{faultyDB(t, failingOn("create", "notification_dedupes")), db, db, db}, nil)
	broken.sendLikeNotification(ctx, fan.ID, photo)
	broken = newPhotoServiceFrom(t, photoDeps{faultyDB(t, failingOn("create", "notifications")), db, db, db}, nil)
	broken.sendLikeNotification(ctx, fan.ID, photo)
	assert.Empty(t, notificationsOf(t, db, owner.ID))
	assert.Zero(t, countRows(t, db, &models.NotificationDedupe{}), "failed attempts leave no dedupe record")

	installPushPublisher(t, 0)
	newPhotoService(t, db, nil).sendLikeNotification(ctx, fan.ID, photo)
	notifs := notificationsOf(t, db, owner.ID)
	require.Len(t, notifs, 1, "a full push queue does not affect the in-app notification")
	assert.Equal(t, "", notifs[0].Metadata["liker_avatar"])
}

func TestActivityPhotoService_PhotoNotifications(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newPhotoService(t, db, nil)
	uploader := newUser(t, db, func(u *models.User) { u.ProfilePic = testutil.Ptr("https://img/up.jpg") })
	fanA := newUser(t, db)
	fanB := newUser(t, db)
	makeFollow(t, db, fanA.ID, uploader.ID, models.FollowStateActive)
	makeFollow(t, db, fanB.ID, uploader.ID, models.FollowStateActive)

	t.Run("debounced uploads become one notification per follower", func(t *testing.T) {
		publisher := installPushPublisher(t, 10)
		svc.scheduleNotification(ctx, uploader.ID, "2026-04-05")
		svc.scheduleNotification(ctx, uploader.ID, "2026-04-05")
		pending, ok := pendingFor(svc, uploader.ID)
		require.True(t, ok)
		assert.Equal(t, 2, pending.photoCount)
		assert.Equal(t, "https://img/up.jpg", pending.uploaderAvatar)

		pending.timer.Reset(time.Millisecond) // fire the debounce timer now
		require.Eventually(t, func() bool { _, ok := pendingFor(svc, uploader.ID); return !ok },
			5*time.Second, 2*time.Millisecond)
		waitForAsync(t)

		for _, fan := range []*models.User{fanA, fanB} {
			notifs := notificationsOf(t, db, fan.ID)
			require.Len(t, notifs, 1)
			assert.Equal(t, models.NotifTypePhotoUploaded, notifs[0].Type)
			assert.Equal(t, "New Story!", notifs[0].Title)
			assert.Equal(t, uploader.Username+" shared 2 new photos", notifs[0].Body)
			assert.EqualValues(t, 2, notifs[0].Metadata["photo_count"])
		}
		pushes := queuedPushes(t, publisher)
		require.Len(t, pushes, 2)
		assert.Equal(t, fmt.Sprintf("photo_uploaded:%d:%d:2026-04-05", pushes[0].UserID, uploader.ID), pushes[0].DedupeKey)
		assert.Equal(t, fmt.Sprintf("/user/%s?date=2026-04-05", uploader.Username), pushes[0].DeepLink)
		assert.Equal(t, 14400, pushes[0].TTLSeconds)
	})

	t.Run("single photo, unparsable date and full push queue", func(t *testing.T) {
		installPushPublisher(t, 0)
		svc.sendPhotoNotification(ctx, &pendingPhotoNotification{
			uploaderID: uploader.ID, uploaderUsername: uploader.Username, photoDate: "someday", photoCount: 1,
		})
		notifs := notificationsOf(t, db, fanA.ID)
		require.Len(t, notifs, 2)
		assert.Equal(t, uploader.Username+" shared a new photo", notifs[1].Body)
	})

	t.Run("unknown uploader is not scheduled", func(t *testing.T) {
		svc.scheduleNotification(ctx, 999999, "2026-04-05")
		_, ok := pendingFor(svc, 999999)
		assert.False(t, ok)
	})

	t.Run("no followers, follower lookup and notification failures", func(t *testing.T) {
		lonely := newUser(t, db)
		before := countRows(t, db, &models.Notification{})
		svc.sendPhotoNotification(ctx, &pendingPhotoNotification{uploaderID: lonely.ID, uploaderUsername: lonely.Username, photoDate: "2026-04-05", photoCount: 1})

		brokenFollows := newPhotoServiceFrom(t, photoDeps{db, db, testutil.BrokenDB(t), db}, nil)
		brokenFollows.sendPhotoNotification(ctx, &pendingPhotoNotification{uploaderID: uploader.ID, photoDate: "2026-04-05", photoCount: 1})

		brokenNotifs := newPhotoServiceFrom(t, photoDeps{db, db, db, testutil.BrokenDB(t)}, nil)
		brokenNotifs.sendPhotoNotification(ctx, &pendingPhotoNotification{uploaderID: uploader.ID, photoDate: "2026-04-05", photoCount: 1})
		assert.Equal(t, before, countRows(t, db, &models.Notification{}))
	})
}
