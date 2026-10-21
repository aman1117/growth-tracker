package handlers

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/alicebob/miniredis/v2/server"
	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/services"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/zap"
	"go.uber.org/zap/zaptest/observer"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

// ==================== Wiring ====================

// stack holds the repositories and services that container.New wires, all built on one
// *gorm.DB: the shared test database, testutil.BrokenDB or a faultyDB.
type stack struct {
	db    *gorm.DB
	cfg   *config.Config
	async bool

	userRepo           *repository.UserRepository
	activityRepo       *repository.ActivityRepository
	streakRepo         *repository.StreakRepository
	tileConfigRepo     *repository.TileConfigRepository
	likeRepo           *repository.LikeRepository
	badgeRepo          *repository.BadgeRepository
	notificationRepo   *repository.NotificationRepository
	pushRepo           *repository.PushRepository
	followRepo         *repository.FollowRepository
	activityPhotoRepo  *repository.ActivityPhotoRepository
	recentSearchRepo   *repository.RecentSearchRepository
	commentRepo        *repository.CommentRepository
	commentLikeRepo    *repository.CommentLikeRepository
	commentMentionRepo *repository.CommentMentionRepository
	commentDedupeRepo  *repository.CommentDedupeRepository

	authSvc       *services.AuthService
	profileSvc    *services.ProfileService
	streakSvc     *services.StreakService
	notifSvc      *services.NotificationService
	activitySvc   *services.ActivityService
	analyticsSvc  *services.AnalyticsService
	tileConfigSvc *services.TileConfigService
	blobSvc       *services.BlobService
	badgeSvc      *services.BadgeService
	followSvc     *services.FollowService
	searchSvc     *services.SearchSuggestionsService
	commentSvc    *services.CommentService
	tokenSvc      *TokenService
}

// newStack mirrors container.New. Unless async is set, the dependencies that only feed
// fire-and-forget goroutines (follow/comment/day-completion notifications and recent-search
// recording) are left nil, which every consumer supports; otherwise those goroutines could
// write to the database after the test truncated it. Tests that enable async wait for the
// side effects they trigger.
func newStack(db *gorm.DB, cfg *config.Config, async bool) *stack {
	s := &stack{db: db, cfg: cfg, async: async}

	s.userRepo = repository.NewUserRepository(db)
	s.activityRepo = repository.NewActivityRepository(db)
	s.streakRepo = repository.NewStreakRepository(db)
	s.tileConfigRepo = repository.NewTileConfigRepository(db)
	s.likeRepo = repository.NewLikeRepository(db)
	s.badgeRepo = repository.NewBadgeRepository(db)
	s.notificationRepo = repository.NewNotificationRepository(db)
	s.pushRepo = repository.NewPushRepository(db)
	s.followRepo = repository.NewFollowRepository(db)
	s.activityPhotoRepo = repository.NewActivityPhotoRepository(db)
	s.recentSearchRepo = repository.NewRecentSearchRepository(db)
	s.commentRepo = repository.NewCommentRepository(db)
	s.commentLikeRepo = repository.NewCommentLikeRepository(db)
	s.commentMentionRepo = repository.NewCommentMentionRepository(db)
	s.commentDedupeRepo = repository.NewCommentDedupeRepository(db)

	s.authSvc = services.NewAuthService(s.userRepo)
	s.profileSvc = services.NewProfileService(s.userRepo, s.followRepo)
	s.streakSvc = services.NewStreakService(s.streakRepo)
	s.notifSvc = services.NewNotificationService(s.notificationRepo)
	s.activitySvc = services.NewActivityService(s.activityRepo, s.streakSvc, s.userRepo, s.followRepo, s.asyncNotif())
	s.analyticsSvc = services.NewAnalyticsService(s.activityRepo, s.streakRepo, s.userRepo)
	s.tileConfigSvc = services.NewTileConfigService(s.tileConfigRepo, s.userRepo, s.activityPhotoRepo)
	s.blobSvc = services.NewBlobService(s.userRepo, &cfg.AzureStorage)
	s.badgeSvc = services.NewBadgeService(s.badgeRepo, s.userRepo)
	s.followSvc = services.NewFollowService(s.followRepo, s.userRepo, &cfg.Follow)
	s.searchSvc = services.NewSearchSuggestionsService(s.recentSearchRepo)
	s.commentSvc = services.NewCommentService(s.commentRepo, s.commentLikeRepo, s.commentMentionRepo,
		s.commentDedupeRepo, s.userRepo, s.followRepo, s.asyncNotif(), s.profileSvc)
	s.tokenSvc = NewTokenService(&cfg.JWT)
	return s
}

func (s *stack) asyncNotif() *services.NotificationService {
	if s.async {
		return s.notifSvc
	}
	return nil
}

// handlerSet holds one instance of every handler; nil entries are not mounted.
type handlerSet struct {
	auth              *AuthHandler
	profile           *ProfileHandler
	activity          *ActivityHandler
	streak            *StreakHandler
	analytics         *AnalyticsHandler
	tileConfig        *TileConfigHandler
	passwordReset     *PasswordResetHandler
	verification      *VerificationHandler
	blob              *BlobHandler
	like              *LikeHandler
	badge             *BadgeHandler
	notification      *NotificationHandler
	push              *PushHandler
	follow            *FollowHandler
	activityPhoto     *ActivityPhotoHandler
	searchSuggestions *SearchSuggestionsHandler
	comment           *CommentHandler
}

// handlers builds the handlers like container.New. The email service is nil (tests that send
// email build their own handler) and so are the optional blob and activity photo handlers.
func (s *stack) handlers() *handlerSet {
	var recentSearches *services.SearchSuggestionsService
	if s.async {
		recentSearches = s.searchSvc
	}
	return &handlerSet{
		auth:              NewAuthHandler(s.authSvc, s.tokenSvc, s.profileSvc, nil),
		profile:           NewProfileHandler(s.profileSvc, s.authSvc, s.followSvc, s.streakSvc, recentSearches),
		activity:          NewActivityHandler(s.activitySvc, s.authSvc, s.profileSvc),
		streak:            NewStreakHandler(s.streakSvc, s.authSvc, s.profileSvc, s.badgeSvc),
		analytics:         NewAnalyticsHandler(s.analyticsSvc, s.authSvc, s.profileSvc),
		tileConfig:        NewTileConfigHandler(s.tileConfigSvc, s.authSvc, s.profileSvc),
		passwordReset:     NewPasswordResetHandler(s.authSvc, nil),
		verification:      NewVerificationHandler(s.userRepo, nil),
		like:              NewLikeHandler(s.likeRepo, s.authSvc, s.profileSvc, s.notifSvc),
		badge:             NewBadgeHandler(s.badgeSvc, s.authSvc),
		notification:      NewNotificationHandler(s.notifSvc),
		push:              NewPushHandler(s.pushRepo, s.cfg),
		follow:            NewFollowHandler(s.followSvc, s.userRepo, s.asyncNotif()),
		searchSuggestions: NewSearchSuggestionsHandler(s.searchSvc),
		comment:           NewCommentHandler(s.commentSvc, s.profileSvc, s.authSvc),
	}
}

// passThrough stands in for middleware.Auth on anonymous requests.
func passThrough(c *fiber.Ctx) error { return c.Next() }

// mountRoutes registers the routes of routes.Router.Setup (same methods and paths) for every
// non-nil handler. auth replaces middleware.Auth; rate limiters are omitted.
func mountRoutes(app *fiber.App, h *handlerSet, auth fiber.Handler) {
	api := app.Group("/api")

	if a := h.auth; a != nil {
		api.Post("/register", a.Register)
		api.Post("/login", a.Login)
		api.Post("/update-username", auth, a.UpdateUsername)
		api.Post("/change-password", auth, a.ChangePassword)
	}
	if p := h.passwordReset; p != nil {
		api.Post("/auth/forgot-password", p.ForgotPassword)
		api.Post("/auth/reset-password", p.ResetPassword)
		api.Get("/auth/reset-password/validate", p.ValidateResetToken)
	}
	if v := h.verification; v != nil {
		api.Post("/auth/verify-email", v.VerifyEmail)
		api.Post("/auth/resend-verification", auth, v.ResendVerificationEmail)
	}
	if p := h.profile; p != nil {
		api.Post("/users", auth, p.SearchUsers)
		api.Get("/autocomplete/users", auth, p.AutocompleteUsers)
		api.Post("/update-privacy", auth, p.UpdatePrivacy)
		api.Get("/get-privacy", auth, p.GetPrivacy)
		api.Post("/update-bio", auth, p.UpdateBio)
		api.Get("/get-bio", auth, p.GetBio)
		api.Get("/profile", auth, p.GetProfile)
		api.Get("/users/:userId/profile", auth, p.GetUserProfile)
	}
	if s := h.searchSuggestions; s != nil {
		api.Get("/search/suggestions", auth, s.GetSearchSuggestions)
		api.Delete("/search/recent/:userId", auth, s.DeleteRecentSearch)
		api.Delete("/search/recent", auth, s.ClearRecentSearches)
	}
	if a := h.activity; a != nil {
		api.Post("/create-activity", auth, a.CreateActivity)
		api.Post("/get-activities", auth, a.GetActivities)
		api.Post("/get-daily-totals", auth, a.GetDailyTotals)
	}
	if s := h.streak; s != nil {
		api.Post("/get-streak", auth, s.GetStreak)
	}
	if a := h.analytics; a != nil {
		api.Post("/get-week-analytics", auth, a.GetWeekAnalytics)
	}
	if tc := h.tileConfig; tc != nil {
		api.Get("/tile-config", auth, tc.GetConfig)
		api.Post("/tile-config", auth, tc.SaveConfig)
		api.Post("/tile-config/user", auth, tc.GetConfigByUsername)
	}
	if l := h.like; l != nil {
		api.Post("/like-day", auth, l.LikeDay)
		api.Post("/unlike-day", auth, l.UnlikeDay)
		api.Post("/get-likes", auth, l.GetLikes)
	}
	if b := h.badge; b != nil {
		api.Get("/badges", auth, b.GetBadges)
		api.Post("/badges/user", auth, b.GetBadgesByUsername)
	}
	if b := h.blob; b != nil {
		api.Post("/profile/upload-picture", auth, b.UploadProfilePicture)
		api.Delete("/profile/picture", auth, b.DeleteProfilePicture)
	}
	if n := h.notification; n != nil {
		notifications := api.Group("/notifications", auth)
		notifications.Get("", n.GetNotifications)
		notifications.Get("/unread-count", n.GetUnreadCount)
		notifications.Patch("/:id/read", n.MarkAsRead)
		notifications.Patch("/read-all", n.MarkAllAsRead)
		notifications.Delete("/:id", n.DeleteNotification)
	}
	if p := h.push; p != nil {
		api.Get("/push/vapid-public-key", p.GetVapidPublicKey)
		api.Post("/push/subscriptions", auth, p.RegisterSubscription)
		api.Delete("/push/subscriptions", auth, p.UnregisterSubscription)
		api.Get("/push/preferences", auth, p.GetPreferences)
		api.Put("/push/preferences", auth, p.UpdatePreferences)
		api.Post("/push/cleanup", auth, p.RunCleanup)
	}
	if f := h.follow; f != nil {
		api.Post("/users/:targetId/follow", auth, f.FollowUser)
		api.Delete("/users/:targetId/follow", auth, f.UnfollowUser)
		api.Post("/follow-requests/:targetId/cancel", auth, f.CancelFollowRequest)
		api.Get("/me/follow-requests/incoming", auth, f.GetIncomingRequests)
		api.Post("/me/follow-requests/:requesterId/accept", auth, f.AcceptFollowRequest)
		api.Post("/me/follow-requests/:requesterId/decline", auth, f.DeclineFollowRequest)
		api.Delete("/me/followers/:followerId", auth, f.RemoveFollower)
		api.Get("/users/:userId/followers", auth, f.GetFollowers)
		api.Get("/users/:userId/following", auth, f.GetFollowing)
		api.Get("/users/:userId/mutuals", auth, f.GetMutuals)
		api.Get("/users/:userId/follow-counts", auth, f.GetFollowCounts)
		api.Post("/me/follow-counts/reconcile", auth, f.ReconcileMyCounters)
		api.Post("/relationships/lookup", auth, f.LookupRelationships)
	}
	if p := h.activityPhoto; p != nil {
		api.Post("/activity-photo", auth, p.UploadPhoto)
		api.Delete("/activity-photo/:id", auth, p.DeletePhoto)
		api.Get("/activity-photos", auth, p.GetPhotos)
		api.Get("/activity-photos/following", auth, p.GetFollowingStories)
		api.Post("/activity-photo/:id/view", auth, p.RecordView)
		api.Get("/activity-photo/:id/viewers", auth, p.GetPhotoViewers)
		api.Post("/activity-photo/:id/like", auth, p.LikePhoto)
		api.Delete("/activity-photo/:id/like", auth, p.UnlikePhoto)
		api.Get("/activity-photo/:id/like-status", auth, p.GetPhotoLikeStatus)
		api.Get("/activity-photo/:id/interactions", auth, p.GetPhotoInteractions)
	}
	if c := h.comment; c != nil {
		api.Post("/days/:username/:date/comments", auth, c.CreateComment)
		api.Post("/days/:username/:date/comments/:commentId/replies", auth, c.CreateReply)
		api.Get("/days/:username/:date/comments", auth, c.GetComments)
		api.Get("/days/:username/:date/comments/count", auth, c.GetCommentCount)
		api.Delete("/comments/:commentId", auth, c.DeleteComment)
		api.Put("/comments/:commentId", auth, c.EditComment)
		api.Post("/comments/:commentId/like", auth, c.LikeComment)
		api.Delete("/comments/:commentId/like", auth, c.UnlikeComment)
		api.Get("/comments/:commentId/replies", auth, c.GetReplies)
	}
}

// newApp mounts h on a fresh Fiber app whose requests are authenticated as user (nil means
// anonymous: no "user_id"/"username" locals).
func newApp(h *handlerSet, user *models.User, cfg ...fiber.Config) *fiber.App {
	app := fiber.New(cfg...)
	auth := fiber.Handler(passThrough)
	if user != nil {
		auth = testutil.AsUser(user.ID, user.Username)
	}
	mountRoutes(app, h, auth)
	return app
}

// call sends one request to h authenticated as user.
func call(t *testing.T, h *handlerSet, user *models.User, method, target string, body any, opts ...testutil.RequestOption) testutil.Response {
	t.Helper()
	return testutil.Do(t, newApp(h, user), method, target, body, opts...)
}

// ==================== Test environment ====================

type envOptions struct {
	async bool
	cfg   *config.Config
}

type envOption func(*envOptions)

// withAsync enables the fire-and-forget side effects (see newStack).
func withAsync() envOption { return func(o *envOptions) { o.async = true } }

// withConfig wires the environment with cfg instead of a default test configuration.
func withConfig(cfg *config.Config) envOption { return func(o *envOptions) { o.cfg = cfg } }

// testEnv is a full set of handlers on the shared test database.
type testEnv struct {
	*stack
	h *handlerSet
}

// newEnv must be called from a top-level test: it uses testutil.DB.
func newEnv(t *testing.T, opts ...envOption) *testEnv {
	t.Helper()
	o := envOptions{}
	for _, opt := range opts {
		opt(&o)
	}
	if o.cfg == nil {
		o.cfg = testutil.Config()
	}
	s := newStack(testutil.DB(t), o.cfg, o.async)
	return &testEnv{stack: s, h: s.handlers()}
}

// brokenStack returns services whose every query fails.
func brokenStack(t *testing.T) *stack {
	t.Helper()
	return newStack(testutil.BrokenDB(t), testutil.Config(), false)
}

func (e *testEnv) do(t *testing.T, user *models.User, method, target string, body any, opts ...testutil.RequestOption) testutil.Response {
	t.Helper()
	return call(t, e.h, user, method, target, body, opts...)
}

// user creates a user the way registration does: UserRepository.Create also initialises the
// user's follow_counters row, and the counter upserts rely on it (without the row the first
// increment only inserts zeros).
func (e *testEnv) user(t *testing.T, opts ...func(*models.User)) *models.User {
	t.Helper()
	u := testutil.CreateUser(t, e.db, opts...)
	require.NoError(t, e.db.Create(&models.FollowCounter{UserID: u.ID}).Error)
	return u
}

// ==================== Fixtures ====================

func itoa(id uint) string { return strconv.FormatUint(uint64(id), 10) }

func private(u *models.User) { u.IsPrivate = true }

func verified(u *models.User) { u.IsVerified = true }

func withUsername(name string) func(*models.User) {
	return func(u *models.User) { u.Username = name }
}

func withBio(bio string) func(*models.User) {
	return func(u *models.User) { u.Bio = &bio }
}

func withPicture(url string) func(*models.User) {
	return func(u *models.User) {
		thumb := url + "?thumb"
		u.ProfilePic = &url
		u.ProfilePicThumb = &thumb
	}
}

// setUnverifiedEmail clears email_verified (a zero value is not written on Create).
func setUnverifiedEmail(t *testing.T, db *gorm.DB, u *models.User) {
	t.Helper()
	require.NoError(t, db.Model(&models.User{}).Where("id = ?", u.ID).Update("email_verified", false).Error)
	u.EmailVerified = false
}

func follow(t *testing.T, db *gorm.DB, follower, followee *models.User) {
	t.Helper()
	createEdge(t, db, follower.ID, followee.ID, models.FollowStateActive)
}

func requestFollow(t *testing.T, db *gorm.DB, follower, followee *models.User) {
	t.Helper()
	createEdge(t, db, follower.ID, followee.ID, models.FollowStatePending)
}

func createEdge(t *testing.T, db *gorm.DB, followerID, followeeID uint, state models.FollowState) {
	t.Helper()
	require.NoError(t, repository.NewFollowRepository(db).CreateFollowWithCounters(followerID, followeeID, state, nil))
}

func edgeState(t *testing.T, db *gorm.DB, followerID, followeeID uint) models.FollowState {
	t.Helper()
	var edge models.FollowEdgeByFollower
	err := db.Where("follower_id = ? AND followee_id = ?", followerID, followeeID).First(&edge).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ""
	}
	require.NoError(t, err)
	return edge.State
}

// createNotification inserts a system notification created at createdAt.
func createNotification(t *testing.T, db *gorm.DB, userID uint, title string, read bool, createdAt time.Time) *models.Notification {
	t.Helper()
	n := &models.Notification{
		UserID:    userID,
		Type:      models.NotifTypeSystemAnnounce,
		Title:     title,
		Body:      title + " body",
		Metadata:  models.NotificationMetadata{"source": "test"},
		CreatedAt: createdAt,
	}
	if read {
		readAt := time.Now()
		n.ReadAt = &readAt
	}
	require.NoError(t, db.Create(n).Error)
	return n
}

func createComment(t *testing.T, db *gorm.DB, dayOwnerID, authorID uint, day time.Time, body string, parent *models.Comment) *models.Comment {
	t.Helper()
	c := &models.Comment{DayOwnerID: dayOwnerID, DayDate: day, AuthorID: authorID, Body: body}
	if parent != nil {
		c.ParentCommentID = &parent.ID
		root := parent.ID
		if parent.RootCommentID != nil {
			root = *parent.RootCommentID
		}
		c.RootCommentID = &root
		c.ReplyToUserID = &parent.AuthorID
	}
	require.NoError(t, db.Create(c).Error)
	return c
}

func createPhoto(t *testing.T, db *gorm.DB, userID uint, activity string, day time.Time) *models.ActivityPhoto {
	t.Helper()
	base := "http://localhost:10000/devstoreaccount1/profile-pictures/activity-photos/" + activity + "-" + day.Format("2006-01-02")
	p := &models.ActivityPhoto{
		UserID:       userID,
		ActivityName: activity,
		PhotoDate:    day,
		PhotoURL:     base + ".jpg",
		ThumbnailURL: base + "_thumb.jpg",
	}
	require.NoError(t, db.Create(p).Error)
	return p
}

func count(t *testing.T, db *gorm.DB, model any, where string, args ...any) int64 {
	t.Helper()
	var n int64
	q := db.Model(model)
	if where != "" {
		q = q.Where(where, args...)
	}
	require.NoError(t, q.Count(&n).Error)
	return n
}

// eventually waits for asynchronous side effects (goroutines started by handlers/services).
func eventually(t *testing.T, cond func() bool, msgAndArgs ...any) {
	t.Helper()
	require.Eventually(t, cond, 5*time.Second, 5*time.Millisecond, msgAndArgs...)
}

// waitNotification waits until userID has a notification of type typ and returns it.
func waitNotification(t *testing.T, db *gorm.DB, userID uint, typ models.NotificationType) models.Notification {
	t.Helper()
	var found models.Notification
	eventually(t, func() bool {
		var n models.Notification
		if db.Where("user_id = ? AND type = ?", userID, typ).First(&n).Error != nil {
			return false
		}
		found = n
		return true
	}, "notification %s for user %d", typ, userID)
	return found
}

// ==================== Response assertions ====================

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	return b
}

// assertError checks the error envelope written by the response package.
func assertError(t *testing.T, res testutil.Response, status int, code string) dto.ErrorResponse {
	t.Helper()
	require.Equalf(t, status, res.Status, "body: %s", res.Body)
	var e dto.ErrorResponse
	res.Decode(t, &e)
	assert.False(t, e.Success)
	assert.Equal(t, code, e.ErrorCode)
	assert.NotEmpty(t, e.Error)
	return e
}

func assertErrorMessage(t *testing.T, res testutil.Response, status int, code, message string) {
	t.Helper()
	e := assertError(t, res, status, code)
	assert.Equal(t, message, e.Error)
}

// assertSuccessMessage checks a dto.SuccessResponse body.
func assertSuccessMessage(t *testing.T, res testutil.Response, status int, message string) {
	t.Helper()
	require.Equalf(t, status, res.Status, "body: %s", res.Body)
	var s dto.SuccessResponse
	res.Decode(t, &s)
	assert.True(t, s.Success)
	assert.Equal(t, message, s.Message)
}

// decodeAs asserts the status and decodes the body into T.
func decodeAs[T any](t *testing.T, res testutil.Response, status int) T {
	t.Helper()
	require.Equalf(t, status, res.Status, "body: %s", res.Body)
	var v T
	res.Decode(t, &v)
	return v
}

// ==================== Configuration and logging ====================

// useConfig installs a fresh test configuration (optionally mutated) as config.AppConfig and
// reinstalls the default one when the test ends.
func useConfig(t *testing.T, mutate func(*config.Config)) *config.Config {
	t.Helper()
	cfg := testutil.Config()
	if mutate != nil {
		mutate(cfg)
	}
	t.Cleanup(func() { testutil.Config() })
	return cfg
}

// observeLogs routes the global loggers to an in-memory observer for the rest of the test, so
// tests can wait for log lines written by background goroutines.
func observeLogs(t *testing.T) *observer.ObservedLogs {
	t.Helper()
	core, logs := observer.New(zap.DebugLevel)
	prevLog, prevSugar := logger.Log, logger.Sugar
	logger.Log = zap.New(core)
	logger.Sugar = logger.Log.Sugar()
	t.Cleanup(func() { logger.Log, logger.Sugar = prevLog, prevSugar })
	return logs
}

func waitLog(t *testing.T, logs *observer.ObservedLogs, message string) {
	t.Helper()
	eventually(t, func() bool { return logs.FilterMessage(message).Len() > 0 }, "log %q", message)
}

// ==================== Fault injection ====================

// failRedisCommand makes miniredis answer cmd (upper case) with an error when its first
// argument starts with keyPrefix; every other command behaves normally.
func failRedisCommand(mr *miniredis.Miniredis, cmd, keyPrefix string) {
	mr.Server().SetPreHook(func(c *server.Peer, command string, args ...string) bool {
		if command == cmd && len(args) > 0 && strings.HasPrefix(args[0], keyPrefix) {
			c.WriteError("ERR injected failure")
			return true
		}
		return false
	})
}

var errInjected = errors.New("injected database failure")

// faultFunc decides whether a statement fails. op is one of create, query, update, delete,
// row (Raw(...).Scan) and raw (Exec).
type faultFunc func(op string, stmt *gorm.Statement) bool

// failOn fails every op statement against table.
func failOn(op, table string) faultFunc {
	return func(gotOp string, stmt *gorm.Statement) bool { return gotOp == op && stmt.Table == table }
}

// failSQL fails raw/row statements whose SQL contains fragment.
func failSQL(fragment string) faultFunc {
	return func(op string, stmt *gorm.Statement) bool {
		return (op == "raw" || op == "row") && strings.Contains(stmt.SQL.String(), fragment)
	}
}

// failNth fails the nth statement (1-based) matched by match.
func failNth(n int, match faultFunc) faultFunc {
	var mu sync.Mutex
	seen := 0
	return func(op string, stmt *gorm.Statement) bool {
		if !match(op, stmt) {
			return false
		}
		mu.Lock()
		defer mu.Unlock()
		seen++
		return seen == n
	}
}

func anyOf(fns ...faultFunc) faultFunc {
	return func(op string, stmt *gorm.Statement) bool {
		for _, fn := range fns {
			if fn(op, stmt) {
				return true
			}
		}
		return false
	}
}

// faultyDB opens a second connection pool to the test database in which statements selected by
// fail return errInjected without reaching PostgreSQL. It covers branches where an earlier
// query must succeed and a later one fail, which testutil.BrokenDB cannot express.
func faultyDB(t *testing.T, fail faultFunc) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(postgres.Open(testutil.DSN(t)), &gorm.Config{
		Logger: gormlogger.Default.LogMode(gormlogger.Silent),
	})
	require.NoError(t, err)
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	inject := func(op string) func(*gorm.DB) {
		return func(tx *gorm.DB) {
			if tx.Error == nil && fail(op, tx.Statement) {
				_ = tx.AddError(errInjected)
			}
		}
	}
	cb := db.Callback()
	require.NoError(t, cb.Create().Before("gorm:create").Register("test:fault_create", inject("create")))
	require.NoError(t, cb.Query().Before("gorm:query").Register("test:fault_query", inject("query")))
	require.NoError(t, cb.Update().Before("gorm:update").Register("test:fault_update", inject("update")))
	require.NoError(t, cb.Delete().Before("gorm:delete").Register("test:fault_delete", inject("delete")))
	require.NoError(t, cb.Row().Before("gorm:row").Register("test:fault_row", inject("row")))
	require.NoError(t, cb.Raw().Before("gorm:raw").Register("test:fault_raw", inject("raw")))
	return db
}

// ==================== Images ====================

func testImage(w, h int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 128, A: 255})
		}
	}
	return img
}

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, testImage(w, h)))
	return buf.Bytes()
}

func jpegBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, jpeg.Encode(&buf, testImage(w, h), &jpeg.Options{Quality: 80}))
	return buf.Bytes()
}

// heicHeader starts like an ISO BMFF "ftyp" box, which the image processor detects as HEIC.
var heicHeader = []byte{0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00}

func decodeJPEG(t *testing.T, data []byte) image.Image {
	t.Helper()
	img, err := jpeg.Decode(bytes.NewReader(data))
	require.NoError(t, err)
	return img
}

// ==================== Fake Azure Blob Storage ====================

const fakeBlobAccount = "devstoreaccount1"

// fakeBlobStore is a minimal Azure Blob endpoint: container creation, single-shot block blob
// uploads and deletes. Failures can be injected per request.
type fakeBlobStore struct {
	server *httptest.Server

	mu              sync.Mutex
	blobs           map[string][]byte
	requests        []string
	failPut         func(name string) bool
	deleteStatus    int
	containerStatus int
	containerCode   string
}

func newFakeBlobStore(t *testing.T) *fakeBlobStore {
	t.Helper()
	f := &fakeBlobStore{blobs: map[string][]byte{}}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	return f
}

// connectionString points the Azure SDK at the fake. The account key is random per run.
func (f *fakeBlobStore) connectionString() string {
	key := make([]byte, 64)
	_, _ = rand.Read(key)
	return "DefaultEndpointsProtocol=http;AccountName=" + fakeBlobAccount +
		";AccountKey=" + base64.StdEncoding.EncodeToString(key) +
		";BlobEndpoint=" + f.server.URL + "/" + fakeBlobAccount + ";"
}

func (f *fakeBlobStore) serve(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/"+fakeBlobAccount+"/")
	body, _ := io.ReadAll(r.Body)

	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, r.Method+" "+name)
	w.Header().Set("x-ms-request-id", "fake-request")

	switch {
	case r.Method == http.MethodPut && r.URL.Query().Get("restype") == "container":
		status := f.containerStatus
		if status == 0 {
			status = http.StatusCreated
		}
		if f.containerCode != "" {
			w.Header().Set("x-ms-error-code", f.containerCode)
		}
		w.WriteHeader(status)
	case r.Method == http.MethodPut:
		if f.failPut != nil && f.failPut(name) {
			w.Header().Set("x-ms-error-code", "InternalError")
			// Ask the SDK to retry after 1ms so its retry policy does not slow the tests down.
			w.Header().Set("x-ms-retry-after-ms", "1")
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		f.blobs[name] = body
		w.Header().Set("ETag", `"0x8D0000000000001"`)
		w.WriteHeader(http.StatusCreated)
	case r.Method == http.MethodDelete:
		if f.deleteStatus != 0 {
			w.Header().Set("x-ms-error-code", "BlobNotFound")
			w.WriteHeader(f.deleteStatus)
			return
		}
		delete(f.blobs, name)
		w.WriteHeader(http.StatusAccepted)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *fakeBlobStore) blob(name string) ([]byte, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, ok := f.blobs[name]
	return b, ok
}

func (f *fakeBlobStore) blobNames() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	names := make([]string, 0, len(f.blobs))
	for name := range f.blobs {
		names = append(names, name)
	}
	return names
}

// requestsWith returns "METHOD name" entries recorded for method.
func (f *fakeBlobStore) requestsWith(method string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, r := range f.requests {
		if strings.HasPrefix(r, method+" ") {
			out = append(out, strings.TrimPrefix(r, method+" "))
		}
	}
	return out
}

func (f *fakeBlobStore) setFailPut(fn func(name string) bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failPut = fn
}

func (f *fakeBlobStore) setDeleteStatus(status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleteStatus = status
}

// ==================== Fake SMTP server ====================

// fakeSMTP speaks enough SMTP for net/smtp.SendMail (used by services.EmailService when no
// Resend key is configured) and hands every message body to mails.
type fakeSMTP struct {
	addr   string
	reject bool
	mails  chan string
	ln     net.Listener
	wg     sync.WaitGroup
}

func newFakeSMTP(t *testing.T, reject bool) *fakeSMTP {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	s := &fakeSMTP{addr: ln.Addr().String(), reject: reject, mails: make(chan string, 16), ln: ln}
	s.wg.Add(1)
	go s.serve()
	t.Cleanup(func() {
		_ = ln.Close()
		s.wg.Wait()
	})
	return s
}

func (s *fakeSMTP) serve() {
	defer s.wg.Done()
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.handle(conn)
		}()
	}
}

func (s *fakeSMTP) handle(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	r := bufio.NewReader(conn)
	reply := func(line string) { _, _ = io.WriteString(conn, line+"\r\n") }

	reply("220 fake.smtp ESMTP")
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		cmd := strings.ToUpper(strings.TrimSpace(line))
		switch {
		case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
			reply("250 fake.smtp")
		case strings.HasPrefix(cmd, "MAIL FROM"):
			if s.reject {
				reply("550 5.7.1 sender rejected")
				continue
			}
			reply("250 OK")
		case cmd == "DATA":
			reply("354 End data with <CR><LF>.<CR><LF>")
			var data strings.Builder
			for {
				l, err := r.ReadString('\n')
				if err != nil {
					return
				}
				if l == ".\r\n" {
					break
				}
				data.WriteString(strings.TrimPrefix(l, "."))
			}
			s.mails <- data.String()
			reply("250 OK")
		case cmd == "QUIT":
			reply("221 Bye")
			return
		default: // RCPT, RSET, NOOP
			reply("250 OK")
		}
	}
}

// waitMail returns the next message delivered to the fake server.
func (s *fakeSMTP) waitMail(t *testing.T) string {
	t.Helper()
	select {
	case m := <-s.mails:
		return m
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for an email")
		return ""
	}
}

// assertNoMail checks that nothing was delivered so far.
func (s *fakeSMTP) assertNoMail(t *testing.T) {
	t.Helper()
	select {
	case m := <-s.mails:
		t.Fatalf("unexpected email:\n%s", m)
	default:
	}
}

// newEmailService builds the production EmailService pointed at the fake SMTP server.
func newEmailService(t *testing.T, srv *fakeSMTP, cfg *config.Config) *services.EmailService {
	t.Helper()
	host, port, err := net.SplitHostPort(srv.addr)
	require.NoError(t, err)
	t.Setenv("SMTP_HOST", host)
	t.Setenv("SMTP_PORT", port)
	svc, err := services.NewEmailService(&cfg.Email, cfg.Server.FrontendURL)
	require.NoError(t, err)
	return svc
}

var mailTokenPattern = regexp.MustCompile(`token=([0-9a-f]{64})`)

// tokenFromMail extracts the raw token from the link in an email body.
func tokenFromMail(t *testing.T, mail string) string {
	t.Helper()
	m := mailTokenPattern.FindStringSubmatch(mail)
	require.NotNil(t, m, "no token link in email:\n%s", mail)
	return m[1]
}
