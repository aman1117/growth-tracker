package handlers

import (
	"bytes"
	"net/http"
	"strings"
	"testing"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/services"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const blobContainer = "profile-pictures"

// azureConfig returns the storage configuration of cfg pointed at the fake blob store.
func azureConfig(cfg *config.Config, fake *fakeBlobStore) config.AzureStorageConfig {
	storage := cfg.AzureStorage
	storage.ConnectionString = fake.connectionString()
	storage.AccountName = fakeBlobAccount
	return storage
}

func newTestBlobHandler(t *testing.T, blobSvc *services.BlobService, storage config.AzureStorageConfig) *BlobHandler {
	t.Helper()
	h, err := NewBlobHandler(blobSvc, &storage)
	require.NoError(t, err)
	require.True(t, h.IsEnabled())
	return h
}

// uploadPicture posts a multipart profile picture. The body limit is raised above Fiber's 4MB
// default so the handler's own 5MB check is reachable.
func uploadPicture(t *testing.T, h *BlobHandler, user *models.User, filename string, content []byte) testutil.Response {
	t.Helper()
	body, contentType := testutil.Multipart(t, "image", filename, content, nil)
	app := newApp(&handlerSet{blob: h}, user, fiber.Config{BodyLimit: 16 << 20})
	return testutil.Do(t, app, http.MethodPost, "/api/profile/upload-picture", body, testutil.WithHeader("Content-Type", contentType))
}

func profilePicture(t *testing.T, env *testEnv, user *models.User) (pic, thumb *string) {
	t.Helper()
	var u models.User
	require.NoError(t, env.db.First(&u, user.ID).Error)
	return u.ProfilePic, u.ProfilePicThumb
}

func TestNewBlobHandler(t *testing.T) {
	env := newEnv(t)

	t.Run("disabled without a connection string", func(t *testing.T) {
		h, err := NewBlobHandler(env.blobSvc, &config.AzureStorageConfig{ContainerName: blobContainer})
		require.NoError(t, err)
		assert.False(t, h.IsEnabled())
	})

	t.Run("invalid connection string", func(t *testing.T) {
		_, err := NewBlobHandler(env.blobSvc, &config.AzureStorageConfig{ConnectionString: "not a connection string", ContainerName: blobContainer})
		assert.ErrorContains(t, err, "failed to create blob client")
	})

	t.Run("creates the container", func(t *testing.T) {
		fake := newFakeBlobStore(t)
		newTestBlobHandler(t, env.blobSvc, azureConfig(env.cfg, fake))
		assert.Equal(t, []string{blobContainer}, fake.requestsWith(http.MethodPut))
	})

	t.Run("existing container", func(t *testing.T) {
		fake := newFakeBlobStore(t)
		fake.containerStatus, fake.containerCode = http.StatusConflict, "ContainerAlreadyExists"
		logs := observeLogs(t)
		newTestBlobHandler(t, env.blobSvc, azureConfig(env.cfg, fake))
		assert.Zero(t, logs.FilterMessageSnippet("Container creation warning").Len())
	})

	t.Run("container creation failure is only a warning", func(t *testing.T) {
		fake := newFakeBlobStore(t)
		fake.containerStatus, fake.containerCode = http.StatusForbidden, "AuthorizationFailure"
		logs := observeLogs(t)
		newTestBlobHandler(t, env.blobSvc, azureConfig(env.cfg, fake))
		assert.Equal(t, 1, logs.FilterMessageSnippet("Container creation warning").Len())
	})
}

func TestBlobHandler_Disabled(t *testing.T) {
	env := newEnv(t)
	user := env.user(t, withPicture("http://localhost:10000/devstoreaccount1/profile-pictures/1/old.jpg"))
	h, err := NewBlobHandler(env.blobSvc, &env.cfg.AzureStorage)
	require.NoError(t, err)

	res := uploadPicture(t, h, user, "me.png", pngBytes(t, 10, 10))
	assertErrorMessage(t, res, http.StatusServiceUnavailable, constants.ErrCodeServerError, "Profile picture upload is not configured")

	res = call(t, &handlerSet{blob: h}, user, http.MethodDelete, "/api/profile/picture", nil)
	assertSuccessMessage(t, res, http.StatusOK, constants.MsgProfilePicDeleted)
	pic, thumb := profilePicture(t, env, user)
	assert.Nil(t, pic, "the URLs are cleared even when the blobs cannot be deleted")
	assert.Nil(t, thumb)
}

func TestBlobHandler_UploadProfilePicture_Validation(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	h := newTestBlobHandler(t, env.blobSvc, azureConfig(env.cfg, newFakeBlobStore(t)))

	t.Run("not a multipart request", func(t *testing.T) {
		res := call(t, &handlerSet{blob: h}, user, http.MethodPost, "/api/profile/upload-picture", map[string]string{"image": "x"})
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "No image file provided")
	})

	t.Run("missing file", func(t *testing.T) {
		body, contentType := testutil.Multipart(t, "", "", nil, map[string]string{"other": "field"})
		res := call(t, &handlerSet{blob: h}, user, http.MethodPost, "/api/profile/upload-picture", body, testutil.WithHeader("Content-Type", contentType))
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "No image file provided")
	})

	tests := []struct {
		name, filename string
		content        []byte
		message        string
	}{
		{"too large", "big.jpg", bytes.Repeat([]byte{0xFF}, constants.MaxProfilePicSize+1), "Image size must be less than 5MB"},
		{"wrong extension", "notes.txt", []byte("hello"), "Only JPG, PNG, WebP, and HEIC images are allowed"},
		{"not an image", "fake.png", []byte("definitely not a png"), "Failed to process image: invalid image file: unsupported image format"},
		{"heic", "photo.heic", heicHeader, "Failed to process image: HEIC/HEIF images are not yet supported, please convert to JPEG or PNG"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			assertErrorMessage(t, uploadPicture(t, h, user, tc.filename, tc.content), http.StatusBadRequest, constants.ErrCodeInvalidRequest, tc.message)
		})
	}

	t.Run("unknown user", func(t *testing.T) {
		res := uploadPicture(t, h, ghostUser, "me.png", pngBytes(t, 10, 10))
		assertErrorMessage(t, res, http.StatusNotFound, constants.ErrCodeUserNotFound, "User not found")
	})
}

func TestBlobHandler_UploadProfilePicture(t *testing.T) {
	env := newEnv(t)
	fake := newFakeBlobStore(t)
	h := newTestBlobHandler(t, env.blobSvc, azureConfig(env.cfg, fake))
	prefix := "http://localhost:10000/devstoreaccount1/profile-pictures/"
	user := env.user(t, withPicture(prefix+"1/old.jpg"))
	require.NoError(t, env.db.Model(user).Update("profile_pic_thumb", prefix+"1/old_thumb.jpg").Error)

	res := uploadPicture(t, h, user, "Me.PNG", pngBytes(t, 400, 300))

	require.Equal(t, http.StatusOK, res.Status, "body: %s", res.Body)
	got := res.JSON(t)
	assert.Equal(t, true, got["success"])
	pic, thumb := got["profile_pic"].(string), got["profile_pic_thumb"].(string)
	assert.Regexp(t, `^`+prefix+itoa(user.ID)+`/[0-9a-f-]{36}\.jpg$`, pic)
	assert.Equal(t, strings.TrimSuffix(pic, ".jpg")+"_thumb.jpg", thumb)

	full, ok := fake.blob(blobContainer + "/" + strings.TrimPrefix(pic, prefix))
	require.True(t, ok, "full image uploaded")
	assert.Equal(t, 400, decodeJPEG(t, full).Bounds().Dx(), "small images are not upscaled")
	small, ok := fake.blob(blobContainer + "/" + strings.TrimPrefix(thumb, prefix))
	require.True(t, ok, "thumbnail uploaded")
	assert.Equal(t, 200, decodeJPEG(t, small).Bounds().Dx())
	assert.Equal(t, 200, decodeJPEG(t, small).Bounds().Dy())

	assert.ElementsMatch(t, []string{blobContainer + "/1/old.jpg", blobContainer + "/1/old_thumb.jpg"}, fake.requestsWith(http.MethodDelete),
		"the previous picture is deleted")
	storedPic, storedThumb := profilePicture(t, env, user)
	assert.Equal(t, pic, *storedPic)
	assert.Equal(t, thumb, *storedThumb)
}

func TestBlobHandler_UploadProfilePicture_ProductionURLs(t *testing.T) {
	env := newEnv(t)
	fake := newFakeBlobStore(t)
	h := newTestBlobHandler(t, env.blobSvc, azureConfig(env.cfg, fake))
	user := env.user(t)
	useConfig(t, func(c *config.Config) { c.Env = "production" })

	res := uploadPicture(t, h, user, "me.jpg", jpegBytes(t, 2000, 1000))

	require.Equal(t, http.StatusOK, res.Status, "body: %s", res.Body)
	pic := res.JSON(t)["profile_pic"].(string)
	prefix := "https://" + fakeBlobAccount + ".blob.core.windows.net/profile-pictures/"
	require.True(t, strings.HasPrefix(pic, prefix), pic)
	full, ok := fake.blob(blobContainer + "/" + strings.TrimPrefix(pic, prefix))
	require.True(t, ok)
	assert.Equal(t, 1080, decodeJPEG(t, full).Bounds().Dx(), "large images are resized to 1080px")
}

func TestBlobHandler_UploadProfilePicture_Failures(t *testing.T) {
	env := newEnv(t)
	fake := newFakeBlobStore(t)
	h := newTestBlobHandler(t, env.blobSvc, azureConfig(env.cfg, fake))
	user := env.user(t)
	upload := func(t *testing.T, h *BlobHandler) testutil.Response {
		t.Helper()
		return uploadPicture(t, h, user, "me.png", pngBytes(t, 20, 20))
	}

	t.Run("full image upload fails", func(t *testing.T) {
		fake.setFailPut(func(string) bool { return true })
		defer fake.setFailPut(nil)
		assertErrorMessage(t, upload(t, h), http.StatusInternalServerError, constants.ErrCodeServerError, "Failed to upload image")
		assert.Empty(t, fake.blobNames())
	})

	t.Run("thumbnail upload fails and the full image is removed", func(t *testing.T) {
		fake.setFailPut(func(name string) bool { return strings.HasSuffix(name, "_thumb.jpg") })
		defer fake.setFailPut(nil)
		assertErrorMessage(t, upload(t, h), http.StatusInternalServerError, constants.ErrCodeServerError, "Failed to upload image")
		assert.Empty(t, fake.blobNames())
		assert.Len(t, fake.requestsWith(http.MethodDelete), 1)
	})

	t.Run("old blobs that cannot be deleted do not block the upload", func(t *testing.T) {
		require.NoError(t, env.db.Model(user).Updates(map[string]any{
			"profile_pic":       "http://localhost:10000/devstoreaccount1/profile-pictures/1/gone.jpg",
			"profile_pic_thumb": "http://localhost:10000/devstoreaccount1/profile-pictures/1/gone_thumb.jpg",
		}).Error)
		fake.setDeleteStatus(http.StatusNotFound)
		defer fake.setDeleteStatus(0)
		require.Equal(t, http.StatusOK, upload(t, h).Status)
	})

	t.Run("profile update fails", func(t *testing.T) {
		faulty := newStack(faultyDB(t, failOn("update", "users")), env.cfg, false)
		failing := newTestBlobHandler(t, faulty.blobSvc, azureConfig(env.cfg, fake))
		assertErrorMessage(t, upload(t, failing), http.StatusInternalServerError, constants.ErrCodeUpdateFailed, "Failed to update profile")
	})
}

func TestBlobHandler_DeleteProfilePicture(t *testing.T) {
	env := newEnv(t)
	fake := newFakeBlobStore(t)
	h := &handlerSet{blob: newTestBlobHandler(t, env.blobSvc, azureConfig(env.cfg, fake))}
	prefix := "http://localhost:10000/devstoreaccount1/profile-pictures/"
	del := func(t *testing.T, user *models.User) testutil.Response {
		t.Helper()
		return call(t, h, user, http.MethodDelete, "/api/profile/picture", nil)
	}

	t.Run("deletes both blobs and clears the profile", func(t *testing.T) {
		user := env.user(t, withPicture(prefix+"7/pic.jpg"))
		require.NoError(t, env.db.Model(user).Update("profile_pic_thumb", prefix+"7/pic_thumb.jpg").Error)

		assertSuccessMessage(t, del(t, user), http.StatusOK, constants.MsgProfilePicDeleted)

		assert.ElementsMatch(t, []string{blobContainer + "/7/pic.jpg", blobContainer + "/7/pic_thumb.jpg"}, fake.requestsWith(http.MethodDelete))
		pic, thumb := profilePicture(t, env, user)
		assert.Nil(t, pic)
		assert.Nil(t, thumb)
	})

	t.Run("pictures outside the container are not touched", func(t *testing.T) {
		before := len(fake.requestsWith(http.MethodDelete))
		user := env.user(t, withPicture("https://cdn.example.com/elsewhere.jpg"))
		assertSuccessMessage(t, del(t, user), http.StatusOK, constants.MsgProfilePicDeleted)
		assert.Len(t, fake.requestsWith(http.MethodDelete), before)
	})

	t.Run("user without a picture", func(t *testing.T) {
		assertSuccessMessage(t, del(t, env.user(t)), http.StatusOK, constants.MsgProfilePicDeleted)
	})

	t.Run("blob deletion failures are only logged", func(t *testing.T) {
		fake.setDeleteStatus(http.StatusNotFound)
		defer fake.setDeleteStatus(0)
		user := env.user(t, withPicture(prefix+"8/pic.jpg"))
		assertSuccessMessage(t, del(t, user), http.StatusOK, constants.MsgProfilePicDeleted)
	})

	t.Run("unknown user", func(t *testing.T) {
		assertErrorMessage(t, del(t, ghostUser), http.StatusNotFound, constants.ErrCodeUserNotFound, "User not found")
	})

	t.Run("profile update fails", func(t *testing.T) {
		user := env.user(t)
		faulty := newStack(faultyDB(t, failOn("update", "users")), env.cfg, false)
		failing := &handlerSet{blob: newTestBlobHandler(t, faulty.blobSvc, azureConfig(env.cfg, fake))}
		res := call(t, failing, user, http.MethodDelete, "/api/profile/picture", nil)
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeUpdateFailed, "Failed to update profile")
	})

	t.Run("user lookup fails", func(t *testing.T) {
		broken := services.NewBlobService(repository.NewUserRepository(testutil.BrokenDB(t)), &env.cfg.AzureStorage)
		failing := &handlerSet{blob: newTestBlobHandler(t, broken, azureConfig(env.cfg, fake))}
		res := call(t, failing, env.user(t), http.MethodDelete, "/api/profile/picture", nil)
		assertErrorMessage(t, res, http.StatusNotFound, constants.ErrCodeUserNotFound, "User not found")
	})
}
