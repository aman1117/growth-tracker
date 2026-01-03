package services

import (
	"context"
	"fmt"
	"time"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/pkg/models"
	"github.com/resend/resend-go/v3"
)

// EmailService handles email-related operations
type EmailService struct {
	client      *resend.Client
	fromAddress string
	fromName    string
	frontendURL string
}

// NewEmailService creates a new EmailService
func NewEmailService(cfg *config.EmailConfig, frontendURL string) (*EmailService, error) {
	if cfg.ResendAPIKey == "" {
		return nil, fmt.Errorf("RESEND_API_KEY is not set")
	}

	return &EmailService{
		client:      resend.NewClient(cfg.ResendAPIKey),
		fromAddress: cfg.FromAddress,
		fromName:    cfg.FromName,
		frontendURL: frontendURL,
	}, nil
}

// SendPasswordResetEmail sends a password reset email
func (s *EmailService) SendPasswordResetEmail(email, username, token string) error {
	resetLink := fmt.Sprintf("%s/reset-password?token=%s", s.frontendURL, token)

	htmlContent := s.buildPasswordResetHTML(username, resetLink)

	params := &resend.SendEmailRequest{
		From:    fmt.Sprintf("%s <%s>", s.fromName, s.fromAddress),
		To:      []string{email},
		Subject: "Reset Your Password - Growth Tracker",
		Html:    htmlContent,
	}

	_, err := s.client.Emails.Send(params)
	return err
}

// SendStreakReminderEmail sends a streak reminder email
func (s *EmailService) SendStreakReminderEmail(email, username string) error {
	subject := fmt.Sprintf("Don't lose your streak, %s! 🔥", username)

	htmlContent := s.buildStreakReminderHTML(username)

	params := &resend.SendEmailRequest{
		From:    fmt.Sprintf("Aman | %s <%s>", s.fromName, s.fromAddress),
		To:      []string{email},
		Subject: subject,
		Html:    htmlContent,
	}

	_, err := s.client.Emails.Send(params)
	return err
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

func (s *EmailService) buildStreakReminderHTML(username string) string {
	return fmt.Sprintf(`
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border-radius: 12px; border: 1px solid #e5e7eb; background-color: #ffffff;">
    <h2 style="margin: 0 0 16px; color: #111827;">Hi %s 👋</h2>
    <p style="margin: 0 0 12px; color: #374151;">
        You missed your streak yesterday, but you can still update your logs.
    </p>
    <p style="margin: 0 0 20px; color: #374151;">
        Just head over to Growth Tracker and update your logs for yesterday.
    </p>
    <div style="margin: 0 0 24px;">
        <a href="https://track-growth.vercel.app/"
           style="display: inline-block; padding: 10px 20px; background-color: #4f46e5; color: #ffffff; text-decoration: none; border-radius: 999px; font-weight: 600;">
            Update yesterday's logs
        </a>
    </div>
    <p style="margin: 0 0 4px; color: #111827;">
        Keep growing 🌱
    </p>
    <p style="margin: 0; font-weight: 600; color:#111827;">Aman</p>
</div>
`, username)
}

// ==================== Cron Service ====================

// CronService handles scheduled job logic
type CronService struct {
	userRepo   *repository.UserRepository
	streakRepo *repository.StreakRepository
	streakSvc  *StreakService
	emailSvc   *EmailService
}

// NewCronService creates a new CronService
func NewCronService(
	userRepo *repository.UserRepository,
	streakRepo *repository.StreakRepository,
	streakSvc *StreakService,
	emailSvc *EmailService,
) *CronService {
	return &CronService{
		userRepo:   userRepo,
		streakRepo: streakRepo,
		streakSvc:  streakSvc,
		emailSvc:   emailSvc,
	}
}

// RunDailyJob runs the daily streak processing job
func (s *CronService) RunDailyJob(ctx context.Context) error {
	users, err := s.userRepo.GetAll()
	if err != nil {
		return err
	}

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

	for _, user := range users {
		if err := s.streakSvc.AddStreak(user.ID, todayIST, true); err != nil {
			return err
		}
	}

	return nil
}

// SendStreakReminderEmails sends reminder emails to users who missed their streak
func (s *CronService) SendStreakReminderEmails() error {
	if s.emailSvc == nil {
		return fmt.Errorf("email service not configured")
	}

	loc, err := time.LoadLocation(constants.TimezoneIST)
	if err != nil {
		return fmt.Errorf("failed to load timezone: %v", err)
	}

	yesterday := time.Now().In(loc).AddDate(0, 0, -1).Format(constants.DateFormat)

	// Find users who missed their streak yesterday
	userIDs, err := s.streakRepo.FindUsersMissedStreak(yesterday)
	if err != nil {
		return err
	}

	if len(userIDs) == 0 {
		return nil
	}

	// Get user details and send emails
	var notSuccessful int
	for _, userID := range userIDs {
		user, err := s.userRepo.FindByID(userID)
		if err != nil || user == nil {
			notSuccessful++
			continue
		}

		if err := s.emailSvc.SendStreakReminderEmail(user.Email, user.Username); err != nil {
			notSuccessful++
		}
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
