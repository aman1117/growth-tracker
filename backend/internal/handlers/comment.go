package handlers

import (
	"strconv"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/response"
	"github.com/aman1117/backend/internal/services"
	"github.com/aman1117/backend/internal/validator"
	"github.com/gofiber/fiber/v2"
)

// CommentHandler handles comment-related requests
type CommentHandler struct {
	commentSvc *services.CommentService
	profileSvc *services.ProfileService
	authSvc    *services.AuthService
}

// NewCommentHandler creates a new CommentHandler
func NewCommentHandler(
	commentSvc *services.CommentService,
	profileSvc *services.ProfileService,
	authSvc *services.AuthService,
) *CommentHandler {
	return &CommentHandler{
		commentSvc: commentSvc,
		profileSvc: profileSvc,
		authSvc:    authSvc,
	}
}

// CreateComment creates a top-level comment on a day
// @Summary Create a comment on a day
// @Description Add a top-level comment on a user's day. Supports @mentions and dedup via X-Idempotency-Key header.
// @Tags Comments
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param username path string true "Day owner username" example("john_doe")
// @Param date path string true "Day date (YYYY-MM-DD)" example("2026-03-26")
// @Param X-Idempotency-Key header string false "Idempotency key for dedup"
// @Param request body dto.CreateCommentRequest true "Comment body"
// @Success 201 {object} dto.CommentActionResponse "Comment created"
// @Failure 400 {object} dto.ErrorResponse "Validation error"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Private account"
// @Failure 404 {object} dto.ErrorResponse "User not found"
// @Failure 409 {object} dto.ErrorResponse "Duplicate comment"
// @Failure 429 {object} dto.ErrorResponse "Rate limit exceeded"
// @Router /days/{username}/{date}/comments [post]
func (h *CommentHandler) CreateComment(c *fiber.Ctx) error {
	userID := getUserID(c)
	username := getUsername(c)

	dayOwnerUsername := c.Params("username")
	dateStr := c.Params("date")

	if dayOwnerUsername == "" || dateStr == "" {
		return response.BadRequest(c, "Username and date are required", constants.ErrCodeMissingFields)
	}

	dayDate, err := time.Parse(constants.DateFormat, dateStr)
	if err != nil {
		return response.BadRequest(c, "Invalid date format (use YYYY-MM-DD)", constants.ErrCodeInvalidDate)
	}

	// Resolve day owner
	dayOwner, err := h.authSvc.GetUserByUsername(dayOwnerUsername)
	if err != nil || dayOwner == nil {
		return response.NotFound(c, "User not found", constants.ErrCodeUserNotFound)
	}

	// Privacy check
	if !h.profileSvc.CanViewProfile(dayOwner, userID) {
		return response.Forbidden(c, "This account is private", constants.ErrCodeAccountPrivate)
	}

	var req dto.CreateCommentRequest
	if err := c.BodyParser(&req); err != nil {
		return response.BadRequest(c, "Invalid request body", constants.ErrCodeInvalidRequest)
	}

	// Get idempotency key from header
	var idempotencyKey *string
	if key := c.Get("X-Idempotency-Key"); key != "" {
		idempotencyKey = &key
	}

	result, err := h.commentSvc.CreateComment(
		c.Context(),
		userID, username,
		dayOwner.ID, dayOwnerUsername,
		dayDate,
		req.Body,
		nil, // no parent (top-level)
		idempotencyKey,
	)
	if err != nil {
		if valErr, ok := err.(*validator.ValidationError); ok {
			if valErr.ErrorCode == constants.ErrCodeDuplicateComment {
				return response.Conflict(c, valErr.Message, valErr.ErrorCode)
			}
			return response.BadRequest(c, valErr.Message, valErr.ErrorCode)
		}
		logger.Sugar.Errorw("CreateComment failed",
			"user_id", userID,
			"day_owner", dayOwnerUsername,
			"error", err,
		)
		return response.InternalError(c, "Failed to create comment", constants.ErrCodeCreateFailed)
	}

	return c.Status(fiber.StatusCreated).JSON(dto.CommentActionResponse{
		Success: true,
		Comment: result,
		Message: constants.MsgCommentCreated,
	})
}

// CreateReply creates a reply to an existing comment
// @Summary Reply to a comment
// @Description Create a reply to an existing comment. Supports nested replies (all flatten under root).
// @Tags Comments
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param username path string true "Day owner username" example("john_doe")
// @Param date path string true "Day date (YYYY-MM-DD)" example("2026-03-26")
// @Param commentId path int true "Parent comment ID" example(1)
// @Param X-Idempotency-Key header string false "Idempotency key for dedup"
// @Param request body dto.CreateReplyRequest true "Reply body"
// @Success 201 {object} dto.CommentActionResponse "Reply created"
// @Failure 400 {object} dto.ErrorResponse "Validation error"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Private account"
// @Failure 404 {object} dto.ErrorResponse "User or parent comment not found"
// @Failure 409 {object} dto.ErrorResponse "Duplicate comment"
// @Failure 429 {object} dto.ErrorResponse "Rate limit exceeded"
// @Router /days/{username}/{date}/comments/{commentId}/replies [post]
func (h *CommentHandler) CreateReply(c *fiber.Ctx) error {
	userID := getUserID(c)
	username := getUsername(c)

	dayOwnerUsername := c.Params("username")
	dateStr := c.Params("date")
	commentIDStr := c.Params("commentId")

	if dayOwnerUsername == "" || dateStr == "" || commentIDStr == "" {
		return response.BadRequest(c, "Username, date, and comment ID are required", constants.ErrCodeMissingFields)
	}

	dayDate, err := time.Parse(constants.DateFormat, dateStr)
	if err != nil {
		return response.BadRequest(c, "Invalid date format (use YYYY-MM-DD)", constants.ErrCodeInvalidDate)
	}

	commentID, err := strconv.ParseUint(commentIDStr, 10, 64)
	if err != nil {
		return response.BadRequest(c, "Invalid comment ID", constants.ErrCodeInvalidRequest)
	}

	dayOwner, err := h.authSvc.GetUserByUsername(dayOwnerUsername)
	if err != nil || dayOwner == nil {
		return response.NotFound(c, "User not found", constants.ErrCodeUserNotFound)
	}

	if !h.profileSvc.CanViewProfile(dayOwner, userID) {
		return response.Forbidden(c, "This account is private", constants.ErrCodeAccountPrivate)
	}

	var req dto.CreateReplyRequest
	if err := c.BodyParser(&req); err != nil {
		return response.BadRequest(c, "Invalid request body", constants.ErrCodeInvalidRequest)
	}

	var idempotencyKey *string
	if key := c.Get("X-Idempotency-Key"); key != "" {
		idempotencyKey = &key
	}

	parentID := uint(commentID)
	result, err := h.commentSvc.CreateComment(
		c.Context(),
		userID, username,
		dayOwner.ID, dayOwnerUsername,
		dayDate,
		req.Body,
		&parentID,
		idempotencyKey,
	)
	if err != nil {
		if valErr, ok := err.(*validator.ValidationError); ok {
			if valErr.ErrorCode == constants.ErrCodeDuplicateComment {
				return response.Conflict(c, valErr.Message, valErr.ErrorCode)
			}
			return response.BadRequest(c, valErr.Message, valErr.ErrorCode)
		}
		logger.Sugar.Errorw("CreateReply failed",
			"user_id", userID,
			"parent_id", commentID,
			"error", err,
		)
		return response.InternalError(c, "Failed to create reply", constants.ErrCodeCreateFailed)
	}

	return c.Status(fiber.StatusCreated).JSON(dto.CommentActionResponse{
		Success: true,
		Comment: result,
		Message: constants.MsgCommentCreated,
	})
}

// DeleteComment soft-deletes a comment
// @Summary Delete a comment
// @Description Soft-delete a comment. Allowed by comment author or day owner. Preserves thread integrity.
// @Tags Comments
// @Produce json
// @Security BearerAuth
// @Param commentId path int true "Comment ID" example(1)
// @Success 200 {object} dto.SuccessResponse "Comment deleted"
// @Failure 400 {object} dto.ErrorResponse "Invalid comment ID"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Not authorized to delete"
// @Failure 404 {object} dto.ErrorResponse "Comment not found"
// @Router /comments/{commentId} [delete]
func (h *CommentHandler) DeleteComment(c *fiber.Ctx) error {
	userID := getUserID(c)
	commentIDStr := c.Params("commentId")

	commentID, err := strconv.ParseUint(commentIDStr, 10, 64)
	if err != nil {
		return response.BadRequest(c, "Invalid comment ID", constants.ErrCodeInvalidRequest)
	}

	// We need the day owner ID for authorization. Get the comment first to find it.
	// The service layer handles the authorization check.
	// For efficiency, pass 0 — the service will look up the comment's day_owner_id.
	if err := h.commentSvc.DeleteComment(c.Context(), uint(commentID), userID, 0); err != nil {
		if valErr, ok := err.(*validator.ValidationError); ok {
			if valErr.ErrorCode == constants.ErrCodeCommentForbidden {
				return response.Forbidden(c, valErr.Message, valErr.ErrorCode)
			}
			return response.NotFound(c, valErr.Message, valErr.ErrorCode)
		}
		logger.Sugar.Errorw("DeleteComment failed",
			"user_id", userID,
			"comment_id", commentID,
			"error", err,
		)
		return response.InternalError(c, "Failed to delete comment", constants.ErrCodeDeleteFailed)
	}

	return response.Success(c, constants.MsgCommentDeleted)
}

// LikeComment likes a comment
// @Summary Like a comment
// @Description Like a comment. Idempotent — liking an already-liked comment is a no-op.
// @Tags Comments
// @Produce json
// @Security BearerAuth
// @Param commentId path int true "Comment ID" example(1)
// @Success 200 {object} dto.LikeActionResponse "Like successful"
// @Failure 400 {object} dto.ErrorResponse "Invalid comment ID or deleted comment"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 429 {object} dto.ErrorResponse "Rate limit exceeded"
// @Router /comments/{commentId}/like [post]
func (h *CommentHandler) LikeComment(c *fiber.Ctx) error {
	userID := getUserID(c)
	username := getUsername(c)
	commentIDStr := c.Params("commentId")

	commentID, err := strconv.ParseUint(commentIDStr, 10, 64)
	if err != nil {
		return response.BadRequest(c, "Invalid comment ID", constants.ErrCodeInvalidRequest)
	}

	liked, newCount, err := h.commentSvc.LikeComment(c.Context(), uint(commentID), userID, username)
	if err != nil {
		if valErr, ok := err.(*validator.ValidationError); ok {
			return response.BadRequest(c, valErr.Message, valErr.ErrorCode)
		}
		logger.Sugar.Errorw("LikeComment failed",
			"user_id", userID,
			"comment_id", commentID,
			"error", err,
		)
		return response.InternalError(c, "Failed to like comment", constants.ErrCodeCreateFailed)
	}

	return response.JSON(c, dto.LikeActionResponse{
		Success:  true,
		Liked:    liked,
		NewCount: int64(newCount),
	})
}

// UnlikeComment unlikes a comment
// @Summary Unlike a comment
// @Description Remove a like from a comment. Idempotent — unliking a not-liked comment is a no-op.
// @Tags Comments
// @Produce json
// @Security BearerAuth
// @Param commentId path int true "Comment ID" example(1)
// @Success 200 {object} dto.LikeActionResponse "Unlike successful"
// @Failure 400 {object} dto.ErrorResponse "Invalid comment ID"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 429 {object} dto.ErrorResponse "Rate limit exceeded"
// @Router /comments/{commentId}/like [delete]
func (h *CommentHandler) UnlikeComment(c *fiber.Ctx) error {
	userID := getUserID(c)
	commentIDStr := c.Params("commentId")

	commentID, err := strconv.ParseUint(commentIDStr, 10, 64)
	if err != nil {
		return response.BadRequest(c, "Invalid comment ID", constants.ErrCodeInvalidRequest)
	}

	liked, newCount, err := h.commentSvc.UnlikeComment(c.Context(), uint(commentID), userID)
	if err != nil {
		if valErr, ok := err.(*validator.ValidationError); ok {
			return response.BadRequest(c, valErr.Message, valErr.ErrorCode)
		}
		logger.Sugar.Errorw("UnlikeComment failed",
			"user_id", userID,
			"comment_id", commentID,
			"error", err,
		)
		return response.InternalError(c, "Failed to unlike comment", constants.ErrCodeDeleteFailed)
	}

	return response.JSON(c, dto.LikeActionResponse{
		Success:  true,
		Liked:    liked,
		NewCount: int64(newCount),
	})
}

// GetComments retrieves top-level comments for a day
// @Summary Get comments for a day
// @Description Retrieve paginated top-level comments for a user's day. Supports sort=top (ranked) and sort=newest.
// @Tags Comments
// @Produce json
// @Security BearerAuth
// @Param username path string true "Day owner username" example("john_doe")
// @Param date path string true "Day date (YYYY-MM-DD)" example("2026-03-26")
// @Param sort query string false "Sort order: top or newest" default(top) Enums(top, newest)
// @Param cursor query int false "Cursor for pagination (last comment ID)"
// @Param limit query int false "Number of comments per page" default(20) maximum(50)
// @Success 200 {object} dto.CommentsListResponse "Comments list"
// @Failure 400 {object} dto.ErrorResponse "Validation error"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Private account"
// @Failure 404 {object} dto.ErrorResponse "User not found"
// @Router /days/{username}/{date}/comments [get]
func (h *CommentHandler) GetComments(c *fiber.Ctx) error {
	userID := getUserID(c)
	dayOwnerUsername := c.Params("username")
	dateStr := c.Params("date")

	if dayOwnerUsername == "" || dateStr == "" {
		return response.BadRequest(c, "Username and date are required", constants.ErrCodeMissingFields)
	}

	dayDate, err := time.Parse(constants.DateFormat, dateStr)
	if err != nil {
		return response.BadRequest(c, "Invalid date format (use YYYY-MM-DD)", constants.ErrCodeInvalidDate)
	}

	dayOwner, err := h.authSvc.GetUserByUsername(dayOwnerUsername)
	if err != nil || dayOwner == nil {
		return response.NotFound(c, "User not found", constants.ErrCodeUserNotFound)
	}

	if !h.profileSvc.CanViewProfile(dayOwner, userID) {
		return response.Forbidden(c, "This account is private", constants.ErrCodeAccountPrivate)
	}

	sortBy := c.Query("sort", "top")
	if sortBy != "top" && sortBy != "newest" {
		sortBy = "top"
	}

	var cursor *uint
	if cursorStr := c.Query("cursor"); cursorStr != "" {
		if v, err := strconv.ParseUint(cursorStr, 10, 64); err == nil {
			u := uint(v)
			cursor = &u
		}
	}

	limit, _ := strconv.Atoi(c.Query("limit", "20"))
	if limit <= 0 || limit > constants.CommentListMaxLimit {
		limit = constants.CommentListDefaultLimit
	}

	result, err := h.commentSvc.GetTopLevelComments(c.Context(), dayOwner.ID, userID, dayDate, sortBy, cursor, limit)
	if err != nil {
		logger.Sugar.Errorw("GetComments failed",
			"day_owner", dayOwnerUsername,
			"date", dateStr,
			"error", err,
		)
		return response.InternalError(c, "Failed to get comments", constants.ErrCodeFetchFailed)
	}

	return response.JSON(c, result)
}

// GetReplies retrieves replies for a comment thread
// @Summary Get replies for a comment
// @Description Retrieve paginated replies for a comment thread, ordered oldest-first.
// @Tags Comments
// @Produce json
// @Security BearerAuth
// @Param commentId path int true "Root comment ID" example(1)
// @Param cursor query int false "Cursor for pagination (last reply ID)"
// @Param limit query int false "Number of replies per page" default(20) maximum(50)
// @Success 200 {object} dto.CommentsListResponse "Replies list"
// @Failure 400 {object} dto.ErrorResponse "Invalid comment ID"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Private account"
// @Failure 404 {object} dto.ErrorResponse "Comment not found"
// @Router /comments/{commentId}/replies [get]
func (h *CommentHandler) GetReplies(c *fiber.Ctx) error {
	userID := getUserID(c)
	commentIDStr := c.Params("commentId")

	commentID, err := strconv.ParseUint(commentIDStr, 10, 64)
	if err != nil {
		return response.BadRequest(c, "Invalid comment ID", constants.ErrCodeInvalidRequest)
	}

	// Privacy check: look up the root comment's day owner to verify access
	rootComment, err := h.commentSvc.GetCommentByID(c.Context(), uint(commentID))
	if err != nil || rootComment == nil {
		return response.NotFound(c, "Comment not found", constants.ErrCodeCommentNotFound)
	}
	dayOwner, _ := h.authSvc.GetUserByID(rootComment.DayOwnerID)
	if dayOwner != nil && !h.profileSvc.CanViewProfile(dayOwner, userID) {
		return response.Forbidden(c, "This account is private", constants.ErrCodeAccountPrivate)
	}

	var cursor *uint
	if cursorStr := c.Query("cursor"); cursorStr != "" {
		if v, err := strconv.ParseUint(cursorStr, 10, 64); err == nil {
			u := uint(v)
			cursor = &u
		}
	}

	limit, _ := strconv.Atoi(c.Query("limit", "20"))
	if limit <= 0 || limit > constants.CommentReplyMaxLimit {
		limit = constants.CommentReplyDefaultLimit
	}

	result, err := h.commentSvc.GetReplies(c.Context(), uint(commentID), userID, cursor, limit)
	if err != nil {
		logger.Sugar.Errorw("GetReplies failed",
			"comment_id", commentID,
			"error", err,
		)
		return response.InternalError(c, "Failed to get replies", constants.ErrCodeFetchFailed)
	}

	return response.JSON(c, result)
}

// GetCommentCount returns the total comment count for a day
// @Summary Get comment count for a day
// @Description Returns the total number of non-deleted comments for a user's day.
// @Tags Comments
// @Produce json
// @Security BearerAuth
// @Param username path string true "Day owner username" example("john_doe")
// @Param date path string true "Day date (YYYY-MM-DD)" example("2026-03-26")
// @Success 200 {object} dto.CommentCountResponse "Comment count"
// @Failure 400 {object} dto.ErrorResponse "Validation error"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Private account"
// @Failure 404 {object} dto.ErrorResponse "User not found"
// @Router /days/{username}/{date}/comments/count [get]
func (h *CommentHandler) GetCommentCount(c *fiber.Ctx) error {
	userID := getUserID(c)
	dayOwnerUsername := c.Params("username")
	dateStr := c.Params("date")

	if dayOwnerUsername == "" || dateStr == "" {
		return response.BadRequest(c, "Username and date are required", constants.ErrCodeMissingFields)
	}

	dayDate, err := time.Parse(constants.DateFormat, dateStr)
	if err != nil {
		return response.BadRequest(c, "Invalid date format (use YYYY-MM-DD)", constants.ErrCodeInvalidDate)
	}

	dayOwner, err := h.authSvc.GetUserByUsername(dayOwnerUsername)
	if err != nil || dayOwner == nil {
		return response.NotFound(c, "User not found", constants.ErrCodeUserNotFound)
	}

	if !h.profileSvc.CanViewProfile(dayOwner, userID) {
		return response.Forbidden(c, "This account is private", constants.ErrCodeAccountPrivate)
	}

	count, err := h.commentSvc.GetCommentCount(c.Context(), dayOwner.ID, dayDate)
	if err != nil {
		logger.Sugar.Errorw("GetCommentCount failed",
			"day_owner", dayOwnerUsername,
			"date", dateStr,
			"error", err,
		)
		return response.InternalError(c, "Failed to get comment count", constants.ErrCodeFetchFailed)
	}

	return response.JSON(c, dto.CommentCountResponse{
		Success: true,
		Count:   count,
	})
}
