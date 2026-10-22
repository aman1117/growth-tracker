package services

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/validator"
	"github.com/aman1117/backend/pkg/models"
)

// Errors returned by ChallengeService. Invalid input is reported as a
// *validator.ValidationError with the INVALID_CHALLENGE code.
var (
	// ErrChallengeNotFound is also returned to users who do not take part in the challenge,
	// so its existence never leaks.
	ErrChallengeNotFound     = errors.New("challenge not found")
	ErrChallengeFull         = errors.New("challenge is full")
	ErrChallengeLimitReached = errors.New("open challenge limit reached")
	ErrChallengeEnded        = errors.New("challenge has ended")
	ErrChallengeNotActive    = errors.New("challenge is not active")
	ErrCreatorCannotLeave    = errors.New("the creator cannot leave the challenge")
	ErrChallengeInProgress   = errors.New("challenge can no longer be deleted")
	ErrCannotCheerSelf       = errors.New("cannot cheer yourself")
	ErrNotChallengeCreator   = errors.New("only the creator can delete the challenge")

	errInviteCodeTaken = errors.New("invite code already taken")
)

// maxInviteCodeAttempts bounds the retries when a random invite code is already taken.
const maxInviteCodeAttempts = 5

// ChallengeService holds the challenge rules: input validation, permissions, live scoring from
// the activity log and the daily job that locks days and stores the final results.
type ChallengeService struct {
	repo       *repository.ChallengeRepository
	jobLogRepo *repository.CronJobLogRepository
	notifSvc   *NotificationService
	now        func() time.Time
	newCode    func() string
	instanceID string
}

// ChallengeOption customises a ChallengeService.
type ChallengeOption func(*ChallengeService)

// WithChallengeClock replaces the wall clock, which decides what "today" (IST) is.
func WithChallengeClock(now func() time.Time) ChallengeOption {
	return func(s *ChallengeService) { s.now = now }
}

// NewChallengeService creates a new ChallengeService. jobLogRepo (used to claim the daily job
// so that one replica runs it) and notifSvc may be nil.
func NewChallengeService(
	repo *repository.ChallengeRepository,
	jobLogRepo *repository.CronJobLogRepository,
	notifSvc *NotificationService,
	opts ...ChallengeOption,
) *ChallengeService {
	instanceID := os.Getenv("HOSTNAME")
	if instanceID == "" {
		instanceID = fmt.Sprintf("instance-%d", time.Now().UnixNano()%10000)
	}
	s := &ChallengeService{
		repo:       repo,
		jobLogRepo: jobLogRepo,
		notifSvc:   notifSvc,
		now:        time.Now,
		newCode:    generateInviteCode,
		instanceID: instanceID,
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// today returns the current IST date.
func (s *ChallengeService) today() time.Time {
	return istDate(s.now())
}

// ==================== Queries ====================

// List returns every upcoming and active challenge the user takes part in plus the 20 most
// recently ended ones: active by end date, then upcoming by start date, then ended, most
// recent first.
func (s *ChallengeService) List(ctx context.Context, viewerID uint) ([]dto.ChallengeSummary, error) {
	today := s.today()
	rows, err := s.repo.ListForUser(viewerID, today, constants.ChallengeRecentEndedLimit)
	if err != nil {
		return nil, fmt.Errorf("list challenges: %w", err)
	}

	// Live ranks need every participant of the active and ended (not finalized) challenges;
	// streaks need the viewer's locked days of every started challenge.
	var rankIDs, dayIDs []uint
	for i := range rows {
		rules := newChallengeRules(&rows[i].Challenge, today)
		if rules.status() == ChallengeStatusUpcoming {
			continue
		}
		dayIDs = append(dayIDs, rows[i].ID)
		if rows[i].FinalizedAt == nil {
			rankIDs = append(rankIDs, rows[i].ID)
		}
	}
	participants, err := s.repo.ListParticipants(rankIDs)
	if err != nil {
		return nil, fmt.Errorf("list participants: %w", err)
	}
	totals, err := s.repo.LockedTotals(rankIDs)
	if err != nil {
		return nil, fmt.Errorf("sum locked days: %w", err)
	}
	live, err := s.repo.ActivityDays(rankIDs, today)
	if err != nil {
		return nil, fmt.Errorf("read activity days: %w", err)
	}
	myDays, err := s.repo.ListUserDays(viewerID, dayIDs)
	if err != nil {
		return nil, fmt.Errorf("list locked days: %w", err)
	}

	participantsBy := make(map[uint][]repository.ChallengeParticipantRow)
	for _, p := range participants {
		participantsBy[p.ChallengeID] = append(participantsBy[p.ChallengeID], p)
	}
	totalsBy := make(map[uint]map[uint]repository.ChallengeLockedTotal)
	for _, t := range totals {
		if totalsBy[t.ChallengeID] == nil {
			totalsBy[t.ChallengeID] = make(map[uint]repository.ChallengeLockedTotal)
		}
		totalsBy[t.ChallengeID][t.UserID] = t
	}
	liveBy := make(map[uint][]repository.ChallengeActivityDay)
	for _, a := range live {
		liveBy[a.ChallengeID] = append(liveBy[a.ChallengeID], a)
	}
	myDaysBy := make(map[uint][]models.ChallengeDay)
	for _, d := range myDays {
		myDaysBy[d.ChallengeID] = append(myDaysBy[d.ChallengeID], d)
	}

	summaries := make([]dto.ChallengeSummary, 0, len(rows))
	for i := range rows {
		row := &rows[i]
		rules := newChallengeRules(&row.Challenge, today)
		window := rules.window(row.JoinedOn)

		facts := make([]dayFacts, rules.durationDays())
		addSnapshots(rules, facts, myDaysBy[row.ID])
		var viewerLive []repository.ChallengeActivityDay
		for _, a := range liveBy[row.ID] {
			if a.UserID == viewerID {
				viewerLive = append(viewerLive, a)
			}
		}
		addLiveDays(rules, facts, viewerLive)
		score := rules.score(rules.evaluateDays(window.start, facts), window)

		var rank *int
		if rules.status() != ChallengeStatusUpcoming && row.FinalizedAt == nil {
			ranks := rankFromTotals(rules, viewerID, score, participantsBy[row.ID], totalsBy[row.ID], liveBy[row.ID])
			if r, ok := ranks[viewerID]; ok {
				rank = &r
			}
		}
		final := finalResultOf(row.FinalizedAt != nil, row.FinalRank, row.FinalDaysMet, row.FinalTotalHours, row.Completed)
		me := progressOf(window, score, rank, final)
		summaries = append(summaries, summaryOf(&row.Challenge, rules, row.ParticipantCount, viewerID, me))
	}
	sortSummaries(summaries)
	return summaries, nil
}

// GetDetail returns a challenge with every participant's progress. Users who do not take part
// get ErrChallengeNotFound.
func (s *ChallengeService) GetDetail(ctx context.Context, viewerID, challengeID uint) (*dto.ChallengeDetail, error) {
	detail, _, err := s.loadDetail(challengeID, viewerID, s.today())
	return detail, err
}

// InviteCandidates returns up to limit (default 20, at most 50) people the viewer follows or who
// follow the viewer, who are not participants yet, optionally filtered by a username prefix.
// Invited marks people who already have an invite; leaving the challenge removes it.
func (s *ChallengeService) InviteCandidates(ctx context.Context, viewerID, challengeID uint, query string, limit int) ([]dto.InviteCandidate, error) {
	if _, err := s.requireParticipant(challengeID, viewerID); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = constants.ChallengeCandidatesDefault
	}
	limit = min(limit, constants.ChallengeCandidatesMax)
	prefix := strings.TrimSpace(query)
	candidates := []dto.InviteCandidate{}
	if utf8.RuneCountInString(prefix) > constants.UsernameMaxLength {
		return candidates, nil // no username is that long
	}

	rows, err := s.repo.InviteCandidates(challengeID, viewerID, prefix, limit)
	if err != nil {
		return nil, fmt.Errorf("list invite candidates: %w", err)
	}
	for _, r := range rows {
		candidates = append(candidates, dto.InviteCandidate{
			ChallengeUser: dto.ChallengeUser{
				ID:              r.ID,
				Username:        r.Username,
				ProfilePic:      r.ProfilePic,
				ProfilePicThumb: r.ProfilePicThumb,
				IsVerified:      r.IsVerified,
			},
			Invited: r.Invited,
		})
	}
	return candidates, nil
}

// PreviewByCode describes the challenge behind an invite code to any signed-in user, including
// whether they can join it.
func (s *ChallengeService) PreviewByCode(ctx context.Context, viewerID uint, rawCode string) (*dto.ChallengePreview, error) {
	challenge, err := s.findByCode(rawCode)
	if err != nil {
		return nil, err
	}
	participants, err := s.repo.ListParticipants([]uint{challenge.ID})
	if err != nil {
		return nil, fmt.Errorf("list participants: %w", err)
	}
	today := s.today()
	rules := newChallengeRules(challenge, today)

	isParticipant := findParticipantRow(participants, viewerID) != nil
	var blocked *string
	if !isParticipant {
		reason := ""
		switch {
		case rules.status() == ChallengeStatusEnded:
			reason = JoinBlockedEnded
		case len(participants) >= constants.ChallengeMaxParticipants:
			reason = JoinBlockedFull
		default:
			open, err := s.repo.CountOpenForUser(viewerID, today)
			if err != nil {
				return nil, fmt.Errorf("count open challenges: %w", err)
			}
			if open >= constants.ChallengeMaxOpenPerUser {
				reason = JoinBlockedLimit
			}
		}
		if reason != "" {
			blocked = &reason
		}
	}

	preview := make([]dto.ChallengeUser, 0, constants.ChallengePreviewParticipants)
	for i := 0; i < len(participants) && i < constants.ChallengePreviewParticipants; i++ {
		preview = append(preview, challengeUserOf(participants[i]))
	}
	return &dto.ChallengePreview{
		ID:                  challenge.ID,
		Title:               challenge.Title,
		Activity:            challenge.Activity,
		GoalType:            challenge.GoalType,
		TargetHours:         challenge.TargetHours,
		StartDate:           formatDate(rules.start),
		EndDate:             formatDate(rules.end),
		DurationDays:        rules.durationDays(),
		Status:              rules.status(),
		Finalized:           challenge.FinalizedAt != nil,
		ParticipantCount:    len(participants),
		MaxParticipants:     constants.ChallengeMaxParticipants,
		Creator:             creatorOf(challenge, participants),
		ParticipantsPreview: preview,
		IsParticipant:       isParticipant,
		CanJoin:             !isParticipant && blocked == nil,
		JoinBlockedReason:   blocked,
	}, nil
}

// ==================== Commands ====================

// Create validates the input, creates the challenge with a fresh invite code and makes the
// creator its first participant. Creators take part, so the open-challenge limit applies.
func (s *ChallengeService) Create(ctx context.Context, viewerID uint, req dto.CreateChallengeRequest) (*dto.ChallengeDetail, error) {
	today := s.today()
	title, valErr := validator.NormalizeChallengeTitle(req.Title)
	if valErr != nil {
		return nil, valErr
	}
	if valErr := validator.ValidateChallengeActivity(req.Activity); valErr != nil {
		return nil, valErr
	}
	if valErr := validator.ValidateChallengeGoal(req.GoalType, req.TargetHours); valErr != nil {
		return nil, valErr
	}
	if valErr := validator.ValidateChallengeDuration(req.DurationDays); valErr != nil {
		return nil, valErr
	}
	start, valErr := validator.ParseChallengeStartDate(req.StartDate, today)
	if valErr != nil {
		return nil, valErr
	}

	now := s.now()
	challenge := &models.Challenge{
		CreatorID:   viewerID,
		Title:       title,
		Activity:    req.Activity,
		GoalType:    req.GoalType,
		TargetHours: *req.TargetHours,
		StartDate:   start,
		EndDate:     start.AddDate(0, 0, *req.DurationDays-1),
	}
	for attempt := 1; ; attempt++ {
		challenge.ID = 0
		challenge.InviteCode = s.newCode()
		err := s.repo.WithTransaction(func(tx *repository.ChallengeRepository) error {
			if err := s.checkOpenLimit(tx, viewerID, today); err != nil {
				return err
			}
			created, err := tx.CreateChallenge(challenge)
			if err != nil {
				return err
			}
			if !created {
				return errInviteCodeTaken
			}
			return tx.AddParticipant(&models.ChallengeParticipant{
				ChallengeID: challenge.ID,
				UserID:      viewerID,
				JoinedAt:    now,
				JoinedOn:    today,
			})
		})
		if errors.Is(err, errInviteCodeTaken) && attempt < maxInviteCodeAttempts {
			logger.Sugar.Warnw("Challenge invite code collision, retrying with a new code",
				"user_id", viewerID,
				"attempt", attempt,
			)
			continue
		}
		if errors.Is(err, ErrChallengeLimitReached) {
			return nil, err
		}
		if err != nil {
			return nil, fmt.Errorf("create challenge: %w", err)
		}
		break
	}

	logger.Sugar.Infow("Challenge created",
		"challenge_id", challenge.ID,
		"user_id", viewerID,
		"duration_days", *req.DurationDays,
		"starts_in_days", daysBetween(today, start),
	)
	detail, _, err := s.loadDetail(challenge.ID, viewerID, today)
	return detail, err
}

// JoinByCode adds the viewer to the challenge behind an invite code and returns its detail.
// Joining again is a no-op. The challenge's row lock serialises joins, so the participant cap
// holds under concurrency; the user's row lock does the same for the open-challenge limit.
func (s *ChallengeService) JoinByCode(ctx context.Context, viewerID uint, rawCode string) (*dto.ChallengeDetail, error) {
	challenge, err := s.findByCode(rawCode)
	if err != nil {
		return nil, err
	}
	today := s.today()
	now := s.now()
	joined := false
	participantCount := int64(0)
	err = s.repo.WithLockedChallenge(challenge.ID, func(tx *repository.ChallengeRepository, locked *models.Challenge) error {
		existing, err := tx.FindParticipant(locked.ID, viewerID)
		if err != nil {
			return err
		}
		if existing != nil {
			return nil
		}
		if newChallengeRules(locked, today).status() == ChallengeStatusEnded {
			return ErrChallengeEnded
		}
		participantCount, err = tx.CountParticipants(locked.ID)
		if err != nil {
			return err
		}
		if participantCount >= constants.ChallengeMaxParticipants {
			return ErrChallengeFull
		}
		if err := s.checkOpenLimit(tx, viewerID, today); err != nil {
			return err
		}
		joined = true
		participantCount++
		return tx.AddParticipant(&models.ChallengeParticipant{
			ChallengeID: locked.ID,
			UserID:      viewerID,
			JoinedAt:    now,
			JoinedOn:    today,
		})
	})
	if err != nil {
		return nil, s.mapLockedError(err, "join challenge")
	}
	if joined {
		logger.Sugar.Infow("Challenge joined",
			"challenge_id", challenge.ID,
			"user_id", viewerID,
			"participant_count", participantCount,
		)
	}

	detail, participants, loadErr := s.loadDetail(challenge.ID, viewerID, today)
	if joined && challenge.CreatorID != viewerID {
		if joiner := findParticipantRow(participants, viewerID); joiner != nil {
			s.notify(challenge.ID, "challenge_joined", challenge.CreatorID, func(nctx context.Context) error {
				return s.notifSvc.NotifyChallengeJoined(nctx, challenge.CreatorID, viewerID,
					joiner.Username, avatarOf(joiner.ProfilePic), challenge.ID, challenge.Title)
			})
		} else {
			logger.Sugar.Warnw("Challenge joined notification skipped: loading the challenge failed after the join",
				"challenge_id", challenge.ID,
				"user_id", viewerID,
				"error", loadErr,
			)
		}
	}
	if loadErr != nil {
		return nil, loadErr
	}
	return detail, nil
}

// Leave removes the viewer (who must not be the creator) from a challenge that has not ended,
// together with their locked days.
func (s *ChallengeService) Leave(ctx context.Context, viewerID, challengeID uint) error {
	today := s.today()
	err := s.repo.WithLockedChallenge(challengeID, func(tx *repository.ChallengeRepository, challenge *models.Challenge) error {
		participant, err := tx.FindParticipant(challenge.ID, viewerID)
		if err != nil {
			return err
		}
		if participant == nil {
			return ErrChallengeNotFound
		}
		if challenge.CreatorID == viewerID {
			return ErrCreatorCannotLeave
		}
		if newChallengeRules(challenge, today).status() == ChallengeStatusEnded {
			return ErrChallengeEnded
		}
		return tx.RemoveParticipant(challenge.ID, viewerID)
	})
	if err != nil {
		return s.mapLockedError(err, "leave challenge")
	}
	logger.Sugar.Infow("Challenge left", "challenge_id", challengeID, "user_id", viewerID)
	return nil
}

// Delete deletes a challenge and everything attached to it. Only the creator may, while the
// challenge is upcoming or while they are its only participant.
func (s *ChallengeService) Delete(ctx context.Context, viewerID, challengeID uint) error {
	today := s.today()
	err := s.repo.WithLockedChallenge(challengeID, func(tx *repository.ChallengeRepository, challenge *models.Challenge) error {
		participant, err := tx.FindParticipant(challenge.ID, viewerID)
		if err != nil {
			return err
		}
		if participant == nil {
			return ErrChallengeNotFound
		}
		if challenge.CreatorID != viewerID {
			return ErrNotChallengeCreator
		}
		if newChallengeRules(challenge, today).status() != ChallengeStatusUpcoming {
			count, err := tx.CountParticipants(challenge.ID)
			if err != nil {
				return err
			}
			if count > 1 {
				return ErrChallengeInProgress
			}
		}
		return tx.Delete(challenge.ID)
	})
	if err != nil {
		return s.mapLockedError(err, "delete challenge")
	}
	logger.Sugar.Infow("Challenge deleted", "challenge_id", challengeID, "user_id", viewerID)
	return nil
}

// Cheer lets a participant cheer another participant of an active challenge, once per IST day.
// alreadyCheered is true (and nobody is notified) for a repeat.
func (s *ChallengeService) Cheer(ctx context.Context, viewerID, challengeID, targetID uint) (alreadyCheered bool, err error) {
	challenge, participants, err := s.loadParticipation(challengeID, viewerID)
	if err != nil {
		return false, err
	}
	if targetID == viewerID {
		return false, ErrCannotCheerSelf
	}
	if findParticipantRow(participants, targetID) == nil {
		return false, validator.NewValidationError("user_id must be a participant of this challenge", constants.ErrCodeInvalidChallenge)
	}
	today := s.today()
	if newChallengeRules(challenge, today).status() != ChallengeStatusActive {
		return false, ErrChallengeNotActive
	}

	created, err := s.repo.CreateCheer(&models.ChallengeCheer{
		ChallengeID: challenge.ID,
		FromUserID:  viewerID,
		ToUserID:    targetID,
		CheerDate:   today,
		CreatedAt:   s.now(),
	})
	if err != nil {
		return false, fmt.Errorf("create cheer: %w", err)
	}
	logger.Sugar.Infow("Challenge cheer",
		"challenge_id", challenge.ID,
		"user_id", viewerID,
		"to_user_id", targetID,
		"new", created,
	)
	if created {
		cheerer := findParticipantRow(participants, viewerID)
		s.notify(challenge.ID, "challenge_cheer", targetID, func(nctx context.Context) error {
			return s.notifSvc.NotifyChallengeCheer(nctx, targetID, viewerID, cheerer.Username,
				avatarOf(cheerer.ProfilePic), challenge.ID, challenge.Title, formatDate(today))
		})
	}
	return !created, nil
}

// Invite invites 1 to 20 users to a challenge that has not ended. Users who do not exist, are
// participants, are the inviter, have no ACTIVE follow relationship with the inviter (in either
// direction) or already have an invite (from anyone) are skipped; invited + skipped =
// len(userIDs). Leaving a challenge removes the leaver's invite, so they can be invited again.
func (s *ChallengeService) Invite(ctx context.Context, viewerID, challengeID uint, userIDs []uint) (invited, skipped int, err error) {
	if valErr := validator.ValidateInviteUserIDs(userIDs); valErr != nil {
		return 0, 0, valErr
	}
	challenge, participants, err := s.loadParticipation(challengeID, viewerID)
	if err != nil {
		return 0, 0, err
	}
	if newChallengeRules(challenge, s.today()).status() == ChallengeStatusEnded {
		return 0, 0, ErrChallengeEnded
	}

	seen := make(map[uint]bool, len(userIDs))
	candidates := make([]uint, 0, len(userIDs))
	for _, id := range userIDs {
		if id != 0 && id != viewerID && !seen[id] {
			seen[id] = true
			candidates = append(candidates, id)
		}
	}
	invites, err := s.repo.CreateInvites(challenge.ID, viewerID, candidates, s.now())
	if err != nil {
		return 0, 0, fmt.Errorf("create invites: %w", err)
	}
	invited, skipped = len(invites), len(userIDs)-len(invites)
	logger.Sugar.Infow("Challenge invites sent",
		"challenge_id", challenge.ID,
		"user_id", viewerID,
		"requested", len(userIDs),
		"invited", invited,
		"skipped", skipped,
	)

	inviter := findParticipantRow(participants, viewerID)
	for _, invite := range invites {
		s.notify(challenge.ID, "challenge_invite", invite.InviteeID, func(nctx context.Context) error {
			return s.notifSvc.NotifyChallengeInvite(nctx, invite.InviteeID, viewerID, inviter.Username,
				avatarOf(inviter.ProfilePic), challenge.ID, invite.ID, challenge.Title, challenge.InviteCode)
		})
	}
	return invited, skipped, nil
}

// DeleteStaleInvites deletes invites still held by people who joined a challenge with them and
// left it back when leaving kept the invite, so they can be invited again. Safe to run on every
// start: it never deletes an open invite.
func (s *ChallengeService) DeleteStaleInvites(ctx context.Context) error {
	deleted, err := s.repo.DeleteStaleInvites()
	if err != nil {
		return fmt.Errorf("delete stale challenge invites: %w", err)
	}
	if deleted > 0 {
		logger.Sugar.Infow("Stale challenge invites deleted", "deleted_count", deleted)
	}
	return nil
}

// ==================== Loading and building ====================

// findByCode resolves an invite code (case-insensitive, surrounding spaces ignored).
func (s *ChallengeService) findByCode(rawCode string) (*models.Challenge, error) {
	code, ok := validator.NormalizeInviteCode(rawCode)
	if !ok {
		return nil, ErrChallengeNotFound
	}
	challenge, err := s.repo.FindByInviteCode(code)
	if err != nil {
		return nil, fmt.Errorf("find challenge by code: %w", err)
	}
	if challenge == nil {
		return nil, ErrChallengeNotFound
	}
	return challenge, nil
}

// requireParticipant returns the challenge when the user takes part in it.
func (s *ChallengeService) requireParticipant(challengeID, userID uint) (*models.Challenge, error) {
	challenge, err := s.repo.FindByID(challengeID)
	if err != nil {
		return nil, fmt.Errorf("find challenge: %w", err)
	}
	if challenge == nil {
		return nil, ErrChallengeNotFound
	}
	participant, err := s.repo.FindParticipant(challengeID, userID)
	if err != nil {
		return nil, fmt.Errorf("find participant: %w", err)
	}
	if participant == nil {
		return nil, ErrChallengeNotFound
	}
	return challenge, nil
}

// loadParticipation returns the challenge and its participants when the user takes part in it.
func (s *ChallengeService) loadParticipation(challengeID, userID uint) (*models.Challenge, []repository.ChallengeParticipantRow, error) {
	challenge, err := s.repo.FindByID(challengeID)
	if err != nil {
		return nil, nil, fmt.Errorf("find challenge: %w", err)
	}
	if challenge == nil {
		return nil, nil, ErrChallengeNotFound
	}
	participants, err := s.repo.ListParticipants([]uint{challengeID})
	if err != nil {
		return nil, nil, fmt.Errorf("list participants: %w", err)
	}
	if findParticipantRow(participants, userID) == nil {
		return nil, nil, ErrChallengeNotFound
	}
	return challenge, participants, nil
}

// loadDetail builds the detail of a challenge the viewer takes part in.
func (s *ChallengeService) loadDetail(challengeID, viewerID uint, today time.Time) (*dto.ChallengeDetail, []repository.ChallengeParticipantRow, error) {
	challenge, participants, err := s.loadParticipation(challengeID, viewerID)
	if err != nil {
		return nil, nil, err
	}
	rules := newChallengeRules(challenge, today)

	facts := make(map[uint][]dayFacts, len(participants))
	for _, p := range participants {
		facts[p.UserID] = make([]dayFacts, rules.durationDays())
	}
	snapshots, err := s.repo.ListDays(challenge.ID)
	if err != nil {
		return nil, nil, fmt.Errorf("list locked days: %w", err)
	}
	for _, d := range snapshots {
		if f, ok := facts[d.UserID]; ok {
			addSnapshots(rules, f, []models.ChallengeDay{d})
		}
	}
	if rules.hasLiveDays() {
		live, err := s.repo.ActivityDays([]uint{challenge.ID}, today)
		if err != nil {
			return nil, nil, fmt.Errorf("read activity days: %w", err)
		}
		for _, a := range live {
			if f, ok := facts[a.UserID]; ok {
				addLiveDays(rules, f, []repository.ChallengeActivityDay{a})
			}
		}
	}
	cheered := map[uint]bool{}
	if rules.status() == ChallengeStatusActive {
		ids, err := s.repo.CheeredUserIDs(challenge.ID, viewerID, today)
		if err != nil {
			return nil, nil, fmt.Errorf("list cheers: %w", err)
		}
		for _, id := range ids {
			cheered[id] = true
		}
	}

	type scored struct {
		row    repository.ChallengeParticipantRow
		window participationWindow
		days   []evaluatedDay
		score  participantScore
	}
	all := make([]scored, len(participants))
	entries := make([]rankEntry, len(participants))
	for i, p := range participants {
		window := rules.window(p.JoinedOn)
		days := rules.evaluateDays(window.start, facts[p.UserID])
		score := rules.score(days, window)
		all[i] = scored{row: p, window: window, days: days, score: score}
		entries[i] = rankEntry{userID: p.UserID, daysMet: score.daysMet, totalCenti: score.totalCenti}
	}
	var ranks map[uint]int
	if rules.status() != ChallengeStatusUpcoming {
		ranks = rankParticipants(challenge.GoalType, entries)
	}

	finalized := challenge.FinalizedAt != nil
	var me dto.ChallengeProgress
	var myDays []dto.ChallengeDay
	result := make([]dto.ChallengeParticipant, 0, len(all))
	for _, p := range all {
		var rank *int
		if r, ok := ranks[p.row.UserID]; ok {
			rank = &r
		}
		progress := progressOf(p.window, p.score, rank,
			finalResultOf(finalized, p.row.FinalRank, p.row.FinalDaysMet, p.row.FinalTotalHours, p.row.Completed))
		if p.row.UserID == viewerID {
			me = progress
			myDays = challengeDaysOf(p.days)
		}
		result = append(result, dto.ChallengeParticipant{
			ChallengeProgress: progress,
			User:              challengeUserOf(p.row),
			JoinedOn:          formatDate(civilDate(p.row.JoinedOn)),
			IsMe:              p.row.UserID == viewerID,
			CheeredToday:      cheered[p.row.UserID],
			Days:              daysString(p.days),
		})
	}
	sort.SliceStable(result, func(i, j int) bool { return participantLess(result[i], result[j]) })

	isCreator := challenge.CreatorID == viewerID
	status := rules.status()
	var lockedThrough *string
	if rules.lockedThrough != nil {
		d := formatDate(*rules.lockedThrough)
		lockedThrough = &d
	}
	detail := &dto.ChallengeDetail{
		ChallengeSummary: summaryOf(challenge, rules, len(participants), viewerID, me),
		InviteCode:       challenge.InviteCode,
		Today:            formatDate(today),
		LockedThrough:    lockedThrough,
		ResultsDate:      formatDate(rules.end.AddDate(0, 0, constants.ChallengeLockDelayDays)),
		CompletionDays:   completionThreshold(rules.durationDays()),
		MaxParticipants:  constants.ChallengeMaxParticipants,
		Creator:          creatorOf(challenge, participants),
		CanInvite:        status != ChallengeStatusEnded,
		CanLeave:         !isCreator && status != ChallengeStatusEnded,
		CanDelete:        isCreator && (status == ChallengeStatusUpcoming || len(participants) == 1),
		Participants:     result,
		MyDays:           myDays,
	}
	return detail, participants, nil
}

// checkOpenLimit locks the user's row and fails when they already take part in the maximum
// number of upcoming or active challenges.
func (s *ChallengeService) checkOpenLimit(tx *repository.ChallengeRepository, userID uint, today time.Time) error {
	if err := tx.LockUser(userID); err != nil {
		return err
	}
	open, err := tx.CountOpenForUser(userID, today)
	if err != nil {
		return err
	}
	if open >= constants.ChallengeMaxOpenPerUser {
		return ErrChallengeLimitReached
	}
	return nil
}

// mapLockedError turns the repository's not-found error into the service's and wraps
// unexpected errors; the service's own errors pass through.
func (s *ChallengeService) mapLockedError(err error, action string) error {
	switch {
	case errors.Is(err, repository.ErrChallengeNotFound):
		return ErrChallengeNotFound
	case errors.Is(err, ErrChallengeNotFound), errors.Is(err, ErrChallengeEnded), errors.Is(err, ErrChallengeFull),
		errors.Is(err, ErrChallengeLimitReached), errors.Is(err, ErrCreatorCannotLeave),
		errors.Is(err, ErrChallengeInProgress), errors.Is(err, ErrNotChallengeCreator):
		return err
	default:
		return fmt.Errorf("%s: %w", action, err)
	}
}

// notify sends one notification; a failure is logged and never fails the caller.
func (s *ChallengeService) notify(challengeID uint, kind string, recipientID uint, send func(ctx context.Context) error) {
	if s.notifSvc == nil {
		return
	}
	if err := send(context.Background()); err != nil {
		logger.Sugar.Warnw("Challenge notification failed; the action itself succeeded",
			"challenge_id", challengeID,
			"type", kind,
			"recipient_id", recipientID,
			"error", err,
		)
	}
}

// addSnapshots records locked days in facts (indexed by offset from the start date).
func addSnapshots(rules challengeRules, facts []dayFacts, days []models.ChallengeDay) {
	for _, d := range days {
		if i := daysBetween(rules.start, civilDate(d.DayDate)); i >= 0 && i < len(facts) {
			facts[i].snapshot = true
			facts[i].snapMet = d.Met
			facts[i].snapCenti = hoursToCenti(d.Hours)
		}
	}
}

// addLiveDays records what was logged on unlocked dates in facts.
func addLiveDays(rules challengeRules, facts []dayFacts, days []repository.ChallengeActivityDay) {
	for _, d := range days {
		if i := daysBetween(rules.start, civilDate(d.DayDate)); i >= 0 && i < len(facts) {
			facts[i].liveCenti = hoursToCenti(d.Hours)
			facts[i].liveLogged = d.Logged
		}
	}
}

// rankFromTotals ranks the participants of a challenge from their locked totals plus their
// unlocked days, for lists that do not load every participant's days. The viewer's own score,
// computed from their days, is used as is.
func rankFromTotals(
	rules challengeRules,
	viewerID uint,
	viewerScore participantScore,
	participants []repository.ChallengeParticipantRow,
	totals map[uint]repository.ChallengeLockedTotal,
	live []repository.ChallengeActivityDay,
) map[uint]int {
	entries := make(map[uint]*rankEntry, len(participants))
	for _, p := range participants {
		t := totals[p.UserID]
		entries[p.UserID] = &rankEntry{userID: p.UserID, daysMet: t.DaysMet, totalCenti: hoursToCenti(t.TotalHours)}
	}
	for _, a := range live {
		e, ok := entries[a.UserID]
		if !ok {
			continue
		}
		centi := hoursToCenti(a.Hours)
		e.totalCenti += centi
		if dayMet(rules.goalType, rules.targetCenti, centi, a.Logged) {
			e.daysMet++
		}
	}
	list := make([]rankEntry, 0, len(participants))
	for _, p := range participants {
		e := *entries[p.UserID]
		if p.UserID == viewerID {
			e.daysMet, e.totalCenti = viewerScore.daysMet, viewerScore.totalCenti
		}
		list = append(list, e)
	}
	return rankParticipants(rules.goalType, list)
}

// finalResult is a participant's stored final standing.
type finalResult struct {
	rank       *int
	daysMet    *int
	totalHours *float64
	completed  *bool
}

// finalResultOf returns the stored results of a finalized challenge's participant, or nil.
func finalResultOf(finalized bool, rank, daysMet *int, totalHours *float64, completed *bool) *finalResult {
	if !finalized {
		return nil
	}
	return &finalResult{rank: rank, daysMet: daysMet, totalHours: totalHours, completed: completed}
}

// progressOf builds a participant's progress from their score. Once a challenge is finalized
// the stored results replace the computed days met, hours, rank and completion (a missing
// stored value falls back to the computed one).
func progressOf(window participationWindow, score participantScore, rank *int, final *finalResult) dto.ChallengeProgress {
	progress := dto.ChallengeProgress{
		Rank:          rank,
		DaysMet:       score.daysMet,
		DaysElapsed:   window.daysElapsed,
		DaysPossible:  window.daysPossible,
		CurrentStreak: score.currentStreak,
		TotalHours:    centiToHours(score.totalCenti),
	}
	if score.today != nil {
		hours, status := centiToHours(score.today.centi), score.today.status
		progress.TodayHours, progress.TodayStatus = &hours, &status
	}
	if final == nil {
		return progress
	}
	if final.rank != nil {
		progress.Rank = final.rank
	}
	if final.daysMet != nil {
		progress.DaysMet = *final.daysMet
	}
	if final.totalHours != nil {
		progress.TotalHours = centiToHours(hoursToCenti(*final.totalHours))
	}
	completed := progress.DaysMet >= completionThreshold(window.daysPossible)
	if final.completed != nil {
		completed = *final.completed
	}
	progress.Completed = &completed
	return progress
}

// summaryOf builds the summary shared by the list and the detail.
func summaryOf(challenge *models.Challenge, rules challengeRules, participantCount int, viewerID uint, me dto.ChallengeProgress) dto.ChallengeSummary {
	return dto.ChallengeSummary{
		ID:               challenge.ID,
		Title:            challenge.Title,
		Activity:         challenge.Activity,
		GoalType:         challenge.GoalType,
		TargetHours:      challenge.TargetHours,
		StartDate:        formatDate(rules.start),
		EndDate:          formatDate(rules.end),
		DurationDays:     rules.durationDays(),
		Status:           rules.status(),
		Finalized:        challenge.FinalizedAt != nil,
		DayNumber:        rules.dayNumber(),
		ParticipantCount: participantCount,
		IsCreator:        challenge.CreatorID == viewerID,
		Me:               me,
	}
}

// participantLess orders participants by rank (unranked last), then username, then ID.
func participantLess(a, b dto.ChallengeParticipant) bool {
	if (a.Rank == nil) != (b.Rank == nil) {
		return a.Rank != nil
	}
	if a.Rank != nil && *a.Rank != *b.Rank {
		return *a.Rank < *b.Rank
	}
	if a.User.Username != b.User.Username {
		return a.User.Username < b.User.Username
	}
	return a.User.ID < b.User.ID
}

// sortSummaries orders the list: active by end date, upcoming by start date, then ended with
// the most recent first.
func sortSummaries(summaries []dto.ChallengeSummary) {
	group := map[string]int{ChallengeStatusActive: 0, ChallengeStatusUpcoming: 1, ChallengeStatusEnded: 2}
	sort.SliceStable(summaries, func(i, j int) bool {
		a, b := summaries[i], summaries[j]
		if a.Status != b.Status {
			return group[a.Status] < group[b.Status]
		}
		switch a.Status {
		case ChallengeStatusActive:
			if a.EndDate != b.EndDate {
				return a.EndDate < b.EndDate
			}
		case ChallengeStatusUpcoming:
			if a.StartDate != b.StartDate {
				return a.StartDate < b.StartDate
			}
		default:
			if a.EndDate != b.EndDate {
				return a.EndDate > b.EndDate
			}
			return a.ID > b.ID
		}
		return a.ID < b.ID
	})
}

// challengeDaysOf converts the viewer's evaluated days for the API.
func challengeDaysOf(days []evaluatedDay) []dto.ChallengeDay {
	result := make([]dto.ChallengeDay, len(days))
	for i, d := range days {
		result[i] = dto.ChallengeDay{Date: formatDate(d.date), Status: d.status, Locked: d.locked}
		if d.hasHours() {
			hours := centiToHours(d.centi)
			result[i].Hours = &hours
		}
	}
	return result
}

func challengeUserOf(p repository.ChallengeParticipantRow) dto.ChallengeUser {
	return dto.ChallengeUser{
		ID:              p.UserID,
		Username:        p.Username,
		ProfilePic:      p.ProfilePic,
		ProfilePicThumb: p.ProfilePicThumb,
		IsVerified:      p.IsVerified,
	}
}

// creatorOf returns the creator from the participants (the creator cannot leave).
func creatorOf(challenge *models.Challenge, participants []repository.ChallengeParticipantRow) dto.ChallengeUser {
	if p := findParticipantRow(participants, challenge.CreatorID); p != nil {
		return challengeUserOf(*p)
	}
	return dto.ChallengeUser{ID: challenge.CreatorID}
}

func findParticipantRow(participants []repository.ChallengeParticipantRow, userID uint) *repository.ChallengeParticipantRow {
	for i := range participants {
		if participants[i].UserID == userID {
			return &participants[i]
		}
	}
	return nil
}

// avatarOf returns the profile picture URL used in notification metadata ("" without one).
func avatarOf(profilePic *string) string {
	if profilePic == nil {
		return ""
	}
	return *profilePic
}
