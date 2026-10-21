package services

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
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

const testFrontendURL = "https://app.example.com"

func testEmailConfig() *config.EmailConfig {
	return &config.EmailConfig{FromAddress: "noreply@example.com", FromName: "Growth Tracker"}
}

// ==================== Resend fake ====================

type resendRequest struct {
	Auth    string
	From    string   `json:"from"`
	To      []string `json:"to"`
	Subject string   `json:"subject"`
	HTML    string   `json:"html"`
}

// fakeResend stands in for the Resend API: it records POST /emails requests and answers with
// the configured status code.
type fakeResend struct {
	mu       sync.Mutex
	status   int
	requests []resendRequest
}

func (f *fakeResend) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.URL.Path != "/emails" {
		http.NotFound(w, r)
		return
	}
	var req resendRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	req.Auth = r.Header.Get("Authorization")

	f.mu.Lock()
	f.requests = append(f.requests, req)
	status := f.status
	f.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if status >= http.StatusMultipleChoices {
		_, _ = io.WriteString(w, `{"statusCode":422,"name":"validation_error","message":"Invalid to field"}`)
		return
	}
	_, _ = io.WriteString(w, `{"id":"email-123"}`)
}

func (f *fakeResend) setStatus(status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.status = status
}

func (f *fakeResend) recorded() []resendRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]resendRequest(nil), f.requests...)
}

// newResendEmailService returns an EmailService configured for Resend whose client talks to a
// fake API server.
func newResendEmailService(t *testing.T) (*EmailService, *fakeResend) {
	t.Helper()
	fake := &fakeResend{status: http.StatusOK}
	server := httptest.NewServer(http.HandlerFunc(fake.handle))
	t.Cleanup(server.Close)

	cfg := testEmailConfig()
	cfg.ResendAPIKey = "re_test_key"
	svc, err := NewEmailService(cfg, testFrontendURL)
	require.NoError(t, err)
	sender, ok := svc.sender.(*ResendEmailSender)
	require.True(t, ok, "an API key selects Resend")
	sender.client.BaseURL, err = url.Parse(server.URL + "/")
	require.NoError(t, err)
	return svc, fake
}

// ==================== SMTP fake ====================

type smtpMessage struct {
	From string
	To   []string
	Data string
}

// fakeSMTP is a minimal SMTP server (like Mailpit) that records delivered messages.
type fakeSMTP struct {
	host, port   string
	rejectSender bool
	mu           sync.Mutex
	messages     []smtpMessage
}

// startFakeSMTP serves SMTP on a free local port until the test ends.
func startFakeSMTP(t *testing.T, rejectSender bool) *fakeSMTP {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	host, port, err := net.SplitHostPort(ln.Addr().String())
	require.NoError(t, err)
	srv := &fakeSMTP{host: host, port: port, rejectSender: rejectSender}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			wg.Add(1)
			go func() {
				defer wg.Done()
				srv.serve(conn)
			}()
		}
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		wg.Wait()
	})
	return srv
}

func (s *fakeSMTP) serve(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	r := bufio.NewReader(conn)
	reply := func(line string) { _, _ = io.WriteString(conn, line+"\r\n") }

	reply("220 fake.smtp ESMTP")
	var msg smtpMessage
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		cmd := strings.TrimRight(line, "\r\n")
		upper := strings.ToUpper(cmd)
		switch {
		case strings.HasPrefix(upper, "EHLO"), strings.HasPrefix(upper, "HELO"):
			reply("250 fake.smtp")
		case strings.HasPrefix(upper, "MAIL FROM:"):
			if s.rejectSender {
				reply("550 sender rejected")
				continue
			}
			msg = smtpMessage{From: cmd[len("MAIL FROM:"):]}
			reply("250 OK")
		case strings.HasPrefix(upper, "RCPT TO:"):
			msg.To = append(msg.To, cmd[len("RCPT TO:"):])
			reply("250 OK")
		case upper == "DATA":
			reply("354 end data with <CR><LF>.<CR><LF>")
			var data strings.Builder
			for {
				l, err := r.ReadString('\n')
				if err != nil {
					return
				}
				if l == ".\r\n" {
					break
				}
				data.WriteString(l)
			}
			msg.Data = data.String()
			s.mu.Lock()
			s.messages = append(s.messages, msg)
			s.mu.Unlock()
			reply("250 OK queued")
		case upper == "QUIT":
			reply("221 bye")
			return
		default:
			reply("250 OK")
		}
	}
}

func (s *fakeSMTP) received() []smtpMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]smtpMessage(nil), s.messages...)
}

// ==================== Email service ====================

func TestEmailService_Resend(t *testing.T) {
	svc, fake := newResendEmailService(t)

	require.NoError(t, svc.SendPasswordResetEmail("ada@example.com", "ada", "reset-token"))
	require.NoError(t, svc.SendVerificationEmail("bob@example.com", "bob", "verify-token"))

	requests := fake.recorded()
	require.Len(t, requests, 2)
	reset, verify := requests[0], requests[1]

	assert.Equal(t, "Bearer re_test_key", reset.Auth)
	assert.Equal(t, "Growth Tracker <noreply@example.com>", reset.From)
	assert.Equal(t, []string{"ada@example.com"}, reset.To)
	assert.Equal(t, "Reset Your Password - Growth Tracker", reset.Subject)
	assert.Contains(t, reset.HTML, "Hi <strong>ada</strong>")
	assert.Contains(t, reset.HTML, `href="https://app.example.com/reset-password?token=reset-token"`)
	assert.Contains(t, reset.HTML, "15 minutes")
	assert.Contains(t, reset.HTML, `width="100%"`, "format verbs are escaped in the template")

	assert.Equal(t, []string{"bob@example.com"}, verify.To)
	assert.Equal(t, "Verify Your Email - Growth Tracker", verify.Subject)
	assert.Contains(t, verify.HTML, "Hi <strong>bob</strong>")
	assert.Contains(t, verify.HTML, `href="https://app.example.com/verify-email?token=verify-token"`)
	assert.Contains(t, verify.HTML, "24 hours")
	assert.Contains(t, verify.HTML, `href="https://app.example.com" style=`)
}

func TestEmailService_ResendError(t *testing.T) {
	svc, fake := newResendEmailService(t)
	fake.setStatus(http.StatusUnprocessableEntity)

	err := svc.SendPasswordResetEmail("not-an-email", "ada", "token")
	require.EqualError(t, err, "[ERROR]: Invalid to field")
	assert.Len(t, fake.recorded(), 1)
}

func TestEmailService_SMTPFallback(t *testing.T) {
	smtpServer := startFakeSMTP(t, false)
	t.Setenv("SMTP_HOST", smtpServer.host)
	t.Setenv("SMTP_PORT", smtpServer.port)

	svc, err := NewEmailService(testEmailConfig(), testFrontendURL)
	require.NoError(t, err)
	sender, ok := svc.sender.(*SMTPEmailSender)
	require.True(t, ok, "without an API key the service falls back to SMTP")
	assert.Equal(t, smtpServer.host, sender.host)
	assert.Equal(t, smtpServer.port, sender.port)

	require.NoError(t, svc.SendVerificationEmail("ada@example.com", "ada", "verify-token"))

	messages := smtpServer.received()
	require.Len(t, messages, 1)
	msg := messages[0]
	assert.Equal(t, "<noreply@example.com>", msg.From)
	assert.Equal(t, []string{"<ada@example.com>"}, msg.To)
	assert.Contains(t, msg.Data, "From: Growth Tracker <noreply@example.com>\r\n")
	assert.Contains(t, msg.Data, "To: ada@example.com\r\n")
	assert.Contains(t, msg.Data, "Subject: Verify Your Email - Growth Tracker\r\n")
	assert.Contains(t, msg.Data, "Content-Type: text/html; charset=\"UTF-8\"\r\n")
	assert.Contains(t, msg.Data, "https://app.example.com/verify-email?token=verify-token")
}

func TestEmailService_SMTPFailure(t *testing.T) {
	smtpServer := startFakeSMTP(t, true)
	t.Setenv("SMTP_HOST", smtpServer.host)
	t.Setenv("SMTP_PORT", smtpServer.port)

	svc, err := NewEmailService(testEmailConfig(), testFrontendURL)
	require.NoError(t, err)

	err = svc.SendPasswordResetEmail("ada@example.com", "ada", "token")
	require.ErrorContains(t, err, "sender rejected")
	assert.Empty(t, smtpServer.received())
}

func TestEmailService_SMTPDefaults(t *testing.T) {
	t.Setenv("SMTP_HOST", "")
	t.Setenv("SMTP_PORT", "")

	svc, err := NewEmailService(testEmailConfig(), testFrontendURL)
	require.NoError(t, err)
	sender, ok := svc.sender.(*SMTPEmailSender)
	require.True(t, ok)
	assert.Equal(t, "localhost", sender.host)
	assert.Equal(t, "1025", sender.port, "Mailpit's default port")
	assert.Equal(t, "noreply@example.com", sender.fromAddress)
	assert.Equal(t, "Growth Tracker", sender.fromName)
	assert.Equal(t, testFrontendURL, svc.frontendURL)
}

// ==================== Cron service ====================

// cronDeps selects the database behind each CronService dependency; nil jobLogs or notifs
// leave the job-log repository or the notification service unconfigured.
type cronDeps struct {
	users, streaks, jobLogs, notifs *gorm.DB
}

func newCronService(d cronDeps) *CronService {
	var jobLogRepo *repository.CronJobLogRepository
	if d.jobLogs != nil {
		jobLogRepo = repository.NewCronJobLogRepository(d.jobLogs)
	}
	var notifSvc *NotificationService
	if d.notifs != nil {
		notifSvc = newNotificationService(d.notifs)
	}
	streakRepo := repository.NewStreakRepository(d.streaks)
	return NewCronService(repository.NewUserRepository(d.users), streakRepo, jobLogRepo, NewStreakService(streakRepo), nil, notifSvc)
}

func cronJobLogs(t *testing.T, db *gorm.DB, jobName string) []models.CronJobLog {
	t.Helper()
	var logs []models.CronJobLog
	require.NoError(t, db.Where("job_name = ?", jobName).Order("id").Find(&logs).Error)
	return logs
}

func streakOn(t *testing.T, db *gorm.DB, userID uint, day time.Time) *models.Streak {
	t.Helper()
	streak, err := repository.NewStreakRepository(db).FindByUserAndDate(userID, day)
	require.NoError(t, err)
	return streak
}

func TestNewCronService(t *testing.T) {
	db := testDB(t)
	users := repository.NewUserRepository(db)
	streaks := repository.NewStreakRepository(db)
	jobLogs := repository.NewCronJobLogRepository(db)
	streakSvc := NewStreakService(streaks)
	emailSvc := &EmailService{}
	notifSvc := newNotificationService(db)

	t.Setenv("HOSTNAME", "worker-7")
	svc := NewCronService(users, streaks, jobLogs, streakSvc, emailSvc, notifSvc)
	assert.Equal(t, "worker-7", svc.instanceID)
	assert.Same(t, users, svc.userRepo)
	assert.Same(t, streaks, svc.streakRepo)
	assert.Same(t, jobLogs, svc.cronJobLogRepo)
	assert.Same(t, streakSvc, svc.streakSvc)
	assert.Same(t, emailSvc, svc.emailSvc)
	assert.Same(t, notifSvc, svc.notifSvc)

	t.Setenv("HOSTNAME", "")
	assert.Regexp(t, `^instance-\d+$`, NewCronService(users, streaks, jobLogs, streakSvc, emailSvc, notifSvc).instanceID)
}

func TestCronService_RunDailyJob(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	t.Setenv("HOSTNAME", "cron-test")
	today := todayIST()

	veteran := newUser(t, db)
	testutil.CreateStreak(t, db, veteran.ID, 3, 5, today.AddDate(0, 0, -1))
	newcomer := newUser(t, db)

	require.NoError(t, newCronService(cronDeps{users: db, streaks: db, jobLogs: db}).RunDailyJob(ctx))

	s := streakOn(t, db, veteran.ID, today)
	require.NotNil(t, s, "every user gets a record for the new IST day")
	assert.Equal(t, 0, s.Current)
	assert.Equal(t, 5, s.Longest, "the record carries over")
	s = streakOn(t, db, newcomer.ID, today)
	require.NotNil(t, s)
	assert.Equal(t, 0, s.Current)
	assert.Equal(t, 0, s.Longest)

	logs := cronJobLogs(t, db, models.CronJobDailyStreak)
	require.Len(t, logs, 1)
	assert.Equal(t, models.CronJobStatusCompleted, logs[0].Status)
	assert.Equal(t, 2, logs[0].UsersCount)
	assert.Equal(t, "cron-test", logs[0].InstanceID)
	assert.Equal(t, today.Format(constants.DateFormat), logs[0].JobDate.Format(constants.DateFormat))
	assert.Empty(t, logs[0].Error)
	assert.WithinDuration(t, time.Now(), logs[0].CompletedAt, time.Minute)

	// Another replica (or a retry) finds today's job claimed and does nothing.
	late := newUser(t, db)
	require.NoError(t, newCronService(cronDeps{users: db, streaks: db, jobLogs: db}).RunDailyJob(ctx))
	assert.Nil(t, streakOn(t, db, late.ID, today))
	assert.Len(t, cronJobLogs(t, db, models.CronJobDailyStreak), 1)
}

func TestCronService_RunDailyJob_WithoutJobLog(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	user := newUser(t, db)
	svc := newCronService(cronDeps{users: db, streaks: db})

	require.NoError(t, svc.RunDailyJob(ctx))
	require.NoError(t, svc.RunDailyJob(ctx), "the per-user check keeps reruns idempotent")

	assert.EqualValues(t, 1, countRows(t, db.Where("user_id = ?", user.ID), &models.Streak{}))
	assert.Zero(t, countRows(t, db, &models.CronJobLog{}))
}

func TestCronService_RunDailyJob_ContinuesWhenClaimFails(t *testing.T) {
	db := testDB(t)
	user := newUser(t, db)
	svc := newCronService(cronDeps{users: db, streaks: db, jobLogs: testutil.BrokenDB(t)})

	require.NoError(t, svc.RunDailyJob(context.Background()))
	assert.NotNil(t, streakOn(t, db, user.ID, todayIST()))
}

func TestCronService_RunDailyJob_LoadingUsersFails(t *testing.T) {
	db := testDB(t)
	svc := newCronService(cronDeps{users: testutil.BrokenDB(t), streaks: db, jobLogs: db})

	require.Error(t, svc.RunDailyJob(context.Background()))
	logs := cronJobLogs(t, db, models.CronJobDailyStreak)
	require.Len(t, logs, 1)
	assert.Equal(t, models.CronJobStatusFailed, logs[0].Status)
	assert.Zero(t, logs[0].UsersCount)
	assert.NotEmpty(t, logs[0].Error)
}

func TestCronService_RunDailyJob_StreakUpdateFails(t *testing.T) {
	db := testDB(t)
	newUser(t, db)
	newUser(t, db)
	creates := 0
	streaks := faultyDB(t, func(s stmtInfo) bool {
		if s.is("create", "streaks") {
			creates++
			return creates == 2
		}
		return false
	})
	svc := newCronService(cronDeps{users: db, streaks: streaks, jobLogs: db})

	require.ErrorIs(t, svc.RunDailyJob(context.Background()), errInjected)
	logs := cronJobLogs(t, db, models.CronJobDailyStreak)
	require.Len(t, logs, 1)
	assert.Equal(t, models.CronJobStatusFailed, logs[0].Status)
	assert.Equal(t, 1, logs[0].UsersCount, "users processed before the failure")
	assert.Equal(t, errInjected.Error(), logs[0].Error)
}

func TestCronService_UpdateJobLog(t *testing.T) {
	db := testDB(t)

	log := &models.CronJobLog{ID: 1}
	(&CronService{}).updateJobLog(log, models.CronJobStatusCompleted, 1, "")
	assert.Empty(t, log.Status, "nothing to do without a repository")

	svc := &CronService{cronJobLogRepo: repository.NewCronJobLogRepository(db)}
	svc.updateJobLog(nil, models.CronJobStatusCompleted, 1, "")
	unsaved := &models.CronJobLog{}
	svc.updateJobLog(unsaved, models.CronJobStatusCompleted, 1, "")
	assert.Empty(t, unsaved.Status, "logs that were never stored are left alone")

	broken := &CronService{cronJobLogRepo: repository.NewCronJobLogRepository(testutil.BrokenDB(t))}
	log = &models.CronJobLog{ID: 7}
	broken.updateJobLog(log, models.CronJobStatusFailed, 3, "boom") // the failure is only logged
	assert.Equal(t, models.CronJobStatusFailed, log.Status)
	assert.Equal(t, 3, log.UsersCount)
	assert.Equal(t, "boom", log.Error)
}

func TestCronService_SendStreakReminders_RequiresNotificationService(t *testing.T) {
	require.EqualError(t, (&CronService{}).SendStreakReminders(context.Background()), "notification service not configured")
}

func TestCronService_SendStreakReminders_RemindsUsersWhoHaveNotLoggedToday(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	pub := installPushPublisher(t, 10)
	today := todayIST()
	idle := newUser(t, db)
	testutil.CreateStreak(t, db, idle.ID, 0, 4, today)
	active := newUser(t, db)
	testutil.CreateStreak(t, db, active.ID, 2, 4, today)
	lapsed := newUser(t, db)
	testutil.CreateStreak(t, db, lapsed.ID, 0, 1, today.AddDate(0, 0, -1))
	svc := newCronService(cronDeps{users: db, streaks: db, jobLogs: db, notifs: db})

	require.NoError(t, svc.SendStreakReminders(ctx))

	notifs := notificationsOf(t, db, idle.ID)
	require.Len(t, notifs, 1)
	assert.Equal(t, models.NotifTypeStreakAtRisk, notifs[0].Type)
	assert.Empty(t, notificationsOf(t, db, active.ID))
	assert.Empty(t, notificationsOf(t, db, lapsed.ID))

	pushes := queuedPushes(t, pub)
	require.Len(t, pushes, 1)
	assert.Equal(t, idle.ID, pushes[0].UserID)
	assert.Equal(t, fmt.Sprintf("streak_reminder:%d:%s", idle.ID, today.Format(constants.DateFormat)), pushes[0].DedupeKey)
	assert.Equal(t, "/", pushes[0].DeepLink)
	assert.Equal(t, 7200, pushes[0].TTLSeconds)
	assert.Equal(t, float64(notifs[0].ID), pushes[0].Data["notification_id"])

	logs := cronJobLogs(t, db, models.CronJobStreakReminder)
	require.Len(t, logs, 1)
	assert.Equal(t, models.CronJobStatusCompleted, logs[0].Status)
	assert.Equal(t, 1, logs[0].UsersCount)

	require.NoError(t, svc.SendStreakReminders(ctx), "a second run on the same day is skipped")
	assert.Len(t, notificationsOf(t, db, idle.ID), 1)
}

func TestCronService_SendStreakReminders_NobodyToRemind(t *testing.T) {
	db := testDB(t)
	svc := newCronService(cronDeps{users: db, streaks: db, jobLogs: db, notifs: db})

	require.NoError(t, svc.SendStreakReminders(context.Background()))
	logs := cronJobLogs(t, db, models.CronJobStreakReminder)
	require.Len(t, logs, 1)
	assert.Equal(t, models.CronJobStatusCompleted, logs[0].Status)
	assert.Zero(t, logs[0].UsersCount)
}

func TestCronService_SendStreakReminders_ContinuesWhenClaimFails(t *testing.T) {
	db := testDB(t)
	user := newUser(t, db)
	testutil.CreateStreak(t, db, user.ID, 0, 0, todayIST())
	svc := newCronService(cronDeps{users: db, streaks: db, jobLogs: testutil.BrokenDB(t), notifs: db})

	require.NoError(t, svc.SendStreakReminders(context.Background()))
	assert.Len(t, notificationsOf(t, db, user.ID), 1)
}

func TestCronService_SendStreakReminders_CountsFailedReminders(t *testing.T) {
	db := testDB(t)
	user := newUser(t, db)
	testutil.CreateStreak(t, db, user.ID, 0, 0, todayIST())
	svc := newCronService(cronDeps{users: db, streaks: db, jobLogs: db, notifs: testutil.BrokenDB(t)})

	require.NoError(t, svc.SendStreakReminders(context.Background()), "failed reminders are not fatal")
	logs := cronJobLogs(t, db, models.CronJobStreakReminder)
	require.Len(t, logs, 1)
	assert.Equal(t, models.CronJobStatusCompleted, logs[0].Status)
	assert.Zero(t, logs[0].UsersCount, "only successful reminders are counted")
}

func TestCronService_SendStreakReminders_FindingUsersFails(t *testing.T) {
	db := testDB(t)
	svc := newCronService(cronDeps{users: db, streaks: testutil.BrokenDB(t), jobLogs: db, notifs: db})

	require.ErrorContains(t, svc.SendStreakReminders(context.Background()), "failed to find users who missed streak")
	logs := cronJobLogs(t, db, models.CronJobStreakReminder)
	require.Len(t, logs, 1)
	assert.Equal(t, models.CronJobStatusFailed, logs[0].Status)
	assert.NotEmpty(t, logs[0].Error)
}

func TestCronService_CleanupOldNotifications(t *testing.T) {
	ctx := context.Background()
	assert.NoError(t, (&CronService{}).CleanupOldNotifications(ctx), "nothing to do without notifications")

	db := testDB(t)
	seedNotification(t, db, 1, time.Now().AddDate(0, 0, -100), false)
	recent := seedNotification(t, db, 1, time.Now(), false)
	svc := newCronService(cronDeps{users: db, streaks: db, notifs: db})

	require.NoError(t, svc.CleanupOldNotifications(ctx))
	remaining := notificationsOf(t, db, 1)
	require.Len(t, remaining, 1)
	assert.Equal(t, recent.ID, remaining[0].ID)
	require.NoError(t, svc.CleanupOldNotifications(ctx), "nothing left to delete")

	broken := newCronService(cronDeps{users: db, streaks: db, notifs: testutil.BrokenDB(t)})
	require.ErrorContains(t, broken.CleanupOldNotifications(ctx), "notification cleanup failed")
}

// ==================== Blob service ====================

func TestBlobService(t *testing.T) {
	db := testDB(t)
	users := repository.NewUserRepository(db)
	cfg := &config.AzureStorageConfig{AccountName: "growthpics", ContainerName: "profile-pictures"}

	assert.False(t, NewBlobService(users, cfg).IsEnabled(), "disabled without a connection string")
	cfg.ConnectionString = "UseDevelopmentStorage=true"
	svc := NewBlobService(users, cfg)
	assert.True(t, svc.IsEnabled())
	assert.Equal(t, "https://growthpics.blob.core.windows.net/profile-pictures/user-1/pic.jpg", svc.GeneratePublicURL("user-1/pic.jpg"))

	user := newUser(t, db)
	pic, thumb := "https://cdn.example.com/p.jpg", "https://cdn.example.com/p_thumb.jpg"
	require.NoError(t, svc.UpdateProfilePic(user.ID, &pic, &thumb))
	got, err := svc.GetUser(user.ID)
	require.NoError(t, err)
	require.NotNil(t, got)
	assert.Equal(t, &pic, got.ProfilePic)
	assert.Equal(t, &thumb, got.ProfilePicThumb)

	require.NoError(t, svc.UpdateProfilePic(user.ID, nil, nil))
	got, err = svc.GetUser(user.ID)
	require.NoError(t, err)
	assert.Nil(t, got.ProfilePic)
	assert.Nil(t, got.ProfilePicThumb)

	missing, err := svc.GetUser(user.ID + 1000)
	require.NoError(t, err)
	assert.Nil(t, missing)
}
