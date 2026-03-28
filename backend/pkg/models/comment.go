package models

import "time"

// Comment represents a comment on a user's day.
// Top-level comments have ParentCommentID = nil and RootCommentID = nil.
// Replies have ParentCommentID set and RootCommentID pointing to the top-level comment.
type Comment struct {
	ID              uint       `gorm:"primaryKey" json:"id"`
	DayOwnerID      uint       `gorm:"not null;index:idx_comment_day_date,priority:1" json:"day_owner_id"`
	DayDate         time.Time  `gorm:"type:date;not null;index:idx_comment_day_date,priority:2" json:"day_date"`
	AuthorID        uint       `gorm:"not null;index:idx_comment_author" json:"author_id"`
	Author          User       `gorm:"foreignKey:AuthorID;constraint:OnDelete:CASCADE" json:"-"`
	ParentCommentID *uint      `gorm:"index:idx_comment_parent" json:"parent_comment_id"`
	RootCommentID   *uint      `gorm:"index:idx_comment_root_created,priority:1" json:"root_comment_id"`
	ReplyToUserID   *uint      `json:"reply_to_user_id"`
	Body            string     `gorm:"type:text;not null" json:"body"`
	LikeCount       int        `gorm:"not null;default:0" json:"like_count"`
	ReplyCount      int        `gorm:"not null;default:0" json:"reply_count"`
	IsEdited        bool       `gorm:"not null;default:false" json:"is_edited"`
	IsDeleted       bool       `gorm:"not null;default:false" json:"is_deleted"`
	DeletedAt       *time.Time `json:"deleted_at,omitempty"`
	CreatedAt       time.Time  `gorm:"not null;default:now();autoCreateTime;index:idx_comment_root_created,priority:2,sort:desc" json:"created_at"`
	UpdatedAt       time.Time  `gorm:"not null;default:now();autoUpdateTime" json:"updated_at"`
}

// TableName returns the table name for Comment
func (Comment) TableName() string {
	return "comments"
}

// IsTopLevel returns true if this is a top-level comment (not a reply)
func (c *Comment) IsTopLevel() bool {
	return c.ParentCommentID == nil
}

// CommentLike represents a user liking a comment.
// Unique constraint on (comment_id, user_id) prevents duplicate likes.
type CommentLike struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	CommentID uint      `gorm:"not null;uniqueIndex:idx_comment_like_unique,priority:1;index:idx_comment_like_comment" json:"comment_id"`
	UserID    uint      `gorm:"not null;uniqueIndex:idx_comment_like_unique,priority:2;index:idx_comment_like_user" json:"user_id"`
	CreatedAt time.Time `gorm:"not null;default:now();autoCreateTime" json:"created_at"`
}

// TableName returns the table name for CommentLike
func (CommentLike) TableName() string {
	return "comment_likes"
}

// CommentMention represents an @mention of a user in a comment.
// Username is a snapshot at mention time so display is stable across username changes.
type CommentMention struct {
	ID              uint      `gorm:"primaryKey" json:"id"`
	CommentID       uint      `gorm:"not null;index:idx_comment_mention_comment" json:"comment_id"`
	MentionedUserID uint      `gorm:"not null;index:idx_comment_mention_user" json:"mentioned_user_id"`
	Username        string    `gorm:"type:varchar(20);not null" json:"username"`
	CreatedAt       time.Time `gorm:"not null;default:now();autoCreateTime" json:"created_at"`
}

// TableName returns the table name for CommentMention
func (CommentMention) TableName() string {
	return "comment_mentions"
}

// CommentDedupe prevents duplicate comment submissions.
// Uses both client-provided idempotency key and server-side body hash.
// The 60-second window is enforced in the service layer.
type CommentDedupe struct {
	ID             uint      `gorm:"primaryKey"`
	UserID         uint      `gorm:"not null;uniqueIndex:idx_comment_dedupe,priority:1"`
	DayOwnerID     uint      `gorm:"not null;uniqueIndex:idx_comment_dedupe,priority:2"`
	DayDate        time.Time `gorm:"type:date;not null;uniqueIndex:idx_comment_dedupe,priority:3"`
	BodyHash       string    `gorm:"type:varchar(64);not null;uniqueIndex:idx_comment_dedupe,priority:4"`
	IdempotencyKey *string   `gorm:"type:varchar(64);uniqueIndex:idx_comment_idempotency"`
	CommentID      uint      `gorm:"not null"`
	CreatedAt      time.Time `gorm:"not null;default:now();autoCreateTime;index:idx_comment_dedupe_created"`
}

// TableName returns the table name for CommentDedupe
func (CommentDedupe) TableName() string {
	return "comment_dedupes"
}
