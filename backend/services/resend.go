package services

import (
	"fmt"
	"time"

	"github.com/aman1117/backend/models"
	"github.com/aman1117/backend/utils"
	"github.com/resend/resend-go/v3"
)

var resendClient *resend.Client

func InitResendClient() (*resend.Client, error) {
	if resendClient != nil {
		return resendClient, nil
	}

	apiKey := utils.GetFromEnv("RESEND_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("RESEND_API_KEY is not set")
	}

	resendClient = resend.NewClient(apiKey)
	return resendClient, nil
}

// SendStreakReminderEmails sends reminder emails to users who missed their streak yesterday
// This is called by the cron job at 9 AM IST
func SendStreakReminderEmails() error {
	db := utils.GetDB()

	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		return fmt.Errorf("failed to load timezone: %v", err)
	}

	yesterday := time.Now().In(loc).AddDate(0, 0, -1).Format("2006-01-02")

	var users []models.User

	db.
		Where("id IN (?)",
			db.Table("streaks").
				Where("current = 0").
				Select("user_id").
				Where("DATE(activity_date) = ?", yesterday),
		).
		Find(&users)
	if len(users) == 0 {
		fmt.Println("No users found who missed their streak yesterday")
		return nil
	}

	client, err := InitResendClient()
	if err != nil {
		return fmt.Errorf("failed to initialize resend client: %v", err)
	}
	notSuccessful := 0
	for _, user := range users {
		subject := fmt.Sprintf("Don’t lose your streak, %s! 🔥", user.Username)

		html := fmt.Sprintf(`
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
`, user.Username)

		params := &resend.SendEmailRequest{
			From:    "Aman | Growth Tracker <aman@amancodes.dev>",
			To:      []string{user.Email},
			Subject: subject,
			Html:    html,
		}

		if _, err := client.Emails.Send(params); err != nil {
			fmt.Printf("Failed to send email to %s: %v\n", user.Email, err)
			notSuccessful++
		}
	}

	fmt.Printf("Sent emails to %d users, %d were not successful\n", len(users), notSuccessful)
	return nil
}
