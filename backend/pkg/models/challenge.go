package models

import "time"

// Challenge goal types: the daily hours of the activity must reach the target (at least) or
// stay within it (at most).
const (
	ChallengeGoalAtLeast = "at_least"
	ChallengeGoalAtMost  = "at_most"
)

// Challenge is a shared daily time goal for one predefined activity over a fixed run of days.
// Dates are IST calendar dates stored as DATE columns.
type Challenge struct {
	ID            uint       `gorm:"primaryKey"`
	CreatorID     uint       `gorm:"not null;index:idx_challenge_creator"`
	Creator       User       `gorm:"foreignKey:CreatorID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE" json:"-"`
	Title         string     `gorm:"type:varchar(60);not null"`
	Activity      string     `gorm:"type:varchar(50);not null"`
	GoalType      string     `gorm:"type:varchar(10);not null"`
	TargetHours   float64    `gorm:"type:decimal(4,2);not null"`
	StartDate     time.Time  `gorm:"type:date;not null"`
	EndDate       time.Time  `gorm:"type:date;not null;index:idx_challenge_end_date"`
	InviteCode    string     `gorm:"type:varchar(8);not null;uniqueIndex:idx_challenge_invite_code"`
	LockedThrough *time.Time `gorm:"type:date"`        // last date whose results are final (snapshotted)
	FinalizedAt   *time.Time `gorm:"type:timestamptz"` // set once the final results are stored
	CreatedAt     time.Time  `gorm:"not null;default:now();autoCreateTime"`
	UpdatedAt     time.Time  `gorm:"not null;default:now();autoUpdateTime"`
}

// TableName specifies the table name for Challenge
func (Challenge) TableName() string {
	return "challenges"
}

// DurationDays returns the number of calendar days from StartDate through EndDate.
func (c *Challenge) DurationDays() int {
	start := time.Date(c.StartDate.Year(), c.StartDate.Month(), c.StartDate.Day(), 0, 0, 0, 0, time.UTC)
	end := time.Date(c.EndDate.Year(), c.EndDate.Month(), c.EndDate.Day(), 0, 0, 0, 0, time.UTC)
	return int(end.Sub(start)/(24*time.Hour)) + 1
}

// ChallengeParticipant links a user to a challenge. The Final* fields and Completed are
// stored when the challenge is finalized.
type ChallengeParticipant struct {
	ID              uint      `gorm:"primaryKey"`
	ChallengeID     uint      `gorm:"not null;uniqueIndex:idx_challenge_participant,priority:1"`
	Challenge       Challenge `gorm:"foreignKey:ChallengeID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE" json:"-"`
	UserID          uint      `gorm:"not null;uniqueIndex:idx_challenge_participant,priority:2;index:idx_challenge_participant_user"`
	User            User      `gorm:"foreignKey:UserID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE" json:"-"`
	JoinedAt        time.Time `gorm:"type:timestamptz;not null"`
	JoinedOn        time.Time `gorm:"type:date;not null"` // IST date of JoinedAt
	FinalRank       *int
	FinalDaysMet    *int
	FinalTotalHours *float64 `gorm:"type:decimal(6,2)"`
	Completed       *bool
}

// TableName specifies the table name for ChallengeParticipant
func (ChallengeParticipant) TableName() string {
	return "challenge_participants"
}

// ChallengeDay is the locked (final) result of one participant on one challenge date.
type ChallengeDay struct {
	ID          uint      `gorm:"primaryKey"`
	ChallengeID uint      `gorm:"not null;uniqueIndex:idx_challenge_day,priority:1"`
	Challenge   Challenge `gorm:"foreignKey:ChallengeID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE" json:"-"`
	UserID      uint      `gorm:"not null;uniqueIndex:idx_challenge_day,priority:2"`
	User        User      `gorm:"foreignKey:UserID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE" json:"-"`
	DayDate     time.Time `gorm:"type:date;not null;uniqueIndex:idx_challenge_day,priority:3"`
	Hours       float64   `gorm:"type:decimal(4,2);not null;default:0"` // hours of the challenge activity
	Logged      bool      `gorm:"not null;default:false"`               // any activity logged that day
	Met         bool      `gorm:"not null;default:false"`
	LockedAt    time.Time `gorm:"type:timestamptz;not null"`
}

// TableName specifies the table name for ChallengeDay
func (ChallengeDay) TableName() string {
	return "challenge_days"
}

// ChallengeCheer records that one participant cheered another on an IST date.
type ChallengeCheer struct {
	ID          uint      `gorm:"primaryKey"`
	ChallengeID uint      `gorm:"not null;uniqueIndex:idx_challenge_cheer,priority:1"`
	Challenge   Challenge `gorm:"foreignKey:ChallengeID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE" json:"-"`
	FromUserID  uint      `gorm:"not null;uniqueIndex:idx_challenge_cheer,priority:2"`
	FromUser    User      `gorm:"foreignKey:FromUserID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE" json:"-"`
	ToUserID    uint      `gorm:"not null;uniqueIndex:idx_challenge_cheer,priority:3"`
	ToUser      User      `gorm:"foreignKey:ToUserID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE" json:"-"`
	CheerDate   time.Time `gorm:"type:date;not null;uniqueIndex:idx_challenge_cheer,priority:4"`
	CreatedAt   time.Time `gorm:"not null;default:now();autoCreateTime"`
}

// TableName specifies the table name for ChallengeCheer
func (ChallengeCheer) TableName() string {
	return "challenge_cheers"
}

// ChallengeInvite records that a user was invited to a challenge (once, by anyone).
type ChallengeInvite struct {
	ID          uint      `gorm:"primaryKey"`
	ChallengeID uint      `gorm:"not null;uniqueIndex:idx_challenge_invite,priority:1"`
	Challenge   Challenge `gorm:"foreignKey:ChallengeID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE" json:"-"`
	InviterID   uint      `gorm:"not null"`
	Inviter     User      `gorm:"foreignKey:InviterID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE" json:"-"`
	InviteeID   uint      `gorm:"not null;uniqueIndex:idx_challenge_invite,priority:2;index:idx_challenge_invite_invitee"`
	Invitee     User      `gorm:"foreignKey:InviteeID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE" json:"-"`
	CreatedAt   time.Time `gorm:"not null;default:now();autoCreateTime"`
}

// TableName specifies the table name for ChallengeInvite
func (ChallengeInvite) TableName() string {
	return "challenge_invites"
}
