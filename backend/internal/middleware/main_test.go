package middleware_test

import (
	"os"
	"testing"

	"github.com/aman1117/backend/internal/testutil"
)

func TestMain(m *testing.M) {
	testutil.Setup()
	os.Exit(m.Run())
}
