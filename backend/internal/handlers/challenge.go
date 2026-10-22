package handlers

import (
	"errors"
	"net/url"
	"strconv"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/response"
	"github.com/aman1117/backend/internal/services"
	"github.com/aman1117/backend/internal/validator"
	"github.com/gofiber/fiber/v2"
)

// ChallengeHandler handles challenge requests
type ChallengeHandler struct {
	challengeSvc *services.ChallengeService
}

// NewChallengeHandler creates a new ChallengeHandler
func NewChallengeHandler(challengeSvc *services.ChallengeService) *ChallengeHandler {
	return &ChallengeHandler{challengeSvc: challengeSvc}
}

// ListChallenges returns the viewer's challenges
// @Summary List my challenges
// @Description Every upcoming and active challenge the user takes part in plus the 20 most recently ended: active (by end date), upcoming (by start date), then ended (most recent first).
// @Tags Challenges
// @Produce json
// @Security BearerAuth
// @Success 200 {object} dto.ChallengeListResponse "Challenges"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 429 {object} dto.ErrorResponse "Rate limit exceeded"
// @Failure 500 {object} dto.ErrorResponse "Server error"
// @Router /challenges [get]
func (h *ChallengeHandler) ListChallenges(c *fiber.Ctx) error {
	userID := getUserID(c)
	if userID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}

	challenges, err := h.challengeSvc.List(c.Context(), userID)
	if err != nil {
		return h.fail(c, err, "Failed to load challenges", constants.ErrCodeFetchFailed, 0)
	}
	return response.JSON(c, dto.ChallengeListResponse{Success: true, Challenges: challenges})
}

// CreateChallenge creates a challenge
// @Summary Create a challenge
// @Description Create a daily time goal for one predefined activity; the creator joins automatically. Fails with CHALLENGE_LIMIT_REACHED when the user already takes part in 10 upcoming or active challenges.
// @Tags Challenges
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body dto.CreateChallengeRequest true "Challenge"
// @Success 201 {object} dto.ChallengeResponse "Challenge created"
// @Failure 400 {object} dto.ErrorResponse "Malformed body (INVALID_REQUEST) or invalid field (INVALID_CHALLENGE)"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 409 {object} dto.ErrorResponse "Open challenge limit reached (CHALLENGE_LIMIT_REACHED)"
// @Failure 429 {object} dto.ErrorResponse "Rate limit exceeded"
// @Failure 500 {object} dto.ErrorResponse "Server error"
// @Router /challenges [post]
func (h *ChallengeHandler) CreateChallenge(c *fiber.Ctx) error {
	userID := getUserID(c)
	if userID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}

	var req dto.CreateChallengeRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	challenge, err := h.challengeSvc.Create(c.Context(), userID, req)
	if err != nil {
		return h.fail(c, err, "Failed to create challenge", constants.ErrCodeCreateFailed, 0)
	}
	return c.Status(fiber.StatusCreated).JSON(dto.ChallengeResponse{Success: true, Challenge: challenge})
}

// GetChallenge returns a challenge with every participant's progress
// @Summary Get a challenge
// @Description Challenge detail with participants (by rank) and the viewer's days. Participants only.
// @Tags Challenges
// @Produce json
// @Security BearerAuth
// @Param id path int true "Challenge ID" example(12)
// @Success 200 {object} dto.ChallengeResponse "Challenge"
// @Failure 400 {object} dto.ErrorResponse "Invalid challenge ID"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 404 {object} dto.ErrorResponse "Challenge not found (or not a participant)"
// @Failure 429 {object} dto.ErrorResponse "Rate limit exceeded"
// @Failure 500 {object} dto.ErrorResponse "Server error"
// @Router /challenges/{id} [get]
func (h *ChallengeHandler) GetChallenge(c *fiber.Ctx) error {
	userID := getUserID(c)
	if userID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}
	challengeID, ok := parseChallengeID(c)
	if !ok {
		return invalidChallengeID(c)
	}

	challenge, err := h.challengeSvc.GetDetail(c.Context(), userID, challengeID)
	if err != nil {
		return h.fail(c, err, "Failed to load challenge", constants.ErrCodeFetchFailed, challengeID)
	}
	return response.JSON(c, dto.ChallengeResponse{Success: true, Challenge: challenge})
}

// DeleteChallenge deletes a challenge
// @Summary Delete a challenge
// @Description Deletes the challenge with its participants, days, cheers and invites. Creator only, while the challenge is upcoming or the creator is its only participant.
// @Tags Challenges
// @Produce json
// @Security BearerAuth
// @Param id path int true "Challenge ID" example(12)
// @Success 200 {object} dto.SuccessResponse "Challenge deleted"
// @Failure 400 {object} dto.ErrorResponse "Invalid challenge ID"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 403 {object} dto.ErrorResponse "Not the creator (NOT_AUTHORIZED)"
// @Failure 404 {object} dto.ErrorResponse "Challenge not found (or not a participant)"
// @Failure 409 {object} dto.ErrorResponse "Started with other participants (CHALLENGE_IN_PROGRESS)"
// @Failure 429 {object} dto.ErrorResponse "Rate limit exceeded"
// @Failure 500 {object} dto.ErrorResponse "Server error"
// @Router /challenges/{id} [delete]
func (h *ChallengeHandler) DeleteChallenge(c *fiber.Ctx) error {
	userID := getUserID(c)
	if userID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}
	challengeID, ok := parseChallengeID(c)
	if !ok {
		return invalidChallengeID(c)
	}

	if err := h.challengeSvc.Delete(c.Context(), userID, challengeID); err != nil {
		return h.fail(c, err, "Failed to delete challenge", constants.ErrCodeDeleteFailed, challengeID)
	}
	return response.JSON(c, dto.SuccessResponse{Success: true})
}

// LeaveChallenge removes the viewer from a challenge
// @Summary Leave a challenge
// @Description Leave a challenge that has not ended. The creator cannot leave. The participant's locked days are removed; joining again starts a new window.
// @Tags Challenges
// @Produce json
// @Security BearerAuth
// @Param id path int true "Challenge ID" example(12)
// @Success 200 {object} dto.SuccessResponse "Left the challenge"
// @Failure 400 {object} dto.ErrorResponse "Invalid challenge ID"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 404 {object} dto.ErrorResponse "Challenge not found (or not a participant)"
// @Failure 409 {object} dto.ErrorResponse "Creator (CREATOR_CANNOT_LEAVE) or ended (CHALLENGE_ENDED)"
// @Failure 429 {object} dto.ErrorResponse "Rate limit exceeded"
// @Failure 500 {object} dto.ErrorResponse "Server error"
// @Router /challenges/{id}/leave [post]
func (h *ChallengeHandler) LeaveChallenge(c *fiber.Ctx) error {
	userID := getUserID(c)
	if userID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}
	challengeID, ok := parseChallengeID(c)
	if !ok {
		return invalidChallengeID(c)
	}

	if err := h.challengeSvc.Leave(c.Context(), userID, challengeID); err != nil {
		return h.fail(c, err, "Failed to leave challenge", constants.ErrCodeDeleteFailed, challengeID)
	}
	return response.JSON(c, dto.SuccessResponse{Success: true})
}

// CheerParticipant cheers another participant
// @Summary Cheer a participant
// @Description Cheer another participant of an active challenge, at most once per day (IST). A repeat succeeds with already_cheered=true and sends no notification.
// @Tags Challenges
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param id path int true "Challenge ID" example(12)
// @Param request body dto.CheerChallengeRequest true "Participant to cheer"
// @Success 200 {object} dto.ChallengeCheerResponse "Cheered"
// @Failure 400 {object} dto.ErrorResponse "Invalid ID or body (INVALID_REQUEST), not a participant (INVALID_CHALLENGE) or self (CANNOT_CHEER_SELF)"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 404 {object} dto.ErrorResponse "Challenge not found (or not a participant)"
// @Failure 409 {object} dto.ErrorResponse "Challenge not active (CHALLENGE_NOT_ACTIVE)"
// @Failure 429 {object} dto.ErrorResponse "Rate limit exceeded"
// @Failure 500 {object} dto.ErrorResponse "Server error"
// @Router /challenges/{id}/cheers [post]
func (h *ChallengeHandler) CheerParticipant(c *fiber.Ctx) error {
	userID := getUserID(c)
	if userID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}
	challengeID, ok := parseChallengeID(c)
	if !ok {
		return invalidChallengeID(c)
	}
	var req dto.CheerChallengeRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}
	if req.UserID == 0 {
		return response.BadRequest(c, "user_id is required", constants.ErrCodeInvalidRequest)
	}

	alreadyCheered, err := h.challengeSvc.Cheer(c.Context(), userID, challengeID, req.UserID)
	if err != nil {
		return h.fail(c, err, "Failed to cheer", constants.ErrCodeCreateFailed, challengeID)
	}
	return response.JSON(c, dto.ChallengeCheerResponse{Success: true, AlreadyCheered: alreadyCheered})
}

// GetInviteCandidates lists people the viewer can invite
// @Summary List invite candidates
// @Description People the user follows or who follow the user (active follows), who are not participants, ordered by username. Participants only.
// @Tags Challenges
// @Produce json
// @Security BearerAuth
// @Param id path int true "Challenge ID" example(12)
// @Param q query string false "Case-insensitive username prefix" example("jo")
// @Param limit query int false "Maximum number of users" default(20) maximum(50)
// @Success 200 {object} dto.InviteCandidatesResponse "Candidates"
// @Failure 400 {object} dto.ErrorResponse "Invalid challenge ID or limit"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 404 {object} dto.ErrorResponse "Challenge not found (or not a participant)"
// @Failure 429 {object} dto.ErrorResponse "Rate limit exceeded"
// @Failure 500 {object} dto.ErrorResponse "Server error"
// @Router /challenges/{id}/invite-candidates [get]
func (h *ChallengeHandler) GetInviteCandidates(c *fiber.Ctx) error {
	userID := getUserID(c)
	if userID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}
	challengeID, ok := parseChallengeID(c)
	if !ok {
		return invalidChallengeID(c)
	}
	limit := constants.ChallengeCandidatesDefault
	if raw := c.Query("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			return response.BadRequest(c, "limit must be a positive integer", constants.ErrCodeInvalidRequest)
		}
		limit = min(parsed, constants.ChallengeCandidatesMax)
	}

	users, err := h.challengeSvc.InviteCandidates(c.Context(), userID, challengeID, c.Query("q"), limit)
	if err != nil {
		return h.fail(c, err, "Failed to load invite candidates", constants.ErrCodeFetchFailed, challengeID)
	}
	return response.JSON(c, dto.InviteCandidatesResponse{Success: true, Users: users})
}

// InviteUsers invites users to a challenge
// @Summary Invite users
// @Description Invite 1-20 users to a challenge that has not ended. Users who do not exist, already take part, were invited before (by anyone) or have no active follow relationship with you (either direction) are skipped. Participants only.
// @Tags Challenges
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param id path int true "Challenge ID" example(12)
// @Param request body dto.InviteToChallengeRequest true "Users to invite"
// @Success 200 {object} dto.ChallengeInviteResponse "Invited and skipped counts"
// @Failure 400 {object} dto.ErrorResponse "Invalid ID or body (INVALID_REQUEST) or not 1-20 users (INVALID_CHALLENGE)"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 404 {object} dto.ErrorResponse "Challenge not found (or not a participant)"
// @Failure 409 {object} dto.ErrorResponse "Challenge ended (CHALLENGE_ENDED)"
// @Failure 429 {object} dto.ErrorResponse "Rate limit exceeded"
// @Failure 500 {object} dto.ErrorResponse "Server error"
// @Router /challenges/{id}/invites [post]
func (h *ChallengeHandler) InviteUsers(c *fiber.Ctx) error {
	userID := getUserID(c)
	if userID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}
	challengeID, ok := parseChallengeID(c)
	if !ok {
		return invalidChallengeID(c)
	}
	var req dto.InviteToChallengeRequest
	if err := c.BodyParser(&req); err != nil {
		return response.InvalidRequest(c)
	}

	invited, skipped, err := h.challengeSvc.Invite(c.Context(), userID, challengeID, req.UserIDs)
	if err != nil {
		return h.fail(c, err, "Failed to send invites", constants.ErrCodeCreateFailed, challengeID)
	}
	return response.JSON(c, dto.ChallengeInviteResponse{Success: true, Invited: invited, Skipped: skipped})
}

// PreviewChallenge describes the challenge behind an invite code
// @Summary Preview a challenge by invite code
// @Description What an invite link shows: the challenge, its creator, up to 5 participants and whether the user can join. Codes are case-insensitive.
// @Tags Challenges
// @Produce json
// @Security BearerAuth
// @Param code path string true "Invite code" example("K7Q2M9XA")
// @Success 200 {object} dto.ChallengePreviewResponse "Preview"
// @Failure 400 {object} dto.ErrorResponse "Malformed invite code"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 404 {object} dto.ErrorResponse "Challenge not found"
// @Failure 429 {object} dto.ErrorResponse "Rate limit exceeded"
// @Failure 500 {object} dto.ErrorResponse "Server error"
// @Router /challenge-codes/{code} [get]
func (h *ChallengeHandler) PreviewChallenge(c *fiber.Ctx) error {
	userID := getUserID(c)
	if userID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}
	code, ok := parseInviteCode(c)
	if !ok {
		return invalidInviteCode(c)
	}

	preview, err := h.challengeSvc.PreviewByCode(c.Context(), userID, code)
	if err != nil {
		return h.fail(c, err, "Failed to load challenge", constants.ErrCodeFetchFailed, 0)
	}
	return response.JSON(c, dto.ChallengePreviewResponse{Success: true, Preview: preview})
}

// JoinChallenge joins the challenge behind an invite code
// @Summary Join a challenge by invite code
// @Description Join a challenge that has not ended and is not full, while taking part in fewer than 10 upcoming or active challenges. Joining again succeeds without changes.
// @Tags Challenges
// @Produce json
// @Security BearerAuth
// @Param code path string true "Invite code" example("K7Q2M9XA")
// @Success 200 {object} dto.ChallengeResponse "Joined challenge"
// @Failure 400 {object} dto.ErrorResponse "Malformed invite code"
// @Failure 401 {object} dto.ErrorResponse "Unauthorized"
// @Failure 404 {object} dto.ErrorResponse "Challenge not found"
// @Failure 409 {object} dto.ErrorResponse "Ended (CHALLENGE_ENDED), full (CHALLENGE_FULL) or open challenge limit reached (CHALLENGE_LIMIT_REACHED)"
// @Failure 429 {object} dto.ErrorResponse "Rate limit exceeded"
// @Failure 500 {object} dto.ErrorResponse "Server error"
// @Router /challenge-codes/{code}/join [post]
func (h *ChallengeHandler) JoinChallenge(c *fiber.Ctx) error {
	userID := getUserID(c)
	if userID == 0 {
		return response.Unauthorized(c, "Authentication required", constants.ErrCodeUnauthorized)
	}
	code, ok := parseInviteCode(c)
	if !ok {
		return invalidInviteCode(c)
	}

	challenge, err := h.challengeSvc.JoinByCode(c.Context(), userID, code)
	if err != nil {
		return h.fail(c, err, "Failed to join challenge", constants.ErrCodeCreateFailed, 0)
	}
	return response.JSON(c, dto.ChallengeResponse{Success: true, Challenge: challenge})
}

// ==================== Helpers ====================

// parseChallengeID reads the :id path parameter (a positive 32-bit integer).
func parseChallengeID(c *fiber.Ctx) (uint, bool) {
	id, err := strconv.ParseUint(c.Params("id"), 10, 32)
	if err != nil || id == 0 {
		return 0, false
	}
	return uint(id), true
}

func invalidChallengeID(c *fiber.Ctx) error {
	return response.BadRequest(c, "Invalid challenge ID", constants.ErrCodeInvalidRequest)
}

// parseInviteCode reads and normalises the :code path parameter (case-insensitive, trimmed).
func parseInviteCode(c *fiber.Ctx) (string, bool) {
	raw, err := url.PathUnescape(c.Params("code"))
	if err != nil {
		return "", false
	}
	return validator.NormalizeInviteCode(raw)
}

func invalidInviteCode(c *fiber.Ctx) error {
	return response.BadRequest(c, "Invalid invite code", constants.ErrCodeInvalidRequest)
}

// fail maps a service error to its response; unexpected errors are logged and reported as
// failMessage/failCode with status 500.
func (h *ChallengeHandler) fail(c *fiber.Ctx, err error, failMessage, failCode string, challengeID uint) error {
	var valErr *validator.ValidationError
	switch {
	case errors.As(err, &valErr):
		return response.BadRequest(c, valErr.Message, valErr.ErrorCode)
	case errors.Is(err, services.ErrChallengeNotFound):
		return response.NotFound(c, "Challenge not found", constants.ErrCodeChallengeNotFound)
	case errors.Is(err, services.ErrChallengeFull):
		return response.Conflict(c, "This challenge is full", constants.ErrCodeChallengeFull)
	case errors.Is(err, services.ErrChallengeLimitReached):
		return response.Conflict(c, "You already take part in the maximum number of open challenges",
			constants.ErrCodeChallengeLimitReached)
	case errors.Is(err, services.ErrChallengeEnded):
		return response.Conflict(c, "This challenge has ended", constants.ErrCodeChallengeEnded)
	case errors.Is(err, services.ErrChallengeNotActive):
		return response.Conflict(c, "You can only cheer while the challenge is active", constants.ErrCodeChallengeNotActive)
	case errors.Is(err, services.ErrCreatorCannotLeave):
		return response.Conflict(c, "The creator cannot leave the challenge", constants.ErrCodeCreatorCannotLeave)
	case errors.Is(err, services.ErrChallengeInProgress):
		return response.Conflict(c, "A challenge can only be deleted before it starts or while you are its only participant",
			constants.ErrCodeChallengeInProgress)
	case errors.Is(err, services.ErrCannotCheerSelf):
		return response.BadRequest(c, "You cannot cheer yourself", constants.ErrCodeCannotCheerSelf)
	case errors.Is(err, services.ErrNotChallengeCreator):
		return response.Forbidden(c, "Only the creator can delete this challenge", constants.ErrCodeNotAuthorized)
	}

	logger.LogWithContext(getTraceID(c), getUserID(c)).Errorw(failMessage,
		"challenge_id", challengeID,
		"error", err,
		"action", "responded with 500; the client may retry",
	)
	return response.InternalError(c, failMessage, failCode)
}
