package testutil_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/aman1117/backend/pkg/redis"
	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/bcrypt"
)

func TestMain(m *testing.M) { os.Exit(testutil.RunWithDatabase(m)) }

func TestSetupInstallsTestConfigAndUTC(t *testing.T) {
	require.NotNil(t, config.AppConfig)
	assert.Equal(t, testutil.JWTSecret, config.AppConfig.JWT.SecretKey)
	assert.Equal(t, time.UTC, time.Local)
}

func TestDatabaseSchemaAndExtensions(t *testing.T) {
	db := testutil.DB(t)

	for _, table := range []string{"users", "activities", "story_likes", "recent_searches", "comments"} {
		assert.True(t, db.Migrator().HasTable(table), "missing table %s", table)
	}

	var similarity float64
	require.NoError(t, db.Raw("SELECT similarity('growth', 'growth')").Scan(&similarity).Error)
	assert.InDelta(t, 1.0, similarity, 0.0001)

	var tz string
	require.NoError(t, db.Raw("SHOW TIME ZONE").Scan(&tz).Error)
	assert.Equal(t, "UTC", tz)

	var unicode string
	require.NoError(t, db.Raw("SELECT ?::text", "streak 🔥 día").Scan(&unicode).Error)
	assert.Equal(t, "streak 🔥 día", unicode)
}

func TestFixturesAndIsolation(t *testing.T) {
	t.Run("creates data", func(t *testing.T) {
		db := testutil.DB(t)
		user := testutil.CreateUser(t, db, func(u *models.User) { u.IsPrivate = true })
		assert.NotZero(t, user.ID)
		assert.True(t, user.IsPrivate)
		assert.NoError(t, bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(testutil.TestPassword)))

		day := testutil.Day(2026, time.March, 9)
		activity := testutil.CreateActivity(t, db, user.ID, models.ActivityStudy, 2.5, day)
		streak := testutil.CreateStreak(t, db, user.ID, 3, 7, day)
		assert.NotZero(t, activity.ID)
		assert.NotZero(t, streak.ID)

		var stored models.Activity
		require.NoError(t, db.First(&stored, activity.ID).Error)
		assert.Equal(t, "2026-03-09", stored.ActivityDate.Format("2006-01-02"))
	})

	t.Run("previous test data is gone", func(t *testing.T) {
		db := testutil.DB(t)
		var count int64
		require.NoError(t, db.Model(&models.User{}).Count(&count).Error)
		assert.Zero(t, count)

		user := testutil.CreateUser(t, db)
		assert.Equal(t, uint(1), user.ID, "identities restart after truncation")
	})
}

func TestBrokenDBFailsEveryQuery(t *testing.T) {
	db := testutil.BrokenDB(t)
	var count int64
	assert.Error(t, db.Model(&models.User{}).Count(&count).Error)
}

func TestStartRedis(t *testing.T) {
	assert.False(t, redis.IsAvailable())

	t.Run("installs an in-memory client", func(t *testing.T) {
		server := testutil.StartRedis(t)
		require.True(t, redis.IsAvailable())
		require.NoError(t, redis.Get().Set(context.Background(), "k", "v", time.Minute).Err())
		got, err := server.Get("k")
		require.NoError(t, err)
		assert.Equal(t, "v", got)
	})

	assert.False(t, redis.IsAvailable(), "client is removed when the test ends")
}

func TestDoAndAsUser(t *testing.T) {
	app := fiber.New()
	app.Post("/echo", testutil.AsUser(42, "alice"), func(c *fiber.Ctx) error {
		var body map[string]any
		if err := c.BodyParser(&body); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
		}
		return c.JSON(fiber.Map{
			"user_id":  c.Locals("user_id"),
			"username": c.Locals("username"),
			"auth":     c.Get("Authorization"),
			"body":     body,
		})
	})
	app.Post("/upload", func(c *fiber.Ctx) error {
		file, err := c.FormFile("photo")
		if err != nil {
			return c.SendStatus(fiber.StatusBadRequest)
		}
		return c.JSON(fiber.Map{"name": file.Filename, "size": file.Size, "caption": c.FormValue("caption")})
	})

	res := testutil.Do(t, app, fiber.MethodPost, "/echo", map[string]any{"hello": "world"}, testutil.WithToken("abc"))
	require.Equal(t, fiber.StatusOK, res.Status)
	body := res.JSON(t)
	assert.EqualValues(t, 42, body["user_id"])
	assert.Equal(t, "alice", body["username"])
	assert.Equal(t, "Bearer abc", body["auth"])
	assert.Equal(t, map[string]any{"hello": "world"}, body["body"])

	res = testutil.Do(t, app, fiber.MethodPost, "/echo", "{not json")
	assert.Equal(t, fiber.StatusBadRequest, res.Status)

	payload, contentType := testutil.Multipart(t, "photo", "a.jpg", []byte("jpeg-bytes"), map[string]string{"caption": "hi"})
	res = testutil.Do(t, app, fiber.MethodPost, "/upload", payload, testutil.WithHeader("Content-Type", contentType))
	require.Equal(t, fiber.StatusOK, res.Status)
	var upload struct {
		Name    string `json:"name"`
		Size    int    `json:"size"`
		Caption string `json:"caption"`
	}
	res.Decode(t, &upload)
	assert.Equal(t, "a.jpg", upload.Name)
	assert.Equal(t, len("jpeg-bytes"), upload.Size)
	assert.Equal(t, "hi", upload.Caption)
}

func TestPtr(t *testing.T) {
	p := testutil.Ptr("bio")
	require.NotNil(t, p)
	assert.Equal(t, "bio", *p)
}
