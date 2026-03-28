package services

import (
	"context"
	"crypto/sha256"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/validator"
	"github.com/aman1117/backend/pkg/models"
	"github.com/aman1117/backend/pkg/redis"
)

// CommentService handles comment business logic
type CommentService struct {
	commentRepo *repository.CommentRepository
	likeRepo    *repository.CommentLikeRepository
	mentionRepo *repository.CommentMentionRepository
	dedupeRepo  *repository.CommentDedupeRepository
	userRepo    *repository.UserRepository
	followRepo  *repository.FollowRepository
	notifSvc    *NotificationService
	profileSvc  *ProfileService
}

// NewCommentService creates a new CommentService
func NewCommentService(
	commentRepo *repository.CommentRepository,
	likeRepo *repository.CommentLikeRepository,
	mentionRepo *repository.CommentMentionRepository,
	dedupeRepo *repository.CommentDedupeRepository,
	userRepo *repository.UserRepository,
	followRepo *repository.FollowRepository,
	notifSvc *NotificationService,
	profileSvc *ProfileService,
) *CommentService {
	return &CommentService{
		commentRepo: commentRepo,
		likeRepo:    likeRepo,
		mentionRepo: mentionRepo,
		dedupeRepo:  dedupeRepo,
		userRepo:    userRepo,
		followRepo:  followRepo,
		notifSvc:    notifSvc,
		profileSvc:  profileSvc,
	}
}

// CreateComment creates a new comment on a day
func (s *CommentService) CreateComment(
	ctx context.Context,
	authorID uint,
	authorUsername string,
	dayOwnerID uint,
	dayOwnerUsername string,
	dayDate time.Time,
	body string,
	parentCommentID *uint,
	idempotencyKey *string,
) (*dto.CommentDTO, error) {
	trimmedBody := strings.TrimSpace(body)

	// 1. Check idempotency key
	if idempotencyKey != nil && *idempotencyKey != "" {
		existing, err := s.dedupeRepo.CheckIdempotencyKey(*idempotencyKey, constants.CommentDedupeWindow)
		if err != nil {
			logger.Sugar.Warnw("Idempotency check failed, proceeding",
				"key", *idempotencyKey,
				"error", err,
			)
		}
		if existing != nil {
			comment, err := s.commentRepo.GetByIDWithAuthor(existing.CommentID)
			if err == nil && comment != nil {
				logger.Sugar.Debugw("Idempotency key matched, returning existing comment",
					"key", *idempotencyKey,
					"comment_id", existing.CommentID,
				)
				return s.buildCommentDTO(comment, authorID, nil, nil), nil
			}
		}
	}

	// 2. Validate body
	if valErr := validator.ValidateCommentBody(trimmedBody); valErr != nil {
		return nil, valErr
	}

	// 3. Body hash dedup
	bodyHash := hashBody(trimmedBody)
	existingDedupe, err := s.dedupeRepo.CheckBodyHash(authorID, dayOwnerID, dayDate, bodyHash, constants.CommentDedupeWindow)
	if err != nil {
		logger.Sugar.Warnw("Body hash dedup check failed, proceeding",
			"author_id", authorID,
			"error", err,
		)
	}
	if existingDedupe != nil {
		logger.Sugar.Infow("Duplicate comment rejected (body hash)",
			"author_id", authorID,
			"day_owner_id", dayOwnerID,
			"day_date", dayDate.Format(constants.DateFormat),
		)
		return nil, validator.NewValidationError(
			"Duplicate comment detected. Please wait before posting again.",
			constants.ErrCodeDuplicateComment,
		)
	}

	// 4. Parse and validate mentions
	mentionedUsernames, valErr := validator.ParseMentions(trimmedBody)
	if valErr != nil {
		return nil, valErr
	}

	// 5. Resolve parent/root for replies
	var rootCommentID *uint
	var replyToUserID *uint
	var parentComment *models.Comment

	if parentCommentID != nil {
		parentComment, err = s.commentRepo.GetByID(*parentCommentID)
		if err != nil {
			return nil, validator.NewValidationError(
				"Parent comment not found",
				constants.ErrCodeParentNotFound,
			)
		}

		// Determine root: if parent is top-level, root = parent.ID; else root = parent's root
		if parentComment.RootCommentID == nil {
			id := parentComment.ID
			rootCommentID = &id
		} else {
			rootCommentID = parentComment.RootCommentID
		}

		replyToUserID = &parentComment.AuthorID
	}

	// 6. Create comment
	comment := &models.Comment{
		DayOwnerID:      dayOwnerID,
		DayDate:         dayDate,
		AuthorID:        authorID,
		ParentCommentID: parentCommentID,
		RootCommentID:   rootCommentID,
		ReplyToUserID:   replyToUserID,
		Body:            trimmedBody,
	}

	if err := s.commentRepo.Create(comment); err != nil {
		return nil, fmt.Errorf("failed to create comment: %w", err)
	}

	// 7. Store dedupe record
	dedupe := &models.CommentDedupe{
		UserID:         authorID,
		DayOwnerID:     dayOwnerID,
		DayDate:        dayDate,
		BodyHash:       bodyHash,
		IdempotencyKey: idempotencyKey,
		CommentID:      comment.ID,
	}
	if err := s.dedupeRepo.Upsert(dedupe); err != nil {
		logger.Sugar.Warnw("Failed to store dedupe record, continuing",
			"comment_id", comment.ID,
			"error", err,
		)
	}

	// 8. Increment reply_count on every ancestor (parent → root)
	if parentCommentID != nil {
		if err := s.commentRepo.IncrementAncestorReplyCounts(comment.ID); err != nil {
			logger.Sugar.Errorw("Failed to increment ancestor reply counts",
				"comment_id", comment.ID,
				"error", err,
			)
		}
	}

	// 9. Resolve mentions and store
	mentionDTOs := s.resolveMentions(comment.ID, mentionedUsernames)

	// 10. Invalidate comment count cache
	s.invalidateCountCache(ctx, dayOwnerID, dayDate)

	// 11. Get author info for response
	author, _ := s.userRepo.FindByID(authorID)
	result := &dto.CommentDTO{
		ID:              comment.ID,
		DayOwnerID:      dayOwnerID,
		DayDate:         dayDate.Format(constants.DateFormat),
		AuthorID:        authorID,
		AuthorUsername:  authorUsername,
		ParentCommentID: parentCommentID,
		RootCommentID:   rootCommentID,
		ReplyToUserID:   replyToUserID,
		Body:            trimmedBody,
		LikeCount:       0,
		ReplyCount:      0,
		IsEdited:        false,
		IsDeleted:       false,
		LikedByMe:       false,
		Mentions:        mentionDTOs,
		CreatedAt:       comment.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}
	if author != nil {
		result.AuthorAvatar = author.ProfilePic
		result.AuthorVerified = author.IsVerified
	}
	if replyToUserID != nil {
		replyToUsername, _ := s.commentRepo.GetReplyToUsername(*replyToUserID)
		if replyToUsername != "" {
			result.ReplyToUsername = &replyToUsername
		}
	}

	if len(result.Mentions) == 0 {
		result.Mentions = []dto.MentionDTO{}
	}

	// 12. Async notifications
	go s.sendCommentNotifications(
		context.Background(),
		comment,
		authorUsername,
		author,
		dayOwnerID,
		dayOwnerUsername,
		dayDate,
		parentComment,
		mentionDTOs,
	)

	logger.Sugar.Infow("Comment created",
		"comment_id", comment.ID,
		"author_id", authorID,
		"day_owner_id", dayOwnerID,
		"is_reply", parentCommentID != nil,
	)

	return result, nil
}

// DeleteComment soft-deletes a comment if authorized
func (s *CommentService) DeleteComment(ctx context.Context, commentID, requestingUserID, dayOwnerID uint) error {
	comment, err := s.commentRepo.GetByID(commentID)
	if err != nil {
		return validator.NewValidationError("Comment not found", constants.ErrCodeCommentNotFound)
	}
	if comment.IsDeleted {
		return validator.NewValidationError("Comment already deleted", constants.ErrCodeCommentDeleted)
	}

	// Authorization: author or day owner
	// If dayOwnerID is 0, use the comment's DayOwnerID (handler may not know it upfront)
	effectiveDayOwnerID := dayOwnerID
	if effectiveDayOwnerID == 0 {
		effectiveDayOwnerID = comment.DayOwnerID
	}
	if comment.AuthorID != requestingUserID && effectiveDayOwnerID != requestingUserID {
		logger.Sugar.Warnw("Unauthorized comment delete attempt",
			"comment_id", commentID,
			"requesting_user", requestingUserID,
			"author_id", comment.AuthorID,
			"day_owner_id", effectiveDayOwnerID,
		)
		return validator.NewValidationError("Not authorized to delete this comment", constants.ErrCodeCommentForbidden)
	}

	if err := s.commentRepo.SoftDelete(commentID); err != nil {
		return fmt.Errorf("failed to delete comment: %w", err)
	}

	// Decrement ancestor reply counts only if this reply has no children.
	// If it has children, it stays as a "[Deleted]" placeholder to keep the thread visible.
	if comment.ParentCommentID != nil && comment.ReplyCount == 0 {
		if err := s.commentRepo.DecrementAncestorReplyCounts(comment.ID); err != nil {
			logger.Sugar.Warnw("Failed to decrement ancestor reply counts",
				"comment_id", comment.ID,
				"error", err,
			)
		}
	}

	s.invalidateCountCache(ctx, comment.DayOwnerID, comment.DayDate)

	logger.Sugar.Infow("Comment deleted",
		"comment_id", commentID,
		"deleted_by", requestingUserID,
	)

	return nil
}

// LikeComment likes a comment (idempotent). Returns (liked, newCount, error).
func (s *CommentService) LikeComment(ctx context.Context, commentID, userID uint, username string) (bool, int, error) {
	comment, err := s.commentRepo.GetByID(commentID)
	if err != nil {
		return false, 0, validator.NewValidationError("Comment not found", constants.ErrCodeCommentNotFound)
	}
	if comment.IsDeleted {
		return false, 0, validator.NewValidationError("Cannot like a deleted comment", constants.ErrCodeCommentDeleted)
	}

	created, err := s.likeRepo.Create(commentID, userID)
	if err != nil {
		return false, 0, fmt.Errorf("failed to like comment: %w", err)
	}

	// Only increment count if actually created (not a duplicate)
	if created {
		if err := s.likeRepo.IncrementLikeCount(commentID); err != nil {
			logger.Sugar.Warnw("Failed to increment like count",
				"comment_id", commentID,
				"error", err,
			)
		}
	}

	newCount := comment.LikeCount
	if created {
		newCount++
	}

	logger.Sugar.Debugw("Comment like processed",
		"comment_id", commentID,
		"user_id", userID,
		"was_new_like", created,
		"new_count", newCount,
	)

	// Notify comment author (skip self-like, only on new like)
	if created && comment.AuthorID != userID && s.notifSvc != nil {
		user, _ := s.userRepo.FindByID(userID)
		dayOwner, _ := s.userRepo.FindByID(comment.DayOwnerID)
		avatar := ""
		dayOwnerUsername := ""
		if user != nil && user.ProfilePic != nil {
			avatar = *user.ProfilePic
		}
		if dayOwner != nil {
			dayOwnerUsername = dayOwner.Username
		}
		go s.notifSvc.NotifyCommentLiked(
			context.Background(),
			comment.AuthorID,
			userID,
			username,
			avatar,
			commentID,
			truncateCommentPreview(comment.Body),
			dayOwnerUsername,
			comment.DayDate.Format(constants.DateFormat),
		)
	}

	return true, newCount, nil
}

// UnlikeComment unlikes a comment. Returns (liked, newCount, error).
func (s *CommentService) UnlikeComment(ctx context.Context, commentID, userID uint) (bool, int, error) {
	comment, err := s.commentRepo.GetByID(commentID)
	if err != nil {
		return false, 0, validator.NewValidationError("Comment not found", constants.ErrCodeCommentNotFound)
	}

	deleted, err := s.likeRepo.Delete(commentID, userID)
	if err != nil {
		return false, 0, fmt.Errorf("failed to unlike comment: %w", err)
	}

	// Only decrement if actually deleted
	if deleted {
		if err := s.likeRepo.DecrementLikeCount(commentID); err != nil {
			logger.Sugar.Warnw("Failed to decrement like count",
				"comment_id", comment.ID,
				"error", err,
			)
		}
	}

	newCount := comment.LikeCount
	if deleted && newCount > 0 {
		newCount--
	}

	logger.Sugar.Debugw("Comment unlike processed",
		"comment_id", commentID,
		"user_id", userID,
		"was_removed", deleted,
		"new_count", newCount,
	)

	return false, newCount, nil
}

// GetTopLevelComments retrieves top-level comments for a day
func (s *CommentService) GetTopLevelComments(
	ctx context.Context,
	dayOwnerID, currentUserID uint,
	dayDate time.Time,
	sortBy string,
	cursor *uint,
	limit int,
) (*dto.CommentsListResponse, error) {
	if limit <= 0 || limit > constants.CommentListMaxLimit {
		limit = constants.CommentListDefaultLimit
	}

	var comments []repository.CommentWithAuthor
	var err error

	if sortBy == "top" {
		// For ranked sort, fetch all candidates without cursor (ranking invalidates ID-based cursor)
		// Then rank and paginate in memory
		comments, err = s.commentRepo.GetTopLevelByDay(dayOwnerID, dayDate, nil, limit*3)
		if err != nil {
			return nil, fmt.Errorf("failed to get comments: %w", err)
		}
		rankComments(comments)
		// Apply cursor after ranking (skip comments already seen)
		if cursor != nil && *cursor > 0 {
			skipIdx := -1
			for i, c := range comments {
				if c.ID == *cursor {
					skipIdx = i
					break
				}
			}
			if skipIdx >= 0 && skipIdx+1 < len(comments) {
				comments = comments[skipIdx+1:]
			} else if skipIdx >= 0 {
				comments = nil
			}
		}
	} else {
		// For newest sort, cursor-based pagination works naturally (ID-ordered)
		comments, err = s.commentRepo.GetTopLevelByDay(dayOwnerID, dayDate, cursor, limit)
		if err != nil {
			return nil, fmt.Errorf("failed to get comments: %w", err)
		}
	}

	// Paginate
	hasMore := len(comments) > limit
	if hasMore {
		comments = comments[:limit]
	}

	// Enrich with liked-by-me and mentions
	commentDTOs, err := s.enrichComments(comments, currentUserID)
	if err != nil {
		return nil, err
	}

	var nextCursor *uint
	if hasMore && len(commentDTOs) > 0 {
		lastID := commentDTOs[len(commentDTOs)-1].ID
		nextCursor = &lastID
	}

	return &dto.CommentsListResponse{
		Success:    true,
		Comments:   commentDTOs,
		HasMore:    hasMore,
		NextCursor: nextCursor,
	}, nil
}

// GetReplies retrieves replies for a root comment, oldest first
func (s *CommentService) GetReplies(
	ctx context.Context,
	rootCommentID, currentUserID uint,
	cursor *uint,
	limit int,
) (*dto.CommentsListResponse, error) {
	if limit <= 0 || limit > constants.CommentReplyMaxLimit {
		limit = constants.CommentReplyDefaultLimit
	}

	comments, err := s.commentRepo.GetRepliesByRoot(rootCommentID, cursor, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to get replies: %w", err)
	}

	hasMore := len(comments) > limit
	if hasMore {
		comments = comments[:limit]
	}

	commentDTOs, err := s.enrichComments(comments, currentUserID)
	if err != nil {
		return nil, err
	}

	var nextCursor *uint
	if hasMore && len(commentDTOs) > 0 {
		lastID := commentDTOs[len(commentDTOs)-1].ID
		nextCursor = &lastID
	}

	return &dto.CommentsListResponse{
		Success:    true,
		Comments:   commentDTOs,
		HasMore:    hasMore,
		NextCursor: nextCursor,
	}, nil
}

// GetCommentCount returns the comment count for a day (with caching)
func (s *CommentService) GetCommentCount(ctx context.Context, dayOwnerID uint, dayDate time.Time) (int64, error) {
	dateStr := dayDate.Format(constants.DateFormat)
	cacheKey := fmt.Sprintf("%s%d:%s", constants.CommentCountCachePrefix, dayOwnerID, dateStr)

	// Try cache
	if redis.IsAvailable() {
		cached, err := redis.Get().Get(ctx, cacheKey).Int64()
		if err == nil {
			logger.Sugar.Debugw("Comment count cache hit",
				"day_owner_id", dayOwnerID,
				"day_date", dateStr,
				"count", cached,
			)
			return cached, nil
		}
	}

	count, err := s.commentRepo.GetCommentCountForDay(dayOwnerID, dayDate)
	if err != nil {
		return 0, err
	}

	// Cache result
	if redis.IsAvailable() {
		redis.Get().Set(ctx, cacheKey, count, constants.CommentCountCacheTTL)
	}

	return count, nil
}

// GetCommentByID retrieves a comment by its ID (used for authorization checks)
func (s *CommentService) GetCommentByID(ctx context.Context, commentID uint) (*models.Comment, error) {
	return s.commentRepo.GetByID(commentID)
}

// ==================== Private Helpers ====================

func (s *CommentService) enrichComments(comments []repository.CommentWithAuthor, currentUserID uint) ([]dto.CommentDTO, error) {
	if len(comments) == 0 {
		return []dto.CommentDTO{}, nil
	}

	// Batch get liked-by-me
	commentIDs := make([]uint, len(comments))
	for i, c := range comments {
		commentIDs[i] = c.ID
	}

	likedMap, err := s.likeRepo.BatchHasLiked(commentIDs, currentUserID)
	if err != nil {
		logger.Sugar.Warnw("Failed to batch check likes", "error", err)
		likedMap = make(map[uint]bool)
	}

	// Batch get mentions
	mentionsMap, err := s.mentionRepo.GetByCommentIDs(commentIDs)
	if err != nil {
		logger.Sugar.Warnw("Failed to batch get mentions", "error", err)
		mentionsMap = make(map[uint][]models.CommentMention)
	}

	// Collect reply-to user IDs
	replyToUserIDs := make(map[uint]bool)
	for _, c := range comments {
		if c.ReplyToUserID != nil {
			replyToUserIDs[*c.ReplyToUserID] = true
		}
	}
	replyToUsernames := make(map[uint]string)
	for userID := range replyToUserIDs {
		uname, err := s.commentRepo.GetReplyToUsername(userID)
		if err == nil && uname != "" {
			replyToUsernames[userID] = uname
		}
	}

	dtos := make([]dto.CommentDTO, len(comments))
	for i, c := range comments {
		dtos[i] = *s.buildCommentDTO(&c, currentUserID, likedMap, mentionsMap)
		// Set reply-to username
		if c.ReplyToUserID != nil {
			if uname, ok := replyToUsernames[*c.ReplyToUserID]; ok {
				dtos[i].ReplyToUsername = &uname
			}
		}
	}

	return dtos, nil
}

func (s *CommentService) buildCommentDTO(
	c *repository.CommentWithAuthor,
	currentUserID uint,
	likedMap map[uint]bool,
	mentionsMap map[uint][]models.CommentMention,
) *dto.CommentDTO {
	result := &dto.CommentDTO{
		ID:              c.ID,
		DayOwnerID:      c.DayOwnerID,
		DayDate:         c.DayDate.Format(constants.DateFormat),
		AuthorID:        c.AuthorID,
		AuthorUsername:  c.AuthorUsername,
		AuthorAvatar:    c.AuthorAvatar,
		AuthorVerified:  c.AuthorVerified,
		ParentCommentID: c.ParentCommentID,
		RootCommentID:   c.RootCommentID,
		ReplyToUserID:   c.ReplyToUserID,
		Body:            c.Body,
		LikeCount:       c.LikeCount,
		ReplyCount:      c.ReplyCount,
		IsEdited:        c.IsEdited,
		IsDeleted:       c.IsDeleted,
		LikedByMe:       false,
		Mentions:        []dto.MentionDTO{},
		CreatedAt:       c.CreatedAt.Format("2006-01-02T15:04:05Z"),
	}

	if likedMap != nil {
		result.LikedByMe = likedMap[c.ID]
	}

	if mentionsMap != nil {
		if mentions, ok := mentionsMap[c.ID]; ok {
			for _, m := range mentions {
				result.Mentions = append(result.Mentions, dto.MentionDTO{
					UserID:   m.MentionedUserID,
					Username: m.Username,
				})
			}
		}
	}

	return result
}

// resolveMentions resolves @usernames to user IDs, stores CommentMention records,
// and returns the corresponding MentionDTOs. Used by both CreateComment and EditComment.
func (s *CommentService) resolveMentions(commentID uint, usernames []string) []dto.MentionDTO {
	if len(usernames) == 0 {
		return []dto.MentionDTO{}
	}

	users, err := s.userRepo.FindByUsernames(usernames)
	if err != nil {
		logger.Sugar.Warnw("Failed to resolve mention usernames",
			"comment_id", commentID,
			"usernames", usernames,
			"error", err,
		)
		return []dto.MentionDTO{}
	}
	if len(users) == 0 {
		return []dto.MentionDTO{}
	}

	logger.Sugar.Debugw("Mentions resolved",
		"comment_id", commentID,
		"requested", len(usernames),
		"resolved", len(users),
	)

	var mentions []models.CommentMention
	var mentionDTOs []dto.MentionDTO
	for _, u := range users {
		mentions = append(mentions, models.CommentMention{
			CommentID:       commentID,
			MentionedUserID: u.ID,
			Username:        u.Username,
		})
		mentionDTOs = append(mentionDTOs, dto.MentionDTO{
			UserID:   u.ID,
			Username: u.Username,
		})
	}
	if err := s.mentionRepo.CreateBatch(mentions); err != nil {
		logger.Sugar.Warnw("Failed to store mentions",
			"comment_id", commentID,
			"error", err,
		)
	}
	return mentionDTOs
}

// EditComment updates a comment's body if authorized and within the edit window.
// No notifications are sent on edit.
func (s *CommentService) EditComment(ctx context.Context, commentID, requestingUserID uint, newBody string) (*dto.CommentDTO, error) {
	comment, err := s.commentRepo.GetByID(commentID)
	if err != nil {
		return nil, validator.NewValidationError("Comment not found", constants.ErrCodeCommentNotFound)
	}
	if comment.IsDeleted {
		return nil, validator.NewValidationError("Cannot edit a deleted comment", constants.ErrCodeCommentDeleted)
	}

	// Authorization: only the original author can edit
	if comment.AuthorID != requestingUserID {
		logger.Sugar.Warnw("Unauthorized comment edit attempt",
			"comment_id", commentID,
			"requesting_user", requestingUserID,
			"author_id", comment.AuthorID,
		)
		return nil, validator.NewValidationError("Not authorized to edit this comment", constants.ErrCodeCommentForbidden)
	}

	// Time window check
	if time.Since(comment.CreatedAt) > constants.CommentEditWindow {
		return nil, validator.NewValidationError("Edit window has expired", constants.ErrCodeCommentEditExpired)
	}

	trimmedBody := strings.TrimSpace(newBody)
	if valErr := validator.ValidateCommentBody(trimmedBody); valErr != nil {
		return nil, valErr
	}

	// Update body
	if err := s.commentRepo.UpdateBody(commentID, trimmedBody); err != nil {
		return nil, fmt.Errorf("failed to update comment: %w", err)
	}

	// Re-parse mentions and replace old ones
	mentionedUsernames, valErr := validator.ParseMentions(trimmedBody)
	if valErr != nil {
		return nil, valErr
	}
	if err := s.mentionRepo.DeleteByCommentID(commentID); err != nil {
		logger.Sugar.Warnw("Failed to delete old mentions during edit",
			"comment_id", commentID,
			"error", err,
		)
	}
	s.resolveMentions(commentID, mentionedUsernames)

	// Fetch updated comment with author info for the response
	updated, err := s.commentRepo.GetByIDWithAuthor(commentID)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch updated comment: %w", err)
	}

	// Get mentions for DTO
	mentions, _ := s.mentionRepo.GetByCommentID(commentID)
	mentionsMap := map[uint][]models.CommentMention{commentID: mentions}

	// Get like status for current user
	likedMap, _ := s.likeRepo.BatchHasLiked([]uint{commentID}, requestingUserID)

	result := s.buildCommentDTO(updated, requestingUserID, likedMap, mentionsMap)

	// Resolve reply-to username if present
	if updated.ReplyToUserID != nil {
		replyToUsername, _ := s.commentRepo.GetReplyToUsername(*updated.ReplyToUserID)
		if replyToUsername != "" {
			result.ReplyToUsername = &replyToUsername
		}
	}

	logger.Sugar.Infow("Comment edited",
		"comment_id", commentID,
		"edited_by", requestingUserID,
	)

	return result, nil
}

func (s *CommentService) sendCommentNotifications(
	ctx context.Context,
	comment *models.Comment,
	authorUsername string,
	author *models.User,
	dayOwnerID uint,
	dayOwnerUsername string,
	dayDate time.Time,
	parentComment *models.Comment,
	mentions []dto.MentionDTO,
) {
	if s.notifSvc == nil {
		return
	}

	avatar := ""
	if author != nil && author.ProfilePic != nil {
		avatar = *author.ProfilePic
	}

	notifiedUsers := make(map[uint]bool)
	notifiedUsers[comment.AuthorID] = true // Never notify self
	dateStr := dayDate.Format(constants.DateFormat)
	bodyPreview := truncateCommentPreview(comment.Body)

	if parentComment == nil {
		// Top-level comment: notify day owner
		if dayOwnerID != comment.AuthorID {
			notifiedUsers[dayOwnerID] = true
			if err := s.notifSvc.NotifyCommentReceived(
				ctx, dayOwnerID, comment.AuthorID, authorUsername, avatar,
				comment.ID, bodyPreview, dayOwnerUsername, dateStr,
			); err != nil {
				logger.Sugar.Warnw("Failed to send comment_received notification",
					"comment_id", comment.ID,
					"recipient", dayOwnerID,
					"error", err,
				)
			}
		}
	} else {
		// Reply: notify parent comment author
		if !notifiedUsers[parentComment.AuthorID] {
			notifiedUsers[parentComment.AuthorID] = true
			if err := s.notifSvc.NotifyCommentReply(
				ctx, parentComment.AuthorID, comment.AuthorID, authorUsername, avatar,
				comment.ID, bodyPreview, dayOwnerUsername, dateStr,
			); err != nil {
				logger.Sugar.Warnw("Failed to send comment_reply notification",
					"comment_id", comment.ID,
					"recipient", parentComment.AuthorID,
					"error", err,
				)
			}
		}
		// Also notify day owner if different from parent author and commenter
		if !notifiedUsers[dayOwnerID] {
			notifiedUsers[dayOwnerID] = true
			if err := s.notifSvc.NotifyCommentReceived(
				ctx, dayOwnerID, comment.AuthorID, authorUsername, avatar,
				comment.ID, bodyPreview, dayOwnerUsername, dateStr,
			); err != nil {
				logger.Sugar.Warnw("Failed to send comment_received notification to day owner",
					"comment_id", comment.ID,
					"recipient", dayOwnerID,
					"error", err,
				)
			}
		}
	}

	// Mention notifications with privacy check
	for _, mention := range mentions {
		if notifiedUsers[mention.UserID] {
			continue
		}
		notifiedUsers[mention.UserID] = true

		// Privacy check: if mentioned user is private and commenter doesn't follow them, skip
		mentionedUser, err := s.userRepo.FindByID(mention.UserID)
		if err != nil || mentionedUser == nil {
			continue
		}
		if mentionedUser.IsPrivate && s.followRepo != nil {
			isFollowing, err := s.followRepo.IsFollowing(comment.AuthorID, mention.UserID)
			if err != nil || !isFollowing {
				logger.Sugar.Debugw("Skipping mention notification (privacy)",
					"mentioned_user_id", mention.UserID,
					"commenter_id", comment.AuthorID,
				)
				continue
			}
		}

		s.notifSvc.NotifyCommentMention(
			ctx, mention.UserID, comment.AuthorID, authorUsername, avatar,
			comment.ID, bodyPreview, dayOwnerUsername, dateStr,
		)
		logger.Sugar.Debugw("Mention notification sent",
			"comment_id", comment.ID,
			"mentioned_user_id", mention.UserID,
		)
	}
}

func (s *CommentService) invalidateCountCache(ctx context.Context, dayOwnerID uint, dayDate time.Time) {
	if !redis.IsAvailable() {
		return
	}
	dateStr := dayDate.Format(constants.DateFormat)
	cacheKey := fmt.Sprintf("%s%d:%s", constants.CommentCountCachePrefix, dayOwnerID, dateStr)
	redis.Get().Del(ctx, cacheKey)
}

// rankComments sorts comments by ranking score (descending)
func rankComments(comments []repository.CommentWithAuthor) {
	now := time.Now()
	sort.SliceStable(comments, func(i, j int) bool {
		scoreI := computeScore(&comments[i], now)
		scoreJ := computeScore(&comments[j], now)
		if scoreI != scoreJ {
			return scoreI > scoreJ
		}
		return comments[i].ID > comments[j].ID
	})
}

func computeScore(c *repository.CommentWithAuthor, now time.Time) float64 {
	// Like component: log2(1 + like_count)
	likeScore := math.Log2(1 + float64(c.LikeCount))

	// Recency decay: 1 / (1 + hoursAge/6)
	hoursAge := now.Sub(c.CreatedAt).Hours()
	recencyScore := 1.0 / (1.0 + hoursAge/6.0)

	// Verified boost
	verifiedBoost := 0.0
	if c.AuthorVerified {
		verifiedBoost = 0.3
	}

	return likeScore + recencyScore + verifiedBoost
}

func hashBody(body string) string {
	h := sha256.Sum256([]byte(body))
	return fmt.Sprintf("%x", h)
}

func truncateCommentPreview(body string) string {
	if len(body) <= constants.CommentPreviewLength {
		return body
	}
	return body[:constants.CommentPreviewLength] + "..."
}
