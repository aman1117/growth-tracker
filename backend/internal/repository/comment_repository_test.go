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

func commentIDs(rows []CommentWithAuthor) []uint {
	ids := make([]uint, len(rows))
	for i, c := range rows {
		ids[i] = c.ID
	}
	return ids
}

func replyCount(t *testing.T, db *gorm.DB, id uint) int {
	t.Helper()
	var c models.Comment
	require.NoError(t, db.First(&c, id).Error)
	return c.ReplyCount
}

func TestCommentRepository_CreateAndGet(t *testing.T) {
	db := testutil.DB(t)
	repo := NewCommentRepository(db)
	owner := testutil.CreateUser(t, db)
	author := namedUser(t, db, "author", verified, withAvatar)

	comment := &models.Comment{DayOwnerID: owner.ID, DayDate: day, AuthorID: author.ID, Body: "Great día! 🎉"}
	require.NoError(t, repo.Create(comment))
	require.NotZero(t, comment.ID)

	got, err := repo.GetByID(comment.ID)
	require.NoError(t, err)
	assert.Equal(t, "Great día! 🎉", got.Body)
	assert.Equal(t, "2026-03-09", got.DayDate.Format(dateLayout))
	assert.True(t, got.IsTopLevel())
	assert.Zero(t, got.LikeCount)
	assert.Zero(t, got.ReplyCount)
	assert.False(t, got.IsEdited)
	assert.False(t, got.IsDeleted)

	withAuthor, err := repo.GetByIDWithAuthor(comment.ID)
	require.NoError(t, err)
	assert.Equal(t, comment.ID, withAuthor.ID)
	assert.Equal(t, "Great día! 🎉", withAuthor.Body)
	assert.Equal(t, "author", withAuthor.AuthorUsername)
	assert.Equal(t, author.ProfilePic, withAuthor.AuthorAvatar)
	assert.Equal(t, author.ProfilePicThumb, withAuthor.AuthorAvatarThumb)
	assert.True(t, withAuthor.AuthorVerified)

	_, err = repo.GetByID(9999)
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
	_, err = repo.GetByIDWithAuthor(9999)
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
}

func TestCommentRepository_Create_UnknownAuthor(t *testing.T) {
	db := testutil.DB(t)
	repo := NewCommentRepository(db)

	err := repo.Create(&models.Comment{DayOwnerID: 1, DayDate: day, AuthorID: 9999, Body: "hi"})

	assert.Error(t, err)
}

func TestCommentRepository_GetTopLevelByDay(t *testing.T) {
	db := testutil.DB(t)
	repo := NewCommentRepository(db)
	owner, other := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	author := namedUser(t, db, "commenter")
	c1 := createComment(t, db, owner.ID, day, author.ID, nil, "first", t0.Add(1*time.Minute))
	c2 := createComment(t, db, owner.ID, day, other.ID, nil, "second", t0.Add(2*time.Minute))
	c3 := createComment(t, db, owner.ID, day, author.ID, nil, "third", t0.Add(3*time.Minute))
	createComment(t, db, owner.ID, day, other.ID, c1, "a reply", t0.Add(4*time.Minute))
	createComment(t, db, owner.ID, day.AddDate(0, 0, 1), author.ID, nil, "another day", t0)
	createComment(t, db, other.ID, day, author.ID, nil, "another owner", t0)

	got, err := repo.GetTopLevelByDay(owner.ID, day, nil, 5)
	require.NoError(t, err)
	assert.Equal(t, []uint{c3.ID, c2.ID, c1.ID}, commentIDs(got), "top-level comments only, newest first")
	assert.Equal(t, "commenter", got[0].AuthorUsername)

	got, err = repo.GetTopLevelByDay(owner.ID, day, nil, 1)
	require.NoError(t, err)
	assert.Equal(t, []uint{c3.ID, c2.ID}, commentIDs(got), "one extra row signals another page")

	got, err = repo.GetTopLevelByDay(owner.ID, day, &c2.ID, 5)
	require.NoError(t, err)
	assert.Equal(t, []uint{c1.ID}, commentIDs(got), "cursor continues after the given comment")

	zero := uint(0)
	got, err = repo.GetTopLevelByDay(owner.ID, day, &zero, 5)
	require.NoError(t, err)
	assert.Len(t, got, 3, "a zero cursor means the first page")
}

func TestCommentRepository_GetRepliesByRoot(t *testing.T) {
	db := testutil.DB(t)
	repo := NewCommentRepository(db)
	owner, author := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	root := createComment(t, db, owner.ID, day, author.ID, nil, "root", t0)
	otherRoot := createComment(t, db, owner.ID, day, author.ID, nil, "other root", t0)
	r1 := createComment(t, db, owner.ID, day, owner.ID, root, "reply 1", t0.Add(1*time.Minute))
	r2 := createComment(t, db, owner.ID, day, author.ID, root, "reply 2", t0.Add(2*time.Minute))
	nested := createComment(t, db, owner.ID, day, author.ID, r1, "reply to reply 1", t0.Add(3*time.Minute))
	createComment(t, db, owner.ID, day, author.ID, otherRoot, "elsewhere", t0.Add(4*time.Minute))

	got, err := repo.GetRepliesByRoot(root.ID, nil, 10)
	require.NoError(t, err)
	assert.Equal(t, []uint{r1.ID, r2.ID, nested.ID}, commentIDs(got), "the whole thread, oldest first")
	require.NotNil(t, got[2].ParentCommentID)
	assert.Equal(t, r1.ID, *got[2].ParentCommentID)
	require.NotNil(t, got[2].ReplyToUserID)
	assert.Equal(t, owner.ID, *got[2].ReplyToUserID)

	got, err = repo.GetRepliesByRoot(root.ID, nil, 1)
	require.NoError(t, err)
	assert.Equal(t, []uint{r1.ID, r2.ID}, commentIDs(got), "limit plus one")

	got, err = repo.GetRepliesByRoot(root.ID, &r1.ID, 10)
	require.NoError(t, err)
	assert.Equal(t, []uint{r2.ID, nested.ID}, commentIDs(got))
}

func TestCommentRepository_SoftDeleteAndUpdateBody(t *testing.T) {
	db := testutil.DB(t)
	repo := NewCommentRepository(db)
	owner, author := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	doomed := createComment(t, db, owner.ID, day, author.ID, nil, "oops", t0)
	edited := createComment(t, db, owner.ID, day, author.ID, nil, "typo", t0)

	require.NoError(t, repo.SoftDelete(doomed.ID))
	got, err := repo.GetByID(doomed.ID)
	require.NoError(t, err)
	assert.True(t, got.IsDeleted)
	assert.Equal(t, "[Deleted]", got.Body)
	require.NotNil(t, got.DeletedAt)
	firstDeletedAt := *got.DeletedAt

	require.NoError(t, repo.SoftDelete(doomed.ID))
	got, err = repo.GetByID(doomed.ID)
	require.NoError(t, err)
	assert.True(t, got.DeletedAt.Equal(firstDeletedAt), "deleting twice keeps the original time")

	require.NoError(t, repo.UpdateBody(doomed.ID, "resurrected"))
	got, err = repo.GetByID(doomed.ID)
	require.NoError(t, err)
	assert.Equal(t, "[Deleted]", got.Body, "deleted comments cannot be edited")
	assert.False(t, got.IsEdited)

	require.NoError(t, repo.UpdateBody(edited.ID, "fixed ✏️"))
	got, err = repo.GetByID(edited.ID)
	require.NoError(t, err)
	assert.Equal(t, "fixed ✏️", got.Body)
	assert.True(t, got.IsEdited)
	assert.False(t, got.IsDeleted)
}

func TestCommentRepository_AncestorReplyCounts(t *testing.T) {
	db := testutil.DB(t)
	repo := NewCommentRepository(db)
	owner, author := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	root := createComment(t, db, owner.ID, day, author.ID, nil, "root", t0)
	child := createComment(t, db, owner.ID, day, author.ID, root, "child", t0)
	grandchild := createComment(t, db, owner.ID, day, author.ID, child, "grandchild", t0)
	unrelated := createComment(t, db, owner.ID, day, author.ID, nil, "unrelated", t0)
	replyCounts := func() [4]int {
		return [4]int{replyCount(t, db, root.ID), replyCount(t, db, child.ID), replyCount(t, db, grandchild.ID), replyCount(t, db, unrelated.ID)}
	}

	require.NoError(t, repo.IncrementAncestorReplyCounts(grandchild.ID))
	assert.Equal(t, [4]int{1, 1, 0, 0}, replyCounts(), "every ancestor is incremented")

	require.NoError(t, repo.IncrementAncestorReplyCounts(child.ID))
	assert.Equal(t, [4]int{2, 1, 0, 0}, replyCounts())

	require.NoError(t, repo.IncrementAncestorReplyCounts(root.ID))
	assert.Equal(t, [4]int{2, 1, 0, 0}, replyCounts(), "top-level comments have no ancestors")

	require.NoError(t, repo.DecrementAncestorReplyCounts(grandchild.ID))
	assert.Equal(t, [4]int{1, 0, 0, 0}, replyCounts())

	require.NoError(t, repo.DecrementAncestorReplyCounts(grandchild.ID))
	assert.Equal(t, [4]int{0, 0, 0, 0}, replyCounts(), "counts never go below zero")

	require.NoError(t, repo.DecrementAncestorReplyCounts(child.ID))
	assert.Equal(t, [4]int{0, 0, 0, 0}, replyCounts())
}

func TestCommentRepository_GetCommentCountForDay(t *testing.T) {
	db := testutil.DB(t)
	repo := NewCommentRepository(db)
	owner, author := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	c1 := createComment(t, db, owner.ID, day, author.ID, nil, "one", t0)
	createComment(t, db, owner.ID, day, author.ID, nil, "two", t0)
	createComment(t, db, owner.ID, day, author.ID, c1, "reply", t0)
	deleted := createComment(t, db, owner.ID, day, author.ID, nil, "gone", t0)
	require.NoError(t, repo.SoftDelete(deleted.ID))
	createComment(t, db, owner.ID, day.AddDate(0, 0, 1), author.ID, nil, "tomorrow", t0)

	count, err := repo.GetCommentCountForDay(owner.ID, day)
	require.NoError(t, err)
	assert.Equal(t, int64(3), count, "replies count, deleted comments do not")

	count, err = repo.GetCommentCountForDay(author.ID, day)
	require.NoError(t, err)
	assert.Zero(t, count)
}

func TestCommentRepository_GetReplyToUsername(t *testing.T) {
	db := testutil.DB(t)
	repo := NewCommentRepository(db)
	user := namedUser(t, db, "replied_to")

	name, err := repo.GetReplyToUsername(user.ID)
	require.NoError(t, err)
	assert.Equal(t, "replied_to", name)

	_, err = repo.GetReplyToUsername(9999)
	assert.ErrorIs(t, err, gorm.ErrRecordNotFound)
}

func TestCommentRepository_DatabaseErrors(t *testing.T) {
	repo := NewCommentRepository(testutil.BrokenDB(t))
	calls := map[string]func() error{
		"Create": func() error {
			return repo.Create(&models.Comment{DayOwnerID: 1, DayDate: day, AuthorID: 1, Body: "x"})
		},
		"GetByID":                      func() error { _, err := repo.GetByID(1); return err },
		"GetByIDWithAuthor":            func() error { _, err := repo.GetByIDWithAuthor(1); return err },
		"GetTopLevelByDay":             func() error { _, err := repo.GetTopLevelByDay(1, day, nil, 10); return err },
		"GetRepliesByRoot":             func() error { _, err := repo.GetRepliesByRoot(1, nil, 10); return err },
		"SoftDelete":                   func() error { return repo.SoftDelete(1) },
		"UpdateBody":                   func() error { return repo.UpdateBody(1, "x") },
		"IncrementAncestorReplyCounts": func() error { return repo.IncrementAncestorReplyCounts(1) },
		"DecrementAncestorReplyCounts": func() error { return repo.DecrementAncestorReplyCounts(1) },
		"GetCommentCountForDay":        func() error { _, err := repo.GetCommentCountForDay(1, day); return err },
		"GetReplyToUsername":           func() error { _, err := repo.GetReplyToUsername(1); return err },
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) {
			err := call()
			assert.Error(t, err)
			assert.NotErrorIs(t, err, gorm.ErrRecordNotFound)
		})
	}
}

// ==================== Comment likes ====================

func likeCount(t *testing.T, db *gorm.DB, id uint) int {
	t.Helper()
	var c models.Comment
	require.NoError(t, db.First(&c, id).Error)
	return c.LikeCount
}

func TestCommentLikeRepository(t *testing.T) {
	db := testutil.DB(t)
	repo := NewCommentLikeRepository(db)
	owner, alice, bob := testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	c1 := createComment(t, db, owner.ID, day, owner.ID, nil, "one", t0)
	c2 := createComment(t, db, owner.ID, day, owner.ID, nil, "two", t0)
	c3 := createComment(t, db, owner.ID, day, owner.ID, nil, "three", t0)

	created, err := repo.Create(c1.ID, alice.ID)
	require.NoError(t, err)
	assert.True(t, created)
	created, err = repo.Create(c1.ID, alice.ID)
	require.NoError(t, err)
	assert.False(t, created, "a second like by the same user is ignored")
	created, err = repo.Create(c1.ID, bob.ID)
	require.NoError(t, err)
	assert.True(t, created)
	created, err = repo.Create(c3.ID, alice.ID)
	require.NoError(t, err)
	assert.True(t, created)

	liked, err := repo.HasLiked(c1.ID, alice.ID)
	require.NoError(t, err)
	assert.True(t, liked)
	liked, err = repo.HasLiked(c2.ID, alice.ID)
	require.NoError(t, err)
	assert.False(t, liked)

	batch, err := repo.BatchHasLiked([]uint{c1.ID, c2.ID, c3.ID}, alice.ID)
	require.NoError(t, err)
	assert.Equal(t, map[uint]bool{c1.ID: true, c3.ID: true}, batch)
	batch, err = repo.BatchHasLiked(nil, alice.ID)
	require.NoError(t, err)
	assert.NotNil(t, batch)
	assert.Empty(t, batch)

	deleted, err := repo.Delete(c1.ID, alice.ID)
	require.NoError(t, err)
	assert.True(t, deleted)
	deleted, err = repo.Delete(c1.ID, alice.ID)
	require.NoError(t, err)
	assert.False(t, deleted, "nothing left to delete")
	liked, err = repo.HasLiked(c1.ID, bob.ID)
	require.NoError(t, err)
	assert.True(t, liked, "other users' likes are kept")
}

func TestCommentLikeRepository_LikeCount(t *testing.T) {
	db := testutil.DB(t)
	repo := NewCommentLikeRepository(db)
	owner := testutil.CreateUser(t, db)
	comment := createComment(t, db, owner.ID, day, owner.ID, nil, "popular", t0)
	other := createComment(t, db, owner.ID, day, owner.ID, nil, "other", t0)

	require.NoError(t, repo.IncrementLikeCount(comment.ID))
	require.NoError(t, repo.IncrementLikeCount(comment.ID))
	assert.Equal(t, 2, likeCount(t, db, comment.ID))

	require.NoError(t, repo.DecrementLikeCount(comment.ID))
	assert.Equal(t, 1, likeCount(t, db, comment.ID))
	require.NoError(t, repo.DecrementLikeCount(comment.ID))
	require.NoError(t, repo.DecrementLikeCount(comment.ID))
	assert.Zero(t, likeCount(t, db, comment.ID), "never below zero")
	assert.Zero(t, likeCount(t, db, other.ID))
}

func TestCommentLikeRepository_DatabaseErrors(t *testing.T) {
	repo := NewCommentLikeRepository(testutil.BrokenDB(t))

	created, err := repo.Create(1, 1)
	assert.Error(t, err, "only duplicate likes are swallowed")
	assert.False(t, created)
	deleted, err := repo.Delete(1, 1)
	assert.Error(t, err)
	assert.False(t, deleted)
	_, err = repo.HasLiked(1, 1)
	assert.Error(t, err)
	assert.Error(t, repo.IncrementLikeCount(1))
	assert.Error(t, repo.DecrementLikeCount(1))
	_, err = repo.BatchHasLiked([]uint{1}, 1)
	assert.Error(t, err)
}

// ==================== Comment mentions ====================

func TestCommentMentionRepository(t *testing.T) {
	db := testutil.DB(t)
	repo := NewCommentMentionRepository(db)
	alice, bob := namedUser(t, db, "alice"), namedUser(t, db, "bob")

	require.NoError(t, repo.CreateBatch(nil))
	require.NoError(t, repo.CreateBatch([]models.CommentMention{
		{CommentID: 1, MentionedUserID: alice.ID, Username: "alice"},
		{CommentID: 1, MentionedUserID: bob.ID, Username: "bob"},
		{CommentID: 2, MentionedUserID: alice.ID, Username: "alice"},
	}))

	mentions, err := repo.GetByCommentID(1)
	require.NoError(t, err)
	require.Len(t, mentions, 2)
	assert.ElementsMatch(t, []string{"alice", "bob"}, []string{mentions[0].Username, mentions[1].Username})

	grouped, err := repo.GetByCommentIDs([]uint{1, 2, 3})
	require.NoError(t, err)
	assert.Len(t, grouped, 2, "comments without mentions are absent")
	assert.Len(t, grouped[1], 2)
	require.Len(t, grouped[2], 1)
	assert.Equal(t, alice.ID, grouped[2][0].MentionedUserID)

	grouped, err = repo.GetByCommentIDs(nil)
	require.NoError(t, err)
	assert.NotNil(t, grouped)
	assert.Empty(t, grouped)

	require.NoError(t, repo.DeleteByCommentID(1))
	mentions, err = repo.GetByCommentID(1)
	require.NoError(t, err)
	assert.Empty(t, mentions)
	mentions, err = repo.GetByCommentID(2)
	require.NoError(t, err)
	assert.Len(t, mentions, 1)
}

func TestCommentMentionRepository_DatabaseErrors(t *testing.T) {
	repo := NewCommentMentionRepository(testutil.BrokenDB(t))

	assert.Error(t, repo.CreateBatch([]models.CommentMention{{CommentID: 1, MentionedUserID: 1, Username: "a"}}))
	_, err := repo.GetByCommentID(1)
	assert.Error(t, err)
	assert.Error(t, repo.DeleteByCommentID(1))
	_, err = repo.GetByCommentIDs([]uint{1})
	assert.Error(t, err)
}

// ==================== Comment dedupe ====================

func TestCommentDedupeRepository_UpsertAndCheck(t *testing.T) {
	db := testutil.DB(t)
	repo := NewCommentDedupeRepository(db)
	user, owner := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	const hash = "5d41402abc4b2a76b9719d911017c592"
	first := &models.CommentDedupe{UserID: user.ID, DayOwnerID: owner.ID, DayDate: day, BodyHash: hash, IdempotencyKey: testutil.Ptr("key-1"), CommentID: 10}

	require.NoError(t, repo.Upsert(first))

	byKey, err := repo.CheckIdempotencyKey("key-1", time.Minute)
	require.NoError(t, err)
	require.NotNil(t, byKey)
	assert.Equal(t, uint(10), byKey.CommentID)
	byHash, err := repo.CheckBodyHash(user.ID, owner.ID, day, hash, time.Minute)
	require.NoError(t, err)
	require.NotNil(t, byHash)
	assert.Equal(t, byKey.ID, byHash.ID)

	for name, check := range map[string]func() (*models.CommentDedupe, error){
		"unknown key": func() (*models.CommentDedupe, error) { return repo.CheckIdempotencyKey("key-2", time.Minute) },
		"other body": func() (*models.CommentDedupe, error) {
			return repo.CheckBodyHash(user.ID, owner.ID, day, "other", time.Minute)
		},
		"other day": func() (*models.CommentDedupe, error) {
			return repo.CheckBodyHash(user.ID, owner.ID, day.AddDate(0, 0, 1), hash, time.Minute)
		},
		"other day owner": func() (*models.CommentDedupe, error) {
			return repo.CheckBodyHash(user.ID, user.ID, day, hash, time.Minute)
		},
		"other commenter": func() (*models.CommentDedupe, error) {
			return repo.CheckBodyHash(owner.ID, owner.ID, day, hash, time.Minute)
		},
	} {
		got, err := check()
		require.NoError(t, err, name)
		assert.Nil(t, got, name)
	}

	t.Run("resubmitting the same body replaces the record", func(t *testing.T) {
		second := &models.CommentDedupe{UserID: user.ID, DayOwnerID: owner.ID, DayDate: day, BodyHash: hash, IdempotencyKey: testutil.Ptr("key-2"), CommentID: 11}
		require.NoError(t, repo.Upsert(second))

		got, err := repo.CheckBodyHash(user.ID, owner.ID, day, hash, time.Minute)
		require.NoError(t, err)
		require.NotNil(t, got)
		assert.Equal(t, uint(11), got.CommentID)
		old, err := repo.CheckIdempotencyKey("key-1", time.Minute)
		require.NoError(t, err)
		assert.Nil(t, old, "the old key is replaced")
		var rows int64
		require.NoError(t, db.Model(&models.CommentDedupe{}).Count(&rows).Error)
		assert.Equal(t, int64(1), rows)
	})

	t.Run("an idempotency key cannot be reused for another body", func(t *testing.T) {
		reused := &models.CommentDedupe{UserID: user.ID, DayOwnerID: owner.ID, DayDate: day, BodyHash: "different", IdempotencyKey: testutil.Ptr("key-2"), CommentID: 12}
		assert.Error(t, repo.Upsert(reused))
	})

	t.Run("records without a key", func(t *testing.T) {
		require.NoError(t, repo.Upsert(&models.CommentDedupe{UserID: user.ID, DayOwnerID: owner.ID, DayDate: day, BodyHash: "a", CommentID: 13}))
		require.NoError(t, repo.Upsert(&models.CommentDedupe{UserID: user.ID, DayOwnerID: owner.ID, DayDate: day, BodyHash: "b", CommentID: 14}))
		got, err := repo.CheckBodyHash(user.ID, owner.ID, day, "b", time.Minute)
		require.NoError(t, err)
		require.NotNil(t, got)
		assert.Nil(t, got.IdempotencyKey)
	})
}

func TestCommentDedupeRepository_WindowAndCleanup(t *testing.T) {
	db := testutil.DB(t)
	repo := NewCommentDedupeRepository(db)
	user, owner := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	require.NoError(t, repo.Upsert(&models.CommentDedupe{UserID: user.ID, DayOwnerID: owner.ID, DayDate: day, BodyHash: "old", IdempotencyKey: testutil.Ptr("old-key"), CommentID: 1}))
	require.NoError(t, repo.Upsert(&models.CommentDedupe{UserID: user.ID, DayOwnerID: owner.ID, DayDate: day, BodyHash: "new", IdempotencyKey: testutil.Ptr("new-key"), CommentID: 2}))
	require.NoError(t, db.Exec("UPDATE comment_dedupes SET created_at = NOW() - INTERVAL '2 minutes' WHERE body_hash = 'old'").Error)

	got, err := repo.CheckIdempotencyKey("old-key", time.Minute)
	require.NoError(t, err)
	assert.Nil(t, got, "outside the window")
	got, err = repo.CheckBodyHash(user.ID, owner.ID, day, "old", time.Minute)
	require.NoError(t, err)
	assert.Nil(t, got)
	got, err = repo.CheckIdempotencyKey("old-key", 5*time.Minute)
	require.NoError(t, err)
	assert.NotNil(t, got, "inside a wider window")

	deleted, err := repo.CleanupExpired(time.Minute)
	require.NoError(t, err)
	assert.Equal(t, int64(1), deleted)
	got, err = repo.CheckIdempotencyKey("new-key", time.Minute)
	require.NoError(t, err)
	assert.NotNil(t, got, "recent records survive cleanup")

	deleted, err = repo.CleanupExpired(time.Minute)
	require.NoError(t, err)
	assert.Zero(t, deleted)
}

func TestCommentDedupeRepository_DatabaseErrors(t *testing.T) {
	repo := NewCommentDedupeRepository(testutil.BrokenDB(t))

	_, err := repo.CheckIdempotencyKey("k", time.Minute)
	assert.Error(t, err)
	_, err = repo.CheckBodyHash(1, 2, day, "h", time.Minute)
	assert.Error(t, err)
	assert.Error(t, repo.Upsert(&models.CommentDedupe{UserID: 1, DayOwnerID: 2, DayDate: day, BodyHash: "h", CommentID: 1}))
	deleted, err := repo.CleanupExpired(time.Minute)
	assert.Error(t, err)
	assert.Zero(t, deleted)
}
