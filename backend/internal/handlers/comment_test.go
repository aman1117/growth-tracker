package handlers

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/gofiber/fiber/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const commentDay = "2026-03-09"

var commentDate = testutil.Day(2026, 3, 9)

func dayPath(owner, date string) string { return "/api/days/" + owner + "/" + date + "/comments" }

func commentPath(id uint) string { return "/api/comments/" + itoa(id) }

func commentBody(body string) map[string]string { return map[string]string{"body": body} }

func commentIDs(comments []dto.CommentDTO) []uint {
	out := make([]uint, 0, len(comments))
	for _, c := range comments {
		out = append(out, c.ID)
	}
	return out
}

func storedComment(t *testing.T, env *testEnv, id uint) models.Comment {
	t.Helper()
	var c models.Comment
	require.NoError(t, env.db.First(&c, id).Error)
	return c
}

// commentAt creates a comment and pins its creation time.
func commentAt(t *testing.T, env *testEnv, owner, author *models.User, body string, parent *models.Comment, at time.Time) *models.Comment {
	t.Helper()
	c := createComment(t, env.db, owner.ID, author.ID, commentDate, body, parent)
	require.NoError(t, env.db.Model(c).Update("created_at", at).Error)
	c.CreatedAt = at
	return c
}

func TestCommentHandler_DayEndpointsValidateTheDay(t *testing.T) {
	env := newEnv(t)
	owner, viewer := env.user(t), env.user(t)
	hidden := env.user(t, private)
	root := createComment(t, env.db, owner.ID, owner.ID, commentDate, "root", nil)

	endpoints := []struct {
		method string
		path   func(owner, date string) string
	}{
		{http.MethodPost, dayPath},
		{http.MethodPost, func(o, d string) string { return dayPath(o, d) + "/" + itoa(root.ID) + "/replies" }},
		{http.MethodGet, dayPath},
		{http.MethodGet, func(o, d string) string { return dayPath(o, d) + "/count" }},
	}
	for _, e := range endpoints {
		name := e.method + " " + e.path(":user", ":date")
		t.Run(name+" bad date", func(t *testing.T) {
			res := env.do(t, viewer, e.method, e.path(owner.Username, "09-03-2026"), commentBody("hi"))
			assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidDate, "Invalid date format (use YYYY-MM-DD)")
		})
		t.Run(name+" unknown user", func(t *testing.T) {
			res := env.do(t, viewer, e.method, e.path("nobody", commentDay), commentBody("hi"))
			assertErrorMessage(t, res, http.StatusNotFound, constants.ErrCodeUserNotFound, "User not found")
		})
		t.Run(name+" private account", func(t *testing.T) {
			res := env.do(t, viewer, e.method, e.path(hidden.Username, commentDay), commentBody("hi"))
			assertErrorMessage(t, res, http.StatusForbidden, constants.ErrCodeAccountPrivate, "This account is private")
		})
	}

	t.Run("reply to a non-numeric comment id", func(t *testing.T) {
		res := env.do(t, viewer, http.MethodPost, dayPath(owner.Username, commentDay)+"/abc/replies", commentBody("hi"))
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid comment ID")
	})
}

func TestCommentHandler_RouteParametersAreRequired(t *testing.T) {
	env := newEnv(t)
	user := env.user(t)
	app := fiber.New()
	api := app.Group("/api", testutil.AsUser(user.ID, user.Username))
	api.Post("/comment", env.h.comment.CreateComment)
	api.Post("/reply", env.h.comment.CreateReply)
	api.Get("/comments", env.h.comment.GetComments)
	api.Get("/count", env.h.comment.GetCommentCount)

	for path, message := range map[string]string{
		"/api/comment":  "Username and date are required",
		"/api/reply":    "Username, date, and comment ID are required",
		"/api/comments": "Username and date are required",
		"/api/count":    "Username and date are required",
	} {
		method := http.MethodGet
		if path == "/api/comment" || path == "/api/reply" {
			method = http.MethodPost
		}
		res := testutil.Do(t, app, method, path, commentBody("hi"))
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeMissingFields, message)
	}
}

func TestCommentHandler_CreateComment(t *testing.T) {
	env := newEnv(t)
	owner := env.user(t, private)
	author := env.user(t, withPicture("http://pics.example/author.jpg"), verified)
	friend := env.user(t, withUsername("friend_1"))
	follow(t, env.db, author, owner)
	path := dayPath(owner.Username, commentDay)
	post := func(t *testing.T, body any, opts ...testutil.RequestOption) testutil.Response {
		t.Helper()
		return env.do(t, author, http.MethodPost, path, body, opts...)
	}

	t.Run("validation", func(t *testing.T) {
		tests := []struct {
			name, code, message string
			body                any
		}{
			{"malformed json", constants.ErrCodeInvalidRequest, "Invalid request body", `{"body":`},
			{"blank", constants.ErrCodeCommentEmpty, "Comment cannot be empty", commentBody("   ")},
			{"too long", constants.ErrCodeCommentTooLong, "Comment must be 200 characters or less", commentBody(strings.Repeat("x", 201))},
			{"too many mentions", constants.ErrCodeTooManyMentions, "Too many mentions (max 10 per comment)",
				commentBody("@aaa @bbb @ccc @ddd @eee @fff @ggg @hhh @iii @jjj @kkk")},
		}
		for _, tc := range tests {
			t.Run(tc.name, func(t *testing.T) {
				assertErrorMessage(t, post(t, tc.body), http.StatusBadRequest, tc.code, tc.message)
			})
		}
		assert.Zero(t, count(t, env.db, &models.Comment{}, ""))
	})

	var created dto.CommentDTO
	t.Run("a follower comments on a private day", func(t *testing.T) {
		res := post(t, commentBody("  Great day @friend_1 and @nobody_here  "))

		got := decodeAs[dto.CommentActionResponse](t, res, http.StatusCreated)
		assert.True(t, got.Success)
		assert.Equal(t, constants.MsgCommentCreated, got.Message)
		require.NotNil(t, got.Comment)
		created = *got.Comment
		assert.NotZero(t, created.ID)
		assert.NotEmpty(t, created.CreatedAt)
		created.ID, created.CreatedAt = 0, ""
		assert.Equal(t, dto.CommentDTO{
			DayOwnerID:        owner.ID,
			DayDate:           commentDay,
			AuthorID:          author.ID,
			AuthorUsername:    author.Username,
			AuthorAvatar:      author.ProfilePic,
			AuthorAvatarThumb: author.ProfilePicThumb,
			AuthorVerified:    true,
			Body:              "Great day @friend_1 and @nobody_here",
			Mentions:          []dto.MentionDTO{{UserID: friend.ID, Username: "friend_1"}},
		}, created)
		assert.EqualValues(t, 1, count(t, env.db, &models.CommentMention{}, "mentioned_user_id = ?", friend.ID))
	})

	t.Run("the same text again is a duplicate", func(t *testing.T) {
		res := post(t, commentBody("Great day @friend_1 and @nobody_here"))
		assertErrorMessage(t, res, http.StatusConflict, constants.ErrCodeDuplicateComment, "Duplicate comment detected. Please wait before posting again.")
	})

	t.Run("a repeated idempotency key returns the first comment", func(t *testing.T) {
		key := testutil.WithHeader("X-Idempotency-Key", "retry-key-1")
		first := decodeAs[dto.CommentActionResponse](t, post(t, commentBody("first attempt"), key), http.StatusCreated)
		retry := decodeAs[dto.CommentActionResponse](t, post(t, commentBody("second attempt"), key), http.StatusCreated)

		assert.Equal(t, first.Comment.ID, retry.Comment.ID)
		assert.Equal(t, "first attempt", retry.Comment.Body)
		assert.Zero(t, count(t, env.db, &models.Comment{}, "body = ?", "second attempt"))
	})
}

func TestCommentHandler_CreateReply(t *testing.T) {
	env := newEnv(t)
	owner, author, other := env.user(t), env.user(t), env.user(t)
	root := createComment(t, env.db, owner.ID, author.ID, commentDate, "root comment", nil)
	replies := dayPath(owner.Username, commentDay) + "/"

	var first dto.CommentDTO
	t.Run("reply to a top-level comment", func(t *testing.T) {
		got := decodeAs[dto.CommentActionResponse](t, env.do(t, owner, http.MethodPost, replies+itoa(root.ID)+"/replies", commentBody("thanks!")), http.StatusCreated)

		require.NotNil(t, got.Comment)
		first = *got.Comment
		assert.Equal(t, &root.ID, first.ParentCommentID)
		assert.Equal(t, &root.ID, first.RootCommentID)
		assert.Equal(t, &author.ID, first.ReplyToUserID)
		require.NotNil(t, first.ReplyToUsername)
		assert.Equal(t, author.Username, *first.ReplyToUsername)
		assert.Equal(t, []dto.MentionDTO{}, first.Mentions)
	})

	t.Run("replies to replies stay in the root thread", func(t *testing.T) {
		got := decodeAs[dto.CommentActionResponse](t, env.do(t, other, http.MethodPost, replies+itoa(first.ID)+"/replies", commentBody("me too")), http.StatusCreated)

		assert.Equal(t, &first.ID, got.Comment.ParentCommentID)
		assert.Equal(t, &root.ID, got.Comment.RootCommentID)
		assert.Equal(t, owner.Username, *got.Comment.ReplyToUsername)
		assert.Equal(t, 2, storedComment(t, env, root.ID).ReplyCount)
		assert.Equal(t, 1, storedComment(t, env, first.ID).ReplyCount)
	})

	t.Run("a repeated idempotency key returns the first reply", func(t *testing.T) {
		key := testutil.WithHeader("X-Idempotency-Key", "reply-retry-key")
		target := replies + itoa(root.ID) + "/replies"
		got := decodeAs[dto.CommentActionResponse](t, env.do(t, other, http.MethodPost, target, commentBody("first try"), key), http.StatusCreated)
		retry := decodeAs[dto.CommentActionResponse](t, env.do(t, other, http.MethodPost, target, commentBody("second try"), key), http.StatusCreated)

		require.NotNil(t, retry.Comment)
		assert.Equal(t, got.Comment.ID, retry.Comment.ID)
		assert.Equal(t, "first try", retry.Comment.Body)
		assert.Zero(t, count(t, env.db, &models.Comment{}, "body = ?", "second try"))
		assert.Equal(t, 3, storedComment(t, env, root.ID).ReplyCount)
	})

	t.Run("errors", func(t *testing.T) {
		tests := []struct {
			name, target string
			body         any
			status       int
			code, msg    string
		}{
			{"unknown parent", replies + itoa(deletedUserID) + "/replies", commentBody("hello"), http.StatusNotFound, constants.ErrCodeParentNotFound, "Parent comment not found"},
			{"malformed json", replies + itoa(root.ID) + "/replies", `{"body":`, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid request body"},
			{"blank", replies + itoa(root.ID) + "/replies", commentBody(""), http.StatusBadRequest, constants.ErrCodeCommentEmpty, "Comment cannot be empty"},
			{"duplicate", replies + itoa(root.ID) + "/replies", commentBody("thanks!"), http.StatusConflict, constants.ErrCodeDuplicateComment, "Duplicate comment detected. Please wait before posting again."},
		}
		for _, tc := range tests {
			t.Run(tc.name, func(t *testing.T) {
				assertErrorMessage(t, env.do(t, owner, http.MethodPost, tc.target, tc.body), tc.status, tc.code, tc.msg)
			})
		}
	})
}

func TestCommentHandler_CreateReply_ParentMustBelongToTheDay(t *testing.T) {
	env := newEnv(t)
	hidden := env.user(t, private)
	public, stranger := env.user(t), env.user(t)
	secret := createComment(t, env.db, hidden.ID, hidden.ID, commentDate, "private thread", nil)
	yesterday := createComment(t, env.db, public.ID, public.ID, commentDate.AddDate(0, 0, -1), "yesterday", nil)
	today := createComment(t, env.db, public.ID, public.ID, commentDate, "today", nil)
	reply := func(t *testing.T, owner *models.User, parentID uint) testutil.Response {
		t.Helper()
		return env.do(t, stranger, http.MethodPost, dayPath(owner.Username, commentDay)+"/"+itoa(parentID)+"/replies", commentBody("sneaky"))
	}
	// A parent outside the URL's day must be indistinguishable from a missing one.
	notFound := func(t *testing.T, res testutil.Response) {
		t.Helper()
		assertErrorMessage(t, res, http.StatusNotFound, constants.ErrCodeParentNotFound, "Parent comment not found")
	}

	t.Run("a parent on another user's day", func(t *testing.T) {
		notFound(t, reply(t, public, secret.ID))
	})

	t.Run("a parent on another date", func(t *testing.T) {
		notFound(t, reply(t, public, yesterday.ID))
	})

	t.Run("a missing parent", func(t *testing.T) {
		notFound(t, reply(t, public, deletedUserID))
	})

	t.Run("the parent's own private day stays guarded", func(t *testing.T) {
		assertErrorMessage(t, reply(t, hidden, secret.ID), http.StatusForbidden, constants.ErrCodeAccountPrivate, "This account is private")
	})

	assert.EqualValues(t, 3, count(t, env.db, &models.Comment{}, ""), "no reply was stored")

	t.Run("a parent on the URL's day", func(t *testing.T) {
		got := decodeAs[dto.CommentActionResponse](t, reply(t, public, today.ID), http.StatusCreated)
		require.NotNil(t, got.Comment)
		assert.Equal(t, &today.ID, got.Comment.ParentCommentID)
		assert.Equal(t, public.ID, got.Comment.DayOwnerID)
		assert.Equal(t, commentDay, got.Comment.DayDate)
	})
}

func TestCommentHandler_CreateComment_DatabaseFailures(t *testing.T) {
	env := newEnv(t)
	owner, author := env.user(t), env.user(t)
	root := createComment(t, env.db, owner.ID, owner.ID, commentDate, "root", nil)
	faulty := newStack(faultyDB(t, failOn("create", "comments")), env.cfg, false)
	h := &handlerSet{comment: NewCommentHandler(faulty.commentSvc, env.profileSvc, env.authSvc)}

	res := call(t, h, author, http.MethodPost, dayPath(owner.Username, commentDay), commentBody("hello"))
	assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeCreateFailed, "Failed to create comment")

	res = call(t, h, author, http.MethodPost, dayPath(owner.Username, commentDay)+"/"+itoa(root.ID)+"/replies", commentBody("hello"))
	assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeCreateFailed, "Failed to create reply")

	assert.EqualValues(t, 1, count(t, env.db, &models.Comment{}, ""))
}

func TestCommentHandler_GetComments(t *testing.T) {
	env := newEnv(t)
	owner, viewer := env.user(t), env.user(t)
	now := time.Now()
	oldest := commentAt(t, env, owner, viewer, "oldest", nil, now.Add(-3*time.Hour))
	liked := commentAt(t, env, owner, owner, "liked", nil, now.Add(-2*time.Hour))
	newest := commentAt(t, env, owner, viewer, "newest", nil, now.Add(-time.Hour))
	commentAt(t, env, owner, owner, "a reply", oldest, now)
	require.NoError(t, env.db.Model(oldest).Update("reply_count", 1).Error)
	require.NoError(t, env.db.Model(liked).Update("like_count", 3).Error)
	require.NoError(t, env.db.Create(&models.CommentLike{CommentID: liked.ID, UserID: viewer.ID}).Error)
	list := func(t *testing.T, query string) dto.CommentsListResponse {
		t.Helper()
		return decodeAs[dto.CommentsListResponse](t, env.do(t, viewer, http.MethodGet, dayPath(owner.Username, commentDay)+query, nil), http.StatusOK)
	}

	t.Run("top comments by default", func(t *testing.T) {
		got := list(t, "")
		assert.True(t, got.Success)
		assert.Equal(t, []uint{liked.ID, newest.ID, oldest.ID}, commentIDs(got.Comments), "likes first, then recency; replies are not listed")
		assert.True(t, got.Comments[0].LikedByMe)
		assert.Equal(t, 1, got.Comments[2].ReplyCount)
		assert.False(t, got.HasMore)
		assert.Nil(t, got.NextCursor)
	})

	t.Run("newest first with a cursor", func(t *testing.T) {
		first := list(t, "?sort=newest&limit=2")
		assert.Equal(t, []uint{newest.ID, liked.ID}, commentIDs(first.Comments))
		assert.True(t, first.HasMore)
		require.NotNil(t, first.NextCursor)
		assert.Equal(t, liked.ID, *first.NextCursor)

		second := list(t, "?sort=newest&limit=2&cursor="+itoa(*first.NextCursor))
		assert.Equal(t, []uint{oldest.ID}, commentIDs(second.Comments))
		assert.False(t, second.HasMore)
	})

	t.Run("top comments with a cursor", func(t *testing.T) {
		assert.Equal(t, []uint{newest.ID, oldest.ID}, commentIDs(list(t, "?cursor="+itoa(liked.ID)).Comments))
		assert.Empty(t, list(t, "?cursor="+itoa(oldest.ID)).Comments, "nothing after the last ranked comment")
		assert.Len(t, list(t, "?cursor="+itoa(deletedUserID)).Comments, 3, "unknown cursors are ignored")
	})

	t.Run("invalid parameters fall back to the defaults", func(t *testing.T) {
		for _, query := range []string{"?sort=random", "?cursor=abc", "?limit=0", "?limit=500", "?limit=abc"} {
			assert.Equal(t, []uint{liked.ID, newest.ID, oldest.ID}, commentIDs(list(t, query).Comments), query)
		}
	})

	t.Run("day without comments", func(t *testing.T) {
		res := env.do(t, viewer, http.MethodGet, dayPath(owner.Username, "2026-03-10"), nil)
		require.Equal(t, http.StatusOK, res.Status)
		assert.Equal(t, map[string]any{"success": true, "comments": []any{}, "has_more": false}, res.JSON(t))
	})
}

func TestCommentHandler_GetReplies(t *testing.T) {
	env := newEnv(t)
	owner, viewer := env.user(t), env.user(t)
	hidden := env.user(t, private)
	now := time.Now()
	root := commentAt(t, env, owner, viewer, "root", nil, now.Add(-4*time.Hour))
	r1 := commentAt(t, env, owner, owner, "first", root, now.Add(-3*time.Hour))
	r2 := commentAt(t, env, owner, viewer, "second", r1, now.Add(-2*time.Hour))
	r3 := commentAt(t, env, owner, owner, "third", root, now.Add(-time.Hour))
	secret := createComment(t, env.db, hidden.ID, hidden.ID, commentDate, "secret", nil)
	replies := func(t *testing.T, query string) dto.CommentsListResponse {
		t.Helper()
		return decodeAs[dto.CommentsListResponse](t, env.do(t, viewer, http.MethodGet, commentPath(root.ID)+"/replies"+query, nil), http.StatusOK)
	}

	t.Run("oldest first", func(t *testing.T) {
		got := replies(t, "")
		assert.Equal(t, []uint{r1.ID, r2.ID, r3.ID}, commentIDs(got.Comments))
		require.NotNil(t, got.Comments[1].ReplyToUsername)
		assert.Equal(t, owner.Username, *got.Comments[1].ReplyToUsername)
	})

	t.Run("pages", func(t *testing.T) {
		first := replies(t, "?limit=2")
		assert.Equal(t, []uint{r1.ID, r2.ID}, commentIDs(first.Comments))
		require.NotNil(t, first.NextCursor)
		assert.True(t, first.HasMore)
		second := replies(t, "?limit=2&cursor="+itoa(*first.NextCursor))
		assert.Equal(t, []uint{r3.ID}, commentIDs(second.Comments))
		assert.False(t, second.HasMore)
		assert.Len(t, replies(t, "?limit=0&cursor=abc").Comments, 3, "invalid parameters fall back to the defaults")
	})

	t.Run("errors", func(t *testing.T) {
		res := env.do(t, viewer, http.MethodGet, "/api/comments/abc/replies", nil)
		assertErrorMessage(t, res, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid comment ID")
		res = env.do(t, viewer, http.MethodGet, commentPath(deletedUserID)+"/replies", nil)
		assertErrorMessage(t, res, http.StatusNotFound, constants.ErrCodeCommentNotFound, "Comment not found")
		res = env.do(t, viewer, http.MethodGet, commentPath(secret.ID)+"/replies", nil)
		assertErrorMessage(t, res, http.StatusForbidden, constants.ErrCodeAccountPrivate, "This account is private")
	})

	t.Run("database failure", func(t *testing.T) {
		faulty := newStack(faultyDB(t, failNth(2, failOn("query", "comments"))), env.cfg, false)
		h := &handlerSet{comment: NewCommentHandler(faulty.commentSvc, env.profileSvc, env.authSvc)}
		res := call(t, h, viewer, http.MethodGet, commentPath(root.ID)+"/replies", nil)
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeFetchFailed, "Failed to get replies")
	})
}

func TestCommentHandler_GetCommentCount(t *testing.T) {
	env := newEnv(t)
	owner, viewer := env.user(t), env.user(t)
	root := createComment(t, env.db, owner.ID, viewer.ID, commentDate, "one", nil)
	createComment(t, env.db, owner.ID, owner.ID, commentDate, "two", root)
	gone := createComment(t, env.db, owner.ID, viewer.ID, commentDate, "three", nil)
	require.NoError(t, env.db.Model(gone).Update("is_deleted", true).Error)
	createComment(t, env.db, owner.ID, viewer.ID, testutil.Day(2026, 3, 10), "other day", nil)

	got := decodeAs[dto.CommentCountResponse](t, env.do(t, viewer, http.MethodGet, dayPath(owner.Username, commentDay)+"/count", nil), http.StatusOK)

	assert.Equal(t, dto.CommentCountResponse{Success: true, Count: 2}, got, "replies count, deleted comments do not")
}

func TestCommentHandler_DayQueriesDatabaseFailure(t *testing.T) {
	env := newEnv(t)
	owner := env.user(t)
	h := &handlerSet{comment: NewCommentHandler(brokenStack(t).commentSvc, env.profileSvc, env.authSvc)}

	res := call(t, h, owner, http.MethodGet, dayPath(owner.Username, commentDay), nil)
	assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeFetchFailed, "Failed to get comments")

	res = call(t, h, owner, http.MethodGet, dayPath(owner.Username, commentDay)+"/count", nil)
	assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeFetchFailed, "Failed to get comment count")
}

func TestCommentHandler_DeleteComment(t *testing.T) {
	env := newEnv(t)
	owner, author, stranger := env.user(t), env.user(t), env.user(t)
	mine := createComment(t, env.db, owner.ID, author.ID, commentDate, "mine", nil)
	moderated := createComment(t, env.db, owner.ID, author.ID, commentDate, "rude", nil)
	del := func(t *testing.T, user *models.User, id string) testutil.Response {
		t.Helper()
		return env.do(t, user, http.MethodDelete, "/api/comments/"+id, nil)
	}

	t.Run("invalid id", func(t *testing.T) {
		assertErrorMessage(t, del(t, author, "abc"), http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid comment ID")
	})

	t.Run("unknown comment", func(t *testing.T) {
		assertErrorMessage(t, del(t, author, itoa(deletedUserID)), http.StatusNotFound, constants.ErrCodeCommentNotFound, "Comment not found")
	})

	t.Run("someone else's comment on someone else's day", func(t *testing.T) {
		assertErrorMessage(t, del(t, stranger, itoa(mine.ID)), http.StatusForbidden, constants.ErrCodeCommentForbidden, "Not authorized to delete this comment")
		assert.False(t, storedComment(t, env, mine.ID).IsDeleted)
	})

	t.Run("the author deletes", func(t *testing.T) {
		assertSuccessMessage(t, del(t, author, itoa(mine.ID)), http.StatusOK, constants.MsgCommentDeleted)
		got := storedComment(t, env, mine.ID)
		assert.True(t, got.IsDeleted)
		assert.Equal(t, "[Deleted]", got.Body)
	})

	t.Run("already deleted", func(t *testing.T) {
		assertErrorMessage(t, del(t, author, itoa(mine.ID)), http.StatusNotFound, constants.ErrCodeCommentDeleted, "Comment already deleted")
	})

	t.Run("the day owner moderates", func(t *testing.T) {
		assertSuccessMessage(t, del(t, owner, itoa(moderated.ID)), http.StatusOK, constants.MsgCommentDeleted)
		assert.True(t, storedComment(t, env, moderated.ID).IsDeleted)
	})

	t.Run("database failure", func(t *testing.T) {
		c := createComment(t, env.db, owner.ID, author.ID, commentDate, "kept", nil)
		faulty := newStack(faultyDB(t, failOn("update", "comments")), env.cfg, false)
		h := &handlerSet{comment: NewCommentHandler(faulty.commentSvc, env.profileSvc, env.authSvc)}
		res := call(t, h, author, http.MethodDelete, commentPath(c.ID), nil)
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeDeleteFailed, "Failed to delete comment")
		assert.False(t, storedComment(t, env, c.ID).IsDeleted)
	})
}

func TestCommentHandler_EditComment(t *testing.T) {
	env := newEnv(t)
	owner := env.user(t)
	author := env.user(t)
	friend := env.user(t, withUsername("pal_99"))
	fresh := createComment(t, env.db, owner.ID, author.ID, commentDate, "typo", nil)
	reply := createComment(t, env.db, owner.ID, author.ID, commentDate, "reply", fresh)
	stale := commentAt(t, env, owner, author, "old", nil, time.Now().Add(-2*time.Hour))
	gone := createComment(t, env.db, owner.ID, author.ID, commentDate, "gone", nil)
	require.NoError(t, env.db.Model(gone).Update("is_deleted", true).Error)
	edit := func(t *testing.T, user *models.User, id string, body any) testutil.Response {
		t.Helper()
		return env.do(t, user, http.MethodPut, "/api/comments/"+id, body)
	}

	t.Run("errors", func(t *testing.T) {
		tests := []struct {
			name   string
			user   *models.User
			id     string
			body   any
			status int
			code   string
			msg    string
		}{
			{"invalid id", author, "abc", commentBody("x"), http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid comment ID"},
			{"malformed json", author, itoa(fresh.ID), `{"body":`, http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid request body"},
			{"unknown comment", author, itoa(deletedUserID), commentBody("x"), http.StatusNotFound, constants.ErrCodeCommentNotFound, "Comment not found"},
			{"not the author", owner, itoa(fresh.ID), commentBody("x"), http.StatusForbidden, constants.ErrCodeCommentForbidden, "Not authorized to edit this comment"},
			{"deleted comment", author, itoa(gone.ID), commentBody("x"), http.StatusBadRequest, constants.ErrCodeCommentDeleted, "Cannot edit a deleted comment"},
			{"edit window expired", author, itoa(stale.ID), commentBody("x"), http.StatusBadRequest, constants.ErrCodeCommentEditExpired, "Edit window has expired"},
			{"blank", author, itoa(fresh.ID), commentBody("  "), http.StatusBadRequest, constants.ErrCodeCommentEmpty, "Comment cannot be empty"},
		}
		for _, tc := range tests {
			t.Run(tc.name, func(t *testing.T) {
				assertErrorMessage(t, edit(t, tc.user, tc.id, tc.body), tc.status, tc.code, tc.msg)
			})
		}
		assert.Equal(t, "typo", storedComment(t, env, fresh.ID).Body)
	})

	t.Run("the author edits within the window", func(t *testing.T) {
		got := decodeAs[dto.CommentActionResponse](t, edit(t, author, itoa(fresh.ID), commentBody(" fixed, thanks @pal_99 ")), http.StatusOK)

		assert.True(t, got.Success)
		assert.Equal(t, constants.MsgCommentEdited, got.Message)
		require.NotNil(t, got.Comment)
		assert.Equal(t, "fixed, thanks @pal_99", got.Comment.Body)
		assert.True(t, got.Comment.IsEdited)
		assert.Equal(t, []dto.MentionDTO{{UserID: friend.ID, Username: "pal_99"}}, got.Comment.Mentions)
		assert.True(t, storedComment(t, env, fresh.ID).IsEdited)
	})

	t.Run("editing a reply keeps its reply-to user", func(t *testing.T) {
		got := decodeAs[dto.CommentActionResponse](t, edit(t, author, itoa(reply.ID), commentBody("edited reply")), http.StatusOK)
		require.NotNil(t, got.Comment.ReplyToUsername)
		assert.Equal(t, author.Username, *got.Comment.ReplyToUsername)
	})

	t.Run("database failure", func(t *testing.T) {
		faulty := newStack(faultyDB(t, failOn("update", "comments")), env.cfg, false)
		h := &handlerSet{comment: NewCommentHandler(faulty.commentSvc, env.profileSvc, env.authSvc)}
		res := call(t, h, author, http.MethodPut, commentPath(fresh.ID), commentBody("again"))
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeUpdateFailed, "Failed to edit comment")
	})
}

func TestCommentHandler_EditComment_RejectedMentionsLeaveTheCommentUnchanged(t *testing.T) {
	env := newEnv(t)
	owner, author := env.user(t), env.user(t)
	c := createComment(t, env.db, owner.ID, author.ID, commentDate, "original", nil)

	res := env.do(t, author, http.MethodPut, commentPath(c.ID), commentBody("@aaa @bbb @ccc @ddd @eee @fff @ggg @hhh @iii @jjj @kkk"))

	assertError(t, res, http.StatusBadRequest, constants.ErrCodeTooManyMentions)
	assert.Equal(t, "original", storedComment(t, env, c.ID).Body)
}

func TestCommentHandler_LikeAndUnlike(t *testing.T) {
	env := newEnv(t)
	owner, fan := env.user(t), env.user(t)
	c := createComment(t, env.db, owner.ID, owner.ID, commentDate, "like me", nil)
	gone := createComment(t, env.db, owner.ID, owner.ID, commentDate, "gone", nil)
	require.NoError(t, env.db.Model(gone).Update("is_deleted", true).Error)
	act := func(t *testing.T, method string, id string) testutil.Response {
		t.Helper()
		return env.do(t, fan, method, "/api/comments/"+id+"/like", nil)
	}

	for _, method := range []string{http.MethodPost, http.MethodDelete} {
		t.Run(method+" invalid id", func(t *testing.T) {
			assertErrorMessage(t, act(t, method, "abc"), http.StatusBadRequest, constants.ErrCodeInvalidRequest, "Invalid comment ID")
		})
		t.Run(method+" unknown comment", func(t *testing.T) {
			assertErrorMessage(t, act(t, method, itoa(deletedUserID)), http.StatusBadRequest, constants.ErrCodeCommentNotFound, "Comment not found")
		})
	}

	steps := []struct {
		name   string
		method string
		want   dto.LikeActionResponse
	}{
		{"like", http.MethodPost, dto.LikeActionResponse{Success: true, Liked: true, NewCount: 1}},
		{"like again is a no-op", http.MethodPost, dto.LikeActionResponse{Success: true, Liked: true, NewCount: 1}},
		{"unlike", http.MethodDelete, dto.LikeActionResponse{Success: true, Liked: false, NewCount: 0}},
		{"unlike again is a no-op", http.MethodDelete, dto.LikeActionResponse{Success: true, Liked: false, NewCount: 0}},
	}
	for _, step := range steps {
		t.Run(step.name, func(t *testing.T) {
			assert.Equal(t, step.want, decodeAs[dto.LikeActionResponse](t, act(t, step.method, itoa(c.ID)), http.StatusOK))
			assert.Equal(t, step.want.NewCount, int64(storedComment(t, env, c.ID).LikeCount))
		})
	}

	t.Run("deleted comments cannot be liked", func(t *testing.T) {
		assertErrorMessage(t, act(t, http.MethodPost, itoa(gone.ID)), http.StatusBadRequest, constants.ErrCodeCommentDeleted, "Cannot like a deleted comment")
	})

	t.Run("database failures", func(t *testing.T) {
		faulty := newStack(faultyDB(t, anyOf(failOn("create", "comment_likes"), failOn("delete", "comment_likes"))), env.cfg, false)
		h := &handlerSet{comment: NewCommentHandler(faulty.commentSvc, env.profileSvc, env.authSvc)}

		res := call(t, h, fan, http.MethodPost, commentPath(c.ID)+"/like", nil)
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeCreateFailed, "Failed to like comment")
		res = call(t, h, fan, http.MethodDelete, commentPath(c.ID)+"/like", nil)
		assertErrorMessage(t, res, http.StatusInternalServerError, constants.ErrCodeDeleteFailed, "Failed to unlike comment")
	})
}

func TestCommentHandler_Notifications(t *testing.T) {
	env := newEnv(t, withAsync())
	owner := env.user(t)
	author := env.user(t, withPicture("http://pics.example/author.jpg"))
	friend := env.user(t, withUsername("buddy_7"))

	created := decodeAs[dto.CommentActionResponse](t,
		env.do(t, author, http.MethodPost, dayPath(owner.Username, commentDay), commentBody("well done @buddy_7")), http.StatusCreated)
	received := waitNotification(t, env.db, owner.ID, models.NotifTypeCommentReceived)
	assert.Equal(t, *author.ProfilePic, received.Metadata["author_avatar"])
	waitNotification(t, env.db, friend.ID, models.NotifTypeCommentMention)

	require.Equal(t, http.StatusCreated,
		env.do(t, owner, http.MethodPost, dayPath(owner.Username, commentDay)+"/"+itoa(created.Comment.ID)+"/replies", commentBody("thanks")).Status)
	waitNotification(t, env.db, author.ID, models.NotifTypeCommentReply)

	require.Equal(t, http.StatusOK, env.do(t, friend, http.MethodPost, commentPath(created.Comment.ID)+"/like", nil).Status)
	waitNotification(t, env.db, author.ID, models.NotifTypeCommentLiked)
}
