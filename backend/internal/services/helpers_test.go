package services

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
	"unsafe"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
	"github.com/alicebob/miniredis/v2"
	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/pkg/models"
	"github.com/aman1117/backend/pkg/redis"
	goredis "github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	gormlogger "gorm.io/gorm/logger"
)

// ==================== Asynchronous work ====================

// serviceGoroutineMarkers identify goroutines running service code in the background: every
// goroutine started by a method of a service type (such as the fire-and-forget notification
// senders, go s.sendCommentNotifications(...)) and the photo-notification debounce timer
// callback. Test helper types never start goroutines from their methods, so the first marker
// only matches production code.
var serviceGoroutineMarkers = [][]byte{
	[]byte("created by github.com/aman1117/backend/internal/services.(*"),
	[]byte("services.(*ActivityPhotoService).scheduleNotification.func"),
}

// waitForAsync waits until no service code runs in the background any more. Tests call it before
// asserting the effects of asynchronous work, and cleanups call it so that no such goroutine
// touches the database or Redis after its test has ended.
func waitForAsync(t testing.TB) {
	t.Helper()
	require.Eventually(t, func() bool { return !serviceGoroutinesRunning() },
		10*time.Second, 2*time.Millisecond, "service goroutines are still running")
}

func serviceGoroutinesRunning() bool {
	stacks := goroutineStacks()
	for _, marker := range serviceGoroutineMarkers {
		if bytes.Contains(stacks, marker) {
			return true
		}
	}
	return false
}

// goroutineStacks returns the stack traces of all goroutines.
func goroutineStacks() []byte {
	buf := make([]byte, 256<<10)
	for {
		n := runtime.Stack(buf, true)
		if n < len(buf) {
			return buf[:n]
		}
		buf = make([]byte, 2*len(buf))
	}
}

// testDB returns the package database (emptied when the test ends) and makes sure asynchronous
// service work has finished before that happens.
func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	db := testutil.DB(t)
	t.Cleanup(func() { waitForAsync(t) })
	return db
}

// startRedis installs an in-memory Redis for the test and makes sure asynchronous service work
// has finished before the client is removed again.
func startRedis(t *testing.T) *miniredis.Miniredis {
	t.Helper()
	mr := testutil.StartRedis(t)
	t.Cleanup(func() { waitForAsync(t) })
	return mr
}

// ==================== Fault injection ====================

var errInjected = errors.New("injected failure")

// stmtInfo describes a statement about to run on a faultyDB.
type stmtInfo struct {
	Op    string // create, query, update, delete, row (Raw/Scan/Rows) or raw (Exec)
	Table string // model or Table() name; empty for raw SQL
	SQL   string // the raw SQL, or the WHERE conditions of a model statement
	Dest  any
}

func (s stmtInfo) is(op, table string) bool {
	return (op == "" || s.Op == op) && (table == "" || s.Table == table)
}

func (s stmtInfo) has(fragment string) bool { return strings.Contains(s.SQL, fragment) }

// faultyDB opens a separate connection pool to the package database whose statements fail with
// errInjected whenever fail returns true, so a test can break one specific query while all the
// others succeed. fail may also run side effects (for example to simulate a concurrent writer)
// and return false.
func faultyDB(t *testing.T, fail func(s stmtInfo) bool) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(postgres.Open(testutil.DSN(t)), &gorm.Config{
		Logger: gormlogger.Default.LogMode(gormlogger.Silent),
	})
	require.NoError(t, err)
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	hook := func(op string) func(*gorm.DB) {
		return func(tx *gorm.DB) {
			if fail(describeStmt(op, tx)) {
				_ = tx.AddError(errInjected)
			}
		}
	}
	cb := db.Callback()
	require.NoError(t, cb.Create().Before("gorm:create").Register("test:fault_create", hook("create")))
	require.NoError(t, cb.Query().Before("gorm:query").Register("test:fault_query", hook("query")))
	require.NoError(t, cb.Update().Before("gorm:update").Register("test:fault_update", hook("update")))
	require.NoError(t, cb.Delete().Before("gorm:delete").Register("test:fault_delete", hook("delete")))
	require.NoError(t, cb.Row().Before("gorm:row").Register("test:fault_row", hook("row")))
	require.NoError(t, cb.Raw().Before("gorm:raw").Register("test:fault_raw", hook("raw")))
	return db
}

func describeStmt(op string, tx *gorm.DB) stmtInfo {
	s := stmtInfo{Op: op, Table: tx.Statement.Table, SQL: tx.Statement.SQL.String(), Dest: tx.Statement.Dest}
	if c, ok := tx.Statement.Clauses["WHERE"]; ok {
		if where, ok := c.Expression.(clause.Where); ok {
			for _, e := range where.Exprs {
				if expr, ok := e.(clause.Expr); ok {
					s.SQL += " " + expr.SQL
				}
			}
		}
	}
	return s
}

// failingOn returns a faultyDB predicate matching statements with the given operation and table
// (empty matches any) whose SQL contains every fragment.
func failingOn(op, table string, fragments ...string) func(stmtInfo) bool {
	return func(s stmtInfo) bool {
		if !s.is(op, table) {
			return false
		}
		for _, f := range fragments {
			if !s.has(f) {
				return false
			}
		}
		return true
	}
}

// redisHook fails every command (also inside pipelines) for which fail returns an error.
type redisHook struct{ fail func(cmd goredis.Cmder) error }

func (h redisHook) DialHook(next goredis.DialHook) goredis.DialHook { return next }

func (h redisHook) ProcessHook(next goredis.ProcessHook) goredis.ProcessHook {
	return func(ctx context.Context, cmd goredis.Cmder) error {
		if err := h.fail(cmd); err != nil {
			cmd.SetErr(err)
			return err
		}
		return next(ctx, cmd)
	}
}

func (h redisHook) ProcessPipelineHook(next goredis.ProcessPipelineHook) goredis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []goredis.Cmder) error {
		for _, cmd := range cmds {
			if err := h.fail(cmd); err != nil {
				for _, c := range cmds {
					c.SetErr(err)
				}
				return err
			}
		}
		return next(ctx, cmds)
	}
}

// failRedisCommands points pkg/redis at mr, until the test ends, through a client whose named
// commands (lower case, such as "publish") fail with err while every other command reaches
// miniredis.
func failRedisCommands(t *testing.T, mr *miniredis.Miniredis, err error, names ...string) {
	t.Helper()
	client := goredis.NewClient(&goredis.Options{Addr: mr.Addr()})
	client.AddHook(redisHook{fail: func(cmd goredis.Cmder) error {
		for _, name := range names {
			if cmd.Name() == name {
				return err
			}
		}
		return nil
	}})
	previous := redis.Get()
	redis.SetClient(client)
	t.Cleanup(func() {
		redis.SetClient(previous)
		_ = client.Close()
	})
	t.Cleanup(func() { waitForAsync(t) })
}

// ==================== Fixtures ====================

// newUser creates a user the way registration does, including its zeroed follow_counters row.
func newUser(t *testing.T, db *gorm.DB, opts ...func(*models.User)) *models.User {
	t.Helper()
	user := testutil.CreateUser(t, db, opts...)
	require.NoError(t, db.Create(&models.FollowCounter{UserID: user.ID}).Error)
	return user
}

// makeFollow creates a follow edge (and its counters) from follower to followee.
func makeFollow(t *testing.T, db *gorm.DB, followerID, followeeID uint, state models.FollowState) {
	t.Helper()
	require.NoError(t, repository.NewFollowRepository(db).CreateFollowWithCounters(followerID, followeeID, state, nil))
}

// notificationsOf returns the stored notifications of a user, oldest first.
func notificationsOf(t *testing.T, db *gorm.DB, userID uint) []models.Notification {
	t.Helper()
	var notifs []models.Notification
	require.NoError(t, db.Where("user_id = ?", userID).Order("id").Find(&notifs).Error)
	return notifs
}

// countRows counts the rows of a model's table.
func countRows(t *testing.T, db *gorm.DB, model any) int64 {
	t.Helper()
	var n int64
	require.NoError(t, db.Model(model).Count(&n).Error)
	return n
}

func newNotificationService(db *gorm.DB) *NotificationService {
	return NewNotificationService(repository.NewNotificationRepository(db))
}

// todayIST returns today's date in India, the calendar used by the app, as a DATE value.
func todayIST() time.Time {
	now := time.Now().In(istLocation)
	return testutil.Day(now.Year(), now.Month(), now.Day())
}

// todayUTC returns today's UTC date at midnight.
func todayUTC() time.Time {
	now := time.Now().UTC()
	return testutil.Day(now.Year(), now.Month(), now.Day())
}

// ==================== Push publisher fakes ====================

// fakeSender stands in for the Service Bus sender and records what PushPublisher sends.
type fakeSender struct {
	mu            sync.Mutex
	batchCapacity uint64 // byte capacity of new batches; 0 rejects every message
	newBatchErr   error  // returned by NewMessageBatch once newBatchOK calls have succeeded
	newBatchOK    int
	sendBatchErr  error
	sendErr       error
	closeErr      error
	newBatchCalls int
	sentBatches   []int32 // number of messages in each batch sent
	sentSingle    []*azservicebus.Message
	closed        bool
}

func (f *fakeSender) NewMessageBatch(context.Context, *azservicebus.MessageBatchOptions) (*azservicebus.MessageBatch, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.newBatchCalls++
	if f.newBatchErr != nil && f.newBatchCalls > f.newBatchOK {
		return nil, f.newBatchErr
	}
	return newTestBatch(f.batchCapacity), nil
}

func (f *fakeSender) setNewBatchErr(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.newBatchErr = err
}

func (f *fakeSender) SendMessageBatch(_ context.Context, batch *azservicebus.MessageBatch, _ *azservicebus.SendMessageBatchOptions) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sentBatches = append(f.sentBatches, batch.NumMessages())
	return f.sendBatchErr
}

func (f *fakeSender) SendMessage(_ context.Context, msg *azservicebus.Message, _ *azservicebus.SendMessageOptions) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sentSingle = append(f.sentSingle, msg)
	return f.sendErr
}

func (f *fakeSender) Close(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
	return f.closeErr
}

func (f *fakeSender) snapshot() (batches []int32, single int, newBatchCalls int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]int32(nil), f.sentBatches...), len(f.sentSingle), f.newBatchCalls
}

// newTestBatch returns an empty Service Bus batch accepting up to maxBytes. The SDK only creates
// batches through a live AMQP link, so the unexported capacity field is set directly; tests
// that need capacity call requireBatchCapacity first.
func newTestBatch(maxBytes uint64) *azservicebus.MessageBatch {
	batch := &azservicebus.MessageBatch{}
	if maxBytes > 0 {
		field := reflect.ValueOf(batch).Elem().FieldByName("maxBytes")
		reflect.NewAt(field.Type(), unsafe.Pointer(field.UnsafeAddr())).Elem().SetUint(maxBytes)
	}
	return batch
}

// requireBatchCapacity fails the test if the SDK's batch no longer has the field newTestBatch
// sets, so an SDK upgrade cannot silently stop these tests from running.
func requireBatchCapacity(t *testing.T) {
	t.Helper()
	field, ok := reflect.TypeOf(azservicebus.MessageBatch{}).FieldByName("maxBytes")
	if !ok || field.Type.Kind() != reflect.Uint64 {
		t.Fatal("azservicebus.MessageBatch has no uint64 maxBytes field any more; update newTestBatch for the new SDK")
	}
}

// installPushPublisher makes GetPushPublisher return an available publisher whose messages stay
// in its queue (no worker runs), so tests can inspect what would be pushed.
func installPushPublisher(t *testing.T, queueSize int) *PushPublisher {
	t.Helper()
	p := &PushPublisher{sender: &fakeSender{}, config: config.AppConfig, queue: make(chan *pushJob, queueSize)}
	previous := pushPublisher
	pushPublisher = p
	t.Cleanup(func() { pushPublisher = previous })
	t.Cleanup(func() { waitForAsync(t) })
	return p
}

// queuedPushes drains the publisher queue and decodes the queued messages.
func queuedPushes(t *testing.T, p *PushPublisher) []PushMessage {
	t.Helper()
	var msgs []PushMessage
	for {
		select {
		case job := <-p.queue:
			var msg PushMessage
			require.NoError(t, json.Unmarshal(job.msg.Body, &msg))
			msgs = append(msgs, msg)
		default:
			return msgs
		}
	}
}

// ==================== Azure Blob fake ====================

const blobAccount = "devstoreaccount1"

// blobCall is a request received by the fake blob store.
type blobCall struct {
	Method      string
	Name        string // blob name inside the container
	ContentType string // x-ms-blob-content-type of uploads
	Size        int
}

// fakeBlobStore is an httptest Azure Blob endpoint: uploads get 201 and deletes 202, except for
// blobs matched by failPut/failDelete, which get 403. Every request is recorded.
type fakeBlobStore struct {
	server     *httptest.Server
	container  string
	mu         sync.Mutex
	calls      []blobCall
	failPut    func(name string) bool
	failDelete func(name string) bool
}

func newFakeBlobStore(t *testing.T, container string) *fakeBlobStore {
	t.Helper()
	store := &fakeBlobStore{container: container}
	store.server = httptest.NewServer(http.HandlerFunc(store.handle))
	t.Cleanup(store.server.Close)
	return store
}

func (s *fakeBlobStore) handle(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	name := strings.TrimPrefix(r.URL.Path, "/"+blobAccount+"/"+s.container+"/")

	s.mu.Lock()
	s.calls = append(s.calls, blobCall{
		Method:      r.Method,
		Name:        name,
		ContentType: r.Header.Get("x-ms-blob-content-type"),
		Size:        len(body),
	})
	failPut, failDelete := s.failPut, s.failDelete
	s.mu.Unlock()

	switch {
	case r.Method == http.MethodPut && failPut != nil && failPut(name),
		r.Method == http.MethodDelete && failDelete != nil && failDelete(name):
		w.WriteHeader(http.StatusForbidden)
	case r.Method == http.MethodPut:
		w.WriteHeader(http.StatusCreated)
	case r.Method == http.MethodDelete:
		w.WriteHeader(http.StatusAccepted)
	default:
		w.WriteHeader(http.StatusBadRequest)
	}
}

func (s *fakeBlobStore) setFailures(failPut, failDelete func(name string) bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failPut, s.failDelete = failPut, failDelete
}

func (s *fakeBlobStore) recorded() []blobCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]blobCall(nil), s.calls...)
}

// connectionString returns an Azurite-style connection string for the fake, with a random key.
func (s *fakeBlobStore) connectionString(t *testing.T) string {
	t.Helper()
	key := make([]byte, 64)
	_, err := rand.Read(key)
	require.NoError(t, err)
	return "DefaultEndpointsProtocol=http;AccountName=" + blobAccount +
		";AccountKey=" + base64.StdEncoding.EncodeToString(key) +
		";BlobEndpoint=" + s.server.URL + "/" + blobAccount + ";"
}

// ==================== Images and files ====================

func testImage(w, h int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 128, A: 255})
		}
	}
	return img
}

func jpegBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, jpeg.Encode(&buf, testImage(w, h), &jpeg.Options{Quality: 90}))
	return buf.Bytes()
}

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, testImage(w, h)))
	return buf.Bytes()
}

// memFile is an in-memory multipart.File.
type memFile struct{ *bytes.Reader }

func (memFile) Close() error { return nil }

func newMemFile(data []byte) memFile { return memFile{bytes.NewReader(data)} }

// unseekableFile is a multipart.File whose Seek fails.
type unseekableFile struct{ memFile }

func (unseekableFile) Seek(int64, int) (int64, error) { return 0, errors.New("seek failed") }

func fileHeader(name string, size int) *multipart.FileHeader {
	return &multipart.FileHeader{Filename: name, Size: int64(size)}
}

// decodeJPEG decodes JPEG bytes produced by the image processor.
func decodeJPEG(t *testing.T, r io.Reader) image.Image {
	t.Helper()
	img, err := jpeg.Decode(r)
	require.NoError(t, err)
	return img
}
