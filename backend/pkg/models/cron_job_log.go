package models

import "time"

// CronJobLog records each execution of a cron job for auditing and debugging
type CronJobLog struct {
	ID uint `gorm:"primaryKey"`

	JobName     string    `gorm:"not null;size:100;index:idx_cron_job_date"`  // e.g., "daily_streak", "streak_reminder", "notification_cleanup"
	JobDate     time.Time `gorm:"type:date;not null;index:idx_cron_job_date"` // The date the job was processing for
	StartedAt   time.Time `gorm:"not null"`                                   // When the job started
	CompletedAt time.Time `gorm:""`                                           // When the job completed (null if failed/running)
	Status      string    `gorm:"not null;size:20;default:'running'"`         // running, completed, failed
	UsersCount  int       `gorm:"default:0"`                                  // Number of users processed
	Error       string    `gorm:"type:text"`                                  // Error message if failed
	InstanceID  string    `gorm:"size:100"`                                   // Container/instance identifier for debugging multi-replica issues
}

// TableName specifies the table name for CronJobLog
func (CronJobLog) TableName() string {
	return "cron_job_logs"
}

// CronJobName constants
const (
	CronJobDailyStreak          = "daily_streak"
	CronJobStreakReminder       = "streak_reminder"
	CronJobNotificationCleanup  = "notification_cleanup"
	CronJobFollowTombstoneClean = "follow_tombstone_cleanup"
)

// CronJobStatus constants
const (
	CronJobStatusRunning   = "running"
	CronJobStatusCompleted = "completed"
	CronJobStatusFailed    = "failed"
	CronJobStatusSkipped   = "skipped"
)
