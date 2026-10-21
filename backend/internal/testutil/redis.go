package testutil

import (
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/aman1117/backend/pkg/redis"
	goredis "github.com/redis/go-redis/v9"
)

// StartRedis starts an in-memory Redis (miniredis), installs a client for it as the
// pkg/redis client and switches back to "Redis unavailable" when the test ends. Use the
// returned server to inspect keys, fast-forward TTLs (FastForward) or simulate failures
// (SetError).
func StartRedis(t testing.TB) *miniredis.Miniredis {
	t.Helper()
	server := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: server.Addr()})
	redis.SetClient(client)
	t.Cleanup(func() {
		redis.SetClient(nil)
		_ = client.Close()
	})
	return server
}
