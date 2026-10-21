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

func statePtr(s models.FollowState) *models.FollowState { return &s }

// acceptedAt returns accepted_at of the edge in both tables.
func acceptedAt(t *testing.T, db *gorm.DB, followerID, followeeID uint) (byFollower, byFollowee *time.Time) {
	t.Helper()
	var a models.FollowEdgeByFollower
	require.NoError(t, db.Where("follower_id = ? AND followee_id = ?", followerID, followeeID).First(&a).Error)
	var b models.FollowEdgeByFollowee
	require.NoError(t, db.Where("followee_id = ? AND follower_id = ?", followeeID, followerID).First(&b).Error)
	return a.AcceptedAt, b.AcceptedAt
}

func TestFollowRepository_GetDB(t *testing.T) {
	db := testutil.DB(t)
	assert.Same(t, db, NewFollowRepository(db).GetDB())
}

func TestFollowRepository_IsFollowing(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	me := testutil.CreateUser(t, db)
	active, pending, removed, stranger := testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	follow(t, db, me.ID, active.ID, models.FollowStateActive, t0)
	follow(t, db, me.ID, pending.ID, models.FollowStatePending, t0)
	follow(t, db, me.ID, removed.ID, models.FollowStateRemoved, t0)

	for _, tc := range []struct {
		name               string
		follower, followee uint
		want               bool
	}{
		{"active", me.ID, active.ID, true},
		{"pending request", me.ID, pending.ID, false},
		{"removed", me.ID, removed.ID, false},
		{"no edge", me.ID, stranger.ID, false},
		{"reverse direction", active.ID, me.ID, false},
	} {
		got, err := repo.IsFollowing(tc.follower, tc.followee)
		require.NoError(t, err)
		assert.Equal(t, tc.want, got, tc.name)
	}
}

func TestFollowRepository_UpsertEdgeDualWrite(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	a, b := testutil.CreateUser(t, db), testutil.CreateUser(t, db)

	require.NoError(t, repo.UpsertEdgeDualWrite(a.ID, b.ID, models.FollowStateActive))
	byFollower, byFollowee := edgeStates(t, db, a.ID, b.ID)
	assert.Equal(t, models.FollowStateActive, byFollower)
	assert.Equal(t, models.FollowStateActive, byFollowee)
	accA, accB := acceptedAt(t, db, a.ID, b.ID)
	assert.NotNil(t, accA, "active edges record when they were accepted")
	assert.NotNil(t, accB)

	require.NoError(t, repo.UpsertEdgeDualWrite(a.ID, b.ID, models.FollowStatePending))
	byFollower, byFollowee = edgeStates(t, db, a.ID, b.ID)
	assert.Equal(t, models.FollowStatePending, byFollower, "an existing edge is updated in place")
	assert.Equal(t, models.FollowStatePending, byFollowee)
	accA, accB = acceptedAt(t, db, a.ID, b.ID)
	assert.Nil(t, accA)
	assert.Nil(t, accB)

	var edges, counterRows int64
	require.NoError(t, db.Model(&models.FollowEdgeByFollower{}).Count(&edges).Error)
	require.NoError(t, db.Model(&models.FollowCounter{}).Count(&counterRows).Error)
	assert.Equal(t, int64(1), edges)
	assert.Zero(t, counterRows, "counters are not touched")
}

func TestFollowRepository_UpsertEdgeDualWrite_RollsBack(t *testing.T) {
	db := testutil.DB(t)
	a, b := testutil.CreateUser(t, db), testutil.CreateUser(t, db)

	for _, table := range []string{"follow_edges_by_follower", "follow_edges_by_followee"} {
		t.Run(table+" fails", func(t *testing.T) {
			repo := NewFollowRepository(faultyDB(t, on("create", table)))

			err := repo.UpsertEdgeDualWrite(a.ID, b.ID, models.FollowStateActive)

			assert.ErrorIs(t, err, errInjected)
			byFollower, byFollowee := edgeStates(t, db, a.ID, b.ID)
			assert.Empty(t, byFollower, "nothing is written to either table")
			assert.Empty(t, byFollowee)
		})
	}
}

func TestFollowRepository_CreateFollowWithCounters(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)

	cases := []struct {
		name         string
		existing     *models.FollowState // edge already present before the call
		before       [2]counts           // follower, followee
		newState     models.FollowState
		after        [2]counts
		wantAccepted bool
	}{
		{
			name: "new follow of a public account", newState: models.FollowStateActive,
			after: [2]counts{{Following: 1}, {Followers: 1}}, wantAccepted: true,
		},
		{
			name: "new request to a private account", newState: models.FollowStatePending,
			after: [2]counts{{}, {Pending: 1}},
		},
		{
			name: "re-follow after removal", existing: statePtr(models.FollowStateRemoved), newState: models.FollowStateActive,
			after: [2]counts{{Following: 1}, {Followers: 1}}, wantAccepted: true,
		},
		{
			name: "new request after removal", existing: statePtr(models.FollowStateRemoved), newState: models.FollowStatePending,
			after: [2]counts{{}, {Pending: 1}},
		},
		{
			name: "already following is not counted twice", existing: statePtr(models.FollowStateActive), newState: models.FollowStateActive,
			before: [2]counts{{Following: 1}, {Followers: 1}},
			after:  [2]counts{{Following: 1}, {Followers: 1}}, wantAccepted: true,
		},
		{
			name: "removed state does not count", newState: models.FollowStateRemoved,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			follower, followee := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
			setCounters(t, db, follower.ID, tc.before[0])
			setCounters(t, db, followee.ID, tc.before[1])
			if tc.existing != nil {
				follow(t, db, follower.ID, followee.ID, *tc.existing, t0)
			}

			require.NoError(t, repo.CreateFollowWithCounters(follower.ID, followee.ID, tc.newState, tc.existing))

			byFollower, byFollowee := edgeStates(t, db, follower.ID, followee.ID)
			assert.Equal(t, tc.newState, byFollower)
			assert.Equal(t, tc.newState, byFollowee)
			accA, accB := acceptedAt(t, db, follower.ID, followee.ID)
			assert.Equal(t, tc.wantAccepted, accA != nil, "accepted_at (by follower)")
			assert.Equal(t, tc.wantAccepted, accB != nil, "accepted_at (by followee)")
			assert.Equal(t, tc.after[0], countsOf(t, db, follower.ID), "follower counters")
			assert.Equal(t, tc.after[1], countsOf(t, db, followee.ID), "followee counters")
		})
	}
}

func TestFollowRepository_CreateFollowWithCounters_CreatesMissingCounterRowsWithDelta(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	follower, followee := testutil.CreateUser(t, db), testutil.CreateUser(t, db) // no follow_counters rows

	require.NoError(t, repo.CreateFollowWithCounters(follower.ID, followee.ID, models.FollowStateActive, nil))

	assert.Equal(t, counts{Following: 1}, countsOf(t, db, follower.ID), "the first follow is counted")
	assert.Equal(t, counts{Followers: 1}, countsOf(t, db, followee.ID))
}

func TestFollowRepository_RequestLifecycle_WithoutExistingCounterRows(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	follower, followee := testutil.CreateUser(t, db), testutil.CreateUser(t, db, private)

	require.NoError(t, repo.CreateFollowWithCounters(follower.ID, followee.ID, models.FollowStatePending, nil))
	assert.Equal(t, counts{Pending: 1}, countsOf(t, db, followee.ID), "the first request is counted")

	require.NoError(t, repo.AcceptFollowWithCounters(follower.ID, followee.ID))
	assert.Equal(t, counts{Following: 1}, countsOf(t, db, follower.ID))
	assert.Equal(t, counts{Followers: 1}, countsOf(t, db, followee.ID), "pending does not drop below zero")

	require.NoError(t, repo.RemoveFollowWithCounters(follower.ID, followee.ID, models.FollowStateActive))
	assert.Equal(t, counts{}, countsOf(t, db, follower.ID))
	assert.Equal(t, counts{}, countsOf(t, db, followee.ID))
}

func TestFollowRepository_RemoveFollowWithCounters_MissingCounterRowsStartAtZero(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	follower, followee := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	follow(t, db, follower.ID, followee.ID, models.FollowStateActive, t0) // edge that predates the counters

	require.NoError(t, repo.RemoveFollowWithCounters(follower.ID, followee.ID, models.FollowStateActive))

	assert.Equal(t, counts{}, countsOf(t, db, follower.ID), "a new counters row never starts negative")
	assert.Equal(t, counts{}, countsOf(t, db, followee.ID))
}

func TestFollowRepository_CreateFollowWithCounters_RollsBack(t *testing.T) {
	db := testutil.DB(t)
	follower, followee := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	setCounters(t, db, follower.ID, counts{})
	setCounters(t, db, followee.ID, counts{})

	cases := []struct {
		name  string
		match stmtMatcher
	}{
		{"first edge write fails", on("create", "follow_edges_by_follower")},
		{"second edge write fails", on("create", "follow_edges_by_followee")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := NewFollowRepository(faultyDB(t, tc.match))

			err := repo.CreateFollowWithCounters(follower.ID, followee.ID, models.FollowStateActive, nil)

			assert.ErrorIs(t, err, errInjected)
			byFollower, byFollowee := edgeStates(t, db, follower.ID, followee.ID)
			assert.Empty(t, byFollower)
			assert.Empty(t, byFollowee)
			assert.Equal(t, counts{}, countsOf(t, db, follower.ID))
			assert.Equal(t, counts{}, countsOf(t, db, followee.ID))
		})
	}
}

func TestFollowRepository_RemoveFollowWithCounters(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)

	cases := []struct {
		name          string
		previous      models.FollowState
		before, after [2]counts
	}{
		{"unfollow", models.FollowStateActive, [2]counts{{Following: 1}, {Followers: 1}}, [2]counts{{}, {}}},
		{"cancel request", models.FollowStatePending, [2]counts{{}, {Pending: 1}}, [2]counts{{}, {}}},
		{"already removed", models.FollowStateRemoved, [2]counts{{Following: 4}, {Followers: 4}}, [2]counts{{Following: 4}, {Followers: 4}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			follower, followee := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
			follow(t, db, follower.ID, followee.ID, tc.previous, t0)
			setCounters(t, db, follower.ID, tc.before[0])
			setCounters(t, db, followee.ID, tc.before[1])

			require.NoError(t, repo.RemoveFollowWithCounters(follower.ID, followee.ID, tc.previous))

			byFollower, byFollowee := edgeStates(t, db, follower.ID, followee.ID)
			assert.Equal(t, models.FollowStateRemoved, byFollower, "a tombstone is kept")
			assert.Equal(t, models.FollowStateRemoved, byFollowee)
			assert.Equal(t, tc.after[0], countsOf(t, db, follower.ID))
			assert.Equal(t, tc.after[1], countsOf(t, db, followee.ID))
		})
	}
}

func TestFollowRepository_RemoveFollowWithCounters_RollsBack(t *testing.T) {
	db := testutil.DB(t)
	follower, followee := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	follow(t, db, follower.ID, followee.ID, models.FollowStateActive, t0)
	setCounters(t, db, follower.ID, counts{Following: 1})
	setCounters(t, db, followee.ID, counts{Followers: 1})

	for _, table := range []string{"follow_edges_by_follower", "follow_edges_by_followee"} {
		t.Run(table, func(t *testing.T) {
			repo := NewFollowRepository(faultyDB(t, on("update", table)))

			err := repo.RemoveFollowWithCounters(follower.ID, followee.ID, models.FollowStateActive)

			assert.ErrorIs(t, err, errInjected)
			byFollower, byFollowee := edgeStates(t, db, follower.ID, followee.ID)
			assert.Equal(t, models.FollowStateActive, byFollower)
			assert.Equal(t, models.FollowStateActive, byFollowee)
			assert.Equal(t, counts{Following: 1}, countsOf(t, db, follower.ID))
			assert.Equal(t, counts{Followers: 1}, countsOf(t, db, followee.ID))
		})
	}
}

func TestFollowRepository_AcceptFollowWithCounters(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	follower, followee := testutil.CreateUser(t, db), testutil.CreateUser(t, db, private)
	follow(t, db, follower.ID, followee.ID, models.FollowStatePending, t0)
	setCounters(t, db, follower.ID, counts{Following: 2})
	setCounters(t, db, followee.ID, counts{Followers: 5, Pending: 1})

	require.NoError(t, repo.AcceptFollowWithCounters(follower.ID, followee.ID))

	byFollower, byFollowee := edgeStates(t, db, follower.ID, followee.ID)
	assert.Equal(t, models.FollowStateActive, byFollower)
	assert.Equal(t, models.FollowStateActive, byFollowee)
	accA, accB := acceptedAt(t, db, follower.ID, followee.ID)
	assert.NotNil(t, accA)
	assert.NotNil(t, accB)
	assert.Equal(t, counts{Following: 3}, countsOf(t, db, follower.ID))
	assert.Equal(t, counts{Followers: 6, Pending: 0}, countsOf(t, db, followee.ID))
}

func TestFollowRepository_AcceptFollowWithCounters_RollsBack(t *testing.T) {
	db := testutil.DB(t)
	follower, followee := testutil.CreateUser(t, db), testutil.CreateUser(t, db, private)
	follow(t, db, follower.ID, followee.ID, models.FollowStatePending, t0)
	setCounters(t, db, follower.ID, counts{})
	setCounters(t, db, followee.ID, counts{Pending: 1})

	for _, table := range []string{"follow_edges_by_follower", "follow_edges_by_followee"} {
		t.Run(table, func(t *testing.T) {
			repo := NewFollowRepository(faultyDB(t, on("update", table)))

			assert.ErrorIs(t, repo.AcceptFollowWithCounters(follower.ID, followee.ID), errInjected)

			byFollower, byFollowee := edgeStates(t, db, follower.ID, followee.ID)
			assert.Equal(t, models.FollowStatePending, byFollower)
			assert.Equal(t, models.FollowStatePending, byFollowee)
			assert.Equal(t, counts{}, countsOf(t, db, follower.ID))
			assert.Equal(t, counts{Pending: 1}, countsOf(t, db, followee.ID))
		})
	}
}

func TestFollowRepository_UpdateEdgeState(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	a, b := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	follow(t, db, a.ID, b.ID, models.FollowStatePending, t0)

	require.NoError(t, repo.UpdateEdgeState(a.ID, b.ID, models.FollowStateActive))
	byFollower, byFollowee := edgeStates(t, db, a.ID, b.ID)
	assert.Equal(t, models.FollowStateActive, byFollower)
	assert.Equal(t, models.FollowStateActive, byFollowee)
	accA, accB := acceptedAt(t, db, a.ID, b.ID)
	require.NotNil(t, accA)
	require.NotNil(t, accB)

	require.NoError(t, repo.UpdateEdgeState(a.ID, b.ID, models.FollowStateRemoved))
	byFollower, byFollowee = edgeStates(t, db, a.ID, b.ID)
	assert.Equal(t, models.FollowStateRemoved, byFollower)
	assert.Equal(t, models.FollowStateRemoved, byFollowee)
	accA2, accB2 := acceptedAt(t, db, a.ID, b.ID)
	require.NotNil(t, accA2, "accepted_at is kept when the edge leaves ACTIVE")
	assert.True(t, accA.Equal(*accA2))
	require.NotNil(t, accB2)

	var counterRows int64
	require.NoError(t, db.Model(&models.FollowCounter{}).Count(&counterRows).Error)
	assert.Zero(t, counterRows, "counters are not touched")

	for _, table := range []string{"follow_edges_by_follower", "follow_edges_by_followee"} {
		t.Run("rolls back when "+table+" fails", func(t *testing.T) {
			faulty := NewFollowRepository(faultyDB(t, on("update", table)))
			assert.ErrorIs(t, faulty.UpdateEdgeState(a.ID, b.ID, models.FollowStateActive), errInjected)
			byFollower, byFollowee := edgeStates(t, db, a.ID, b.ID)
			assert.Equal(t, models.FollowStateRemoved, byFollower)
			assert.Equal(t, models.FollowStateRemoved, byFollowee)
		})
	}
}

func TestFollowRepository_GetEdge(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	me := testutil.CreateUser(t, db)
	active, pending, removed, stranger := testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	follow(t, db, me.ID, active.ID, models.FollowStateActive, t0)
	follow(t, db, me.ID, pending.ID, models.FollowStatePending, t0)
	follow(t, db, me.ID, removed.ID, models.FollowStateRemoved, t0)

	stateOf := func(edge *models.FollowEdgeByFollower) models.FollowState {
		if edge == nil {
			return ""
		}
		return edge.State
	}
	for _, tc := range []struct {
		target                    *models.User
		edge, activeEdge, pending models.FollowState
	}{
		{active, models.FollowStateActive, models.FollowStateActive, ""},
		{pending, models.FollowStatePending, "", models.FollowStatePending},
		{removed, models.FollowStateRemoved, "", ""},
		{stranger, "", "", ""},
	} {
		edge, err := repo.GetEdge(me.ID, tc.target.ID)
		require.NoError(t, err)
		assert.Equal(t, tc.edge, stateOf(edge), "GetEdge(%d)", tc.target.ID)

		activeEdge, err := repo.GetActiveEdge(me.ID, tc.target.ID)
		require.NoError(t, err)
		assert.Equal(t, tc.activeEdge, stateOf(activeEdge), "GetActiveEdge(%d)", tc.target.ID)

		pendingEdge, err := repo.GetPendingEdge(me.ID, tc.target.ID)
		require.NoError(t, err)
		assert.Equal(t, tc.pending, stateOf(pendingEdge), "GetPendingEdge(%d)", tc.target.ID)
	}

	edge, err := repo.GetEdge(me.ID, active.ID)
	require.NoError(t, err)
	require.NotNil(t, edge)
	assert.Equal(t, me.ID, edge.FollowerID)
	assert.Equal(t, active.ID, edge.FolloweeID)
	assert.True(t, edge.CreatedAt.Equal(t0))
}

// ==================== Paginated lists ====================

// pageFetcher adapts one list method: it returns the user IDs of a page and the cursor that
// continues after its last row.
type pageFetcher func(repo *FollowRepository, ownerID uint, limit int, cursor *FollowListCursor) ([]uint, *FollowListCursor, error)

func followerPage(fetch func(*FollowRepository, uint, int, *FollowListCursor) ([]models.FollowEdgeByFollowee, error)) pageFetcher {
	return func(repo *FollowRepository, ownerID uint, limit int, cursor *FollowListCursor) ([]uint, *FollowListCursor, error) {
		edges, err := fetch(repo, ownerID, limit, cursor)
		ids := make([]uint, len(edges))
		var next *FollowListCursor
		for i, e := range edges {
			ids[i] = e.FollowerID
			next = &FollowListCursor{CreatedAt: e.CreatedAt, UserID: e.FollowerID}
		}
		return ids, next, err
	}
}

func followeePage(fetch func(*FollowRepository, uint, int, *FollowListCursor) ([]models.FollowEdgeByFollower, error)) pageFetcher {
	return func(repo *FollowRepository, ownerID uint, limit int, cursor *FollowListCursor) ([]uint, *FollowListCursor, error) {
		edges, err := fetch(repo, ownerID, limit, cursor)
		ids := make([]uint, len(edges))
		var next *FollowListCursor
		for i, e := range edges {
			ids[i] = e.FolloweeID
			next = &FollowListCursor{CreatedAt: e.CreatedAt, UserID: e.FolloweeID}
		}
		return ids, next, err
	}
}

func TestFollowRepository_PaginatedLists(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)

	cases := []struct {
		name     string
		state    models.FollowState
		incoming bool // edges point at the list owner (followers, incoming requests)
		fetch    pageFetcher
	}{
		{"followers", models.FollowStateActive, true, followerPage((*FollowRepository).GetFollowersPaginated)},
		{"following", models.FollowStateActive, false, followeePage((*FollowRepository).GetFollowingPaginated)},
		{"incoming requests", models.FollowStatePending, true, followerPage((*FollowRepository).GetPendingIncomingRequests)},
		{"outgoing requests", models.FollowStatePending, false, followeePage((*FollowRepository).GetPendingOutgoingRequests)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			owner := testutil.CreateUser(t, db)
			edge := func(other *models.User, state models.FollowState, at time.Time) {
				if tc.incoming {
					follow(t, db, other.ID, owner.ID, state, at)
				} else {
					follow(t, db, owner.ID, other.ID, state, at)
				}
			}
			u := []*models.User{testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db)}
			edge(u[0], tc.state, t0.Add(1*time.Minute))
			edge(u[1], tc.state, t0.Add(2*time.Minute))
			edge(u[2], tc.state, t0.Add(3*time.Minute))
			edge(u[3], tc.state, t0.Add(3*time.Minute)) // same instant as u[2]: ties are ordered by user ID
			for _, s := range []models.FollowState{models.FollowStateActive, models.FollowStatePending, models.FollowStateRemoved} {
				if s != tc.state {
					edge(testutil.CreateUser(t, db), s, t0.Add(10*time.Minute))
				}
			}
			reverse := testutil.CreateUser(t, db)
			if tc.incoming {
				follow(t, db, owner.ID, reverse.ID, tc.state, t0.Add(10*time.Minute))
			} else {
				follow(t, db, reverse.ID, owner.ID, tc.state, t0.Add(10*time.Minute))
			}

			var pages [][]uint
			var cursor *FollowListCursor
			for len(pages) < 5 {
				ids, next, err := tc.fetch(repo, owner.ID, 2, cursor)
				require.NoError(t, err)
				pages = append(pages, ids)
				if len(ids) == 0 {
					break
				}
				cursor = next
			}

			assert.Equal(t, [][]uint{{u[3].ID, u[2].ID}, {u[1].ID, u[0].ID}, {}}, pages,
				"newest first, without gaps or duplicates across pages")
		})
	}
}

func TestFollowRepository_GetAllFollowerIDs(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	target := testutil.CreateUser(t, db)
	a, b, pending, removed := testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	follow(t, db, a.ID, target.ID, models.FollowStateActive, t0)
	follow(t, db, b.ID, target.ID, models.FollowStateActive, t0)
	follow(t, db, pending.ID, target.ID, models.FollowStatePending, t0)
	follow(t, db, removed.ID, target.ID, models.FollowStateRemoved, t0)
	follow(t, db, target.ID, pending.ID, models.FollowStateActive, t0)

	ids, err := repo.GetAllFollowerIDs(target.ID)
	require.NoError(t, err)
	assert.ElementsMatch(t, userIDs(a, b), ids)

	ids, err = repo.GetAllFollowerIDs(a.ID)
	require.NoError(t, err)
	assert.Empty(t, ids)
}

// ==================== Relationships ====================

func TestFollowRepository_BatchLookupRelationships(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	viewer := testutil.CreateUser(t, db)
	following, requested, incoming := testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	followingAndIncoming, bothRequested := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	removed, follower, stranger := testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	follow(t, db, viewer.ID, following.ID, models.FollowStateActive, t0)
	follow(t, db, viewer.ID, requested.ID, models.FollowStatePending, t0)
	follow(t, db, incoming.ID, viewer.ID, models.FollowStatePending, t0)
	follow(t, db, viewer.ID, followingAndIncoming.ID, models.FollowStateActive, t0)
	follow(t, db, followingAndIncoming.ID, viewer.ID, models.FollowStatePending, t0)
	follow(t, db, viewer.ID, bothRequested.ID, models.FollowStatePending, t0)
	follow(t, db, bothRequested.ID, viewer.ID, models.FollowStatePending, t0)
	follow(t, db, viewer.ID, removed.ID, models.FollowStateRemoved, t0)
	follow(t, db, follower.ID, viewer.ID, models.FollowStateActive, t0)
	follow(t, db, stranger.ID, following.ID, models.FollowStateActive, t0)

	got, err := repo.BatchLookupRelationships(viewer.ID, userIDs(following, requested, incoming, followingAndIncoming, bothRequested, removed, follower, stranger))

	require.NoError(t, err)
	assert.Equal(t, map[uint]models.RelationshipState{
		following.ID:            models.RelationshipFollowing,
		requested.ID:            models.RelationshipRequested,
		incoming.ID:             models.RelationshipIncomingPending,
		followingAndIncoming.ID: models.RelationshipFollowing, // outgoing state wins
		bothRequested.ID:        models.RelationshipRequested,
		removed.ID:              models.RelationshipNone,
		follower.ID:             models.RelationshipNone, // only the viewer's side is reported
		stranger.ID:             models.RelationshipNone,
	}, got)
}

func TestFollowRepository_BatchLookupRelationships_EmptyTargets(t *testing.T) {
	got, err := NewFollowRepository(testutil.BrokenDB(t)).BatchLookupRelationships(1, nil)

	assert.NoError(t, err, "no query is needed")
	assert.NotNil(t, got)
	assert.Empty(t, got)
}

func TestFollowRepository_BatchLookupRelationships_IncomingQueryFails(t *testing.T) {
	db := testutil.DB(t)
	viewer, target := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	repo := NewFollowRepository(faultyDB(t, nth(2, on("query", "follow_edges_by_follower"))))

	got, err := repo.BatchLookupRelationships(viewer.ID, userIDs(target))

	assert.ErrorIs(t, err, errInjected)
	assert.Nil(t, got)
}

func TestFollowRepository_GetMutualFollowerIDs(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	viewer, target := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	a, b := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	pendingToTarget, notFollowingTarget := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	notFollowedByViewer, requestedByViewer := testutil.CreateUser(t, db), testutil.CreateUser(t, db)

	follow(t, db, viewer.ID, a.ID, models.FollowStateActive, t0.Add(1*time.Minute))
	follow(t, db, a.ID, target.ID, models.FollowStateActive, t0)
	follow(t, db, viewer.ID, b.ID, models.FollowStateActive, t0.Add(2*time.Minute))
	follow(t, db, b.ID, target.ID, models.FollowStateActive, t0)
	follow(t, db, viewer.ID, pendingToTarget.ID, models.FollowStateActive, t0.Add(3*time.Minute))
	follow(t, db, pendingToTarget.ID, target.ID, models.FollowStatePending, t0)
	follow(t, db, viewer.ID, notFollowingTarget.ID, models.FollowStateActive, t0.Add(4*time.Minute))
	follow(t, db, notFollowedByViewer.ID, target.ID, models.FollowStateActive, t0)
	follow(t, db, viewer.ID, requestedByViewer.ID, models.FollowStatePending, t0.Add(5*time.Minute))
	follow(t, db, requestedByViewer.ID, target.ID, models.FollowStateActive, t0)

	ids, err := repo.GetMutualFollowerIDs(viewer.ID, target.ID, 10, nil)
	require.NoError(t, err)
	assert.Equal(t, userIDs(b, a), ids, "ordered by when the viewer followed them, newest first")

	ids, err = repo.GetMutualFollowerIDs(viewer.ID, target.ID, 1, nil)
	require.NoError(t, err)
	assert.Equal(t, userIDs(b), ids)

	ids, err = repo.GetMutualFollowerIDs(viewer.ID, target.ID, 10, &FollowListCursor{CreatedAt: t0.Add(2 * time.Minute), UserID: b.ID})
	require.NoError(t, err)
	assert.Equal(t, userIDs(a), ids)
}

func TestFollowRepository_GetMutualFollowersWithTimestamps(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	viewer, target := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	a, b, c := testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	for _, m := range []struct {
		user *models.User
		at   time.Time
	}{{a, t0.Add(time.Minute)}, {b, t0.Add(2 * time.Minute)}, {c, t0.Add(2 * time.Minute)}} {
		follow(t, db, viewer.ID, m.user.ID, models.FollowStateActive, m.at)
		follow(t, db, m.user.ID, target.ID, models.FollowStateActive, t0)
	}
	follow(t, db, viewer.ID, testutil.CreateUser(t, db).ID, models.FollowStateActive, t0.Add(time.Hour))

	rows, err := repo.GetMutualFollowersWithTimestamps(viewer.ID, target.ID, 10, nil)
	require.NoError(t, err)
	require.Len(t, rows, 3)
	assert.Equal(t, userIDs(c, b, a), []uint{rows[0].UserID, rows[1].UserID, rows[2].UserID},
		"newest first; equal timestamps are ordered by user ID")
	assert.True(t, rows[0].CreatedAt.Equal(t0.Add(2*time.Minute)))
	assert.True(t, rows[2].CreatedAt.Equal(t0.Add(time.Minute)))

	rows, err = repo.GetMutualFollowersWithTimestamps(viewer.ID, target.ID, 1, &FollowListCursor{CreatedAt: t0.Add(2 * time.Minute), UserID: c.ID})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, b.ID, rows[0].UserID, "the cursor resumes inside a group of equal timestamps")
}

// ==================== Counters ====================

func TestFollowRepository_GetOrCreateCounter(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	existing, fresh := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	setCounters(t, db, existing.ID, counts{Followers: 4, Following: 5, Pending: 6})

	counter, err := repo.GetOrCreateCounter(existing.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(4), counter.FollowersCount)
	assert.Equal(t, int64(5), counter.FollowingCount)
	assert.Equal(t, int64(6), counter.PendingRequestsCount)

	counter, err = repo.GetOrCreateCounter(fresh.ID)
	require.NoError(t, err)
	assert.Equal(t, fresh.ID, counter.UserID)
	assert.Equal(t, counts{}, countsOf(t, db, fresh.ID), "a zeroed row is created")

	t.Run("create fails", func(t *testing.T) {
		faulty := NewFollowRepository(faultyDB(t, on("create", "follow_counters")))
		counter, err := faulty.GetOrCreateCounter(testutil.CreateUser(t, db).ID)
		assert.ErrorIs(t, err, errInjected)
		assert.Nil(t, counter)
	})
}

func TestFollowRepository_IncrementCounters(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	user := testutil.CreateUser(t, db)

	require.NoError(t, repo.IncrementFollowersCount(user.ID, 2))
	assert.Equal(t, counts{Followers: 2}, countsOf(t, db, user.ID), "a missing row starts at the delta")
	require.NoError(t, repo.IncrementFollowingCount(user.ID, 3))
	require.NoError(t, repo.IncrementPendingRequestsCount(user.ID, 1))
	assert.Equal(t, counts{Followers: 2, Following: 3, Pending: 1}, countsOf(t, db, user.ID))

	require.NoError(t, repo.IncrementFollowersCount(user.ID, -1))
	require.NoError(t, repo.IncrementFollowingCount(user.ID, -3))
	require.NoError(t, repo.IncrementPendingRequestsCount(user.ID, -1))
	assert.Equal(t, counts{Followers: 1}, countsOf(t, db, user.ID))

	following, pending := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	require.NoError(t, repo.IncrementFollowingCount(following.ID, 5))
	require.NoError(t, repo.IncrementPendingRequestsCount(pending.ID, 4))
	assert.Equal(t, counts{Following: 5}, countsOf(t, db, following.ID))
	assert.Equal(t, counts{Pending: 4}, countsOf(t, db, pending.ID))
}

func TestFollowRepository_GetFollowCountsAndPending(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	user, noRow := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	setCounters(t, db, user.ID, counts{Followers: 7, Following: 8, Pending: 9})

	followers, following, err := repo.GetFollowCounts(user.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(7), followers)
	assert.Equal(t, int64(8), following)
	pending, err := repo.GetPendingRequestsCount(user.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(9), pending)

	followers, following, err = repo.GetFollowCounts(noRow.ID)
	require.NoError(t, err, "a missing row means zero")
	assert.Zero(t, followers)
	assert.Zero(t, following)
	pending, err = repo.GetPendingRequestsCount(noRow.ID)
	require.NoError(t, err)
	assert.Zero(t, pending)
}

// ==================== Cleanup and counts ====================

func ageEdge(t *testing.T, db *gorm.DB, followerID, followeeID uint, updatedAt time.Time) {
	t.Helper()
	for _, table := range []string{"follow_edges_by_follower", "follow_edges_by_followee"} {
		require.NoError(t, db.Exec("UPDATE "+table+" SET updated_at = ? WHERE follower_id = ? AND followee_id = ?",
			updatedAt, followerID, followeeID).Error)
	}
}

func TestFollowRepository_CleanupOldTombstones(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	owner := testutil.CreateUser(t, db)
	oldRemovedA, oldRemovedB := testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	oldActive, oldPending, recentRemoved := testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	follow(t, db, oldRemovedA.ID, owner.ID, models.FollowStateRemoved, t0)
	follow(t, db, owner.ID, oldRemovedB.ID, models.FollowStateRemoved, t0)
	follow(t, db, oldActive.ID, owner.ID, models.FollowStateActive, t0)
	follow(t, db, oldPending.ID, owner.ID, models.FollowStatePending, t0)
	follow(t, db, recentRemoved.ID, owner.ID, models.FollowStateRemoved, t0)
	old := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)
	ageEdge(t, db, oldRemovedA.ID, owner.ID, old)
	ageEdge(t, db, owner.ID, oldRemovedB.ID, old)
	ageEdge(t, db, oldActive.ID, owner.ID, old)
	ageEdge(t, db, oldPending.ID, owner.ID, old)
	cutoff := time.Date(2026, time.February, 1, 0, 0, 0, 0, time.UTC)
	ageEdge(t, db, recentRemoved.ID, owner.ID, cutoff.Add(time.Hour))

	deleted, err := repo.CleanupOldTombstones(cutoff)

	require.NoError(t, err)
	assert.Equal(t, int64(4), deleted, "two tombstones, each stored in both tables")
	for _, edge := range []struct {
		follower, followee *models.User
		want               models.FollowState
	}{
		{oldRemovedA, owner, ""},
		{owner, oldRemovedB, ""},
		{oldActive, owner, models.FollowStateActive},
		{oldPending, owner, models.FollowStatePending},
		{recentRemoved, owner, models.FollowStateRemoved},
	} {
		byFollower, byFollowee := edgeStates(t, db, edge.follower.ID, edge.followee.ID)
		assert.Equal(t, edge.want, byFollower)
		assert.Equal(t, edge.want, byFollowee)
	}

	deleted, err = repo.CleanupOldTombstones(cutoff)
	require.NoError(t, err)
	assert.Zero(t, deleted, "idempotent")
}

func TestFollowRepository_CleanupOldTombstones_SecondTableFails(t *testing.T) {
	db := testutil.DB(t)
	owner := testutil.CreateUser(t, db)
	for i := 0; i < 2; i++ {
		other := testutil.CreateUser(t, db)
		follow(t, db, other.ID, owner.ID, models.FollowStateRemoved, t0)
		ageEdge(t, db, other.ID, owner.ID, t0)
	}
	repo := NewFollowRepository(faultyDB(t, on("delete", "follow_edges_by_followee")))

	deleted, err := repo.CleanupOldTombstones(t0.Add(time.Hour))

	assert.ErrorIs(t, err, errInjected)
	assert.Equal(t, int64(2), deleted, "rows already removed from the first table are reported")
}

func TestFollowRepository_Counts(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	user := testutil.CreateUser(t, db)
	today := time.Now().Truncate(24 * time.Hour)
	edges := []struct {
		state models.FollowState
		at    time.Time
	}{
		{models.FollowStateActive, today},
		{models.FollowStatePending, today.Add(12 * time.Hour)},
		{models.FollowStateRemoved, today.Add(time.Hour)},
		{models.FollowStateActive, today.Add(-time.Second)},
		{models.FollowStateActive, today.Add(24 * time.Hour)},
	}
	for _, e := range edges {
		follow(t, db, user.ID, testutil.CreateUser(t, db).ID, e.state, e.at)
	}
	follow(t, db, testutil.CreateUser(t, db).ID, user.ID, models.FollowStatePending, today)
	follow(t, db, testutil.CreateUser(t, db).ID, user.ID, models.FollowStatePending, today)
	follow(t, db, testutil.CreateUser(t, db).ID, user.ID, models.FollowStateActive, today)

	following, err := repo.CountFollowing(user.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(3), following, "active outgoing edges")

	daily, err := repo.CountDailyFollows(user.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(3), daily, "follow actions created today (UTC), whatever their state")

	pending, err := repo.CountPendingRequestsFor(user.ID)
	require.NoError(t, err)
	assert.Equal(t, int64(2), pending)
}

// ==================== Reconciliation ====================

func TestFollowRepository_ReconcileCounters(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	user := testutil.CreateUser(t, db)
	a, b, c, d := testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	follow(t, db, a.ID, user.ID, models.FollowStateActive, t0)
	follow(t, db, b.ID, user.ID, models.FollowStateActive, t0)
	follow(t, db, c.ID, user.ID, models.FollowStatePending, t0)
	follow(t, db, d.ID, user.ID, models.FollowStateRemoved, t0)
	follow(t, db, user.ID, a.ID, models.FollowStateActive, t0)
	follow(t, db, user.ID, c.ID, models.FollowStateRemoved, t0)
	setCounters(t, db, user.ID, counts{Followers: 99, Following: 99, Pending: 99})

	require.NoError(t, repo.ReconcileCounters(user.ID))
	assert.Equal(t, counts{Followers: 2, Following: 1, Pending: 1}, countsOf(t, db, user.ID), "drift is corrected")

	require.NoError(t, repo.ReconcileCounters(a.ID))
	assert.Equal(t, counts{Followers: 1, Following: 1}, countsOf(t, db, a.ID), "a missing row is created")
}

func TestFollowRepository_ReconcileCounters_Failures(t *testing.T) {
	db := testutil.DB(t)
	user := testutil.CreateUser(t, db)
	follow(t, db, testutil.CreateUser(t, db).ID, user.ID, models.FollowStateActive, t0)
	drifted := counts{Followers: 9, Following: 9, Pending: 9}
	setCounters(t, db, user.ID, drifted)

	cases := []struct {
		name  string
		match stmtMatcher
	}{
		{"followers count fails", nth(1, on("query", "follow_edges_by_followee"))},
		{"following count fails", on("query", "follow_edges_by_follower")},
		{"pending count fails", nth(2, on("query", "follow_edges_by_followee"))},
		{"upsert fails", sqlContains("INSERT INTO follow_counters")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := NewFollowRepository(faultyDB(t, tc.match))
			assert.ErrorIs(t, repo.ReconcileCounters(user.ID), errInjected)
			assert.Equal(t, drifted, countsOf(t, db, user.ID))
		})
	}
}

func TestFollowRepository_ReconcileAllCounters(t *testing.T) {
	db := testutil.DB(t)
	repo := NewFollowRepository(db)
	a, b, withoutRow := testutil.CreateUser(t, db), testutil.CreateUser(t, db), testutil.CreateUser(t, db)
	follow(t, db, a.ID, b.ID, models.FollowStateActive, t0)
	follow(t, db, withoutRow.ID, b.ID, models.FollowStatePending, t0)
	setCounters(t, db, a.ID, counts{Followers: 5, Following: 5, Pending: 5})
	setCounters(t, db, b.ID, counts{})

	reconciled, err := repo.ReconcileAllCounters()

	require.NoError(t, err)
	assert.Equal(t, int64(2), reconciled)
	assert.Equal(t, counts{Following: 1}, countsOf(t, db, a.ID))
	assert.Equal(t, counts{Followers: 1, Pending: 1}, countsOf(t, db, b.ID))
	var rows int64
	require.NoError(t, db.Model(&models.FollowCounter{}).Where("user_id = ?", withoutRow.ID).Count(&rows).Error)
	assert.Zero(t, rows, "only users that already have a counters row are reconciled")
}

func TestFollowRepository_ReconcileAllCounters_SkipsFailures(t *testing.T) {
	db := testutil.DB(t)
	setCounters(t, db, testutil.CreateUser(t, db).ID, counts{Followers: 1})
	setCounters(t, db, testutil.CreateUser(t, db).ID, counts{Followers: 1})
	repo := NewFollowRepository(faultyDB(t, nth(1, on("query", "follow_edges_by_followee"))))

	reconciled, err := repo.ReconcileAllCounters()

	require.NoError(t, err, "one failing user does not abort the run")
	assert.Equal(t, int64(1), reconciled)
}

func TestFollowRepository_DatabaseErrors(t *testing.T) {
	repo := NewFollowRepository(testutil.BrokenDB(t))
	cursor := &FollowListCursor{CreatedAt: t0, UserID: 1}

	calls := map[string]func() error{
		"IsFollowing":         func() error { _, err := repo.IsFollowing(1, 2); return err },
		"UpsertEdgeDualWrite": func() error { return repo.UpsertEdgeDualWrite(1, 2, models.FollowStateActive) },
		"CreateFollowWithCounters": func() error {
			return repo.CreateFollowWithCounters(1, 2, models.FollowStateActive, nil)
		},
		"RemoveFollowWithCounters": func() error {
			return repo.RemoveFollowWithCounters(1, 2, models.FollowStateActive)
		},
		"AcceptFollowWithCounters": func() error { return repo.AcceptFollowWithCounters(1, 2) },
		"UpdateEdgeState":          func() error { return repo.UpdateEdgeState(1, 2, models.FollowStateActive) },
		"GetEdge":                  func() error { _, err := repo.GetEdge(1, 2); return err },
		"GetActiveEdge":            func() error { _, err := repo.GetActiveEdge(1, 2); return err },
		"GetPendingEdge":           func() error { _, err := repo.GetPendingEdge(1, 2); return err },
		"GetFollowersPaginated":    func() error { _, err := repo.GetFollowersPaginated(1, 10, cursor); return err },
		"GetAllFollowerIDs":        func() error { _, err := repo.GetAllFollowerIDs(1); return err },
		"GetFollowingPaginated":    func() error { _, err := repo.GetFollowingPaginated(1, 10, cursor); return err },
		"GetPendingIncomingRequests": func() error {
			_, err := repo.GetPendingIncomingRequests(1, 10, cursor)
			return err
		},
		"GetPendingOutgoingRequests": func() error {
			_, err := repo.GetPendingOutgoingRequests(1, 10, cursor)
			return err
		},
		"BatchLookupRelationships": func() error {
			_, err := repo.BatchLookupRelationships(1, []uint{2})
			return err
		},
		"GetMutualFollowerIDs": func() error {
			_, err := repo.GetMutualFollowerIDs(1, 2, 10, cursor)
			return err
		},
		"GetMutualFollowersWithTimestamps": func() error {
			_, err := repo.GetMutualFollowersWithTimestamps(1, 2, 10, cursor)
			return err
		},
		"GetOrCreateCounter":            func() error { _, err := repo.GetOrCreateCounter(1); return err },
		"IncrementFollowersCount":       func() error { return repo.IncrementFollowersCount(1, 1) },
		"IncrementFollowingCount":       func() error { return repo.IncrementFollowingCount(1, 1) },
		"IncrementPendingRequestsCount": func() error { return repo.IncrementPendingRequestsCount(1, 1) },
		"GetFollowCounts":               func() error { _, _, err := repo.GetFollowCounts(1); return err },
		"GetPendingRequestsCount":       func() error { _, err := repo.GetPendingRequestsCount(1); return err },
		"CleanupOldTombstones":          func() error { _, err := repo.CleanupOldTombstones(t0); return err },
		"CountFollowing":                func() error { _, err := repo.CountFollowing(1); return err },
		"CountDailyFollows":             func() error { _, err := repo.CountDailyFollows(1); return err },
		"CountPendingRequestsFor":       func() error { _, err := repo.CountPendingRequestsFor(1); return err },
		"ReconcileCounters":             func() error { return repo.ReconcileCounters(1) },
		"ReconcileAllCounters":          func() error { _, err := repo.ReconcileAllCounters(); return err },
	}
	for name, call := range calls {
		t.Run(name, func(t *testing.T) { assert.Error(t, call()) })
	}
}
