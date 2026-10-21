package repository

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"
)

// t0 is a fixed reference time for rows whose ordering matters.
var t0 = time.Date(2026, time.March, 1, 12, 0, 0, 0, time.UTC)

// day is the DATE most fixtures are recorded on.
var day = testutil.Day(2026, time.March, 9)

// ==================== Fault injection ====================

// errInjected is the error of statements failed on purpose by faultyDB.
var errInjected = errors.New("injected failure")

// stmtMatcher selects the statements faultyDB fails. op names the GORM callback chain that
// runs the statement: "create", "query" (Find/First/Count/Pluck), "update", "delete",
// "raw" (Exec) or "row" (Raw/Scan).
type stmtMatcher func(op string, stmt *gorm.Statement) bool

// faultyDB opens a second handle on the package database whose statements fail when match
// reports true. Unlike testutil.BrokenDB the other statements succeed, which reaches error
// branches that follow successful statements and shows whether transactions roll back.
func faultyDB(t *testing.T, match stmtMatcher) *gorm.DB {
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
			if match(op, tx.Statement) {
				_ = tx.AddError(errInjected)
			}
		}
	}
	cb := db.Callback()
	require.NoError(t, cb.Create().Before("gorm:create").Register("test:inject_create", inject("create")))
	require.NoError(t, cb.Query().Before("gorm:query").Register("test:inject_query", inject("query")))
	require.NoError(t, cb.Update().Before("gorm:update").Register("test:inject_update", inject("update")))
	require.NoError(t, cb.Delete().Before("gorm:delete").Register("test:inject_delete", inject("delete")))
	require.NoError(t, cb.Raw().Before("gorm:raw").Register("test:inject_raw", inject("raw")))
	require.NoError(t, cb.Row().Before("gorm:row").Register("test:inject_row", inject("row")))
	return db
}

// on matches statements of one operation on one table.
func on(op, table string) stmtMatcher {
	return func(gotOp string, stmt *gorm.Statement) bool {
		return gotOp == op && stmt.Table == table
	}
}

// sqlContains matches raw statements (Exec or Raw) whose SQL contains fragment.
func sqlContains(fragment string) stmtMatcher {
	return func(op string, stmt *gorm.Statement) bool {
		return (op == "raw" || op == "row") && strings.Contains(stmt.SQL.String(), fragment)
	}
}

// nth narrows match to its nth (1-based) matching statement.
func nth(n int, match stmtMatcher) stmtMatcher {
	seen := 0
	return func(op string, stmt *gorm.Statement) bool {
		if !match(op, stmt) {
			return false
		}
		seen++
		return seen == n
	}
}

// ==================== Fixtures ====================

// namedUser creates a user with the given username.
func namedUser(t *testing.T, db *gorm.DB, username string, opts ...func(*models.User)) *models.User {
	t.Helper()
	return testutil.CreateUser(t, db, append([]func(*models.User){
		func(u *models.User) { u.Username = username },
	}, opts...)...)
}

func private(u *models.User)  { u.IsPrivate = true }
func verified(u *models.User) { u.IsVerified = true }

// withAvatar sets profile picture URLs derived from the username.
func withAvatar(u *models.User) {
	u.ProfilePic = testutil.Ptr("https://blob.example.com/avatars/" + u.Username + ".jpg")
	u.ProfilePicThumb = testutil.Ptr("https://blob.example.com/avatars/" + u.Username + "_thumb.jpg")
}

// follow inserts a follow edge into both edge tables.
func follow(t *testing.T, db *gorm.DB, followerID, followeeID uint, state models.FollowState, createdAt time.Time) {
	t.Helper()
	require.NoError(t, db.Create(&models.FollowEdgeByFollower{
		FollowerID: followerID, FolloweeID: followeeID, State: state, CreatedAt: createdAt,
	}).Error)
	require.NoError(t, db.Create(&models.FollowEdgeByFollowee{
		FolloweeID: followeeID, FollowerID: followerID, State: state, CreatedAt: createdAt,
	}).Error)
}

// counts is a compact view of a follow_counters row.
type counts struct{ Followers, Following, Pending int64 }

// setCounters writes a user's follow_counters row.
func setCounters(t *testing.T, db *gorm.DB, userID uint, c counts) {
	t.Helper()
	require.NoError(t, db.Exec(`
		INSERT INTO follow_counters (user_id, followers_count, following_count, pending_requests_count, updated_at)
		VALUES (?, ?, ?, ?, NOW())
		ON CONFLICT (user_id) DO UPDATE SET
			followers_count = EXCLUDED.followers_count,
			following_count = EXCLUDED.following_count,
			pending_requests_count = EXCLUDED.pending_requests_count`,
		userID, c.Followers, c.Following, c.Pending).Error)
}

// countsOf reads a user's follow_counters row, which must exist.
func countsOf(t *testing.T, db *gorm.DB, userID uint) counts {
	t.Helper()
	var c models.FollowCounter
	require.NoError(t, db.Where("user_id = ?", userID).First(&c).Error, "follow_counters row of user %d", userID)
	return counts{Followers: c.FollowersCount, Following: c.FollowingCount, Pending: c.PendingRequestsCount}
}

// edgeStates returns the state of the follower -> followee edge in both edge tables ("" when
// missing), so tests can check the tables stay in sync.
func edgeStates(t *testing.T, db *gorm.DB, followerID, followeeID uint) (byFollower, byFollowee models.FollowState) {
	t.Helper()
	var a models.FollowEdgeByFollower
	if err := db.Where("follower_id = ? AND followee_id = ?", followerID, followeeID).First(&a).Error; err == nil {
		byFollower = a.State
	} else {
		require.ErrorIs(t, err, gorm.ErrRecordNotFound)
	}
	var b models.FollowEdgeByFollowee
	if err := db.Where("followee_id = ? AND follower_id = ?", followeeID, followerID).First(&b).Error; err == nil {
		byFollowee = b.State
	} else {
		require.ErrorIs(t, err, gorm.ErrRecordNotFound)
	}
	return byFollower, byFollowee
}

// createPhoto inserts a story photo for userID's activity on photoDate.
func createPhoto(t *testing.T, db *gorm.DB, userID uint, activity string, photoDate, createdAt time.Time) *models.ActivityPhoto {
	t.Helper()
	photo := &models.ActivityPhoto{
		UserID:       userID,
		ActivityName: activity,
		PhotoDate:    photoDate,
		PhotoURL:     fmt.Sprintf("https://blob.example.com/photos/%d/%s/%s.jpg", userID, photoDate.Format("2006-01-02"), activity),
		ThumbnailURL: fmt.Sprintf("https://blob.example.com/thumbs/%d/%s/%s.jpg", userID, photoDate.Format("2006-01-02"), activity),
		CreatedAt:    createdAt,
	}
	require.NoError(t, db.Create(photo).Error)
	return photo
}

// createComment inserts a comment on ownerID's day; parent is nil for a top-level comment.
func createComment(t *testing.T, db *gorm.DB, ownerID uint, dayDate time.Time, authorID uint, parent *models.Comment, body string, createdAt time.Time) *models.Comment {
	t.Helper()
	comment := &models.Comment{DayOwnerID: ownerID, DayDate: dayDate, AuthorID: authorID, Body: body, CreatedAt: createdAt}
	if parent != nil {
		parentID, root, replyTo := parent.ID, parent.ID, parent.AuthorID
		if parent.RootCommentID != nil {
			root = *parent.RootCommentID
		}
		comment.ParentCommentID, comment.RootCommentID, comment.ReplyToUserID = &parentID, &root, &replyTo
	}
	require.NoError(t, db.Create(comment).Error)
	return comment
}

// userIDs returns the IDs of users, in order.
func userIDs(users ...*models.User) []uint {
	ids := make([]uint, len(users))
	for i, u := range users {
		ids[i] = u.ID
	}
	return ids
}
