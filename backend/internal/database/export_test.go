package database

import "sync"

// ResetForTest forgets the connection (or error) from Init so that a test can call Init again.
// It lives in a _test.go file and is only compiled into this package's tests.
func ResetForTest() {
	db = nil
	initErr = nil
	once = sync.Once{}
}
