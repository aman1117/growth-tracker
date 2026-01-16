package services

import (
	"context"
	"fmt"
	"net/smtp"
	"os"
	"strings"
	"time"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/pkg/models"
	"github.com/resend/resend-go/v3"
)

// EmailSender interface for sending emails (Resend or SMTP)
type EmailSender interface {
	Send(to []string, subject, htmlBody string) error
}

// ResendEmailSender sends emails via Resend API (production)
type ResendEmailSender struct {
	client      *resend.Client
	fromAddress string
	fromName    string
}

func (r *ResendEmailSender) Send(to []string, subject, htmlBody string) error {
	params := &resend.SendEmailRequest{
		From:    fmt.Sprintf("%s <%s>", r.fromName, r.fromAddress),
		To:      to,
		Subject: subject,
		Html:    htmlBody,
	}
	_, err := r.client.Emails.Send(params)
	return err
}

// SMTPEmailSender sends emails via SMTP (for local dev with Mailpit)
type SMTPEmailSender struct {
	host        string
	port        string
	fromAddress string
	fromName    string
}

func (s *SMTPEmailSender) Send(to []string, subject, htmlBody string) error {
	addr := fmt.Sprintf("%s:%s", s.host, s.port)

	// Build email message with proper headers
	from := fmt.Sprintf("%s <%s>", s.fromName, s.fromAddress)
	toHeader := strings.Join(to, ", ")
	msg := fmt.Sprintf("From: %s\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=\"UTF-8\"\r\n\r\n%s",
		from, toHeader, subject, htmlBody)

	// Mailpit doesn't require auth
	err := smtp.SendMail(addr, nil, s.fromAddress, to, []byte(msg))
	if err != nil {
		logger.Sugar.Warnw("SMTP send failed", "error", err, "to", to)
	} else {
		logger.Sugar.Infow("Email sent via SMTP (Mailpit)", "to", to, "subject", subject)
	}
	return err
}

// EmailService handles email-related operations
type EmailService struct {
	sender      EmailSender
	fromAddress string
	fromName    string
	frontendURL string
}

// NewEmailService creates a new EmailService
// Falls back to SMTP if RESEND_API_KEY is not set (for local development with Mailpit)
func NewEmailService(cfg *config.EmailConfig, frontendURL string) (*EmailService, error) {
	var sender EmailSender

	if cfg.ResendAPIKey != "" {
		// Use Resend for production
		sender = &ResendEmailSender{
			client:      resend.NewClient(cfg.ResendAPIKey),
			fromAddress: cfg.FromAddress,
			fromName:    cfg.FromName,
		}
		logger.Sugar.Info("Email service initialized with Resend API")
	} else {
		// Fall back to SMTP for local development (Mailpit)
		smtpHost := os.Getenv("SMTP_HOST")
		smtpPort := os.Getenv("SMTP_PORT")

		if smtpHost == "" {
			smtpHost = "localhost"
		}
		if smtpPort == "" {
			smtpPort = "1025"
		}

		sender = &SMTPEmailSender{
			host:        smtpHost,
			port:        smtpPort,
			fromAddress: cfg.FromAddress,
			fromName:    cfg.FromName,
		}
		logger.Sugar.Infow("Email service initialized with SMTP (Mailpit)", "host", smtpHost, "port", smtpPort)
	}

	return &EmailService{
		sender:      sender,
		fromAddress: cfg.FromAddress,
		fromName:    cfg.FromName,
		frontendURL: frontendURL,
	}, nil
}

// SendPasswordResetEmail sends a password reset email
func (s *EmailService) SendPasswordResetEmail(email, username, token string) error {
	resetLink := fmt.Sprintf("%s/reset-password?token=%s", s.frontendURL, token)

	htmlContent := s.buildPasswordResetHTML(username, resetLink)

	return s.sender.Send([]string{email}, "Reset Your Password - Growth Tracker", htmlContent)
}

// SendVerificationEmail sends an email verification email to a new user
func (s *EmailService) SendVerificationEmail(email, username, token string) error {
	verifyLink := fmt.Sprintf("%s/verify-email?token=%s", s.frontendURL, token)

	htmlContent := s.buildVerificationEmailHTML(username, verifyLink)

	return s.sender.Send([]string{email}, "Verify Your Email - Growth Tracker", htmlContent)
}

func (s *EmailService) buildVerificationEmailHTML(username, verifyLink string) string {
	return fmt.Sprintf(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
    <table width="100%%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
        <tr>
            <td align="center">
                <table width="100%%" style="max-width: 480px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                    <tr>
                        <td style="padding: 40px 32px;">
                            <div style="text-align: center; margin-bottom: 32px;">
                                <h1 style="margin: 0; font-size: 24px; font-weight: 700; color: #1a1a1a;">
                                    ✉️ Verify Your Email
                                </h1>
                            </div>
                            
                            <p style="margin: 0 0 16px; font-size: 16px; color: #333; line-height: 1.5;">
                                Hi <strong>%s</strong>,
                            </p>
                            <p style="margin: 0 0 24px; font-size: 16px; color: #333; line-height: 1.5;">
                                Welcome to Growth Tracker! Please verify your email address by clicking the button below:
                            </p>
                            
                            <div style="text-align: center; margin: 32px 0;">
                                <a href="%s" style="display: inline-block; padding: 14px 32px; background-color: #22c55e; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 16px; border-radius: 8px;">
                                    Verify Email Address
                                </a>
                            </div>
                            
                            <p style="margin: 0 0 16px; font-size: 14px; color: #666; line-height: 1.5;">
                                ⏰ This link will expire in <strong>24 hours</strong>.
                            </p>
                            
                            <div style="background-color: #f8f9fa; border-radius: 8px; padding: 16px; margin-top: 24px;">
                                <p style="margin: 0; font-size: 14px; color: #666; line-height: 1.5;">
                                    If you didn't create an account with Growth Tracker, you can safely ignore this email.
                                </p>
                            </div>
                            
                            <p style="margin: 24px 0 0; font-size: 12px; color: #999; line-height: 1.5; word-break: break-all;">
                                If the button doesn't work, copy and paste this link into your browser:<br>
                                <a href="%s" style="color: #22c55e;">%s</a>
                            </p>
                        </td>
                    </tr>
                    
                    <tr>
                        <td style="padding: 24px 32px; border-top: 1px solid #eee; text-align: center;">
                            <p style="margin: 0; font-size: 12px; color: #999;">
                                Growth Tracker • Track your daily activities
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
`, username, verifyLink, verifyLink, verifyLink)
}

func (s *EmailService) buildPasswordResetHTML(username, resetLink string) string {
	return fmt.Sprintf(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
    <table width="100%%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
        <tr>
            <td align="center">
                <table width="100%%" style="max-width: 480px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                    <tr>
                        <td style="padding: 40px 32px;">
                            <div style="text-align: center; margin-bottom: 32px;">
                                <h1 style="margin: 0; font-size: 24px; font-weight: 700; color: #1a1a1a;">
                                    🔐 Password Reset
                                </h1>
                            </div>
                            
                            <p style="margin: 0 0 16px; font-size: 16px; color: #333; line-height: 1.5;">
                                Hi <strong>%s</strong>,
                            </p>
                            <p style="margin: 0 0 24px; font-size: 16px; color: #333; line-height: 1.5;">
                                We received a request to reset your password for your Growth Tracker account. Click the button below to set a new password:
                            </p>
                            
                            <div style="text-align: center; margin: 32px 0;">
                                <a href="%s" style="display: inline-block; padding: 14px 32px; background-color: #0066ff; color: #ffffff; text-decoration: none; font-weight: 600; font-size: 16px; border-radius: 8px;">
                                    Reset Password
                                </a>
                            </div>
                            
                            <p style="margin: 0 0 16px; font-size: 14px; color: #666; line-height: 1.5;">
                                ⏰ This link will expire in <strong>15 minutes</strong>.
                            </p>
                            
                            <div style="background-color: #f8f9fa; border-radius: 8px; padding: 16px; margin-top: 24px;">
                                <p style="margin: 0; font-size: 14px; color: #666; line-height: 1.5;">
                                    If you didn't request this password reset, you can safely ignore this email. Your password will remain unchanged.
                                </p>
                            </div>
                            
                            <p style="margin: 24px 0 0; font-size: 12px; color: #999; line-height: 1.5; word-break: break-all;">
                                If the button doesn't work, copy and paste this link into your browser:<br>
                                <a href="%s" style="color: #0066ff;">%s</a>
                            </p>
                        </td>
                    </tr>
                    
                    <tr>
                        <td style="padding: 24px 32px; border-top: 1px solid #eee; text-align: center;">
                            <p style="margin: 0; font-size: 12px; color: #999;">
                                Growth Tracker • Track your daily activities
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
`, username, resetLink, resetLink, resetLink)
}

// ==================== Cron Service ====================

// CronService handles scheduled job logic
type CronService struct {
	userRepo       *repository.UserRepository
	streakRepo     *repository.StreakRepository
	cronJobLogRepo *repository.CronJobLogRepository
	streakSvc      *StreakService
	emailSvc       *EmailService
	notifSvc       *NotificationService
	instanceID     string
}

// NewCronService creates a new CronService
func NewCronService(
	userRepo *repository.UserRepository,
	streakRepo *repository.StreakRepository,
	cronJobLogRepo *repository.CronJobLogRepository,
	streakSvc *StreakService,
	emailSvc *EmailService,
	notifSvc *NotificationService,
) *CronService {
	// Generate instance ID from hostname or random string for tracking
	instanceID := os.Getenv("HOSTNAME")
	if instanceID == "" {
		instanceID = fmt.Sprintf("instance-%d", time.Now().UnixNano()%10000)
	}
	return &CronService{
		userRepo:       userRepo,
		streakRepo:     streakRepo,
		cronJobLogRepo: cronJobLogRepo,
		streakSvc:      streakSvc,
		emailSvc:       emailSvc,
		notifSvc:       notifSvc,
		instanceID:     instanceID,
	}
}

// RunDailyJob runs the daily streak processing job
func (s *CronService) RunDailyJob(ctx context.Context) error {
	// Compute today's date in IST
	loc, _ := time.LoadLocation(constants.TimezoneIST)
	nowIST := time.Now().In(loc)
	todayIST := time.Date(
		nowIST.Year(),
		nowIST.Month(),
		nowIST.Day(),
		0, 0, 0, 0,
		loc,
	)

	// Check if job already ran successfully today (idempotency)
	if s.cronJobLogRepo != nil {
		existingLog, err := s.cronJobLogRepo.FindByJobNameAndDate(models.CronJobDailyStreak, todayIST)
		if err != nil {
			logger.Sugar.Warnw("Failed to check existing cron job log", "error", err)
		}
		if existingLog != nil {
			logger.Sugar.Infow("Daily streak job already completed for today, skipping",
				"job_date", todayIST.Format(constants.DateFormat),
				"completed_by", existingLog.InstanceID,
			)
			return nil
		}
	}

	// Create job log entry
	jobLog := &models.CronJobLog{
		JobName:    models.CronJobDailyStreak,
		JobDate:    todayIST,
		StartedAt:  time.Now(),
		Status:     models.CronJobStatusRunning,
		InstanceID: s.instanceID,
	}
	if s.cronJobLogRepo != nil {
		if err := s.cronJobLogRepo.Create(jobLog); err != nil {
			logger.Sugar.Warnw("Failed to create cron job log", "error", err)
		}
	}

	users, err := s.userRepo.GetAll()
	if err != nil {
		s.updateJobLog(jobLog, models.CronJobStatusFailed, 0, err.Error())
		return err
	}

	processedCount := 0
	for _, user := range users {
		if err := s.streakSvc.AddStreak(user.ID, todayIST, true); err != nil {
			s.updateJobLog(jobLog, models.CronJobStatusFailed, processedCount, err.Error())
			return err
		}
		processedCount++
	}

	s.updateJobLog(jobLog, models.CronJobStatusCompleted, processedCount, "")
	logger.Sugar.Infow("Daily streak job completed",
		"users_processed", processedCount,
		"instance_id", s.instanceID,
	)

	return nil
}

// updateJobLog updates a job log with completion status
func (s *CronService) updateJobLog(log *models.CronJobLog, status string, usersCount int, errorMsg string) {
	if s.cronJobLogRepo == nil || log == nil || log.ID == 0 {
		return
	}
	log.Status = status
	log.UsersCount = usersCount
	log.CompletedAt = time.Now()
	log.Error = errorMsg
	if err := s.cronJobLogRepo.Update(log); err != nil {
		logger.Sugar.Warnw("Failed to update cron job log", "error", err)
	}
}

// SendStreakReminders sends push and in-app notifications to users who haven't logged today.
// Runs at 10 PM IST to remind users while they still have time to log.
func (s *CronService) SendStreakReminders(ctx context.Context) error {
	if s.notifSvc == nil {
		return fmt.Errorf("notification service not configured")
	}

	loc, err := time.LoadLocation(constants.TimezoneIST)
	if err != nil {
		return fmt.Errorf("failed to load timezone: %v", err)
	}

	today := time.Now().In(loc).Format(constants.DateFormat)

	// Find users who haven't logged today (streak = 0 for today)
	userIDs, err := s.streakRepo.FindUsersMissedStreak(today)
	if err != nil {
		return fmt.Errorf("failed to find users who missed streak: %w", err)
	}

	if len(userIDs) == 0 {
		logger.Sugar.Info("All users have logged today")
		return nil
	}

	logger.Sugar.Infow("Sending streak reminders",
		"user_count", len(userIDs),
		"date", today,
	)

	// Send notifications to each user
	var successCount, failCount int
	for _, userID := range userIDs {
		if err := s.notifSvc.NotifyStreakReminder(ctx, userID, today); err != nil {
			logger.Sugar.Warnw("Failed to send streak reminder",
				"user_id", userID,
				"error", err,
			)
			failCount++
			continue
		}
		successCount++
	}

	logger.Sugar.Infow("Streak reminders completed",
		"success", successCount,
		"failed", failCount,
	)

	return nil
}

// CleanupOldNotifications removes old notifications based on retention policy
// Should be called daily at off-peak hours (e.g., 3 AM)
func (s *CronService) CleanupOldNotifications(ctx context.Context) error {
	if s.notifSvc == nil {
		return nil // Notification service not configured
	}

	deleted, err := s.notifSvc.CleanupOldNotifications(ctx)
	if err != nil {
		return fmt.Errorf("notification cleanup failed: %w", err)
	}

	if deleted > 0 {
		logger.Sugar.Infow("Notification cleanup completed",
			"deleted_count", deleted,
		)
	}

	return nil
}

// ==================== Blob Service ====================

// BlobService handles profile picture storage
type BlobService struct {
	userRepo    *repository.UserRepository
	accountName string
	container   string
	// blobClient would be the Azure SDK client
	enabled bool
}

// NewBlobService creates a new BlobService
func NewBlobService(userRepo *repository.UserRepository, cfg *config.AzureStorageConfig) *BlobService {
	return &BlobService{
		userRepo:    userRepo,
		accountName: cfg.AccountName,
		container:   cfg.ContainerName,
		enabled:     cfg.ConnectionString != "",
	}
}

// IsEnabled returns whether blob storage is configured
func (s *BlobService) IsEnabled() bool {
	return s.enabled
}

// GetUser retrieves a user by ID
func (s *BlobService) GetUser(userID uint) (*models.User, error) {
	return s.userRepo.FindByID(userID)
}

// UpdateProfilePic updates the user's profile picture URL
func (s *BlobService) UpdateProfilePic(userID uint, url *string) error {
	return s.userRepo.UpdateProfilePic(userID, url)
}

// GeneratePublicURL generates the public URL for a blob
func (s *BlobService) GeneratePublicURL(blobName string) string {
	return fmt.Sprintf("https://%s.blob.core.windows.net/%s/%s", s.accountName, s.container, blobName)
}
