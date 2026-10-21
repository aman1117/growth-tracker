package redis

import (
	"context"
	"encoding/hex"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/aman1117/backend/internal/constants"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// startRedis runs an in-memory Redis, installs a client for it as the package client and
// switches back to "Redis unavailable" when the test ends. (These internal tests cannot use
// testutil.StartRedis because testutil imports this package.)
func startRedis(t *testing.T) *miniredis.Miniredis {
	t.Helper()
	mr := miniredis.RunT(t)
	c := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	SetClient(c)
	t.Cleanup(func() {
		SetClient(nil)
		_ = c.Close()
	})
	return mr
}

// resetClientAfter closes whatever client the test installed (Init creates its own) and
// restores "Redis unavailable".
func resetClientAfter(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		if c := Get(); c != nil {
			_ = c.Close()
		}
		SetClient(nil)
	})
}

// closedAddr returns a local address nothing listens on.
func closedAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := l.Addr().String()
	require.NoError(t, l.Close())
	return addr
}

// failCommand is a go-redis hook that fails every call of one command (lower-case name,
// e.g. "del") while all other commands reach the server.
type failCommand string

func (f failCommand) DialHook(next goredis.DialHook) goredis.DialHook { return next }

func (f failCommand) ProcessHook(next goredis.ProcessHook) goredis.ProcessHook {
	return func(ctx context.Context, cmd goredis.Cmder) error {
		if cmd.Name() == string(f) {
			err := fmt.Errorf("injected %s failure", string(f))
			cmd.SetErr(err)
			return err
		}
		return next(ctx, cmd)
	}
}

func (f failCommand) ProcessPipelineHook(next goredis.ProcessPipelineHook) goredis.ProcessPipelineHook {
	return next
}

// ==================== Client lifecycle ====================

func TestInit(t *testing.T) {
	t.Run("empty URL", func(t *testing.T) {
		resetClientAfter(t)
		err := Init("")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "REDIS_URL is not set")
		assert.False(t, IsAvailable())
	})

	t.Run("unparsable URL", func(t *testing.T) {
		resetClientAfter(t)
		err := Init("http://localhost:6379")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to parse REDIS_URL")
		assert.False(t, IsAvailable())
	})

	t.Run("success", func(t *testing.T) {
		resetClientAfter(t)
		mr := miniredis.RunT(t)

		require.NoError(t, Init("redis://"+mr.Addr()))
		require.True(t, IsAvailable())
		require.NotNil(t, Get())

		require.NoError(t, Get().Set(context.Background(), "k", "v", 0).Err())
		got, err := mr.Get("k")
		require.NoError(t, err)
		assert.Equal(t, "v", got)
	})
}

func TestInit_FailedConnectionLeavesRedisUnavailable(t *testing.T) {
	resetClientAfter(t)

	err := Init("redis://" + closedAddr(t))

	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to connect to Redis")
	assert.False(t, IsAvailable(), "callers fall back instead of using an unreachable server")
	assert.Nil(t, Get())
}

func TestInit_FailedPingClosesTheNewClient(t *testing.T) {
	resetClientAfter(t)
	mr := miniredis.RunT(t)
	mr.RequireAuth("s3cret") // accepts the connection but rejects PING

	err := Init("redis://" + mr.Addr())

	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to connect to Redis")
	assert.False(t, IsAvailable())
	require.Eventually(t, func() bool { return mr.CurrentConnectionCount() == 0 }, 2*time.Second, 10*time.Millisecond,
		"the rejected client's connections are closed")
}

func TestInit_FailedReinitKeepsTheWorkingClient(t *testing.T) {
	startRedis(t)
	working := Get()
	rejecting := miniredis.RunT(t)
	rejecting.RequireAuth("s3cret")

	require.Error(t, Init("redis://"+rejecting.Addr()))

	assert.Same(t, working, Get(), "the client is only replaced after a successful PING")
	assert.NoError(t, Get().Ping(context.Background()).Err())
}

func TestClientAccessors(t *testing.T) {
	resetClientAfter(t)

	SetClient(nil)
	assert.Nil(t, Get())
	assert.False(t, IsAvailable())
	assert.NoError(t, Close(), "Close without a client is a no-op")

	mr := miniredis.RunT(t)
	c := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	SetClient(c)
	assert.Same(t, c, Get())
	assert.True(t, IsAvailable())

	require.NoError(t, Close())
	assert.ErrorIs(t, c.Ping(context.Background()).Err(), goredis.ErrClosed, "Close closes the installed client")
	assert.ErrorIs(t, Close(), goredis.ErrClosed, "Close reports errors from the client")
}

// ==================== Unavailable Redis ====================

func TestHelpers_WithoutClient(t *testing.T) {
	SetClient(nil)
	ctx := context.Background()

	t.Run("token, likes and cooldown helpers require a client", func(t *testing.T) {
		calls := map[string]func() error{
			"StoreResetToken": func() error { return StoreResetToken(ctx, "hash", 1) },
			"ValidateResetToken": func() error {
				id, err := ValidateResetToken(ctx, "raw")
				assert.Zero(t, id)
				return err
			},
			"ConsumeResetToken": func() error {
				id, err := ConsumeResetToken(ctx, "raw")
				assert.Zero(t, id)
				return err
			},
			"DeleteResetToken": func() error { return DeleteResetToken(ctx, "raw") },
			"GetLikesCache": func() error {
				v, err := GetLikesCache(ctx, 1, "2026-03-09")
				assert.Empty(t, v)
				return err
			},
			"SetLikesCache":        func() error { return SetLikesCache(ctx, 1, "2026-03-09", "{}") },
			"InvalidateLikesCache": func() error { return InvalidateLikesCache(ctx, 1, "2026-03-09") },
			"StoreVerifyToken":     func() error { return StoreVerifyToken(ctx, "hash", 1) },
			"ConsumeVerifyToken": func() error {
				id, err := ConsumeVerifyToken(ctx, "raw")
				assert.Zero(t, id)
				return err
			},
			"SetVerifyResendCooldown": func() error { return SetVerifyResendCooldown(ctx, 1) },
			"CheckVerifyResendCooldown": func() error {
				inCooldown, err := CheckVerifyResendCooldown(ctx, 1)
				assert.False(t, inCooldown)
				return err
			},
		}
		for name, call := range calls {
			t.Run(name, func(t *testing.T) {
				err := call()
				require.Error(t, err)
				assert.Contains(t, err.Error(), "redis client not initialized")
			})
		}
	})

	t.Run("optional caches are skipped", func(t *testing.T) {
		v, err := GetAutocompleteCache(ctx, "ali")
		assert.NoError(t, err)
		assert.Empty(t, v)
		assert.NoError(t, SetAutocompleteCache(ctx, "ali", "[]"))

		count, err := GetStoryLikeCount(ctx, 1)
		assert.NoError(t, err)
		assert.Equal(t, int64(-1), count, "-1 means cache miss")
		assert.NoError(t, SetStoryLikeCount(ctx, 1, 5))
		assert.NoError(t, IncrementStoryLikeCount(ctx, 1))
		assert.NoError(t, DecrementStoryLikeCount(ctx, 1))
		assert.NoError(t, InvalidateStoryLikeCount(ctx, 1))

		liked, found, err := GetStoryLikedByUser(ctx, 1, 2)
		assert.NoError(t, err)
		assert.False(t, liked)
		assert.False(t, found)
		assert.NoError(t, SetStoryLikedByUser(ctx, 1, 2, true))
		assert.NoError(t, InvalidateStoryLikedByUser(ctx, 1, 2))

		v, err = GetTrendingCache(ctx, "trending:1")
		assert.NoError(t, err)
		assert.Empty(t, v)
		assert.NoError(t, SetTrendingCache(ctx, "trending:1", "[]"))

		assert.NoError(t, DeleteVerifyTokensForUser(ctx, 1))
	})
}

// ==================== Password reset tokens ====================

func TestGenerateResetToken(t *testing.T) {
	raw, hash, err := GenerateResetToken()
	require.NoError(t, err)

	assert.Len(t, raw, 2*constants.ResetTokenByteLen, "hex encoding doubles the byte length")
	_, err = hex.DecodeString(raw)
	assert.NoError(t, err, "raw token is hex")
	assert.Equal(t, HashToken(raw), hash)

	other, _, err := GenerateResetToken()
	require.NoError(t, err)
	assert.NotEqual(t, raw, other, "tokens are random")
}

func TestHashToken(t *testing.T) {
	// SHA-256 test vectors.
	assert.Equal(t, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", HashToken("abc"))
	assert.Equal(t, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", HashToken(""))
	assert.Equal(t, HashToken("token"), HashToken("token"), "deterministic")
}

func TestResetToken_StoreValidateConsume(t *testing.T) {
	mr := startRedis(t)
	ctx := context.Background()
	raw, hash, err := GenerateResetToken()
	require.NoError(t, err)

	require.NoError(t, StoreResetToken(ctx, hash, 42))

	key := constants.ResetTokenPrefix + hash
	stored, err := mr.Get(key)
	require.NoError(t, err)
	assert.Equal(t, "42", stored)
	assert.Equal(t, constants.ResetTokenTTL, mr.TTL(key))
	assert.False(t, mr.Exists(constants.ResetTokenPrefix+raw), "only the hash is stored")

	userID, err := ValidateResetToken(ctx, raw)
	require.NoError(t, err)
	assert.Equal(t, uint(42), userID)
	assert.True(t, mr.Exists(key), "validation does not consume the token")

	userID, err = ConsumeResetToken(ctx, raw)
	require.NoError(t, err)
	assert.Equal(t, uint(42), userID)
	assert.False(t, mr.Exists(key), "consumption deletes the token")

	userID, err = ConsumeResetToken(ctx, raw)
	require.NoError(t, err)
	assert.Zero(t, userID, "a token is single-use")

	userID, err = ValidateResetToken(ctx, raw)
	require.NoError(t, err)
	assert.Zero(t, userID)
}

func TestResetToken_UnknownToken(t *testing.T) {
	startRedis(t)
	ctx := context.Background()

	userID, err := ValidateResetToken(ctx, "unknown")
	require.NoError(t, err)
	assert.Zero(t, userID)

	userID, err = ConsumeResetToken(ctx, "unknown")
	require.NoError(t, err)
	assert.Zero(t, userID)

	assert.NoError(t, DeleteResetToken(ctx, "unknown"))
}

func TestResetToken_ExpiresAfterTTL(t *testing.T) {
	mr := startRedis(t)
	ctx := context.Background()
	raw, hash, err := GenerateResetToken()
	require.NoError(t, err)
	require.NoError(t, StoreResetToken(ctx, hash, 7))

	mr.FastForward(constants.ResetTokenTTL - time.Second)
	userID, err := ValidateResetToken(ctx, raw)
	require.NoError(t, err)
	assert.Equal(t, uint(7), userID, "still valid just before the TTL")

	mr.FastForward(time.Second)
	userID, err = ConsumeResetToken(ctx, raw)
	require.NoError(t, err)
	assert.Zero(t, userID, "expired")
}

func TestDeleteResetToken(t *testing.T) {
	mr := startRedis(t)
	ctx := context.Background()
	raw, hash, err := GenerateResetToken()
	require.NoError(t, err)
	require.NoError(t, StoreResetToken(ctx, hash, 3))

	require.NoError(t, DeleteResetToken(ctx, raw))

	assert.False(t, mr.Exists(constants.ResetTokenPrefix+hash))
	userID, err := ValidateResetToken(ctx, raw)
	require.NoError(t, err)
	assert.Zero(t, userID)
}

func TestResetToken_CorruptStoredValue(t *testing.T) {
	mr := startRedis(t)
	ctx := context.Background()
	require.NoError(t, mr.Set(constants.ResetTokenPrefix+HashToken("raw"), "not-a-number"))

	_, err := ValidateResetToken(ctx, "raw")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to parse user ID")

	_, err = ConsumeResetToken(ctx, "raw")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to parse user ID")
}

func TestResetToken_RedisErrors(t *testing.T) {
	mr := startRedis(t)
	ctx := context.Background()
	mr.SetError("boom")

	assert.Error(t, StoreResetToken(ctx, "hash", 1))

	_, err := ValidateResetToken(ctx, "raw")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to get reset token")

	_, err = ConsumeResetToken(ctx, "raw")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to get reset token")

	assert.Error(t, DeleteResetToken(ctx, "raw"))
}

func TestConsumeResetToken_DeleteFailureKeepsToken(t *testing.T) {
	mr := startRedis(t)
	ctx := context.Background()
	raw, hash, err := GenerateResetToken()
	require.NoError(t, err)
	require.NoError(t, StoreResetToken(ctx, hash, 5))
	Get().AddHook(failCommand("del"))

	userID, err := ConsumeResetToken(ctx, raw)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to delete reset token")
	assert.Zero(t, userID, "the token is not honoured when it cannot be invalidated")
	assert.True(t, mr.Exists(constants.ResetTokenPrefix+hash))
}

// ==================== Likes cache ====================

func TestLikesCacheKey(t *testing.T) {
	assert.Equal(t, "likes:42:2026-03-09", LikesCacheKey(42, "2026-03-09"))
}

func TestLikesCache(t *testing.T) {
	mr := startRedis(t)
	ctx := context.Background()
	key := LikesCacheKey(7, "2026-03-09")

	got, err := GetLikesCache(ctx, 7, "2026-03-09")
	require.NoError(t, err, "a miss is not an error")
	assert.Empty(t, got)

	require.NoError(t, SetLikesCache(ctx, 7, "2026-03-09", `{"count":2}`))
	assert.Equal(t, constants.LikesCacheTTL, mr.TTL(key))

	got, err = GetLikesCache(ctx, 7, "2026-03-09")
	require.NoError(t, err)
	assert.Equal(t, `{"count":2}`, got)

	got, err = GetLikesCache(ctx, 7, "2026-03-10")
	require.NoError(t, err)
	assert.Empty(t, got, "entries are per day")

	require.NoError(t, InvalidateLikesCache(ctx, 7, "2026-03-09"))
	assert.False(t, mr.Exists(key))
	assert.NoError(t, InvalidateLikesCache(ctx, 7, "2026-03-09"), "invalidating a missing entry is fine")

	require.NoError(t, SetLikesCache(ctx, 7, "2026-03-09", `{"count":3}`))
	mr.FastForward(constants.LikesCacheTTL)
	got, err = GetLikesCache(ctx, 7, "2026-03-09")
	require.NoError(t, err)
	assert.Empty(t, got, "expired")
}

func TestLikesCache_RedisErrors(t *testing.T) {
	mr := startRedis(t)
	ctx := context.Background()
	mr.SetError("boom")

	_, err := GetLikesCache(ctx, 7, "2026-03-09")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "likes:7:2026-03-09")

	err = SetLikesCache(ctx, 7, "2026-03-09", "{}")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to set likes cache")

	err = InvalidateLikesCache(ctx, 7, "2026-03-09")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to invalidate likes cache")
}

// ==================== Email verification tokens ====================

func TestGenerateVerifyToken(t *testing.T) {
	raw, hash, err := GenerateVerifyToken()
	require.NoError(t, err)

	assert.Len(t, raw, 2*constants.VerifyTokenByteLen)
	_, err = hex.DecodeString(raw)
	assert.NoError(t, err)
	assert.Equal(t, HashToken(raw), hash)

	other, _, err := GenerateVerifyToken()
	require.NoError(t, err)
	assert.NotEqual(t, raw, other)
}

func TestVerifyToken_StoreAndConsumeOnce(t *testing.T) {
	mr := startRedis(t)
	ctx := context.Background()
	raw, hash, err := GenerateVerifyToken()
	require.NoError(t, err)

	require.NoError(t, StoreVerifyToken(ctx, hash, 9))

	key := constants.VerifyTokenPrefix + hash
	stored, err := mr.Get(key)
	require.NoError(t, err)
	assert.Equal(t, "9", stored)
	assert.Equal(t, constants.VerifyTokenTTL, mr.TTL(key))

	userID, err := ConsumeVerifyToken(ctx, raw)
	require.NoError(t, err)
	assert.Equal(t, uint(9), userID)
	assert.False(t, mr.Exists(key))

	userID, err = ConsumeVerifyToken(ctx, raw)
	require.NoError(t, err)
	assert.Zero(t, userID, "single-use")
}

func TestVerifyToken_ConcurrentConsumersSucceedOnce(t *testing.T) {
	startRedis(t)
	ctx := context.Background()
	raw, hash, err := GenerateVerifyToken()
	require.NoError(t, err)
	require.NoError(t, StoreVerifyToken(ctx, hash, 11))

	var (
		wg        sync.WaitGroup
		successes atomic.Int32
		failures  atomic.Int32
	)
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			userID, err := ConsumeVerifyToken(ctx, raw)
			if err != nil {
				failures.Add(1)
				return
			}
			if userID == 11 {
				successes.Add(1)
			}
		}()
	}
	wg.Wait()

	assert.Zero(t, failures.Load())
	assert.Equal(t, int32(1), successes.Load(), "GETDEL lets exactly one request consume the token")
}

func TestVerifyToken_Expires(t *testing.T) {
	mr := startRedis(t)
	ctx := context.Background()
	raw, hash, err := GenerateVerifyToken()
	require.NoError(t, err)
	require.NoError(t, StoreVerifyToken(ctx, hash, 9))

	mr.FastForward(constants.VerifyTokenTTL)

	userID, err := ConsumeVerifyToken(ctx, raw)
	require.NoError(t, err)
	assert.Zero(t, userID)
}

func TestVerifyToken_Errors(t *testing.T) {
	t.Run("corrupt value", func(t *testing.T) {
		mr := startRedis(t)
		require.NoError(t, mr.Set(constants.VerifyTokenPrefix+HashToken("raw"), "abc"))

		_, err := ConsumeVerifyToken(context.Background(), "raw")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to parse user ID")
	})

	t.Run("redis failure", func(t *testing.T) {
		mr := startRedis(t)
		mr.SetError("boom")

		assert.Error(t, StoreVerifyToken(context.Background(), "hash", 1))
		_, err := ConsumeVerifyToken(context.Background(), "raw")
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to get/delete verify token")
	})
}

func TestDeleteVerifyTokensForUser_RelyOnExpiry(t *testing.T) {
	startRedis(t)
	ctx := context.Background()
	raw, hash, err := GenerateVerifyToken()
	require.NoError(t, err)
	require.NoError(t, StoreVerifyToken(ctx, hash, 4))

	require.NoError(t, DeleteVerifyTokensForUser(ctx, 4))

	userID, err := ConsumeVerifyToken(ctx, raw)
	require.NoError(t, err)
	assert.Equal(t, uint(4), userID, "tokens are not tracked per user; they expire via TTL")
}

func TestVerifyResendCooldown(t *testing.T) {
	mr := startRedis(t)
	ctx := context.Background()

	inCooldown, err := CheckVerifyResendCooldown(ctx, 5)
	require.NoError(t, err)
	assert.False(t, inCooldown)

	require.NoError(t, SetVerifyResendCooldown(ctx, 5))
	key := constants.VerifyResendPrefix + "5"
	assert.Equal(t, constants.VerifyResendCooldown, mr.TTL(key))

	inCooldown, err = CheckVerifyResendCooldown(ctx, 5)
	require.NoError(t, err)
	assert.True(t, inCooldown)

	inCooldown, err = CheckVerifyResendCooldown(ctx, 6)
	require.NoError(t, err)
	assert.False(t, inCooldown, "cooldown is per user")

	mr.FastForward(constants.VerifyResendCooldown)
	inCooldown, err = CheckVerifyResendCooldown(ctx, 5)
	require.NoError(t, err)
	assert.False(t, inCooldown, "cooldown ends after its TTL")

	mr.SetError("boom")
	assert.Error(t, SetVerifyResendCooldown(ctx, 5))
	_, err = CheckVerifyResendCooldown(ctx, 5)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "failed to check cooldown")
}

// ==================== Autocomplete cache ====================

func TestAutocompleteCache(t *testing.T) {
	mr := startRedis(t)
	ctx := context.Background()
	assert.Equal(t, "autocomplete:users:ali", AutocompleteCacheKey("ali"))

	got, err := GetAutocompleteCache(ctx, "ali")
	require.NoError(t, err)
	assert.Empty(t, got)

	require.NoError(t, SetAutocompleteCache(ctx, "ali", `[{"id":1}]`))
	assert.Equal(t, AutocompleteCacheTTL, mr.TTL(AutocompleteCacheKey("ali")))

	got, err = GetAutocompleteCache(ctx, "ali")
	require.NoError(t, err)
	assert.Equal(t, `[{"id":1}]`, got)

	mr.FastForward(AutocompleteCacheTTL)
	got, err = GetAutocompleteCache(ctx, "ali")
	require.NoError(t, err)
	assert.Empty(t, got)

	mr.SetError("boom")
	_, err = GetAutocompleteCache(ctx, "ali")
	assert.ErrorContains(t, err, "failed to get autocomplete cache")
	assert.ErrorContains(t, SetAutocompleteCache(ctx, "ali", "[]"), "failed to set autocomplete cache")
}

// ==================== Story likes cache ====================

func TestStoryLikeCacheKeys(t *testing.T) {
	assert.Equal(t, "story_like_cnt:12", StoryLikeCountCacheKey(12))
	assert.Equal(t, "story_liked_by:12:34", StoryLikedByCacheKey(12, 34))
}

func TestStoryLikeCount(t *testing.T) {
	mr := startRedis(t)
	ctx := context.Background()
	key := StoryLikeCountCacheKey(12)

	count, err := GetStoryLikeCount(ctx, 12)
	require.NoError(t, err)
	assert.Equal(t, int64(-1), count, "miss")

	require.NoError(t, IncrementStoryLikeCount(ctx, 12))
	require.NoError(t, DecrementStoryLikeCount(ctx, 12))
	assert.False(t, mr.Exists(key), "increments and decrements never create a stale entry")

	require.NoError(t, SetStoryLikeCount(ctx, 12, 3))
	assert.Equal(t, StoryLikeCacheTTL, mr.TTL(key))
	count, err = GetStoryLikeCount(ctx, 12)
	require.NoError(t, err)
	assert.Equal(t, int64(3), count)

	require.NoError(t, IncrementStoryLikeCount(ctx, 12))
	count, err = GetStoryLikeCount(ctx, 12)
	require.NoError(t, err)
	assert.Equal(t, int64(4), count)

	require.NoError(t, DecrementStoryLikeCount(ctx, 12))
	require.NoError(t, DecrementStoryLikeCount(ctx, 12))
	count, err = GetStoryLikeCount(ctx, 12)
	require.NoError(t, err)
	assert.Equal(t, int64(2), count)

	require.NoError(t, SetStoryLikeCount(ctx, 12, 0))
	require.NoError(t, DecrementStoryLikeCount(ctx, 12))
	count, err = GetStoryLikeCount(ctx, 12)
	require.NoError(t, err)
	assert.Zero(t, count, "never below zero")

	require.NoError(t, InvalidateStoryLikeCount(ctx, 12))
	count, err = GetStoryLikeCount(ctx, 12)
	require.NoError(t, err)
	assert.Equal(t, int64(-1), count)
}

func TestStoryLikeCount_NonNumericEntry(t *testing.T) {
	mr := startRedis(t)
	require.NoError(t, mr.Set(StoryLikeCountCacheKey(12), "many"))

	count, err := GetStoryLikeCount(context.Background(), 12)

	assert.ErrorContains(t, err, "failed to get story like count cache")
	assert.Equal(t, int64(-1), count)
}

func TestStoryLikeCount_RedisErrors(t *testing.T) {
	mr := startRedis(t)
	ctx := context.Background()
	mr.SetError("boom")

	count, err := GetStoryLikeCount(ctx, 12)
	assert.Error(t, err)
	assert.Equal(t, int64(-1), count)
	assert.ErrorContains(t, SetStoryLikeCount(ctx, 12, 1), "failed to set story like count cache")
	assert.ErrorContains(t, IncrementStoryLikeCount(ctx, 12), "failed to increment story like count")
	assert.ErrorContains(t, DecrementStoryLikeCount(ctx, 12), "failed to decrement story like count")
	assert.ErrorContains(t, InvalidateStoryLikeCount(ctx, 12), "failed to invalidate story like count cache")
}

func TestStoryLikedByUser(t *testing.T) {
	mr := startRedis(t)
	ctx := context.Background()
	key := StoryLikedByCacheKey(12, 34)

	liked, found, err := GetStoryLikedByUser(ctx, 12, 34)
	require.NoError(t, err)
	assert.False(t, found, "miss")
	assert.False(t, liked)

	require.NoError(t, SetStoryLikedByUser(ctx, 12, 34, true))
	assert.Equal(t, StoryLikeCacheTTL, mr.TTL(key))
	stored, err := mr.Get(key)
	require.NoError(t, err)
	assert.Equal(t, "1", stored)
	liked, found, err = GetStoryLikedByUser(ctx, 12, 34)
	require.NoError(t, err)
	assert.True(t, found)
	assert.True(t, liked)

	require.NoError(t, SetStoryLikedByUser(ctx, 12, 34, false))
	liked, found, err = GetStoryLikedByUser(ctx, 12, 34)
	require.NoError(t, err)
	assert.True(t, found, "a cached 'not liked' is still a hit")
	assert.False(t, liked)

	require.NoError(t, InvalidateStoryLikedByUser(ctx, 12, 34))
	_, found, err = GetStoryLikedByUser(ctx, 12, 34)
	require.NoError(t, err)
	assert.False(t, found)
}

func TestStoryLikedByUser_RedisErrors(t *testing.T) {
	mr := startRedis(t)
	ctx := context.Background()
	mr.SetError("boom")

	liked, found, err := GetStoryLikedByUser(ctx, 12, 34)
	assert.ErrorContains(t, err, "failed to get story liked by user cache")
	assert.False(t, liked)
	assert.False(t, found)
	assert.ErrorContains(t, SetStoryLikedByUser(ctx, 12, 34, true), "failed to set story liked by user cache")
	assert.ErrorContains(t, InvalidateStoryLikedByUser(ctx, 12, 34), "failed to invalidate story liked by user cache")
}

// ==================== Trending cache ====================

func TestTrendingCache(t *testing.T) {
	mr := startRedis(t)
	ctx := context.Background()
	const key = "trending:users:7"

	got, err := GetTrendingCache(ctx, key)
	require.NoError(t, err)
	assert.Empty(t, got)

	require.NoError(t, SetTrendingCache(ctx, key, `[{"id":3}]`))
	assert.Equal(t, TrendingCacheTTL, mr.TTL(key))

	got, err = GetTrendingCache(ctx, key)
	require.NoError(t, err)
	assert.Equal(t, `[{"id":3}]`, got)

	mr.FastForward(TrendingCacheTTL)
	got, err = GetTrendingCache(ctx, key)
	require.NoError(t, err)
	assert.Empty(t, got)

	mr.SetError("boom")
	_, err = GetTrendingCache(ctx, key)
	assert.ErrorContains(t, err, "failed to get trending cache")
	assert.ErrorContains(t, SetTrendingCache(ctx, key, "[]"), "failed to set trending cache")
}
