package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/internal/validator"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

var commentDay = testutil.Day(2026, time.March, 10)

func newCommentService(db *gorm.DB, notif *NotificationService) *CommentService {
	return newCommentServiceWith(db, db, notif)
}

// newCommentServiceWith uses commentDB for the comment repositories and userDB for the user
// and follow repositories.
func newCommentServiceWith(commentDB, userDB *gorm.DB, notif *NotificationService) *CommentService {
	userRepo := repository.NewUserRepository(userDB)
	followRepo := repository.NewFollowRepository(userDB)
	return NewCommentService(
		repository.NewCommentRepository(commentDB),
		repository.NewCommentLikeRepository(commentDB),
		repository.NewCommentMentionRepository(commentDB),
		repository.NewCommentDedupeRepository(commentDB),
		userRepo,
		followRepo,
		notif,
		NewProfileService(userRepo, followRepo),
	)
}

func commentCountKey(ownerID uint, day time.Time) string {
	return fmt.Sprintf("%s%d:%s", constants.CommentCountCachePrefix, ownerID, day.Format(constants.DateFormat))
}

// seedComment inserts a comment directly, for tests that need control over its fields.
func seedComment(t *testing.T, db *gorm.DB, ownerID, authorID uint, body string, opts ...func(*models.Comment)) *models.Comment {
	t.Helper()
	c := &models.Comment{DayOwnerID: ownerID, DayDate: commentDay, AuthorID: authorID, Body: body}
	for _, opt := range opts {
		opt(c)
	}
	require.NoError(t, db.Create(c).Error)
	return c
}

func loadComment(t *testing.T, db *gorm.DB, id uint) models.Comment {
	t.Helper()
	var c models.Comment
	require.NoError(t, db.First(&c, id).Error)
	return c
}

func assertValidationCode(t *testing.T, err error, code string) {
	t.Helper()
	var vErr *validator.ValidationError
	require.ErrorAs(t, err, &vErr)
	assert.Equal(t, code, vErr.ErrorCode)
}

func notificationTypes(t *testing.T, db *gorm.DB, userID uint) []models.NotificationType {
	t.Helper()
	var types []models.NotificationType
	for _, n := range notificationsOf(t, db, userID) {
		types = append(types, n.Type)
	}
	return types
}

func mentionNames(mentions []dto.MentionDTO) []string {
	names := []string{}
	for _, m := range mentions {
		names = append(names, m.Username)
	}
	return names
}

func TestCommentService_CreateComment_TopLevel(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	mr := startRedis(t)
	svc := newCommentService(db, newNotificationService(db))
	owner := newUser(t, db)
	author := newUser(t, db, func(u *models.User) {
		u.ProfilePic = testutil.Ptr("https://img/author.jpg")
		u.ProfilePicThumb = testutil.Ptr("https://img/author_thumb.jpg")
		u.IsVerified = true
	})
	friend := newUser(t, db)
	mr.Set(commentCountKey(owner.ID, commentDay), "4")

	body := fmt.Sprintf("  Great day @%s and @%s! @nobody_here  ", friend.Username, friend.Username)
	got, err := svc.CreateComment(ctx, author.ID, author.Username, owner.ID, owner.Username, commentDay, body, nil, nil)
	require.NoError(t, err)

	trimmed := strings.TrimSpace(body)
	assert.NotZero(t, got.ID)
	assert.Equal(t, owner.ID, got.DayOwnerID)
	assert.Equal(t, "2026-03-10", got.DayDate)
	assert.Equal(t, author.ID, got.AuthorID)
	assert.Equal(t, author.Username, got.AuthorUsername)
	assert.Equal(t, author.ProfilePic, got.AuthorAvatar)
	assert.Equal(t, author.ProfilePicThumb, got.AuthorAvatarThumb)
	assert.True(t, got.AuthorVerified)
	assert.Equal(t, trimmed, got.Body)
	assert.Nil(t, got.ParentCommentID)
	assert.Nil(t, got.RootCommentID)
	assert.Nil(t, got.ReplyToUsername)
	assert.Equal(t, []dto.MentionDTO{{UserID: friend.ID, Username: friend.Username}}, got.Mentions,
		"duplicate and unknown mentions are dropped")
	_, err = time.Parse("2006-01-02T15:04:05Z", got.CreatedAt)
	assert.NoError(t, err)

	stored := loadComment(t, db, got.ID)
	assert.Equal(t, trimmed, stored.Body)
	assert.Equal(t, "2026-03-10", stored.DayDate.Format(constants.DateFormat))
	var mentions []models.CommentMention
	require.NoError(t, db.Where("comment_id = ?", got.ID).Find(&mentions).Error)
	require.Len(t, mentions, 1)
	assert.Equal(t, friend.ID, mentions[0].MentionedUserID)
	var dedupe models.CommentDedupe
	require.NoError(t, db.Where("comment_id = ?", got.ID).First(&dedupe).Error)
	assert.Equal(t, hashBody(trimmed), dedupe.BodyHash)
	assert.Nil(t, dedupe.IdempotencyKey)
	assert.False(t, mr.Exists(commentCountKey(owner.ID, commentDay)), "comment count cache is invalidated")

	waitForAsync(t)
	ownerNotifs := notificationsOf(t, db, owner.ID)
	require.Len(t, ownerNotifs, 1)
	assert.Equal(t, models.NotifTypeCommentReceived, ownerNotifs[0].Type)
	assert.EqualValues(t, got.ID, ownerNotifs[0].Metadata["comment_id"])
	assert.Equal(t, trimmed, ownerNotifs[0].Metadata["comment_preview"])
	assert.Equal(t, owner.Username, ownerNotifs[0].Metadata["day_owner_username"])
	assert.Equal(t, "2026-03-10", ownerNotifs[0].Metadata["day_date"])
	assert.Equal(t, "https://img/author.jpg", ownerNotifs[0].Metadata["author_avatar"])
	assert.Equal(t, []models.NotificationType{models.NotifTypeCommentMention}, notificationTypes(t, db, friend.ID))
	assert.Empty(t, notificationsOf(t, db, author.ID), "authors are never notified about their own comment")
}

func TestCommentService_CreateComment_Validation(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newCommentService(db, nil)
	owner := newUser(t, db)
	author := newUser(t, db)

	create := func(body string) (*dto.CommentDTO, error) {
		return svc.CreateComment(ctx, author.ID, author.Username, owner.ID, owner.Username, commentDay, body, nil, nil)
	}

	_, err := create("   ")
	assertValidationCode(t, err, constants.ErrCodeCommentEmpty)
	_, err = create(strings.Repeat("a", constants.CommentBodyMaxLength+1))
	assertValidationCode(t, err, constants.ErrCodeCommentTooLong)

	var many []string
	for i := 0; i <= constants.CommentMaxMentions; i++ {
		many = append(many, fmt.Sprintf("@user_%02d", i))
	}
	_, err = create(strings.Join(many, " "))
	assertValidationCode(t, err, constants.ErrCodeTooManyMentions)
	assert.Zero(t, countRows(t, db, &models.Comment{}))

	longest, err := create(strings.Repeat("b", constants.CommentBodyMaxLength))
	require.NoError(t, err)
	assert.Len(t, longest.Body, constants.CommentBodyMaxLength)
	assert.Equal(t, []dto.MentionDTO{}, longest.Mentions)

	ghost, err := create("hello @ghost_user")
	require.NoError(t, err)
	assert.Equal(t, []dto.MentionDTO{}, ghost.Mentions, "mentions of unknown users are dropped")
	assert.Zero(t, countRows(t, db, &models.CommentMention{}))

	unicode, err := create("streak 🔥 día — ¡bien!")
	require.NoError(t, err)
	assert.Equal(t, "streak 🔥 día — ¡bien!", loadComment(t, db, unicode.ID).Body)

	_, err = create("streak 🔥 día — ¡bien!")
	assertValidationCode(t, err, constants.ErrCodeDuplicateComment)

	otherDay, err := svc.CreateComment(ctx, author.ID, author.Username, owner.ID, owner.Username,
		commentDay.AddDate(0, 0, 1), "streak 🔥 día — ¡bien!", nil, nil)
	require.NoError(t, err, "the same text on another day is not a duplicate")
	assert.Equal(t, "2026-03-11", otherDay.DayDate)

	parent := uint(999999)
	_, err = svc.CreateComment(ctx, author.ID, author.Username, owner.ID, owner.Username, commentDay, "reply", &parent, nil)
	assertValidationCode(t, err, constants.ErrCodeParentNotFound)
}

func TestCommentService_CreateComment_Idempotency(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newCommentService(db, nil)
	owner := newUser(t, db)
	author := newUser(t, db)
	key := "client-key-1"

	first, err := svc.CreateComment(ctx, author.ID, author.Username, owner.ID, owner.Username, commentDay, "hello", nil, &key)
	require.NoError(t, err)

	again, err := svc.CreateComment(ctx, author.ID, author.Username, owner.ID, owner.Username, commentDay, "different text", nil, &key)
	require.NoError(t, err)
	assert.Equal(t, first.ID, again.ID, "a retried request returns the original comment")
	assert.Equal(t, "hello", again.Body)
	assert.EqualValues(t, 1, countRows(t, db, &models.Comment{}))

	empty := ""
	_, err = svc.CreateComment(ctx, author.ID, author.Username, owner.ID, owner.Username, commentDay, "empty key is ignored", nil, &empty)
	require.NoError(t, err)

	t.Run("key of a vanished comment does not block a new one", func(t *testing.T) {
		require.NoError(t, db.Delete(&models.Comment{}, first.ID).Error)
		created, err := svc.CreateComment(ctx, author.ID, author.Username, owner.ID, owner.Username, commentDay, "brand new", nil, &key)
		require.NoError(t, err, "storing the dedupe record fails (key already used) but the comment is kept")
		assert.NotEqual(t, first.ID, created.ID)
		assert.Equal(t, "brand new", loadComment(t, db, created.ID).Body)
	})
}

func TestCommentService_CreateComment_Replies(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newCommentService(db, newNotificationService(db))
	owner := newUser(t, db)
	alice := newUser(t, db)
	bob := newUser(t, db)

	top, err := svc.CreateComment(ctx, alice.ID, alice.Username, owner.ID, owner.Username, commentDay, "top level", nil, nil)
	require.NoError(t, err)

	reply, err := svc.CreateComment(ctx, bob.ID, bob.Username, owner.ID, owner.Username, commentDay, "first reply", &top.ID, nil)
	require.NoError(t, err)
	assert.Equal(t, &top.ID, reply.ParentCommentID)
	assert.Equal(t, &top.ID, reply.RootCommentID)
	assert.Equal(t, &alice.ID, reply.ReplyToUserID)
	require.NotNil(t, reply.ReplyToUsername)
	assert.Equal(t, alice.Username, *reply.ReplyToUsername)

	nested, err := svc.CreateComment(ctx, alice.ID, alice.Username, owner.ID, owner.Username, commentDay, "nested reply", &reply.ID, nil)
	require.NoError(t, err)
	assert.Equal(t, &reply.ID, nested.ParentCommentID)
	assert.Equal(t, &top.ID, nested.RootCommentID, "replies to replies keep the thread root")
	assert.Equal(t, &bob.ID, nested.ReplyToUserID)

	assert.Equal(t, 2, loadComment(t, db, top.ID).ReplyCount, "every ancestor counts the reply")
	assert.Equal(t, 1, loadComment(t, db, reply.ID).ReplyCount)
	assert.Equal(t, 0, loadComment(t, db, nested.ID).ReplyCount)

	waitForAsync(t)
	assert.ElementsMatch(t,
		[]models.NotificationType{models.NotifTypeCommentReceived, models.NotifTypeCommentReceived, models.NotifTypeCommentReceived},
		notificationTypes(t, db, owner.ID), "the day owner hears about every comment")
	assert.Equal(t, []models.NotificationType{models.NotifTypeCommentReply}, notificationTypes(t, db, alice.ID))
	assert.Equal(t, []models.NotificationType{models.NotifTypeCommentReply}, notificationTypes(t, db, bob.ID))
}

func TestCommentService_CreateComment_DegradedDependencies(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	owner := newUser(t, db)
	author := newUser(t, db, func(u *models.User) { u.ProfilePic = testutil.Ptr("https://img/a.jpg") })
	friend := newUser(t, db)
	key := "key-degraded"

	t.Run("dedupe lookups failing do not block commenting", func(t *testing.T) {
		svc := newCommentServiceWith(faultyDB(t, failingOn("query", "comment_dedupes")), db, nil)
		got, err := svc.CreateComment(ctx, author.ID, author.Username, owner.ID, owner.Username, commentDay, "dedupe down", nil, &key)
		require.NoError(t, err)
		assert.Equal(t, "dedupe down", loadComment(t, db, got.ID).Body)
	})

	t.Run("comment insert failure", func(t *testing.T) {
		svc := newCommentServiceWith(faultyDB(t, failingOn("create", "comments")), db, nil)
		_, err := svc.CreateComment(ctx, author.ID, author.Username, owner.ID, owner.Username, commentDay, "will fail", nil, nil)
		require.ErrorIs(t, err, errInjected)
		assert.Contains(t, err.Error(), "failed to create comment")
	})

	t.Run("reply counter failure keeps the reply", func(t *testing.T) {
		parent := seedComment(t, db, owner.ID, friend.ID, "parent")
		svc := newCommentServiceWith(faultyDB(t, failingOn("raw", "", "reply_count + 1")), db, nil)
		got, err := svc.CreateComment(ctx, author.ID, author.Username, owner.ID, owner.Username, commentDay, "reply", &parent.ID, nil)
		require.NoError(t, err)
		assert.Equal(t, &parent.ID, got.ParentCommentID)
		assert.Zero(t, loadComment(t, db, parent.ID).ReplyCount)
	})

	t.Run("mention lookup failure drops mentions", func(t *testing.T) {
		svc := newCommentServiceWith(db, faultyDB(t, failingOn("query", "users", "username IN ?")), nil)
		got, err := svc.CreateComment(ctx, author.ID, author.Username, owner.ID, owner.Username, commentDay,
			"hi @"+friend.Username, nil, nil)
		require.NoError(t, err)
		assert.Empty(t, got.Mentions)
	})

	t.Run("mention storage failure still reports resolved mentions", func(t *testing.T) {
		svc := newCommentServiceWith(faultyDB(t, failingOn("create", "comment_mentions")), db, nil)
		got, err := svc.CreateComment(ctx, author.ID, author.Username, owner.ID, owner.Username, commentDay,
			"hey @"+friend.Username, nil, nil)
		require.NoError(t, err)
		assert.Equal(t, []string{friend.Username}, mentionNames(got.Mentions))
		var stored int64
		require.NoError(t, db.Model(&models.CommentMention{}).Where("comment_id = ?", got.ID).Count(&stored).Error)
		assert.Zero(t, stored)
	})

	t.Run("author lookup failure omits author details", func(t *testing.T) {
		svc := newCommentServiceWith(db, faultyDB(t, failingOn("query", "users", "id = ?")), nil)
		got, err := svc.CreateComment(ctx, author.ID, author.Username, owner.ID, owner.Username, commentDay, "no avatar", nil, nil)
		require.NoError(t, err)
		assert.Nil(t, got.AuthorAvatar)
		assert.Equal(t, author.Username, got.AuthorUsername)
	})
}

func TestCommentService_SendCommentNotifications(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	notif := newNotificationService(db)
	svc := newCommentService(db, notif)
	owner := newUser(t, db)
	alice := newUser(t, db, func(u *models.User) { u.ProfilePic = testutil.Ptr("https://img/alice.jpg") })
	bob := newUser(t, db)
	public := newUser(t, db)
	privateFollowed := newUser(t, db, func(u *models.User) { u.IsPrivate = true })
	privateStranger := newUser(t, db, func(u *models.User) { u.IsPrivate = true })
	makeFollow(t, db, alice.ID, privateFollowed.ID, models.FollowStateActive)

	comment := func(id, author uint) *models.Comment {
		return &models.Comment{ID: id, DayOwnerID: owner.ID, AuthorID: author, Body: "body", DayDate: commentDay}
	}
	mention := func(users ...*models.User) []dto.MentionDTO {
		var out []dto.MentionDTO
		for _, u := range users {
			out = append(out, dto.MentionDTO{UserID: u.ID, Username: u.Username})
		}
		return out
	}

	t.Run("own top-level comment notifies nobody", func(t *testing.T) {
		svc.sendCommentNotifications(ctx, comment(1, owner.ID), owner.Username, owner, owner.ID, owner.Username, commentDay, nil, nil)
		assert.Zero(t, countRows(t, db, &models.Notification{}))
	})

	t.Run("mentions respect privacy and are not repeated", func(t *testing.T) {
		svc.sendCommentNotifications(ctx, comment(2, alice.ID), alice.Username, alice, owner.ID, owner.Username, commentDay, nil,
			append(mention(owner, alice, public, privateFollowed, privateStranger),
				dto.MentionDTO{UserID: 999999, Username: "ghost"}))

		assert.Equal(t, []models.NotificationType{models.NotifTypeCommentReceived}, notificationTypes(t, db, owner.ID),
			"the day owner gets one notification even when mentioned")
		assert.Empty(t, notificationsOf(t, db, alice.ID))
		assert.Equal(t, []models.NotificationType{models.NotifTypeCommentMention}, notificationTypes(t, db, public.ID))
		assert.Equal(t, []models.NotificationType{models.NotifTypeCommentMention}, notificationTypes(t, db, privateFollowed.ID))
		assert.Empty(t, notificationsOf(t, db, privateStranger.ID), "private users only hear from people they let follow them")

		n := notificationsOf(t, db, public.ID)[0]
		assert.Equal(t, "https://img/alice.jpg", n.Metadata["author_avatar"])
	})

	t.Run("reply to own comment only notifies the day owner", func(t *testing.T) {
		parent := comment(3, bob.ID)
		svc.sendCommentNotifications(ctx, comment(4, bob.ID), bob.Username, nil, owner.ID, owner.Username, commentDay, parent, nil)
		assert.Empty(t, notificationsOf(t, db, bob.ID))
		ownerNotifs := notificationsOf(t, db, owner.ID)
		require.Len(t, ownerNotifs, 2)
		assert.EqualValues(t, 4, ownerNotifs[1].Metadata["comment_id"])
		assert.Equal(t, "", ownerNotifs[1].Metadata["author_avatar"])
	})

	t.Run("reply to the day owner is a single reply notification", func(t *testing.T) {
		parent := comment(5, owner.ID)
		svc.sendCommentNotifications(ctx, comment(6, bob.ID), bob.Username, bob, owner.ID, owner.Username, commentDay, parent, nil)
		types := notificationTypes(t, db, owner.ID)
		assert.Len(t, types, 3)
		assert.Equal(t, models.NotifTypeCommentReply, types[2])
	})

	t.Run("without a follow repository private mentions are notified", func(t *testing.T) {
		noFollows := newCommentService(db, notif)
		noFollows.followRepo = nil
		noFollows.sendCommentNotifications(ctx, comment(7, bob.ID), bob.Username, bob, owner.ID, owner.Username, commentDay, nil,
			mention(privateStranger))
		assert.Equal(t, []models.NotificationType{models.NotifTypeCommentMention}, notificationTypes(t, db, privateStranger.ID))
	})

	t.Run("follow lookup failure skips private mentions", func(t *testing.T) {
		brokenFollows := newCommentService(db, notif)
		brokenFollows.followRepo = repository.NewFollowRepository(testutil.BrokenDB(t))
		before := len(notificationsOf(t, db, privateFollowed.ID))
		brokenFollows.sendCommentNotifications(ctx, comment(8, alice.ID), alice.Username, alice, owner.ID, owner.Username, commentDay, nil,
			mention(privateFollowed))
		assert.Len(t, notificationsOf(t, db, privateFollowed.ID), before)
	})

	t.Run("notification failures are only logged", func(t *testing.T) {
		broken := newCommentService(db, newNotificationService(testutil.BrokenDB(t)))
		before := countRows(t, db, &models.Notification{})
		broken.sendCommentNotifications(ctx, comment(9, bob.ID), bob.Username, bob, owner.ID, owner.Username, commentDay, nil, mention(public))
		broken.sendCommentNotifications(ctx, comment(10, bob.ID), bob.Username, bob, owner.ID, owner.Username, commentDay,
			comment(11, alice.ID), nil)
		assert.Equal(t, before, countRows(t, db, &models.Notification{}))
	})

	t.Run("no notification service", func(t *testing.T) {
		silent := newCommentService(db, nil)
		before := countRows(t, db, &models.Notification{})
		silent.sendCommentNotifications(ctx, comment(12, bob.ID), bob.Username, bob, owner.ID, owner.Username, commentDay, nil, mention(public))
		assert.Equal(t, before, countRows(t, db, &models.Notification{}))
	})
}

func TestCommentService_DeleteComment(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	mr := startRedis(t)
	svc := newCommentService(db, nil)
	owner := newUser(t, db)
	alice := newUser(t, db)
	bob := newUser(t, db)

	t.Run("author deletes their comment", func(t *testing.T) {
		c := seedComment(t, db, owner.ID, alice.ID, "mine")
		mr.Set(commentCountKey(owner.ID, commentDay), "9")
		require.NoError(t, svc.DeleteComment(ctx, c.ID, alice.ID, owner.ID))
		stored := loadComment(t, db, c.ID)
		assert.True(t, stored.IsDeleted)
		assert.Equal(t, "[Deleted]", stored.Body)
		assert.NotNil(t, stored.DeletedAt)
		assert.False(t, mr.Exists(commentCountKey(owner.ID, commentDay)))

		assertValidationCode(t, svc.DeleteComment(ctx, c.ID, alice.ID, owner.ID), constants.ErrCodeCommentDeleted)
	})

	t.Run("day owner may delete comments on their day", func(t *testing.T) {
		c := seedComment(t, db, owner.ID, alice.ID, "moderated")
		require.NoError(t, svc.DeleteComment(ctx, c.ID, owner.ID, 0), "owner is taken from the comment")
		assert.True(t, loadComment(t, db, c.ID).IsDeleted)
	})

	t.Run("others may not", func(t *testing.T) {
		c := seedComment(t, db, owner.ID, alice.ID, "not yours")
		assertValidationCode(t, svc.DeleteComment(ctx, c.ID, bob.ID, 0), constants.ErrCodeCommentForbidden)
		assert.False(t, loadComment(t, db, c.ID).IsDeleted)
		assertValidationCode(t, svc.DeleteComment(ctx, 999999, bob.ID, 0), constants.ErrCodeCommentNotFound)
	})

	t.Run("leaf reply decrements every ancestor", func(t *testing.T) {
		top := seedComment(t, db, owner.ID, alice.ID, "top", func(c *models.Comment) { c.ReplyCount = 2 })
		mid := seedComment(t, db, owner.ID, bob.ID, "mid", func(c *models.Comment) {
			c.ParentCommentID, c.RootCommentID, c.ReplyCount = &top.ID, &top.ID, 1
		})
		leaf := seedComment(t, db, owner.ID, alice.ID, "leaf", func(c *models.Comment) {
			c.ParentCommentID, c.RootCommentID = &mid.ID, &top.ID
		})

		require.NoError(t, svc.DeleteComment(ctx, mid.ID, bob.ID, 0))
		assert.Equal(t, 2, loadComment(t, db, top.ID).ReplyCount, "a reply with children stays as a placeholder")

		require.NoError(t, svc.DeleteComment(ctx, leaf.ID, alice.ID, 0))
		assert.Equal(t, 1, loadComment(t, db, top.ID).ReplyCount)
		assert.Equal(t, 0, loadComment(t, db, mid.ID).ReplyCount)
	})

	t.Run("soft delete failure", func(t *testing.T) {
		c := seedComment(t, db, owner.ID, alice.ID, "sticky")
		broken := newCommentServiceWith(faultyDB(t, failingOn("update", "comments", "is_deleted = false")), db, nil)
		err := broken.DeleteComment(ctx, c.ID, alice.ID, 0)
		require.ErrorIs(t, err, errInjected)
		assert.Contains(t, err.Error(), "failed to delete comment")
		assert.False(t, loadComment(t, db, c.ID).IsDeleted)
	})

	t.Run("reply counter failure is only logged", func(t *testing.T) {
		top := seedComment(t, db, owner.ID, alice.ID, "top", func(c *models.Comment) { c.ReplyCount = 1 })
		reply := seedComment(t, db, owner.ID, bob.ID, "reply", func(c *models.Comment) {
			c.ParentCommentID, c.RootCommentID = &top.ID, &top.ID
		})
		broken := newCommentServiceWith(faultyDB(t, failingOn("raw", "", "reply_count - 1")), db, nil)
		require.NoError(t, broken.DeleteComment(ctx, reply.ID, bob.ID, 0))
		assert.True(t, loadComment(t, db, reply.ID).IsDeleted)
		assert.Equal(t, 1, loadComment(t, db, top.ID).ReplyCount)
	})
}

func TestCommentService_Likes(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newCommentService(db, newNotificationService(db))
	owner := newUser(t, db)
	author := newUser(t, db)
	liker := newUser(t, db, func(u *models.User) { u.ProfilePic = testutil.Ptr("https://img/liker.jpg") })
	c := seedComment(t, db, owner.ID, author.ID, strings.Repeat("x", 150))

	liked, count, err := svc.LikeComment(ctx, c.ID, liker.ID, liker.Username)
	require.NoError(t, err)
	assert.True(t, liked)
	assert.Equal(t, 1, count)
	assert.Equal(t, 1, loadComment(t, db, c.ID).LikeCount)

	liked, count, err = svc.LikeComment(ctx, c.ID, liker.ID, liker.Username)
	require.NoError(t, err, "liking twice is idempotent")
	assert.True(t, liked)
	assert.Equal(t, 1, count)
	assert.Equal(t, 1, loadComment(t, db, c.ID).LikeCount)

	_, count, err = svc.LikeComment(ctx, c.ID, author.ID, author.Username)
	require.NoError(t, err)
	assert.Equal(t, 2, count)

	waitForAsync(t)
	notifs := notificationsOf(t, db, author.ID)
	require.Len(t, notifs, 1, "one notification for the first like, none for self-likes")
	assert.Equal(t, models.NotifTypeCommentLiked, notifs[0].Type)
	assert.Equal(t, liker.Username+" liked your comment", notifs[0].Body)
	assert.Equal(t, strings.Repeat("x", constants.CommentPreviewLength)+"...", notifs[0].Metadata["comment_preview"])
	assert.Equal(t, owner.Username, notifs[0].Metadata["day_owner_username"])
	assert.Equal(t, "https://img/liker.jpg", notifs[0].Metadata["author_avatar"])

	liked, count, err = svc.UnlikeComment(ctx, c.ID, liker.ID)
	require.NoError(t, err)
	assert.False(t, liked)
	assert.Equal(t, 1, count)
	assert.Equal(t, 1, loadComment(t, db, c.ID).LikeCount)

	liked, count, err = svc.UnlikeComment(ctx, c.ID, liker.ID)
	require.NoError(t, err, "unliking twice is a no-op")
	assert.False(t, liked)
	assert.Equal(t, 1, count)

	_, _, err = svc.LikeComment(ctx, 999999, liker.ID, liker.Username)
	assertValidationCode(t, err, constants.ErrCodeCommentNotFound)
	_, _, err = svc.UnlikeComment(ctx, 999999, liker.ID)
	assertValidationCode(t, err, constants.ErrCodeCommentNotFound)

	deleted := seedComment(t, db, owner.ID, author.ID, "gone", func(c *models.Comment) { c.IsDeleted = true })
	_, _, err = svc.LikeComment(ctx, deleted.ID, liker.ID, liker.Username)
	assertValidationCode(t, err, constants.ErrCodeCommentDeleted)

	t.Run("without a notification service", func(t *testing.T) {
		quiet := newCommentService(db, nil)
		other := seedComment(t, db, owner.ID, author.ID, "quiet")
		_, count, err := quiet.LikeComment(ctx, other.ID, liker.ID, liker.Username)
		require.NoError(t, err)
		assert.Equal(t, 1, count)
		waitForAsync(t)
		assert.Len(t, notificationsOf(t, db, author.ID), 1)
	})

	t.Run("storage failures", func(t *testing.T) {
		target := seedComment(t, db, owner.ID, author.ID, "fragile", func(c *models.Comment) { c.LikeCount = 3 })

		likeInsert := newCommentServiceWith(faultyDB(t, failingOn("create", "comment_likes")), db, nil)
		_, _, err := likeInsert.LikeComment(ctx, target.ID, liker.ID, liker.Username)
		require.ErrorIs(t, err, errInjected)
		assert.Contains(t, err.Error(), "failed to like comment")

		counterFails := newCommentServiceWith(faultyDB(t, func(s stmtInfo) bool {
			return s.is("update", "comments") && !s.has("is_deleted")
		}), db, nil)
		liked, count, err := counterFails.LikeComment(ctx, target.ID, liker.ID, liker.Username)
		require.NoError(t, err, "the like is stored even if the counter update fails")
		assert.True(t, liked)
		assert.Equal(t, 4, count)
		assert.Equal(t, 3, loadComment(t, db, target.ID).LikeCount)

		liked, count, err = counterFails.UnlikeComment(ctx, target.ID, liker.ID)
		require.NoError(t, err)
		assert.False(t, liked)
		assert.Equal(t, 2, count)

		unlikeDelete := newCommentServiceWith(faultyDB(t, failingOn("delete", "comment_likes")), db, nil)
		_, _, err = unlikeDelete.UnlikeComment(ctx, target.ID, liker.ID)
		require.ErrorIs(t, err, errInjected)
		assert.Contains(t, err.Error(), "failed to unlike comment")
	})
}

func TestCommentService_GetTopLevelComments(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newCommentService(db, nil)
	owner := newUser(t, db)
	viewer := newUser(t, db)
	writer := newUser(t, db)
	verified := newUser(t, db, func(u *models.User) { u.IsVerified = true })
	now := time.Now()

	old := seedComment(t, db, owner.ID, writer.ID, "old", func(c *models.Comment) { c.CreatedAt = now.Add(-48 * time.Hour) })
	popular := seedComment(t, db, owner.ID, writer.ID, "popular @"+viewer.Username, func(c *models.Comment) {
		c.CreatedAt, c.LikeCount = now.Add(-48*time.Hour), 7
	})
	fresh := seedComment(t, db, owner.ID, writer.ID, "fresh", func(c *models.Comment) { c.CreatedAt = now.Add(-2 * time.Minute) })
	star := seedComment(t, db, owner.ID, verified.ID, "verified", func(c *models.Comment) { c.CreatedAt = now.Add(-time.Minute) })
	seedComment(t, db, owner.ID, writer.ID, "reply", func(c *models.Comment) {
		c.ParentCommentID, c.RootCommentID, c.CreatedAt = &old.ID, &old.ID, now
	})
	seedComment(t, db, owner.ID, writer.ID, "other day", func(c *models.Comment) { c.DayDate = commentDay.AddDate(0, 0, 1) })
	require.NoError(t, db.Create(&models.CommentLike{CommentID: popular.ID, UserID: viewer.ID}).Error)
	require.NoError(t, db.Create(&models.CommentMention{CommentID: popular.ID, MentionedUserID: viewer.ID, Username: viewer.Username}).Error)

	ids := func(res *dto.CommentsListResponse) []uint {
		var out []uint
		for _, c := range res.Comments {
			out = append(out, c.ID)
		}
		return out
	}

	t.Run("newest first with cursor pagination", func(t *testing.T) {
		page, err := svc.GetTopLevelComments(ctx, owner.ID, viewer.ID, commentDay, "newest", nil, 2)
		require.NoError(t, err)
		assert.True(t, page.Success)
		assert.Equal(t, []uint{star.ID, fresh.ID}, ids(page))
		assert.True(t, page.HasMore)
		require.NotNil(t, page.NextCursor)
		assert.Equal(t, fresh.ID, *page.NextCursor)

		rest, err := svc.GetTopLevelComments(ctx, owner.ID, viewer.ID, commentDay, "newest", page.NextCursor, 2)
		require.NoError(t, err)
		assert.Equal(t, []uint{popular.ID, old.ID}, ids(rest))
		assert.False(t, rest.HasMore)
		assert.Nil(t, rest.NextCursor)

		byID := map[uint]dto.CommentDTO{}
		for _, c := range rest.Comments {
			byID[c.ID] = c
		}
		assert.True(t, byID[popular.ID].LikedByMe)
		assert.Equal(t, []dto.MentionDTO{{UserID: viewer.ID, Username: viewer.Username}}, byID[popular.ID].Mentions)
		assert.Equal(t, 7, byID[popular.ID].LikeCount)
		assert.False(t, byID[old.ID].LikedByMe)
		assert.Equal(t, []dto.MentionDTO{}, byID[old.ID].Mentions)
	})

	t.Run("top ranks likes, recency and verified authors", func(t *testing.T) {
		page, err := svc.GetTopLevelComments(ctx, owner.ID, viewer.ID, commentDay, "top", nil, 2)
		require.NoError(t, err)
		assert.Equal(t, []uint{popular.ID, star.ID}, ids(page))
		assert.True(t, page.HasMore)
		require.NotNil(t, page.NextCursor)

		rest, err := svc.GetTopLevelComments(ctx, owner.ID, viewer.ID, commentDay, "top", page.NextCursor, 2)
		require.NoError(t, err)
		assert.Equal(t, []uint{fresh.ID, old.ID}, ids(rest))
		assert.False(t, rest.HasMore)

		last := old.ID
		end, err := svc.GetTopLevelComments(ctx, owner.ID, viewer.ID, commentDay, "top", &last, 2)
		require.NoError(t, err)
		assert.Empty(t, end.Comments)
		assert.False(t, end.HasMore)

		unknown := uint(999999)
		all, err := svc.GetTopLevelComments(ctx, owner.ID, viewer.ID, commentDay, "top", &unknown, 10)
		require.NoError(t, err)
		assert.Equal(t, []uint{popular.ID, star.ID, fresh.ID, old.ID}, ids(all), "an unknown cursor restarts the ranking")
	})

	t.Run("limit is clamped", func(t *testing.T) {
		for _, limit := range []int{0, -5, constants.CommentListMaxLimit + 1} {
			page, err := svc.GetTopLevelComments(ctx, owner.ID, viewer.ID, commentDay, "newest", nil, limit)
			require.NoError(t, err)
			assert.Len(t, page.Comments, 4)
		}
	})

	t.Run("empty day", func(t *testing.T) {
		page, err := svc.GetTopLevelComments(ctx, viewer.ID, viewer.ID, commentDay, "newest", nil, 10)
		require.NoError(t, err)
		assert.Equal(t, []dto.CommentDTO{}, page.Comments)
		assert.False(t, page.HasMore)
	})

	t.Run("enrichment failures degrade gracefully", func(t *testing.T) {
		broken := newCommentServiceWith(faultyDB(t, func(s stmtInfo) bool {
			return s.is("query", "comment_likes") || s.is("query", "comment_mentions")
		}), db, nil)
		page, err := broken.GetTopLevelComments(ctx, owner.ID, viewer.ID, commentDay, "newest", nil, 10)
		require.NoError(t, err)
		require.Len(t, page.Comments, 4)
		for _, c := range page.Comments {
			assert.False(t, c.LikedByMe)
			assert.Empty(t, c.Mentions)
		}
	})

	t.Run("database failure", func(t *testing.T) {
		broken := newCommentService(testutil.BrokenDB(t), nil)
		_, err := broken.GetTopLevelComments(ctx, owner.ID, viewer.ID, commentDay, "newest", nil, 10)
		assert.ErrorContains(t, err, "failed to get comments")
		_, err = broken.GetTopLevelComments(ctx, owner.ID, viewer.ID, commentDay, "top", nil, 10)
		assert.ErrorContains(t, err, "failed to get comments")
	})
}

func TestCommentService_GetReplies(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newCommentService(db, nil)
	owner := newUser(t, db)
	alice := newUser(t, db)
	bob := newUser(t, db)
	base := time.Now().Add(-time.Hour)

	root := seedComment(t, db, owner.ID, alice.ID, "root")
	var replies []uint
	for i := 0; i < 3; i++ {
		r := seedComment(t, db, owner.ID, bob.ID, fmt.Sprintf("reply %d", i), func(c *models.Comment) {
			c.ParentCommentID, c.RootCommentID, c.ReplyToUserID = &root.ID, &root.ID, &alice.ID
			c.CreatedAt = base.Add(time.Duration(i) * time.Minute)
		})
		replies = append(replies, r.ID)
	}

	page, err := svc.GetReplies(ctx, root.ID, alice.ID, nil, 2)
	require.NoError(t, err)
	require.Len(t, page.Comments, 2)
	assert.Equal(t, []uint{replies[0], replies[1]}, []uint{page.Comments[0].ID, page.Comments[1].ID}, "oldest first")
	assert.True(t, page.HasMore)
	require.NotNil(t, page.NextCursor)
	require.NotNil(t, page.Comments[0].ReplyToUsername)
	assert.Equal(t, alice.Username, *page.Comments[0].ReplyToUsername)

	rest, err := svc.GetReplies(ctx, root.ID, alice.ID, page.NextCursor, 2)
	require.NoError(t, err)
	require.Len(t, rest.Comments, 1)
	assert.Equal(t, replies[2], rest.Comments[0].ID)
	assert.False(t, rest.HasMore)
	assert.Nil(t, rest.NextCursor)

	for _, limit := range []int{0, constants.CommentReplyMaxLimit + 1} {
		all, err := svc.GetReplies(ctx, root.ID, alice.ID, nil, limit)
		require.NoError(t, err)
		assert.Len(t, all.Comments, 3)
	}

	none, err := svc.GetReplies(ctx, replies[0], alice.ID, nil, 10)
	require.NoError(t, err)
	assert.Equal(t, []dto.CommentDTO{}, none.Comments)

	_, err = newCommentService(testutil.BrokenDB(t), nil).GetReplies(ctx, root.ID, alice.ID, nil, 10)
	assert.ErrorContains(t, err, "failed to get replies")
}

func TestCommentService_GetCommentCount(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newCommentService(db, nil)
	owner := newUser(t, db)
	alice := newUser(t, db)
	top := seedComment(t, db, owner.ID, alice.ID, "one")
	seedComment(t, db, owner.ID, alice.ID, "two", func(c *models.Comment) { c.ParentCommentID, c.RootCommentID = &top.ID, &top.ID })
	seedComment(t, db, owner.ID, alice.ID, "deleted", func(c *models.Comment) { c.IsDeleted = true })
	seedComment(t, db, owner.ID, alice.ID, "other day", func(c *models.Comment) { c.DayDate = commentDay.AddDate(0, 0, -1) })

	count, err := svc.GetCommentCount(ctx, owner.ID, commentDay)
	require.NoError(t, err)
	assert.EqualValues(t, 2, count, "replies count, deleted comments do not")

	t.Run("cached", func(t *testing.T) {
		mr := startRedis(t)
		count, err := svc.GetCommentCount(ctx, owner.ID, commentDay)
		require.NoError(t, err)
		assert.EqualValues(t, 2, count)
		cached, err := mr.Get(commentCountKey(owner.ID, commentDay))
		require.NoError(t, err)
		assert.Equal(t, "2", cached)
		assert.Equal(t, constants.CommentCountCacheTTL, mr.TTL(commentCountKey(owner.ID, commentDay)))

		mr.Set(commentCountKey(owner.ID, commentDay), "11")
		count, err = svc.GetCommentCount(ctx, owner.ID, commentDay)
		require.NoError(t, err)
		assert.EqualValues(t, 11, count)
	})

	t.Run("failures", func(t *testing.T) {
		mr := startRedis(t)
		mr.SetError("boom")
		count, err := svc.GetCommentCount(ctx, owner.ID, commentDay)
		require.NoError(t, err)
		assert.EqualValues(t, 2, count)

		_, err = newCommentService(testutil.BrokenDB(t), nil).GetCommentCount(ctx, owner.ID, commentDay)
		assert.Error(t, err)
	})

	found, err := svc.GetCommentByID(ctx, top.ID)
	require.NoError(t, err)
	assert.Equal(t, "one", found.Body)
	_, err = svc.GetCommentByID(ctx, 999999)
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
}

func TestCommentService_EditComment(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newCommentService(db, newNotificationService(db))
	owner := newUser(t, db)
	alice := newUser(t, db)
	bob := newUser(t, db)
	carol := newUser(t, db)

	t.Run("author edits within the window and mentions are replaced", func(t *testing.T) {
		top := seedComment(t, db, owner.ID, bob.ID, "top")
		c := seedComment(t, db, owner.ID, alice.ID, "hi @"+bob.Username, func(c *models.Comment) {
			c.ParentCommentID, c.RootCommentID, c.ReplyToUserID = &top.ID, &top.ID, &bob.ID
		})
		require.NoError(t, db.Create(&models.CommentMention{CommentID: c.ID, MentionedUserID: bob.ID, Username: bob.Username}).Error)
		require.NoError(t, db.Create(&models.CommentLike{CommentID: c.ID, UserID: alice.ID}).Error)

		got, err := svc.EditComment(ctx, c.ID, alice.ID, "  hello @"+carol.Username+"  ")
		require.NoError(t, err)
		assert.Equal(t, "hello @"+carol.Username, got.Body)
		assert.True(t, got.IsEdited)
		assert.True(t, got.LikedByMe)
		assert.Equal(t, []string{carol.Username}, mentionNames(got.Mentions))
		require.NotNil(t, got.ReplyToUsername)
		assert.Equal(t, bob.Username, *got.ReplyToUsername)

		stored := loadComment(t, db, c.ID)
		assert.Equal(t, "hello @"+carol.Username, stored.Body)
		assert.True(t, stored.IsEdited)
		var mentions []models.CommentMention
		require.NoError(t, db.Where("comment_id = ?", c.ID).Find(&mentions).Error)
		require.Len(t, mentions, 1)
		assert.Equal(t, carol.ID, mentions[0].MentionedUserID)

		waitForAsync(t)
		assert.Empty(t, notificationsOf(t, db, carol.ID), "edits never notify")
	})

	t.Run("rules", func(t *testing.T) {
		c := seedComment(t, db, owner.ID, alice.ID, "original")
		_, err := svc.EditComment(ctx, c.ID, bob.ID, "hijack")
		assertValidationCode(t, err, constants.ErrCodeCommentForbidden)
		_, err = svc.EditComment(ctx, c.ID, alice.ID, "   ")
		assertValidationCode(t, err, constants.ErrCodeCommentEmpty)
		_, err = svc.EditComment(ctx, c.ID, alice.ID, strings.Repeat("z", constants.CommentBodyMaxLength+1))
		assertValidationCode(t, err, constants.ErrCodeCommentTooLong)
		assert.Equal(t, "original", loadComment(t, db, c.ID).Body)

		_, err = svc.EditComment(ctx, 999999, alice.ID, "x")
		assertValidationCode(t, err, constants.ErrCodeCommentNotFound)

		deleted := seedComment(t, db, owner.ID, alice.ID, "gone", func(c *models.Comment) { c.IsDeleted = true })
		_, err = svc.EditComment(ctx, deleted.ID, alice.ID, "x")
		assertValidationCode(t, err, constants.ErrCodeCommentDeleted)

		stale := seedComment(t, db, owner.ID, alice.ID, "stale", func(c *models.Comment) {
			c.CreatedAt = time.Now().Add(-constants.CommentEditWindow - time.Minute)
		})
		_, err = svc.EditComment(ctx, stale.ID, alice.ID, "too late")
		assertValidationCode(t, err, constants.ErrCodeCommentEditExpired)
	})

	t.Run("too many mentions leave the comment unchanged", func(t *testing.T) {
		c := seedComment(t, db, owner.ID, alice.ID, "original")
		var many []string
		for i := 0; i <= constants.CommentMaxMentions; i++ {
			many = append(many, fmt.Sprintf("@user_%02d", i))
		}
		_, err := svc.EditComment(ctx, c.ID, alice.ID, strings.Join(many, " "))
		assertValidationCode(t, err, constants.ErrCodeTooManyMentions)

		stored := loadComment(t, db, c.ID)
		assert.Equal(t, "original", stored.Body)
		assert.False(t, stored.IsEdited)
	})

	t.Run("update failure", func(t *testing.T) {
		c := seedComment(t, db, owner.ID, alice.ID, "keep me")
		broken := newCommentServiceWith(faultyDB(t, failingOn("update", "comments")), db, nil)
		_, err := broken.EditComment(ctx, c.ID, alice.ID, "changed")
		require.ErrorIs(t, err, errInjected)
		assert.Contains(t, err.Error(), "failed to update comment")
		assert.Equal(t, "keep me", loadComment(t, db, c.ID).Body)
	})

	t.Run("old mentions that cannot be removed are logged", func(t *testing.T) {
		c := seedComment(t, db, owner.ID, alice.ID, "plain")
		broken := newCommentServiceWith(faultyDB(t, failingOn("delete", "comment_mentions")), db, nil)
		got, err := broken.EditComment(ctx, c.ID, alice.ID, "edited")
		require.NoError(t, err)
		assert.Equal(t, "edited", got.Body)
		assert.Nil(t, got.ReplyToUsername)
	})

	t.Run("reload failure", func(t *testing.T) {
		c := seedComment(t, db, owner.ID, alice.ID, "before")
		broken := newCommentServiceWith(faultyDB(t, failingOn("row", "comments")), db, nil)
		_, err := broken.EditComment(ctx, c.ID, alice.ID, "after")
		require.ErrorIs(t, err, errInjected)
		assert.Contains(t, err.Error(), "failed to fetch updated comment")
	})
}

func TestRankComments(t *testing.T) {
	now := time.Now()
	comment := func(id uint, likes int, age time.Duration, verified bool) repository.CommentWithAuthor {
		return repository.CommentWithAuthor{
			Comment:        models.Comment{ID: id, LikeCount: likes, CreatedAt: now.Add(-age)},
			AuthorVerified: verified,
		}
	}
	comments := []repository.CommentWithAuthor{
		comment(1, 0, 72*time.Hour, false),
		comment(2, 0, 0, false),
		comment(3, 3, 24*time.Hour, false),
		comment(4, 0, 0, true),
		comment(5, 0, 72*time.Hour, false), // same score as 1: higher ID first
	}
	rankComments(comments)
	var order []uint
	for _, c := range comments {
		order = append(order, c.ID)
	}
	assert.Equal(t, []uint{3, 4, 2, 5, 1}, order)

	fresh := comment(9, 0, 0, false)
	assert.InDelta(t, 1.0, computeScore(&fresh, now), 1e-9)
	liked := comment(9, 1, 6*time.Hour, true)
	assert.InDelta(t, 1+0.5+0.3, computeScore(&liked, now), 1e-9)
}

func TestCommentHelpers(t *testing.T) {
	sum := sha256.Sum256([]byte("hello"))
	assert.Equal(t, hex.EncodeToString(sum[:]), hashBody("hello"))
	assert.Len(t, hashBody(""), 64)
	assert.NotEqual(t, hashBody("a"), hashBody("A"))
}

func TestTruncateCommentPreview_CountsCharactersNotBytes(t *testing.T) {
	assert.Equal(t, "short", truncateCommentPreview("short"))
	exact := strings.Repeat("e", constants.CommentPreviewLength)
	assert.Equal(t, exact, truncateCommentPreview(exact))
	assert.Equal(t, exact+"...", truncateCommentPreview(exact+"tail"))

	accented := strings.Repeat("é", constants.CommentPreviewLength)
	assert.Equal(t, accented, truncateCommentPreview(accented), "the limit counts characters, not bytes")
	got := truncateCommentPreview("a" + accented)
	assert.Equal(t, "a"+strings.Repeat("é", constants.CommentPreviewLength-1)+"...", got)
	assert.True(t, utf8.ValidString(got))
}

func TestCommentService_NotificationPreviewKeepsWholeCharacters(t *testing.T) {
	db := testDB(t)
	svc := newCommentService(db, newNotificationService(db))
	owner := newUser(t, db)
	author := newUser(t, db)
	ascii := strings.Repeat("a", 95)
	body := ascii + strings.Repeat("é", 10) // 105 characters; byte 100 falls inside an "é"

	_, err := svc.CreateComment(context.Background(), author.ID, author.Username, owner.ID, owner.Username, commentDay, body, nil, nil)
	require.NoError(t, err)

	waitForAsync(t)
	notifs := notificationsOf(t, db, owner.ID)
	require.Len(t, notifs, 1)
	assert.Equal(t, ascii+strings.Repeat("é", 5)+"...", notifs[0].Metadata["comment_preview"])
}
