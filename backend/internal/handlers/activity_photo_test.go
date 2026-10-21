package handlers

import (
	"bytes"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/services"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type photoResponse struct {
	Success bool                 `json:"success"`
	Photo   models.ActivityPhoto `json:"photo"`
}

type photosResponse struct {
	Success bool                   `json:"success"`
	Photos  []models.ActivityPhoto `json:"photos"`
}

type storiesResponse struct {
	Success bool                    `json:"success"`
	Stories []models.UserStoryGroup `json:"stories"`
}

type viewersResponse struct {
	Success bool                 `json:"success"`
	Viewers []models.PhotoViewer `json:"viewers"`
	Total   int64                `json:"total"`
}

type interactionsResponse struct {
	Success      bool                      `json:"success"`
	Interactions []models.PhotoInteraction `json:"interactions"`
	Total        int64                     `json:"total"`
}

type likeStatusResponse struct {
	Success   bool  `json:"success"`
	Liked     bool  `json:"liked"`
	LikeCount int64 `json:"like_count"`
}

var photoDay = testutil.Day(2026, 3, 9)

// istDay returns today's date in IST (the zone the upload window uses) shifted by offset days.
func istDay(offset int) string {
	loc, err := time.LoadLocation(constants.TimezoneIST)
	if err != nil {
		loc = time.FixedZone("IST", 5*60*60+30*60)
	}
	return time.Now().In(loc).AddDate(0, 0, offset).Format(constants.DateFormat)
}

// photoEnv wires the activity photo handler like container.New, against a fake blob store.
type photoEnv struct {
	*testEnv
	fake    *fakeBlobStore
	storage config.AzureStorageConfig
	photos  *handlerSet
}

func newPhotoEnv(t *testing.T) *photoEnv {
	t.Helper()
	env := newEnv(t)
	fake := newFakeBlobStore(t)
	p := &photoEnv{testEnv: env, fake: fake, storage: azureConfig(env.cfg, fake)}
	p.photos = p.handlers(t, env.activityPhotoRepo, env.followRepo, p.storage)
	return p
}

// handlers builds the photo handler on the given repositories. The service's user repository
// uses a closed pool: Upload and LikePhoto start goroutines (a 30s debounced follower
// notification and the like notification) that look the user up first, so they stop there and
// never touch the database after the test ends. TestActivityPhotoHandler_LikePhoto_NotifiesTheOwner
// covers the notification with a working repository.
func (p *photoEnv) handlers(t *testing.T, photoRepo *repository.ActivityPhotoRepository, followRepo *repository.FollowRepository, storage config.AzureStorageConfig) *handlerSet {
	t.Helper()
	quietUsers := repository.NewUserRepository(testutil.BrokenDB(t))
	svc, err := services.NewActivityPhotoService(photoRepo, quietUsers, followRepo, nil, &storage)
	require.NoError(t, err)
	return &handlerSet{activityPhoto: NewActivityPhotoHandler(svc, p.authSvc, p.profileSvc)}
}

func (p *photoEnv) broken(t *testing.T) *handlerSet {
	t.Helper()
	b := brokenStack(t)
	return p.handlers(t, b.activityPhotoRepo, b.followRepo, p.storage)
}

func uploadPhoto(t *testing.T, h *handlerSet, user *models.User, fields map[string]string, filename string, content []byte) testutil.Response {
	t.Helper()
	field := "image"
	if filename == "" {
		field = ""
	}
	body, contentType := testutil.Multipart(t, field, filename, content, fields)
	app := newApp(h, user, fiber.Config{BodyLimit: 16 << 20})
	return testutil.Do(t, app, http.MethodPost, "/api/activity-photo", body, testutil.WithHeader("Content-Type", contentType))
}

func photoAt(t *testing.T, env *testEnv, owner *models.User, activity string, day time.Time, createdAt time.Time) *models.ActivityPhoto {
	t.Helper()
	p := createPhoto(t, env.db, owner.ID, activity, day)
	require.NoError(t, env.db.Model(p).Update("created_at", createdAt).Error)
	return p
}

func TestActivityPhotoHandler_UploadPhoto_Validation(t *testing.T) {
	p := newPhotoEnv(t)
	user := p.user(t)
	yesterday := istDay(-1)
	valid := map[string]string{"activity_name": "study", "photo_date": yesterday}
	png := pngBytes(t, 32, 32)

	tests := []struct {
		name     string
		fields   map[string]string
		filename string
		content  []byte
		code     string
		message  string
	}{
		{"missing activity", map[string]string{"photo_date": yesterday}, "a.png", png, constants.ErrCodeMissingFields, "activity_name and photo_date are required"},
		{"missing date", map[string]string{"activity_name": "study"}, "a.png", png, constants.ErrCodeMissingFields, "activity_name and photo_date are required"},
		{"bad date", map[string]string{"activity_name": "study", "photo_date": "yesterday"}, "a.png", png, constants.ErrCodeInvalidDate, "Invalid date format, use YYYY-MM-DD"},
		{"missing image", valid, "", nil, constants.ErrCodeInvalidRequest, "No image file provided"},
		{"future date", map[string]string{"activity_name": "study", "photo_date": istDay(1)}, "a.png", png, constants.ErrCodeInvalidRequest, "cannot upload photo for future date"},
		{"older than a week", map[string]string{"activity_name": "study", "photo_date": istDay(-8)}, "a.png", png, constants.ErrCodeInvalidRequest, "can only upload photos for the last 7 days"},
		{"too large", valid, "big.jpg", bytes.Repeat([]byte{0xFF}, constants.MaxProfilePicSize+1), constants.ErrCodeInvalidRequest, "image size must be less than 5MB"},
		{"unsupported file", valid, "notes.txt", []byte("hello"), constants.ErrCodeInvalidRequest, "failed to process image: unsupported file extension: .txt"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			res := uploadPhoto(t, p.photos, user, tc.fields, tc.filename, tc.content)
			assertErrorMessage(t, res, http.StatusBadRequest, tc.code, tc.message)
		})
	}
	assert.Empty(t, p.fake.blobNames())
	assert.Zero(t, count(t, p.db, &models.ActivityPhoto{}, ""))
}

func TestActivityPhotoHandler_UploadPhoto(t *testing.T) {
	p := newPhotoEnv(t)
	user := p.user(t)
	day := istDay(-1)

	res := uploadPhoto(t, p.photos, user, map[string]string{"activity_name": "study", "photo_date": day}, "desk.jpg", jpegBytes(t, 1600, 1200))

	got := decodeAs[photoResponse](t, res, http.StatusOK)
	assert.True(t, got.Success)
	photo := got.Photo
	assert.NotZero(t, photo.ID)
	assert.Equal(t, user.ID, photo.UserID)
	assert.Equal(t, "study", photo.ActivityName)
	assert.Equal(t, day, photo.PhotoDate.Format(constants.DateFormat))
	assert.Nil(t, photo.ActivityIcon)
	prefix := "http://localhost:10000/devstoreaccount1/profile-pictures/"
	path := "activity-photos/" + itoa(user.ID) + "/" + day + "/study/"
	assert.Regexp(t, "^"+regexp.QuoteMeta(prefix+path)+`[0-9a-f-]{36}\.jpg$`, photo.PhotoURL)
	assert.Equal(t, strings.TrimSuffix(photo.PhotoURL, ".jpg")+"_thumb.jpg", photo.ThumbnailURL)

	full, ok := p.fake.blob(blobContainer + "/" + strings.TrimPrefix(photo.PhotoURL, prefix))
	require.True(t, ok)
	assert.Equal(t, 1080, decodeJPEG(t, full).Bounds().Dx())
	assert.Equal(t, 810, decodeJPEG(t, full).Bounds().Dy())
	thumb, ok := p.fake.blob(blobContainer + "/" + strings.TrimPrefix(photo.ThumbnailURL, prefix))
	require.True(t, ok)
	assert.Equal(t, 150, decodeJPEG(t, thumb).Bounds().Dx())
	assert.EqualValues(t, 1, count(t, p.db, &models.ActivityPhoto{}, "id = ?", photo.ID))

	t.Run("same activity and day again", func(t *testing.T) {
		res := uploadPhoto(t, p.photos, user, map[string]string{"activity_name": "study", "photo_date": day}, "again.png", pngBytes(t, 20, 20))
		assertErrorMessage(t, res, http.StatusConflict, constants.ErrCodeConflict, "Photo already exists for this activity on this date")
	})

	t.Run("custom tile metadata", func(t *testing.T) {
		activity := models.CustomTilePrefix + uuid.NewString()
		fields := map[string]string{"activity_name": activity, "photo_date": day,
			"activity_icon": "Guitar", "activity_color": "#ff0000", "activity_label": "Guitar practice"}

		got := decodeAs[photoResponse](t, uploadPhoto(t, p.photos, user, fields, "guitar.png", pngBytes(t, 20, 20)), http.StatusOK)

		require.NotNil(t, got.Photo.ActivityIcon)
		assert.Equal(t, "Guitar", *got.Photo.ActivityIcon)
		assert.Equal(t, "#ff0000", *got.Photo.ActivityColor)
		assert.Equal(t, "Guitar practice", *got.Photo.ActivityLabel)
	})

	t.Run("seven days ago is the oldest allowed day", func(t *testing.T) {
		res := uploadPhoto(t, p.photos, user, map[string]string{"activity_name": "sleep", "photo_date": istDay(-7)}, "old.png", pngBytes(t, 20, 20))
		assert.Equal(t, http.StatusOK, res.Status, "body: %s", res.Body)
	})
}

func TestActivityPhotoHandler_UploadPhoto_Failures(t *testing.T) {
	p := newPhotoEnv(t)
	user := p.user(t)
	fields := map[string]string{"activity_name": "study", "photo_date": istDay(-1)}
	upload := func(t *testing.T, h *handlerSet) string {
		t.Helper()
		e := assertError(t, uploadPhoto(t, h, user, fields, "a.png", pngBytes(t, 40, 40)), http.StatusBadRequest, constants.ErrCodeInvalidRequest)
		return e.Error
	}

	t.Run("full image upload fails", func(t *testing.T) {
		p.fake.setFailPut(func(string) bool { return true })
		defer p.fake.setFailPut(nil)
		assert.True(t, strings.HasPrefix(upload(t, p.photos), "failed to upload full image"))
		assert.Empty(t, p.fake.blobNames())
	})

	t.Run("thumbnail upload fails and the full image is removed", func(t *testing.T) {
		p.fake.setFailPut(func(name string) bool { return strings.HasSuffix(name, "_thumb.jpg") })
		defer p.fake.setFailPut(nil)
		assert.True(t, strings.HasPrefix(upload(t, p.photos), "failed to upload thumbnail"))
		assert.Empty(t, p.fake.blobNames())
	})

	t.Run("saving the photo fails and both blobs are removed", func(t *testing.T) {
		faulty := repository.NewActivityPhotoRepository(faultyDB(t, failOn("create", "activity_photos")))
		h := p.handlers(t, faulty, p.followRepo, p.storage)
		assert.Equal(t, "failed to save photo: "+errInjected.Error(), upload(t, h))
		assert.Empty(t, p.fake.blobNames())
	})

	t.Run("checking for an existing photo fails", func(t *testing.T) {
		assert.True(t, strings.HasPrefix(upload(t, p.broken(t)), "failed to check existing photo"))
	})

	t.Run("blob storage not configured", func(t *testing.T) {
		h := p.handlers(t, p.activityPhotoRepo, p.followRepo, p.cfg.AzureStorage)
		assert.Equal(t, "blob storage is not configured", upload(t, h))
	})

	assert.Zero(t, count(t, p.db, &models.ActivityPhoto{}, ""))
}

func TestNewActivityPhotoService_InvalidConnectionString(t *testing.T) {
	env := newEnv(t)
	_, err := services.NewActivityPhotoService(env.activityPhotoRepo, env.userRepo, env.followRepo, nil,
		&config.AzureStorageConfig{ConnectionString: "nonsense", ContainerName: blobContainer})
	assert.ErrorContains(t, err, "failed to create blob client")
}

func TestActivityPhotoHandler_DeletePhoto(t *testing.T) {
	p := newPhotoEnv(t)
	owner, other := p.user(t), p.user(t)
	photo := createPhoto(t, p.db, owner.ID, "study", photoDay)
	del := func(t *testing.T, h *handlerSet, user *models.User, id string) testutil.Response {
		t.Helper()
		return call(t, h, user, http.MethodDelete, "/api/activity-photo/"+id, nil)
	}

	t.Run("invalid id", func(t *testing.T) {
		assertErrorMessage(t, del(t, p.photos, owner, "abc"), http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid photo ID")
	})

	t.Run("unknown photo", func(t *testing.T) {
		assertErrorMessage(t, del(t, p.photos, owner, itoa(deletedUserID)), http.StatusNotFound, constants.ErrCodePhotoNotFound, "Photo not found")
	})

	t.Run("someone else's photo", func(t *testing.T) {
		assertErrorMessage(t, del(t, p.photos, other, itoa(photo.ID)), http.StatusForbidden, constants.ErrCodeNotAuthorized, "Not authorized to delete this photo")
	})

	t.Run("database failure", func(t *testing.T) {
		assertErrorMessage(t, del(t, p.broken(t), owner, itoa(photo.ID)), http.StatusInternalServerError, constants.ErrCodeDeleteFailed, "Failed to delete photo")
	})

	t.Run("the owner deletes the photo and its blobs", func(t *testing.T) {
		assertSuccessMessage(t, del(t, p.photos, owner, itoa(photo.ID)), http.StatusOK, "Photo deleted successfully")
		assert.Zero(t, count(t, p.db, &models.ActivityPhoto{}, "id = ?", photo.ID))
		assert.ElementsMatch(t, []string{
			blobContainer + "/activity-photos/study-2026-03-09.jpg",
			blobContainer + "/activity-photos/study-2026-03-09_thumb.jpg",
		}, p.fake.requestsWith(http.MethodDelete))
	})
}

func TestActivityPhotoHandler_MissingPhotoReturnsPhotoNotFound(t *testing.T) {
	p := newPhotoEnv(t)
	user := p.user(t)
	missing := "/api/activity-photo/" + itoa(deletedUserID)

	for _, tc := range []struct{ method, target string }{
		{http.MethodDelete, missing},
		{http.MethodPost, missing + "/view"},
		{http.MethodGet, missing + "/viewers"},
		{http.MethodGet, missing + "/interactions"},
		{http.MethodPost, missing + "/like"},
		{http.MethodDelete, missing + "/like"},
	} {
		t.Run(tc.method+" "+strings.TrimPrefix(tc.target, missing), func(t *testing.T) {
			res := call(t, p.photos, user, tc.method, tc.target, nil)
			assertErrorMessage(t, res, http.StatusNotFound, constants.ErrCodePhotoNotFound, "Photo not found")
		})
	}
}

func TestActivityPhotoHandler_GetPhotos(t *testing.T) {
	p := newPhotoEnv(t)
	owner, fan, stranger := p.user(t), p.user(t), p.user(t)
	follow(t, p.db, fan, owner)
	sleep := createPhoto(t, p.db, owner.ID, "sleep", photoDay)
	study := createPhoto(t, p.db, owner.ID, "study", photoDay)
	createPhoto(t, p.db, owner.ID, "study", photoDay.AddDate(0, 0, 1))
	query := "?user_id=" + itoa(owner.ID) + "&date=2026-03-09"
	list := func(t *testing.T, h *handlerSet, user *models.User, q string) testutil.Response {
		t.Helper()
		return call(t, h, user, http.MethodGet, "/api/activity-photos"+q, nil)
	}

	tests := []struct {
		name, query   string
		user          *models.User
		status        int
		code, message string
	}{
		{"missing parameters", "", owner, http.StatusBadRequest, constants.ErrCodeMissingFields, "user_id and date are required"},
		{"missing date", "?user_id=" + itoa(owner.ID), owner, http.StatusBadRequest, constants.ErrCodeMissingFields, "user_id and date are required"},
		{"invalid user id", "?user_id=abc&date=2026-03-09", owner, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid user_id"},
		{"invalid date", "?user_id=" + itoa(owner.ID) + "&date=09.03.2026", owner, http.StatusBadRequest, constants.ErrCodeInvalidDate, "Invalid date format, use YYYY-MM-DD"},
		{"not following", query, stranger, http.StatusForbidden, constants.ErrCodeNotAuthorized, "You must follow this user to view their stories"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assertErrorMessage(t, list(t, p.photos, tc.user, tc.query), tc.status, tc.code, tc.message)
		})
	}

	t.Run("own photos are listed without recording views", func(t *testing.T) {
		got := decodeAs[photosResponse](t, list(t, p.photos, owner, query), http.StatusOK)
		assert.True(t, got.Success)
		require.Len(t, got.Photos, 2)
		assert.Equal(t, []uint{sleep.ID, study.ID}, []uint{got.Photos[0].ID, got.Photos[1].ID})
		assert.Zero(t, count(t, p.db, &models.StoryView{}, ""))
	})

	t.Run("followers' views are recorded", func(t *testing.T) {
		got := decodeAs[photosResponse](t, list(t, p.photos, fan, query), http.StatusOK)
		assert.Len(t, got.Photos, 2)
		assert.EqualValues(t, 2, count(t, p.db, &models.StoryView{}, "viewer_id = ?", fan.ID))
	})

	t.Run("access check fails", func(t *testing.T) {
		h := p.handlers(t, p.activityPhotoRepo, brokenStack(t).followRepo, p.storage)
		assertErrorMessage(t, list(t, h, fan, query), http.StatusInternalServerError, constants.ErrCodeServerError, "Failed to check access")
	})

	t.Run("listing fails", func(t *testing.T) {
		assertErrorMessage(t, list(t, p.broken(t), owner, query), http.StatusInternalServerError, constants.ErrCodeFetchFailed, "Failed to get photos")
	})
}

func TestActivityPhotoHandler_GetFollowingStories(t *testing.T) {
	p := newPhotoEnv(t)
	viewer, early, late, unfollowed := p.user(t), p.user(t), p.user(t), p.user(t)
	follow(t, p.db, viewer, early)
	follow(t, p.db, viewer, late)
	base := time.Date(2026, 3, 9, 8, 0, 0, 0, time.UTC)
	seen := photoAt(t, p.testEnv, early, "sleep", photoDay, base)
	unseen := photoAt(t, p.testEnv, early, "study", photoDay, base.Add(time.Minute))
	photoAt(t, p.testEnv, late, "study", photoDay, base.Add(2*time.Minute))
	photoAt(t, p.testEnv, unfollowed, "study", photoDay, base.Add(3*time.Minute))
	require.NoError(t, p.activityPhotoRepo.RecordView(viewer.ID, seen.ID))
	stories := func(t *testing.T, query string) storiesResponse {
		t.Helper()
		return decodeAs[storiesResponse](t, call(t, p.photos, viewer, http.MethodGet, "/api/activity-photos/following"+query, nil), http.StatusOK)
	}

	t.Run("followed users, latest upload first", func(t *testing.T) {
		got := stories(t, "?date=2026-03-09")
		assert.True(t, got.Success)
		require.Len(t, got.Stories, 2)
		assert.Equal(t, late.ID, got.Stories[0].UserID)
		group := got.Stories[1]
		assert.Equal(t, early.Username, group.Username)
		require.Len(t, group.Photos, 2)
		assert.Equal(t, []uint{seen.ID, unseen.ID}, []uint{group.Photos[0].ID, group.Photos[1].ID})
		assert.True(t, group.Photos[0].Viewed)
		assert.False(t, group.Photos[1].Viewed)
		assert.True(t, group.HasUnseen)
	})

	t.Run("limit", func(t *testing.T) {
		assert.Len(t, stories(t, "?date=2026-03-09&limit=1").Stories, 1)
		for _, limit := range []string{"0", "51", "abc"} {
			assert.Len(t, stories(t, "?date=2026-03-09&limit="+limit).Stories, 2, "invalid limit %s falls back to 20", limit)
		}
	})

	t.Run("no stories", func(t *testing.T) {
		assert.Empty(t, stories(t, "?date=2026-03-10").Stories)
	})

	t.Run("errors", func(t *testing.T) {
		res := call(t, p.photos, viewer, http.MethodGet, "/api/activity-photos/following", nil)
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeMissingFields, "date is required")
		res = call(t, p.photos, viewer, http.MethodGet, "/api/activity-photos/following?date=tomorrow", nil)
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidDate, "Invalid date format, use YYYY-MM-DD")
		res = call(t, p.broken(t), viewer, http.MethodGet, "/api/activity-photos/following?date=2026-03-09", nil)
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeFetchFailed, "Failed to get stories")
	})
}

func TestActivityPhotoHandler_RecordView(t *testing.T) {
	p := newPhotoEnv(t)
	owner, viewer := p.user(t), p.user(t)
	photo := createPhoto(t, p.db, owner.ID, "study", photoDay)
	view := func(t *testing.T, h *handlerSet, user *models.User, id string) testutil.Response {
		t.Helper()
		return call(t, h, user, http.MethodPost, "/api/activity-photo/"+id+"/view", nil)
	}

	assertErrorMessage(t, view(t, p.photos, viewer, "abc"), http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid photo ID")
	assertErrorMessage(t, view(t, p.photos, viewer, itoa(deletedUserID)), http.StatusNotFound, constants.ErrCodePhotoNotFound, "Photo not found")
	assertErrorMessage(t, view(t, p.broken(t), viewer, itoa(photo.ID)), http.StatusInternalServerError, constants.ErrCodeServerError, "Failed to record view")

	for _, user := range []*models.User{owner, viewer, viewer} {
		res := view(t, p.photos, user, itoa(photo.ID))
		require.Equal(t, http.StatusOK, res.Status)
		assert.Equal(t, map[string]any{"success": true}, res.JSON(t))
	}
	assert.EqualValues(t, 1, count(t, p.db, &models.StoryView{}, ""), "own views are not recorded and repeats count once")
}

func TestActivityPhotoHandler_ViewersAndInteractions(t *testing.T) {
	p := newPhotoEnv(t)
	owner, first, second, fan, likeOnly := p.user(t), p.user(t), p.user(t), p.user(t), p.user(t)
	photo := createPhoto(t, p.db, owner.ID, "study", photoDay)
	base := time.Date(2026, 3, 9, 8, 0, 0, 0, time.UTC)
	for i, u := range []*models.User{first, second, fan} {
		require.NoError(t, p.db.Create(&models.StoryView{ViewerID: u.ID, PhotoID: photo.ID, ViewedAt: base.Add(time.Duration(i) * time.Hour)}).Error)
	}
	require.NoError(t, p.db.Create(&models.StoryLike{LikerID: fan.ID, PhotoID: photo.ID, LikedAt: base.Add(3 * time.Hour)}).Error)
	require.NoError(t, p.db.Create(&models.StoryLike{LikerID: likeOnly.ID, PhotoID: photo.ID, LikedAt: base.Add(30 * time.Minute)}).Error)
	get := func(t *testing.T, h *handlerSet, user *models.User, id, kind, query string) testutil.Response {
		t.Helper()
		return call(t, h, user, http.MethodGet, "/api/activity-photo/"+id+"/"+kind+query, nil)
	}

	t.Run("viewers, most recent first", func(t *testing.T) {
		got := decodeAs[viewersResponse](t, get(t, p.photos, owner, itoa(photo.ID), "viewers", ""), http.StatusOK)
		assert.True(t, got.Success)
		assert.EqualValues(t, 3, got.Total)
		require.Len(t, got.Viewers, 3)
		assert.Equal(t, []uint{fan.ID, second.ID, first.ID}, []uint{got.Viewers[0].UserID, got.Viewers[1].UserID, got.Viewers[2].UserID})

		page := decodeAs[viewersResponse](t, get(t, p.photos, owner, itoa(photo.ID), "viewers", "?limit=1&offset=1"), http.StatusOK)
		require.Len(t, page.Viewers, 1)
		assert.Equal(t, second.ID, page.Viewers[0].UserID)
		assert.EqualValues(t, 3, page.Total)

		for _, q := range []string{"?limit=0&offset=-1", "?limit=101", "?limit=abc&offset=abc"} {
			assert.Len(t, decodeAs[viewersResponse](t, get(t, p.photos, owner, itoa(photo.ID), "viewers", q), http.StatusOK).Viewers, 3, q)
		}
	})

	t.Run("interactions combine views and likes", func(t *testing.T) {
		got := decodeAs[interactionsResponse](t, get(t, p.photos, owner, itoa(photo.ID), "interactions", ""), http.StatusOK)
		assert.True(t, got.Success)
		assert.EqualValues(t, 4, got.Total)
		types := map[uint]string{}
		var order []uint
		for _, i := range got.Interactions {
			types[i.UserID] = i.InteractionType
			order = append(order, i.UserID)
		}
		assert.Equal(t, map[uint]string{fan.ID: "both", second.ID: "view", likeOnly.ID: "like", first.ID: "view"}, types)
		assert.Equal(t, []uint{fan.ID, second.ID, likeOnly.ID, first.ID}, order)

		page := decodeAs[interactionsResponse](t, get(t, p.photos, owner, itoa(photo.ID), "interactions", "?limit=2&offset=1"), http.StatusOK)
		require.Len(t, page.Interactions, 2)
		assert.Equal(t, second.ID, page.Interactions[0].UserID)
		for _, q := range []string{"?limit=0&offset=-1", "?limit=101", "?limit=abc&offset=abc"} {
			assert.Len(t, decodeAs[interactionsResponse](t, get(t, p.photos, owner, itoa(photo.ID), "interactions", q), http.StatusOK).Interactions, 4, q)
		}
	})

	for kind, forbidden := range map[string]string{
		"viewers":      "Only the photo owner can view viewers",
		"interactions": "Only the photo owner can view interactions",
	} {
		t.Run(kind+" errors", func(t *testing.T) {
			assertErrorMessage(t, get(t, p.photos, owner, "abc", kind, ""), http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid photo ID")
			assertErrorMessage(t, get(t, p.photos, owner, itoa(deletedUserID), kind, ""), http.StatusNotFound, constants.ErrCodePhotoNotFound, "Photo not found")
			assertErrorMessage(t, get(t, p.photos, fan, itoa(photo.ID), kind, ""), http.StatusForbidden, constants.ErrCodeNotAuthorized, forbidden)
		})
	}

	t.Run("database failures", func(t *testing.T) {
		broken := p.broken(t)
		assertErrorMessage(t, get(t, broken, owner, itoa(photo.ID), "viewers", ""), http.StatusInternalServerError, constants.ErrCodeFetchFailed, "Failed to get viewers")
		assertErrorMessage(t, get(t, broken, owner, itoa(photo.ID), "interactions", ""), http.StatusInternalServerError, constants.ErrCodeFetchFailed, "Failed to get interactions")
	})
}

func TestActivityPhotoHandler_LikeAndUnlike(t *testing.T) {
	p := newPhotoEnv(t)
	owner, fan, stranger := p.user(t), p.user(t), p.user(t)
	follow(t, p.db, fan, owner)
	photo := createPhoto(t, p.db, owner.ID, "study", photoDay)
	act := func(t *testing.T, h *handlerSet, user *models.User, method, id string) testutil.Response {
		t.Helper()
		return call(t, h, user, method, "/api/activity-photo/"+id+"/like", nil)
	}
	status := func(t *testing.T) likeStatusResponse {
		t.Helper()
		return decodeAs[likeStatusResponse](t, call(t, p.photos, fan, http.MethodGet, "/api/activity-photo/"+itoa(photo.ID)+"/like-status", nil), http.StatusOK)
	}

	for _, method := range []string{http.MethodPost, http.MethodDelete} {
		t.Run(method+" errors", func(t *testing.T) {
			assertErrorMessage(t, act(t, p.photos, fan, method, "abc"), http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid photo ID")
			assertErrorMessage(t, act(t, p.photos, fan, method, itoa(deletedUserID)), http.StatusNotFound, constants.ErrCodePhotoNotFound, "Photo not found")
		})
	}

	t.Run("own photo", func(t *testing.T) {
		assertErrorMessage(t, act(t, p.photos, owner, http.MethodPost, itoa(photo.ID)), http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Cannot like your own photo")
	})

	t.Run("must follow the owner", func(t *testing.T) {
		assertErrorMessage(t, act(t, p.photos, stranger, http.MethodPost, itoa(photo.ID)), http.StatusForbidden, constants.ErrCodeNotAuthorized, "You must follow this user to like their photos")
	})

	t.Run("like is idempotent and counts as a view", func(t *testing.T) {
		for i := 0; i < 2; i++ {
			res := act(t, p.photos, fan, http.MethodPost, itoa(photo.ID))
			require.Equal(t, http.StatusOK, res.Status)
			assert.Equal(t, map[string]any{"success": true}, res.JSON(t))
		}
		assert.EqualValues(t, 1, count(t, p.db, &models.StoryLike{}, ""))
		assert.EqualValues(t, 1, count(t, p.db, &models.StoryView{}, "viewer_id = ?", fan.ID))
		assert.Equal(t, likeStatusResponse{Success: true, Liked: true, LikeCount: 1}, status(t))
	})

	t.Run("unlike", func(t *testing.T) {
		for i := 0; i < 2; i++ {
			require.Equal(t, http.StatusOK, act(t, p.photos, fan, http.MethodDelete, itoa(photo.ID)).Status)
		}
		assert.Zero(t, count(t, p.db, &models.StoryLike{}, ""))
		assert.Equal(t, likeStatusResponse{Success: true}, status(t))
	})

	t.Run("database failures", func(t *testing.T) {
		broken := p.broken(t)
		assertErrorMessage(t, act(t, broken, fan, http.MethodPost, itoa(photo.ID)), http.StatusInternalServerError, constants.ErrCodeServerError, "Failed to like photo")
		assertErrorMessage(t, act(t, broken, fan, http.MethodDelete, itoa(photo.ID)), http.StatusInternalServerError, constants.ErrCodeServerError, "Failed to unlike photo")
	})
}

func TestActivityPhotoHandler_GetPhotoLikeStatus(t *testing.T) {
	p := newPhotoEnv(t)
	owner, fan := p.user(t), p.user(t)
	follow(t, p.db, fan, owner)
	photo := createPhoto(t, p.db, owner.ID, "study", photoDay)
	path := "/api/activity-photo/" + itoa(photo.ID) + "/like-status"

	t.Run("invalid id", func(t *testing.T) {
		res := call(t, p.photos, fan, http.MethodGet, "/api/activity-photo/abc/like-status", nil)
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid photo ID")
	})

	t.Run("like status lookup fails", func(t *testing.T) {
		res := call(t, p.broken(t), fan, http.MethodGet, path, nil)
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeFetchFailed, "Failed to get like status")
	})

	t.Run("served from the cache", func(t *testing.T) {
		mr := testutil.StartRedis(t)
		require.Equal(t, http.StatusOK, call(t, p.photos, fan, http.MethodPost, "/api/activity-photo/"+itoa(photo.ID)+"/like", nil).Status)
		first := decodeAs[likeStatusResponse](t, call(t, p.photos, fan, http.MethodGet, path, nil), http.StatusOK)
		require.Equal(t, likeStatusResponse{Success: true, Liked: true, LikeCount: 1}, first)
		assert.True(t, mr.Exists("story_like_cnt:"+itoa(photo.ID)))

		require.NoError(t, p.db.Where("1 = 1").Delete(&models.StoryLike{}).Error)
		again := decodeAs[likeStatusResponse](t, call(t, p.photos, fan, http.MethodGet, path, nil), http.StatusOK)
		assert.Equal(t, first, again)
	})

	t.Run("like count lookup fails", func(t *testing.T) {
		mr := testutil.StartRedis(t)
		require.NoError(t, mr.Set("story_liked_by:"+itoa(photo.ID)+":"+itoa(fan.ID), "1"))
		res := call(t, p.broken(t), fan, http.MethodGet, path, nil)
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeFetchFailed, "Failed to get like count")
	})
}

func TestActivityPhotoHandler_LikePhoto_NotifiesTheOwner(t *testing.T) {
	env := newEnv(t)
	logs := observeLogs(t)
	owner := env.user(t)
	fan := env.user(t, withPicture("http://pics.example/fan.jpg"))
	follow(t, env.db, fan, owner)
	photo := createPhoto(t, env.db, owner.ID, "study", photoDay)
	svc, err := services.NewActivityPhotoService(env.activityPhotoRepo, env.userRepo, env.followRepo, env.notifSvc, &env.cfg.AzureStorage)
	require.NoError(t, err)
	h := &handlerSet{activityPhoto: NewActivityPhotoHandler(svc, env.authSvc, env.profileSvc)}
	like := "/api/activity-photo/" + itoa(photo.ID) + "/like"

	require.Equal(t, http.StatusOK, call(t, h, fan, http.MethodPost, like, nil).Status)

	n := waitNotification(t, env.db, owner.ID, models.NotifTypeStoryLiked)
	assert.Equal(t, fan.Username+" liked your story", n.Body)
	assert.Equal(t, *fan.ProfilePic, n.Metadata["liker_avatar"])

	require.Equal(t, http.StatusOK, call(t, h, fan, http.MethodDelete, like, nil).Status)
	require.Equal(t, http.StatusOK, call(t, h, fan, http.MethodPost, like, nil).Status)
	waitLog(t, logs, "Skipping duplicate story like notification")
	assert.EqualValues(t, 1, count(t, env.db, &models.Notification{}, "user_id = ?", owner.ID), "liking again does not notify twice")
}
