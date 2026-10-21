package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"
	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// resetPushSingleton clears the package-level publisher and its sync.Once, before and after the
// test, so InitPushPublisher can run again and tests do not depend on their execution order.
func resetPushSingleton(t *testing.T) {
	t.Helper()
	pushPublisher = nil
	pushPublisherOnce = sync.Once{}
	t.Cleanup(func() {
		pushPublisher = nil
		pushPublisherOnce = sync.Once{}
	})
}

// newTestPublisher builds a publisher around sender without starting its worker.
func newTestPublisher(sender serviceBusSender, queueSize, batchSize int, batchWait time.Duration) *PushPublisher {
	return &PushPublisher{
		sender:    sender,
		config:    &config.Config{},
		queue:     make(chan *pushJob, queueSize),
		batchSize: batchSize,
		batchWait: batchWait,
	}
}

// runWorker starts the publisher's background worker like NewPushPublisher does; closing the
// publisher (at the latest when the test ends) flushes the queue and stops the worker.
func runWorker(t *testing.T, p *PushPublisher) {
	t.Helper()
	p.wg.Add(1)
	go p.worker()
	t.Cleanup(func() { assert.NoError(t, p.Close(context.Background())) })
}

func publish(t *testing.T, p *PushPublisher, userID uint) {
	t.Helper()
	require.NoError(t, p.PublishPushNotification(context.Background(), userID, models.NotifTypeLikeReceived,
		"New like", "Someone liked your day", "like:1", "/notifications", map[string]interface{}{"n": userID}, 60))
}

// nextPush takes the next queued job and decodes its payload.
func nextPush(t *testing.T, p *PushPublisher) (*pushJob, PushMessage) {
	t.Helper()
	var job *pushJob
	select {
	case job = <-p.queue:
	default:
		require.FailNow(t, "no message queued")
	}
	var msg PushMessage
	require.NoError(t, json.Unmarshal(job.msg.Body, &msg))
	return job, msg
}

// closingListener accepts TCP connections and closes them at once, so Service Bus connection
// attempts against it fail fast without any network access. It returns host:port.
func closingListener(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		<-done
	})
	return ln.Addr().String()
}

func serviceBusConnectionString(host string) string {
	return "Endpoint=sb://" + host + "/;SharedAccessKeyName=test;SharedAccessKey=dGVzdA=="
}

func senderClosed(s *fakeSender) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

func TestInitPushPublisher_WithoutConnectionString(t *testing.T) {
	resetPushSingleton(t)
	ctx := context.Background()

	require.NoError(t, InitPushPublisher(&config.Config{}))
	p := GetPushPublisher()
	require.NotNil(t, p)
	assert.False(t, p.IsAvailable(), "push is disabled without a connection string")
	pending, capacity := p.QueueStats()
	assert.Zero(t, pending)
	assert.Zero(t, capacity)
	assert.NoError(t, p.PublishPushNotification(ctx, 1, models.NotifTypeLikeReceived, "t", "b", "", "", nil, 60),
		"publishing is a silent no-op")
	assert.NoError(t, p.Close(ctx))

	// sync.Once: later calls keep the first publisher, even with a config that would fail.
	bad := &config.Config{AzureServiceBus: config.AzureServiceBusConfig{ConnectionString: "not-a-connection-string"}}
	require.NoError(t, InitPushPublisher(bad))
	assert.Same(t, p, GetPushPublisher())
}

func TestInitPushPublisher_InvalidConnectionString(t *testing.T) {
	resetPushSingleton(t)
	bad := &config.Config{AzureServiceBus: config.AzureServiceBusConfig{ConnectionString: "not-a-connection-string"}}

	err := InitPushPublisher(bad)
	require.ErrorContains(t, err, "failed to create Service Bus client")
	assert.Nil(t, GetPushPublisher())
}

func TestNewPushPublisher_Configured(t *testing.T) {
	cfg := &config.Config{AzureServiceBus: config.AzureServiceBusConfig{
		ConnectionString: serviceBusConnectionString(closingListener(t)),
		QueueName:        "push-test",
	}}

	p, err := NewPushPublisher(cfg)
	require.NoError(t, err)
	assert.True(t, p.IsAvailable())
	assert.Same(t, cfg, p.config)
	assert.Equal(t, defaultBatchSize, p.batchSize)
	assert.Equal(t, defaultBatchWait, p.batchWait)
	_, capacity := p.QueueStats()
	assert.Equal(t, defaultQueueSize, capacity)

	require.NoError(t, p.Close(context.Background()), "closing right after start-up is safe")
	assert.False(t, p.IsAvailable())
	assert.Nil(t, p.client)
	// The connection warm-up cannot reach a broker and gives up once the client is closed.
	require.Eventually(t, func() bool {
		return !bytes.Contains(goroutineStacks(), []byte("(*PushPublisher).warmupConnection"))
	}, 20*time.Second, 10*time.Millisecond, "warm-up goroutine still running")
}

func TestPushPublisher_WarmupConnection(t *testing.T) {
	ok := &fakeSender{}
	(&PushPublisher{sender: ok}).warmupConnection()
	_, _, calls := ok.snapshot()
	assert.Equal(t, 1, calls)

	failing := &fakeSender{newBatchErr: errors.New("dial failed")}
	(&PushPublisher{sender: failing}).warmupConnection() // only logged
	_, _, calls = failing.snapshot()
	assert.Equal(t, 1, calls)
}

func TestPushPublisher_WarmupSkipsClosedPublisher(t *testing.T) {
	// Close can finish before the warm-up goroutine started by NewPushPublisher gets to run.
	closed := &fakeSender{}
	p := newTestPublisher(closed, 1, 10, time.Hour)
	require.NoError(t, p.Close(context.Background()))
	require.NotPanics(t, p.warmupConnection)
	_, _, calls := closed.snapshot()
	assert.Zero(t, calls, "a closed publisher does not dial")

	// Close has started but not yet released the sender.
	closing := &fakeSender{}
	p = newTestPublisher(closing, 1, 10, time.Hour)
	p.closed = true
	p.warmupConnection()
	_, _, calls = closing.snapshot()
	assert.Zero(t, calls)
}

func TestPushPublisher_AvailabilityAndQueueStats(t *testing.T) {
	var none *PushPublisher
	assert.False(t, none.IsAvailable())
	pending, capacity := none.QueueStats()
	assert.Equal(t, [2]int{0, 0}, [2]int{pending, capacity})

	unconfigured := &PushPublisher{}
	assert.False(t, unconfigured.IsAvailable())
	pending, capacity = unconfigured.QueueStats()
	assert.Equal(t, [2]int{0, 0}, [2]int{pending, capacity})

	p := newTestPublisher(&fakeSender{}, 4, 10, time.Hour)
	assert.True(t, p.IsAvailable())
	publish(t, p, 1)
	publish(t, p, 2)
	pending, capacity = p.QueueStats()
	assert.Equal(t, [2]int{2, 4}, [2]int{pending, capacity})
}

func TestPushPublisher_PublishPushNotification(t *testing.T) {
	ctx := context.Background()
	p := newTestPublisher(&fakeSender{}, 4, 10, time.Hour)

	t.Run("builds the Service Bus message", func(t *testing.T) {
		data := map[string]interface{}{"photo_id": 7}
		require.NoError(t, p.PublishPushNotification(ctx, 42, models.NotifTypeStoryLiked,
			"Story liked", "alice liked your story", "story:7", "/stories/7", data, 120))

		job, msg := nextPush(t, p)
		assert.Regexp(t, `^push-\d+-\d+$`, msg.MessageID)
		assert.Equal(t, uint(42), msg.UserID)
		assert.Equal(t, string(models.NotifTypeStoryLiked), msg.NotificationType)
		assert.Equal(t, "Story liked", msg.Title)
		assert.Equal(t, "alice liked your story", msg.Body)
		assert.Equal(t, "story:7", msg.DedupeKey)
		assert.Equal(t, "story:7", msg.Tag, "the dedupe key doubles as collapse tag")
		assert.Equal(t, "/stories/7", msg.DeepLink)
		assert.Equal(t, map[string]interface{}{"photo_id": float64(7)}, msg.Data)
		assert.Equal(t, 120, msg.TTLSeconds)
		assert.WithinDuration(t, time.Now(), msg.CreatedAt, time.Minute)

		require.NotNil(t, job.msg.MessageID)
		assert.Equal(t, msg.MessageID, *job.msg.MessageID)
		require.NotNil(t, job.msg.Subject)
		assert.Equal(t, string(models.NotifTypeStoryLiked), *job.msg.Subject)
		require.NotNil(t, job.msg.TimeToLive)
		assert.Equal(t, 120*time.Second, *job.msg.TimeToLive)
		assert.Equal(t, map[string]interface{}{
			"user_id":    uint(42),
			"type":       string(models.NotifTypeStoryLiked),
			"dedupe_key": "story:7",
		}, job.msg.ApplicationProperties)
		assert.Equal(t, ctx, job.ctx)
	})

	t.Run("clears unsafe deep links and truncates long bodies", func(t *testing.T) {
		require.NoError(t, p.PublishPushNotification(ctx, 1, models.NotifTypeLikeReceived,
			"t", strings.Repeat("a", 250), "", "https://evil.example/phish", nil, 60))

		_, msg := nextPush(t, p)
		assert.Empty(t, msg.DeepLink)
		assert.Equal(t, strings.Repeat("a", 197)+"...", msg.Body)
	})

	t.Run("truncates long bodies at whole characters", func(t *testing.T) {
		require.NoError(t, p.PublishPushNotification(ctx, 1, models.NotifTypeLikeReceived,
			"t", strings.Repeat("ü", 250), "", "", nil, 60))

		_, msg := nextPush(t, p)
		assert.Equal(t, strings.Repeat("ü", 197)+"...", msg.Body)
	})

	t.Run("drops the extra data when the payload is too large", func(t *testing.T) {
		data := map[string]interface{}{"blob": strings.Repeat("x", 5000)}
		require.NoError(t, p.PublishPushNotification(ctx, 1, models.NotifTypeLikeReceived, "t", "b", "", "", data, 60))

		job, msg := nextPush(t, p)
		assert.Nil(t, msg.Data)
		assert.LessOrEqual(t, len(job.msg.Body), 4096)
	})

	t.Run("rejects data that cannot be encoded", func(t *testing.T) {
		data := map[string]interface{}{"bad": make(chan int)}
		err := p.PublishPushNotification(ctx, 1, models.NotifTypeLikeReceived, "t", "b", "", "", data, 60)
		require.ErrorContains(t, err, "failed to marshal push message")
		pending, _ := p.QueueStats()
		assert.Zero(t, pending)
	})

	t.Run("reports a full queue instead of blocking", func(t *testing.T) {
		full := newTestPublisher(&fakeSender{}, 1, 10, time.Hour)
		publish(t, full, 1)
		err := full.PublishPushNotification(ctx, 2, models.NotifTypeLikeReceived, "t", "b", "", "", nil, 60)
		require.EqualError(t, err, "push notification queue full")
	})
}

func TestPushPublisher_PublishFromNotification(t *testing.T) {
	ctx := context.Background()
	p := newTestPublisher(&fakeSender{}, 4, 10, time.Hour)

	plain := &models.Notification{ID: 9, UserID: 3, Type: models.NotifTypeNewFollower, Title: "New follower", Body: "bob follows you"}
	require.NoError(t, p.PublishFromNotification(ctx, plain, "follow:3", "/profile/bob"))
	_, msg := nextPush(t, p)
	assert.Equal(t, uint(3), msg.UserID)
	assert.Equal(t, string(models.NotifTypeNewFollower), msg.NotificationType)
	assert.Equal(t, "New follower", msg.Title)
	assert.Equal(t, "bob follows you", msg.Body)
	assert.Equal(t, "follow:3", msg.DedupeKey)
	assert.Equal(t, "/profile/bob", msg.DeepLink)
	assert.Equal(t, 3600, msg.TTLSeconds)
	assert.Equal(t, map[string]interface{}{"notification_id": float64(9)}, msg.Data)

	withMetadata := &models.Notification{ID: 10, UserID: 3, Type: models.NotifTypeLikeReceived,
		Metadata: models.NotificationMetadata{"liker_username": "alice"}}
	require.NoError(t, p.PublishFromNotification(ctx, withMetadata, "", ""))
	_, msg = nextPush(t, p)
	assert.Equal(t, map[string]interface{}{"liker_username": "alice", "notification_id": float64(10)}, msg.Data)
}

func TestPushPublisher_WorkerFlushesPartialBatchOnTimer(t *testing.T) {
	requireBatchCapacity(t)
	sender := &fakeSender{batchCapacity: 1 << 20}
	p := newTestPublisher(sender, 16, 10, 20*time.Millisecond)
	runWorker(t, p)

	for i := uint(1); i <= 3; i++ {
		publish(t, p, i)
	}

	total := func() (sum int32) {
		batches, _, _ := sender.snapshot()
		for _, n := range batches {
			sum += n
		}
		return sum
	}
	require.Eventually(t, func() bool { return total() == 3 }, 5*time.Second, 5*time.Millisecond)
	_, single, _ := sender.snapshot()
	assert.Zero(t, single)
}

func TestPushPublisher_WorkerFlushesFullBatches(t *testing.T) {
	requireBatchCapacity(t)
	sender := &fakeSender{batchCapacity: 1 << 20}
	p := newTestPublisher(sender, 16, 2, time.Hour)
	runWorker(t, p)

	for i := uint(1); i <= 5; i++ {
		publish(t, p, i)
	}
	require.Eventually(t, func() bool {
		batches, _, _ := sender.snapshot()
		return len(batches) == 2
	}, 5*time.Second, 5*time.Millisecond, "two full batches are sent without waiting for the timer")

	require.NoError(t, p.Close(context.Background()))
	batches, _, _ := sender.snapshot()
	assert.Equal(t, []int32{2, 2, 1}, batches, "closing flushes the remainder")
	assert.True(t, senderClosed(sender))
	assert.False(t, p.IsAvailable())
	assert.NoError(t, p.Close(context.Background()), "closing twice is harmless")
	assert.NoError(t, p.PublishPushNotification(context.Background(), 1, models.NotifTypeLikeReceived, "t", "b", "", "", nil, 60),
		"publishing after close is a no-op")
}

func TestPushPublisher_WorkerSplitsBatchAtCapacity(t *testing.T) {
	requireBatchCapacity(t)
	sender := &fakeSender{}
	p := newTestPublisher(sender, 4, 10, time.Hour)
	publish(t, p, 1)
	publish(t, p, 2)

	// Size the batches so that each holds exactly one of the two queued messages.
	first := <-p.queue
	second := <-p.queue
	probe := newTestBatch(1 << 20)
	require.NoError(t, probe.AddMessage(first.msg, nil))
	sender.batchCapacity = probe.NumBytes() + 64
	p.queue <- first
	p.queue <- second

	runWorker(t, p)
	require.NoError(t, p.Close(context.Background()))

	batches, single, newBatchCalls := sender.snapshot()
	assert.Equal(t, []int32{1, 1}, batches)
	assert.Zero(t, single)
	assert.Equal(t, 2, newBatchCalls)
}

func TestPushPublisher_WorkerSendsOversizedMessagesIndividually(t *testing.T) {
	for name, sendErr := range map[string]error{"batch send ok": nil, "batch send fails": errors.New("send failed")} {
		t.Run(name, func(t *testing.T) {
			// A batch without capacity rejects every message: the worker sends the (empty) batch,
			// starts a new one and finally sends the message on its own.
			sender := &fakeSender{sendBatchErr: sendErr, sendErr: errors.New("too large")}
			p := newTestPublisher(sender, 4, 10, time.Hour)
			runWorker(t, p)
			publish(t, p, 1)
			publish(t, p, 2)
			require.NoError(t, p.Close(context.Background()))

			batches, single, newBatchCalls := sender.snapshot()
			assert.Equal(t, []int32{0, 0}, batches)
			assert.Equal(t, 2, single)
			assert.Equal(t, 3, newBatchCalls)
		})
	}
}

func TestPushPublisher_WorkerSendErrorsAreLogged(t *testing.T) {
	requireBatchCapacity(t)
	sender := &fakeSender{batchCapacity: 1 << 20, sendBatchErr: errors.New("send failed")}
	p := newTestPublisher(sender, 4, 10, time.Hour)
	runWorker(t, p)
	publish(t, p, 1)
	publish(t, p, 2)

	require.NoError(t, p.Close(context.Background()))
	batches, _, _ := sender.snapshot()
	assert.Equal(t, []int32{2}, batches)
}

func TestPushPublisher_WorkerDropsBatchWhenBatchCreationFails(t *testing.T) {
	sender := &fakeSender{newBatchErr: errors.New("link detached")}
	p := newTestPublisher(sender, 4, 10, time.Hour)
	runWorker(t, p)
	publish(t, p, 1)
	publish(t, p, 2)

	require.NoError(t, p.Close(context.Background()))
	batches, single, newBatchCalls := sender.snapshot()
	assert.Empty(t, batches)
	assert.Zero(t, single)
	assert.Equal(t, 1, newBatchCalls)
}

func TestPushPublisher_WorkerSurvivesFailedBatchRecreation(t *testing.T) {
	// The first batch has no room, so the worker sends it and starts a new one. When that fails,
	// the rest of the batch is dropped and the worker keeps serving later messages.
	sender := &fakeSender{newBatchErr: errors.New("link detached"), newBatchOK: 1}
	p := newTestPublisher(sender, 4, 2, time.Hour)
	runWorker(t, p)

	publish(t, p, 1)
	publish(t, p, 2)
	require.Eventually(t, func() bool {
		_, _, calls := sender.snapshot()
		return calls == 2
	}, 5*time.Second, time.Millisecond, "the full batch is flushed")

	sender.setNewBatchErr(nil)
	publish(t, p, 3)
	require.NoError(t, p.Close(context.Background()))

	sender.mu.Lock()
	defer sender.mu.Unlock()
	require.Len(t, sender.sentSingle, 1, "only the message published after the failure is delivered")
	assert.Equal(t, uint(3), sender.sentSingle[0].ApplicationProperties["user_id"])
}

func TestPushPublisher_WorkerDropsBatchWithoutSender(t *testing.T) {
	p := newTestPublisher(nil, 4, 10, time.Hour)
	p.queue <- &pushJob{msg: &azservicebus.Message{Body: []byte(`{}`)}, ctx: context.Background()}
	runWorker(t, p)

	require.NoError(t, p.Close(context.Background()))
	pending, _ := p.QueueStats()
	assert.Zero(t, pending)
}

func TestPushPublisher_CloseReleasesSenderAndClient(t *testing.T) {
	client, err := azservicebus.NewClientFromConnectionString(serviceBusConnectionString(closingListener(t)), nil)
	require.NoError(t, err)
	sender := &fakeSender{closeErr: errors.New("close failed")}
	p := newTestPublisher(sender, 4, 10, time.Hour)
	p.client = client
	runWorker(t, p)

	require.NoError(t, p.Close(context.Background()), "close errors are only logged")
	assert.True(t, senderClosed(sender))
	assert.Nil(t, p.sender)
	assert.Nil(t, p.client)
}

func TestPushHelpers(t *testing.T) {
	assert.Regexp(t, `^push-\d+-\d+$`, generateMessageID())

	assert.True(t, isValidDeepLink("/profile/alice"))
	assert.False(t, isValidDeepLink("https://example.com/profile"))
	assert.False(t, isValidDeepLink("javascript:alert(1)"))
}

func TestTruncateBody_CountsCharactersNotBytes(t *testing.T) {
	assert.Equal(t, "short", truncateBody("short", 10))
	assert.Equal(t, "exactly10!", truncateBody("exactly10!", 10))
	assert.Equal(t, "abcdefg...", truncateBody("abcdefghijk", 10))

	tenChars := strings.Repeat("ü", 10)
	assert.Equal(t, tenChars, truncateBody(tenChars, 10), "the limit counts characters, not bytes")
	got := truncateBody("日本語のテキストです。", 10)
	assert.Equal(t, "日本語のテキス...", got)
	assert.True(t, utf8.ValidString(got))
	assert.Equal(t, strings.Repeat("🔥", 7)+"...", truncateBody(strings.Repeat("🔥", 11), 10))
}
