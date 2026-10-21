package repository

import (
	"os"
	"testing"

	"github.com/aman1117/backend/internal/testutil"
)

func TestMain(m *testing.M) { os.Exit(testutil.RunWithDatabase(m)) }
