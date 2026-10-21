package services

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

func newFollowService(db *gorm.DB, cfg config.FollowConfig) *FollowService {
	return NewFollowService(repository.NewFollowRepository(db), repository.NewUserRepository(db), &cfg)
}

// newFollowServiceWith builds a FollowService whose follow and user repositories use different
// databases, so one of them can fail.
func newFollowServiceWith(followDB, userDB *gorm.DB) *FollowService {
	cfg := config.AppConfig.Follow
	return NewFollowService(repository.NewFollowRepository(followDB), repository.NewUserRepository(userDB), &cfg)
}

func relKey(viewer, target uint) string {
	return fmt.Sprintf("%s%d:%d", constants.FollowRelCachePrefix, viewer, target)
}

func countKey(userID uint) string {
	return fmt.Sprintf("%s%d", constants.FollowCountCachePrefix, userID)
}

// counterOf reads a user's follow counters (zero when the row does not exist). It never fails
// the test, so it can be used inside require.Eventually conditions.
func counterOf(db *gorm.DB, userID uint) models.FollowCounter {
	var c models.FollowCounter
	db.Where("user_id = ?", userID).Limit(1).Find(&c)
	return c
}

// edgeStates returns the state of follower -> followee in both edge tables ("" when missing).
func edgeStates(t *testing.T, db *gorm.DB, followerID, followeeID uint) (byFollower, byFollowee models.FollowState) {
	t.Helper()
	var a models.FollowEdgeByFollower
	var b models.FollowEdgeByFollowee
	require.NoError(t, db.Where("follower_id = ? AND followee_id = ?", followerID, followeeID).Limit(1).Find(&a).Error)
	require.NoError(t, db.Where("followee_id = ? AND follower_id = ?", followeeID, followerID).Limit(1).Find(&b).Error)
	return a.State, b.State
}

func assertEdge(t *testing.T, db *gorm.DB, followerID, followeeID uint, want models.FollowState) {
	t.Helper()
	a, b := edgeStates(t, db, followerID, followeeID)
	assert.Equal(t, want, a, "follow_edges_by_follower")
	assert.Equal(t, want, b, "follow_edges_by_followee")
}

func TestFollowService_Follow(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newFollowService(db, config.AppConfig.Follow)
	alice := newUser(t, db)
	bob := newUser(t, db)
	private := newUser(t, db, func(u *models.User) { u.IsPrivate = true })

	t.Run("public account is followed immediately", func(t *testing.T) {
		mr := startRedis(t)
		mr.Set(relKey(alice.ID, bob.ID), string(models.RelationshipNone))
		mr.HSet(countKey(alice.ID), "following", "0")
		mr.HSet(countKey(bob.ID), "followers", "0")

		res, err := svc.Follow(ctx, alice.ID, bob.ID)
		require.NoError(t, err)
		assert.Equal(t, &FollowResult{State: models.FollowStateActive, Message: "Now following"}, res)
		assertEdge(t, db, alice.ID, bob.ID, models.FollowStateActive)
		assert.EqualValues(t, 1, counterOf(db, alice.ID).FollowingCount)
		assert.EqualValues(t, 1, counterOf(db, bob.ID).FollowersCount)
		for _, key := range []string{relKey(alice.ID, bob.ID), countKey(alice.ID), countKey(bob.ID)} {
			assert.False(t, mr.Exists(key), "cache %s is invalidated", key)
		}
	})

	t.Run("following again is a no-op", func(t *testing.T) {
		res, err := svc.Follow(ctx, alice.ID, bob.ID)
		require.NoError(t, err)
		assert.Equal(t, &FollowResult{State: models.FollowStateActive, Message: "Already following"}, res)
		assert.EqualValues(t, 1, counterOf(db, bob.ID).FollowersCount)
	})

	t.Run("private account gets a pending request", func(t *testing.T) {
		res, err := svc.Follow(ctx, alice.ID, private.ID)
		require.NoError(t, err)
		assert.Equal(t, &FollowResult{State: models.FollowStatePending, Message: "Follow request sent"}, res)
		assertEdge(t, db, alice.ID, private.ID, models.FollowStatePending)
		assert.EqualValues(t, 1, counterOf(db, private.ID).PendingRequestsCount)
		assert.Zero(t, counterOf(db, private.ID).FollowersCount)

		res, err = svc.Follow(ctx, alice.ID, private.ID)
		require.NoError(t, err)
		assert.Equal(t, &FollowResult{State: models.FollowStatePending, Message: "Follow request already pending"}, res)
		assert.EqualValues(t, 1, counterOf(db, private.ID).PendingRequestsCount)
	})

	t.Run("re-follow after unfollow", func(t *testing.T) {
		require.NoError(t, svc.Unfollow(ctx, alice.ID, bob.ID))
		res, err := svc.Follow(ctx, alice.ID, bob.ID)
		require.NoError(t, err)
		assert.Equal(t, models.FollowStateActive, res.State)
		assertEdge(t, db, alice.ID, bob.ID, models.FollowStateActive)
		assert.EqualValues(t, 1, counterOf(db, bob.ID).FollowersCount)
	})

	t.Run("validation", func(t *testing.T) {
		_, err := svc.Follow(ctx, alice.ID, alice.ID)
		assert.ErrorContains(t, err, constants.ErrCodeCannotFollowSelf)
		_, err = svc.Follow(ctx, alice.ID, 999999)
		assert.ErrorContains(t, err, constants.ErrCodeUserNotFound)
	})
}

func TestFollowService_FollowLimits(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	alice := newUser(t, db)
	bob := newUser(t, db)
	carol := newUser(t, db)
	makeFollow(t, db, alice.ID, bob.ID, models.FollowStateActive)

	t.Run("total following limit", func(t *testing.T) {
		cfg := config.AppConfig.Follow
		cfg.MaxTotalFollowing = 1
		_, err := newFollowService(db, cfg).Follow(ctx, alice.ID, carol.ID)
		assert.ErrorContains(t, err, constants.ErrCodeFollowLimitExceeded)
		assert.ErrorContains(t, err, "maximum following limit of 1")
		a, _ := edgeStates(t, db, alice.ID, carol.ID)
		assert.Empty(t, a)
	})

	t.Run("daily limit counts follows made today, even if undone", func(t *testing.T) {
		cfg := config.AppConfig.Follow
		cfg.MaxFollowsPerDay = 1
		svc := newFollowService(db, cfg)
		require.NoError(t, svc.Unfollow(ctx, alice.ID, bob.ID))
		_, err := svc.Follow(ctx, alice.ID, carol.ID)
		assert.ErrorContains(t, err, constants.ErrCodeDailyLimitExceeded)
		assert.ErrorContains(t, err, "daily follow limit of 1")
	})
}

func TestFollowService_FollowFailures(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	alice := newUser(t, db)
	bob := newUser(t, db)

	cases := []struct {
		name    string
		svc     func(t *testing.T) *FollowService
		wantErr string
	}{
		{
			name:    "user lookup",
			svc:     func(t *testing.T) *FollowService { return newFollowServiceWith(db, testutil.BrokenDB(t)) },
			wantErr: "failed to fetch target user",
		},
		{
			name:    "edge lookup",
			svc:     func(t *testing.T) *FollowService { return newFollowServiceWith(testutil.BrokenDB(t), db) },
			wantErr: "failed to check existing relationship",
		},
		{
			name: "following count",
			svc: func(t *testing.T) *FollowService {
				return newFollowServiceWith(faultyDB(t, func(s stmtInfo) bool {
					_, isCount := s.Dest.(*int64)
					return s.is("query", "follow_edges_by_follower") && isCount && s.has("state = ?")
				}), db)
			},
			wantErr: "failed to count following",
		},
		{
			name: "daily count",
			svc: func(t *testing.T) *FollowService {
				return newFollowServiceWith(faultyDB(t, failingOn("query", "follow_edges_by_follower", "created_at >=")), db)
			},
			wantErr: "failed to count daily follows",
		},
		{
			name: "edge insert",
			svc: func(t *testing.T) *FollowService {
				return newFollowServiceWith(faultyDB(t, failingOn("create", "follow_edges_by_follower")), db)
			},
			wantErr: "failed to create follow",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := tc.svc(t).Follow(ctx, alice.ID, bob.ID)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.wantErr)
			a, b := edgeStates(t, db, alice.ID, bob.ID)
			assert.Empty(t, a)
			assert.Empty(t, b)
		})
	}
}

func TestFollowService_UnfollowAndRequests(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newFollowService(db, config.AppConfig.Follow)
	alice := newUser(t, db)
	bob := newUser(t, db)
	private := newUser(t, db, func(u *models.User) { u.IsPrivate = true })

	t.Run("unfollow", func(t *testing.T) {
		mr := startRedis(t)
		makeFollow(t, db, alice.ID, bob.ID, models.FollowStateActive)
		mr.Set(relKey(alice.ID, bob.ID), string(models.RelationshipFollowing))

		require.NoError(t, svc.Unfollow(ctx, alice.ID, bob.ID))
		assertEdge(t, db, alice.ID, bob.ID, models.FollowStateRemoved)
		assert.Zero(t, counterOf(db, alice.ID).FollowingCount)
		assert.Zero(t, counterOf(db, bob.ID).FollowersCount)
		assert.False(t, mr.Exists(relKey(alice.ID, bob.ID)))

		assert.ErrorContains(t, svc.Unfollow(ctx, alice.ID, bob.ID), constants.ErrCodeNotFollowing, "already removed")
		assert.ErrorContains(t, svc.Unfollow(ctx, bob.ID, alice.ID), constants.ErrCodeNotFollowing, "never followed")
	})

	t.Run("accept request", func(t *testing.T) {
		_, err := svc.Follow(ctx, alice.ID, private.ID)
		require.NoError(t, err)
		require.NoError(t, svc.AcceptRequest(ctx, private.ID, alice.ID))
		assertEdge(t, db, alice.ID, private.ID, models.FollowStateActive)
		c := counterOf(db, private.ID)
		assert.EqualValues(t, 1, c.FollowersCount)
		assert.Zero(t, c.PendingRequestsCount)
		assert.EqualValues(t, 1, counterOf(db, alice.ID).FollowingCount)

		assert.ErrorContains(t, svc.AcceptRequest(ctx, private.ID, alice.ID), constants.ErrCodeNoFollowRequest)
	})

	t.Run("remove follower", func(t *testing.T) {
		require.NoError(t, svc.RemoveFollower(ctx, private.ID, alice.ID))
		assertEdge(t, db, alice.ID, private.ID, models.FollowStateRemoved)
		assert.Zero(t, counterOf(db, private.ID).FollowersCount)
		assert.Zero(t, counterOf(db, alice.ID).FollowingCount)

		assert.ErrorContains(t, svc.RemoveFollower(ctx, private.ID, alice.ID), constants.ErrCodeNotFollowing)
	})

	t.Run("decline request", func(t *testing.T) {
		_, err := svc.Follow(ctx, bob.ID, private.ID)
		require.NoError(t, err)
		require.NoError(t, svc.DeclineRequest(ctx, private.ID, bob.ID))
		assertEdge(t, db, bob.ID, private.ID, models.FollowStateRemoved)
		assert.Zero(t, counterOf(db, private.ID).PendingRequestsCount)
		assert.ErrorContains(t, svc.DeclineRequest(ctx, private.ID, bob.ID), constants.ErrCodeNoFollowRequest)
	})

	t.Run("cancel request", func(t *testing.T) {
		_, err := svc.Follow(ctx, bob.ID, private.ID)
		require.NoError(t, err)
		require.NoError(t, svc.CancelRequest(ctx, bob.ID, private.ID))
		assertEdge(t, db, bob.ID, private.ID, models.FollowStateRemoved)
		assert.Zero(t, counterOf(db, private.ID).PendingRequestsCount)
		assert.ErrorContains(t, svc.CancelRequest(ctx, bob.ID, private.ID), constants.ErrCodeNoFollowRequest)
	})

	t.Run("unfollowing a pending request withdraws it", func(t *testing.T) {
		_, err := svc.Follow(ctx, bob.ID, private.ID)
		require.NoError(t, err)
		require.NoError(t, svc.Unfollow(ctx, bob.ID, private.ID))
		assert.Zero(t, counterOf(db, private.ID).PendingRequestsCount)
	})
}

func TestFollowService_RequestFailures(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	alice := newUser(t, db)
	bob := newUser(t, db)
	private := newUser(t, db, func(u *models.User) { u.IsPrivate = true })
	makeFollow(t, db, alice.ID, bob.ID, models.FollowStateActive)
	makeFollow(t, db, bob.ID, private.ID, models.FollowStatePending)

	lookupBroken := newFollowServiceWith(testutil.BrokenDB(t), db)
	updateBroken := newFollowServiceWith(faultyDB(t, failingOn("update", "follow_edges_by_follower")), db)

	cases := []struct {
		name    string
		call    func(s *FollowService) error
		lookup  string
		update  string
		follows [2]uint
		state   models.FollowState
	}{
		{"unfollow", func(s *FollowService) error { return s.Unfollow(ctx, alice.ID, bob.ID) },
			"failed to check existing relationship", "failed to unfollow", [2]uint{alice.ID, bob.ID}, models.FollowStateActive},
		{"remove follower", func(s *FollowService) error { return s.RemoveFollower(ctx, bob.ID, alice.ID) },
			"failed to check follow status", "failed to remove follower", [2]uint{alice.ID, bob.ID}, models.FollowStateActive},
		{"cancel request", func(s *FollowService) error { return s.CancelRequest(ctx, bob.ID, private.ID) },
			"failed to check pending request", "failed to cancel request", [2]uint{bob.ID, private.ID}, models.FollowStatePending},
		{"accept request", func(s *FollowService) error { return s.AcceptRequest(ctx, private.ID, bob.ID) },
			"failed to check pending request", "failed to accept request", [2]uint{bob.ID, private.ID}, models.FollowStatePending},
		{"decline request", func(s *FollowService) error { return s.DeclineRequest(ctx, private.ID, bob.ID) },
			"failed to check pending request", "failed to decline request", [2]uint{bob.ID, private.ID}, models.FollowStatePending},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.call(lookupBroken)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.lookup)

			err = tc.call(updateBroken)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.update)
			assertEdge(t, db, tc.follows[0], tc.follows[1], tc.state)
		})
	}
}

func TestFollowService_Lists(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newFollowService(db, config.AppConfig.Follow)
	owner := newUser(t, db)
	private := newUser(t, db, func(u *models.User) { u.IsPrivate = true })
	stranger := newUser(t, db)
	var fans []uint
	for i := 0; i < 3; i++ {
		fan := newUser(t, db)
		fans = append(fans, fan.ID)
		makeFollow(t, db, fan.ID, owner.ID, models.FollowStateActive)
		makeFollow(t, db, owner.ID, fan.ID, models.FollowStateActive)
	}
	makeFollow(t, db, fans[0], private.ID, models.FollowStateActive)
	makeFollow(t, db, stranger.ID, owner.ID, models.FollowStatePending)

	t.Run("followers are paginated with a cursor", func(t *testing.T) {
		page1, hasMore, err := svc.GetFollowers(ctx, owner.ID, owner.ID, 2, nil)
		require.NoError(t, err)
		require.Len(t, page1, 2)
		assert.True(t, hasMore)

		last := page1[len(page1)-1]
		page2, hasMore, err := svc.GetFollowers(ctx, owner.ID, owner.ID, 2,
			&repository.FollowListCursor{CreatedAt: last.CreatedAt, UserID: last.FollowerID})
		require.NoError(t, err)
		require.Len(t, page2, 1)
		assert.False(t, hasMore)

		var got []uint
		for _, e := range append(page1, page2...) {
			got = append(got, e.FollowerID)
		}
		assert.ElementsMatch(t, fans, got, "pending requests are not followers")
	})

	t.Run("following of a public account is visible to anyone", func(t *testing.T) {
		edges, hasMore, err := svc.GetFollowing(ctx, stranger.ID, owner.ID, 0, nil)
		require.NoError(t, err)
		assert.False(t, hasMore)
		var got []uint
		for _, e := range edges {
			got = append(got, e.FolloweeID)
		}
		assert.ElementsMatch(t, fans, got)

		page, hasMore, err := svc.GetFollowing(ctx, owner.ID, owner.ID, 1, nil)
		require.NoError(t, err)
		assert.Len(t, page, 1)
		assert.True(t, hasMore)
	})

	t.Run("limit is clamped", func(t *testing.T) {
		for _, limit := range []int{-1, 0, constants.FollowListMaxLimit + 1} {
			edges, hasMore, err := svc.GetFollowers(ctx, owner.ID, owner.ID, limit, nil)
			require.NoError(t, err)
			assert.Len(t, edges, 3)
			assert.False(t, hasMore)
		}
	})

	t.Run("private lists need an accepted follow", func(t *testing.T) {
		_, _, err := svc.GetFollowers(ctx, stranger.ID, private.ID, 10, nil)
		assert.ErrorContains(t, err, constants.ErrCodeAccountPrivate)
		_, _, err = svc.GetFollowing(ctx, stranger.ID, private.ID, 10, nil)
		assert.ErrorContains(t, err, constants.ErrCodeAccountPrivate)

		edges, _, err := svc.GetFollowers(ctx, fans[0], private.ID, 10, nil)
		require.NoError(t, err)
		require.Len(t, edges, 1)
		assert.Equal(t, fans[0], edges[0].FollowerID)
	})

	t.Run("unknown user", func(t *testing.T) {
		_, _, err := svc.GetFollowers(ctx, owner.ID, 999999, 10, nil)
		assert.ErrorContains(t, err, constants.ErrCodeUserNotFound)
	})

	t.Run("pending incoming requests", func(t *testing.T) {
		makeFollow(t, db, private.ID, owner.ID, models.FollowStatePending)
		page, hasMore, err := svc.GetPendingIncomingRequests(ctx, owner.ID, 1, nil)
		require.NoError(t, err)
		assert.Len(t, page, 1)
		assert.True(t, hasMore)

		all, hasMore, err := svc.GetPendingIncomingRequests(ctx, owner.ID, 500, nil)
		require.NoError(t, err)
		assert.False(t, hasMore)
		var got []uint
		for _, e := range all {
			got = append(got, e.FollowerID)
		}
		assert.ElementsMatch(t, []uint{stranger.ID, private.ID}, got)
		assert.EqualValues(t, 2, svc.GetPendingRequestsCount(ctx, owner.ID))
	})

	t.Run("database failures", func(t *testing.T) {
		brokenAll := newFollowServiceWith(testutil.BrokenDB(t), testutil.BrokenDB(t))
		_, _, err := brokenAll.GetFollowers(ctx, stranger.ID, owner.ID, 10, nil)
		assert.ErrorContains(t, err, "failed to fetch target user")

		brokenEdges := newFollowServiceWith(testutil.BrokenDB(t), db)
		_, _, err = brokenEdges.GetFollowers(ctx, stranger.ID, private.ID, 10, nil)
		assert.ErrorContains(t, err, "failed to check follow status")
		_, _, err = brokenEdges.GetFollowers(ctx, owner.ID, owner.ID, 10, nil)
		assert.ErrorContains(t, err, "failed to get followers")
		_, _, err = brokenEdges.GetFollowing(ctx, owner.ID, owner.ID, 10, nil)
		assert.ErrorContains(t, err, "failed to get following")
		_, _, err = brokenEdges.GetFollowing(ctx, stranger.ID, 999999, 10, nil)
		assert.ErrorContains(t, err, constants.ErrCodeUserNotFound)
		_, _, err = brokenEdges.GetPendingIncomingRequests(ctx, owner.ID, 10, nil)
		assert.ErrorContains(t, err, "failed to get pending requests")
		assert.Zero(t, brokenEdges.GetPendingRequestsCount(ctx, owner.ID))
	})
}

func TestFollowService_Relationships(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newFollowService(db, config.AppConfig.Follow)
	viewer := newUser(t, db)
	followed := newUser(t, db)
	requested := newUser(t, db)
	requester := newUser(t, db)
	stranger := newUser(t, db)
	makeFollow(t, db, viewer.ID, followed.ID, models.FollowStateActive)
	makeFollow(t, db, viewer.ID, requested.ID, models.FollowStatePending)
	makeFollow(t, db, requester.ID, viewer.ID, models.FollowStatePending)

	targets := []uint{followed.ID, requested.ID, requester.ID, stranger.ID}
	want := map[uint]models.RelationshipState{
		followed.ID:  models.RelationshipFollowing,
		requested.ID: models.RelationshipRequested,
		requester.ID: models.RelationshipIncomingPending,
		stranger.ID:  models.RelationshipNone,
	}

	t.Run("without Redis", func(t *testing.T) {
		got, err := svc.LookupRelationships(ctx, viewer.ID, targets)
		require.NoError(t, err)
		assert.Equal(t, want, got)

		state, err := svc.GetRelationshipState(ctx, viewer.ID, requester.ID)
		require.NoError(t, err)
		assert.Equal(t, models.RelationshipIncomingPending, state)
	})

	t.Run("results are cached per pair", func(t *testing.T) {
		mr := startRedis(t)
		got, err := svc.LookupRelationships(ctx, viewer.ID, targets)
		require.NoError(t, err)
		assert.Equal(t, want, got)
		for id, state := range want {
			cached, err := mr.Get(relKey(viewer.ID, id))
			require.NoError(t, err)
			assert.Equal(t, string(state), cached)
			assert.Equal(t, constants.FollowRelCacheTTL, mr.TTL(relKey(viewer.ID, id)))
		}

		mr.Set(relKey(viewer.ID, stranger.ID), string(models.RelationshipFollowing))
		mr.Del(relKey(viewer.ID, followed.ID))
		got, err = svc.LookupRelationships(ctx, viewer.ID, []uint{stranger.ID, followed.ID})
		require.NoError(t, err)
		assert.Equal(t, models.RelationshipFollowing, got[stranger.ID], "served from the cache")
		assert.Equal(t, models.RelationshipFollowing, got[followed.ID], "recomputed")
	})

	t.Run("Redis failure falls back to the database", func(t *testing.T) {
		mr := startRedis(t)
		mr.SetError("boom")
		got, err := svc.LookupRelationships(ctx, viewer.ID, targets)
		require.NoError(t, err)
		assert.Equal(t, want, got)
	})

	t.Run("database failure", func(t *testing.T) {
		broken := newFollowServiceWith(testutil.BrokenDB(t), db)
		_, err := broken.LookupRelationships(ctx, viewer.ID, targets)
		assert.ErrorContains(t, err, "failed to lookup relationships")
		state, err := broken.GetRelationshipState(ctx, viewer.ID, followed.ID)
		assert.Error(t, err)
		assert.Equal(t, models.RelationshipNone, state)
	})
}

func TestFollowService_Mutuals(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newFollowService(db, config.AppConfig.Follow)
	viewer := newUser(t, db)
	target := newUser(t, db, func(u *models.User) { u.IsPrivate = true })
	friendA := newUser(t, db)
	friendB := newUser(t, db)
	notMutual := newUser(t, db)
	for _, f := range []*models.User{friendA, friendB, notMutual} {
		makeFollow(t, db, viewer.ID, f.ID, models.FollowStateActive)
	}
	makeFollow(t, db, friendA.ID, target.ID, models.FollowStateActive)
	makeFollow(t, db, friendB.ID, target.ID, models.FollowStateActive)
	makeFollow(t, db, notMutual.ID, target.ID, models.FollowStatePending)

	ids, hasMore, err := svc.GetMutuals(ctx, viewer.ID, target.ID, 0, nil)
	require.NoError(t, err)
	assert.False(t, hasMore)
	assert.ElementsMatch(t, []uint{friendA.ID, friendB.ID}, ids, "private targets still show your own friends")

	ids, hasMore, err = svc.GetMutuals(ctx, viewer.ID, target.ID, 1, nil)
	require.NoError(t, err)
	assert.Len(t, ids, 1)
	assert.True(t, hasMore)

	edges, hasMore, err := svc.GetMutualsWithTimestamps(ctx, viewer.ID, target.ID, 1, nil)
	require.NoError(t, err)
	require.Len(t, edges, 1)
	assert.True(t, hasMore)
	assert.False(t, edges[0].CreatedAt.IsZero())

	rest, hasMore, err := svc.GetMutualsWithTimestamps(ctx, viewer.ID, target.ID, 1000,
		&repository.FollowListCursor{CreatedAt: edges[0].CreatedAt, UserID: edges[0].UserID})
	require.NoError(t, err)
	assert.False(t, hasMore)
	require.Len(t, rest, 1)
	assert.ElementsMatch(t, []uint{friendA.ID, friendB.ID}, []uint{edges[0].UserID, rest[0].UserID})

	broken := newFollowServiceWith(testutil.BrokenDB(t), db)
	_, _, err = broken.GetMutuals(ctx, viewer.ID, target.ID, 10, nil)
	assert.ErrorContains(t, err, "failed to get mutuals")
	_, _, err = broken.GetMutualsWithTimestamps(ctx, viewer.ID, target.ID, 10, nil)
	assert.ErrorContains(t, err, "failed to get mutuals")
}

func TestFollowService_Counts(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newFollowService(db, config.AppConfig.Follow)
	user := newUser(t, db)
	for i := 0; i < 2; i++ {
		fan := newUser(t, db)
		makeFollow(t, db, fan.ID, user.ID, models.FollowStateActive)
	}
	other := newUser(t, db)
	makeFollow(t, db, user.ID, other.ID, models.FollowStateActive)

	t.Run("without Redis", func(t *testing.T) {
		followers, following, err := svc.GetFollowCounts(ctx, user.ID)
		require.NoError(t, err)
		assert.EqualValues(t, 2, followers)
		assert.EqualValues(t, 1, following)

		followers, following, err = svc.GetFollowCounts(ctx, 999999)
		require.NoError(t, err)
		assert.Zero(t, followers)
		assert.Zero(t, following)
	})

	t.Run("counts are cached", func(t *testing.T) {
		mr := startRedis(t)
		_, _, err := svc.GetFollowCounts(ctx, user.ID)
		require.NoError(t, err)
		assert.Equal(t, "2", mr.HGet(countKey(user.ID), "followers"))
		assert.Equal(t, "1", mr.HGet(countKey(user.ID), "following"))
		assert.Equal(t, constants.FollowCountCacheTTL, mr.TTL(countKey(user.ID)))

		mr.HSet(countKey(user.ID), "followers", "40", "following", "7")
		followers, following, err := svc.GetFollowCounts(ctx, user.ID)
		require.NoError(t, err)
		assert.EqualValues(t, 40, followers)
		assert.EqualValues(t, 7, following)

		mr.Del(countKey(user.ID))
		mr.HSet(countKey(user.ID), "followers", "5")
		followers, following, err = svc.GetFollowCounts(ctx, user.ID)
		require.NoError(t, err)
		assert.EqualValues(t, 5, followers)
		assert.Zero(t, following, "missing field reads as zero")
	})

	t.Run("Redis failure falls back to the database", func(t *testing.T) {
		mr := startRedis(t)
		mr.SetError("boom")
		followers, _, err := svc.GetFollowCounts(ctx, user.ID)
		require.NoError(t, err)
		assert.EqualValues(t, 2, followers)
	})

	t.Run("database failure", func(t *testing.T) {
		_, _, err := newFollowServiceWith(testutil.BrokenDB(t), db).GetFollowCounts(ctx, user.ID)
		assert.Error(t, err)
	})

	t.Run("reconcile repairs drifted counters", func(t *testing.T) {
		mr := startRedis(t)
		require.NoError(t, db.Model(&models.FollowCounter{}).Where("user_id = ?", user.ID).
			Updates(map[string]any{"followers_count": 99, "following_count": -3, "pending_requests_count": 4}).Error)
		mr.HSet(countKey(user.ID), "followers", "99")

		require.NoError(t, svc.ReconcileCounters(ctx, user.ID))
		c := counterOf(db, user.ID)
		assert.EqualValues(t, 2, c.FollowersCount)
		assert.EqualValues(t, 1, c.FollowingCount)
		assert.Zero(t, c.PendingRequestsCount)
		assert.False(t, mr.Exists(countKey(user.ID)))
	})

	t.Run("reconcile without Redis and failure", func(t *testing.T) {
		require.NoError(t, svc.ReconcileCounters(ctx, other.ID))
		assert.EqualValues(t, 1, counterOf(db, other.ID).FollowersCount)
		err := newFollowServiceWith(testutil.BrokenDB(t), db).ReconcileCounters(ctx, user.ID)
		assert.ErrorContains(t, err, "failed to reconcile counters")
	})
}

func TestFollowService_PublishFollowEvent_WithoutRedisUpdatesCountersSynchronously(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	svc := newFollowService(db, config.AppConfig.Follow)

	svc.publishFollowEvent(ctx, models.FollowEventCreated, 1, 2, models.FollowStateActive)
	assert.EqualValues(t, 1, counterOf(db, 1).FollowingCount)
	assert.EqualValues(t, 1, counterOf(db, 2).FollowersCount)

	svc.publishFollowEvent(ctx, models.FollowEventCreated, 3, 4, models.FollowStatePending)
	assert.EqualValues(t, 1, counterOf(db, 4).PendingRequestsCount)
	assert.Zero(t, counterOf(db, 3).FollowingCount)

	svc.publishFollowEvent(ctx, models.FollowEventAccepted, 3, 4, models.FollowStateActive)
	assert.EqualValues(t, 1, counterOf(db, 3).FollowingCount)
	assert.EqualValues(t, 1, counterOf(db, 4).FollowersCount)
	assert.Zero(t, counterOf(db, 4).PendingRequestsCount)

	svc.publishFollowEvent(ctx, models.FollowEventRemoved, 1, 2, models.FollowStateRemoved)
	assert.Zero(t, counterOf(db, 1).FollowingCount)
	assert.Zero(t, counterOf(db, 2).FollowersCount)

	svc.publishFollowEvent(ctx, models.FollowEventCreated, 5, 6, models.FollowStatePending)
	svc.publishFollowEvent(ctx, models.FollowEventDeclined, 5, 6, models.FollowStateRemoved)
	assert.Zero(t, counterOf(db, 6).PendingRequestsCount)

	t.Run("publish failure also falls back", func(t *testing.T) {
		mr := startRedis(t)
		failRedisCommands(t, mr, errInjected, "publish")
		svc.publishFollowEvent(ctx, models.FollowEventCreated, 7, 8, models.FollowStateActive)
		assert.EqualValues(t, 1, counterOf(db, 8).FollowersCount)
	})
}

func TestFollowService_CounterSubscriber(t *testing.T) {
	db := testDB(t)
	svc := newFollowService(db, config.AppConfig.Follow)

	t.Run("not started without Redis", func(t *testing.T) {
		svc.StartFollowCounterSubscriber(context.Background())
		assert.False(t, serviceGoroutinesRunning())
	})

	t.Run("applies published events until cancelled", func(t *testing.T) {
		mr := startRedis(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		svc.StartFollowCounterSubscriber(ctx)
		subscribed := func() bool {
			return mr.PubSubNumSub(constants.FollowEventChannel)[constants.FollowEventChannel] == 1
		}
		require.Eventually(t, subscribed, 5*time.Second, 5*time.Millisecond)

		eventually := func(cond func() bool, msg string) {
			t.Helper()
			require.Eventually(t, cond, 5*time.Second, 5*time.Millisecond, msg)
		}

		mr.HSet(countKey(1), "following", "0")
		mr.HSet(countKey(2), "followers", "0")
		mr.Publish(constants.FollowEventChannel, "not json") // ignored
		svc.publishFollowEvent(ctx, models.FollowEventCreated, 1, 2, models.FollowStateActive)
		eventually(func() bool {
			return counterOf(db, 1).FollowingCount == 1 && counterOf(db, 2).FollowersCount == 1
		}, "direct follow")
		eventually(func() bool { return !mr.Exists(countKey(1)) && !mr.Exists(countKey(2)) }, "count caches invalidated")

		svc.publishFollowEvent(ctx, models.FollowEventCreated, 3, 4, models.FollowStatePending)
		eventually(func() bool { return counterOf(db, 4).PendingRequestsCount == 1 }, "follow request")

		svc.publishFollowEvent(ctx, models.FollowEventAccepted, 3, 4, models.FollowStateActive)
		eventually(func() bool {
			c := counterOf(db, 4)
			return c.FollowersCount == 1 && c.PendingRequestsCount == 0 && counterOf(db, 3).FollowingCount == 1
		}, "request accepted")

		svc.publishFollowEvent(ctx, models.FollowEventRemoved, 3, 4, models.FollowStateRemoved)
		eventually(func() bool { return counterOf(db, 4).FollowersCount == 0 && counterOf(db, 3).FollowingCount == 0 }, "unfollow")

		svc.publishFollowEvent(ctx, models.FollowEventCreated, 5, 6, models.FollowStatePending)
		eventually(func() bool { return counterOf(db, 6).PendingRequestsCount == 1 }, "second request")
		svc.publishFollowEvent(ctx, models.FollowEventDeclined, 5, 6, models.FollowStateRemoved)
		eventually(func() bool { return counterOf(db, 6).PendingRequestsCount == 0 }, "request declined")

		mr.HSet(countKey(9), "followers", "1")
		svc.publishFollowEvent(ctx, models.FollowEventType("FOLLOW_UNKNOWN"), 9, 10, models.FollowStateActive)
		eventually(func() bool { return !mr.Exists(countKey(9)) }, "unknown events only invalidate caches")
		assert.Zero(t, counterOf(db, 10).FollowersCount)

		cancel()
		waitForAsync(t)
		require.Eventually(t, func() bool { return !subscribed() }, 5*time.Second, 5*time.Millisecond, "subscription closed")
	})
}
