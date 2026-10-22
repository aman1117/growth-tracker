package repository

import (
	"cmp"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/aman1117/backend/pkg/models"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var (
	// ErrChallengeNotFound is returned by WithLockedChallenge when the challenge does not exist.
	ErrChallengeNotFound = errors.New("challenge not found")
	// ErrChallengeUserNotFound is returned by LockUser when the user does not exist.
	ErrChallengeUserNotFound = errors.New("user not found")
)

// likeEscaper escapes the LIKE wildcards (and the escape character) in user input.
var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// UserChallengeRow is a challenge a user takes part in, with the user's participation and the
// challenge's participant count.
type UserChallengeRow struct {
	models.Challenge
	ParticipantCount int
	JoinedOn         time.Time
	FinalRank        *int
	FinalDaysMet     *int
	FinalTotalHours  *float64
	Completed        *bool
}

// ChallengeParticipantRow is a participant with the user fields shown in challenge views.
type ChallengeParticipantRow struct {
	ID              uint
	ChallengeID     uint
	UserID          uint
	JoinedAt        time.Time
	JoinedOn        time.Time
	FinalRank       *int
	FinalDaysMet    *int
	FinalTotalHours *float64
	Completed       *bool
	Username        string
	ProfilePic      *string
	ProfilePicThumb *string
	IsVerified      bool
}

// ChallengeActivityDay is what a participant logged on one challenge date that is not locked yet.
type ChallengeActivityDay struct {
	ChallengeID uint
	UserID      uint
	DayDate     time.Time
	Hours       float64 // hours of the challenge activity
	Logged      bool    // whether any activity at all was logged that day
}

// ChallengeLockedTotal sums a participant's locked (snapshotted) days.
type ChallengeLockedTotal struct {
	ChallengeID uint
	UserID      uint
	DaysMet     int
	TotalHours  float64
}

// ChallengeFinalResult is the final standing of one participant.
type ChallengeFinalResult struct {
	ParticipantID uint
	Rank          int
	DaysMet       int
	TotalHours    float64
	Completed     bool
}

// InviteCandidateRow is a user the viewer can invite to a challenge.
type InviteCandidateRow struct {
	ID              uint
	Username        string
	ProfilePic      *string
	ProfilePicThumb *string
	IsVerified      bool
	Invited         bool // has an invite to the challenge (from anyone); leaving removes it
}

// ChallengeRepository handles challenge data operations. Dates are DATE values represented as
// midnight UTC.
type ChallengeRepository struct {
	db *gorm.DB
}

// NewChallengeRepository creates a new ChallengeRepository
func NewChallengeRepository(db *gorm.DB) *ChallengeRepository {
	return &ChallengeRepository{db: db}
}

// ==================== Transactions ====================

// WithTransaction runs fn in a transaction; fn receives a repository bound to it.
func (r *ChallengeRepository) WithTransaction(fn func(tx *ChallengeRepository) error) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		return fn(&ChallengeRepository{db: tx})
	})
}

// WithLockedChallenge runs fn in a transaction that holds a row lock (SELECT ... FOR UPDATE) on
// the challenge, so joins, leaves, deletes and the daily job on one challenge never interleave.
// It returns ErrChallengeNotFound when the challenge does not exist.
func (r *ChallengeRepository) WithLockedChallenge(id uint, fn func(tx *ChallengeRepository, challenge *models.Challenge) error) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var challenge models.Challenge
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", id).Take(&challenge).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return ErrChallengeNotFound
		}
		if err != nil {
			return err
		}
		return fn(&ChallengeRepository{db: tx}, &challenge)
	})
}

// LockUser locks the user's row until the surrounding transaction ends, which serialises the
// open-challenge limit check of concurrent creates and joins by the same user. FOR NO KEY
// UPDATE does not block foreign key checks of other writers. Returns ErrChallengeUserNotFound
// for an unknown user.
func (r *ChallengeRepository) LockUser(userID uint) error {
	var id uint
	if err := r.db.Raw("SELECT id FROM users WHERE id = ? FOR NO KEY UPDATE", userID).Scan(&id).Error; err != nil {
		return err
	}
	if id == 0 {
		return ErrChallengeUserNotFound
	}
	return nil
}

// ==================== Challenges ====================

// CreateChallenge inserts a challenge. created is false (and the ID stays zero) when the invite
// code is already taken, so the caller can retry with another code.
func (r *ChallengeRepository) CreateChallenge(challenge *models.Challenge) (created bool, err error) {
	result := r.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "invite_code"}},
		DoNothing: true,
	}).Create(challenge)
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected == 1, nil
}

// FindByID returns the challenge, or nil when it does not exist.
func (r *ChallengeRepository) FindByID(id uint) (*models.Challenge, error) {
	return r.findOne("id = ?", id)
}

// FindByInviteCode returns the challenge with the (normalised) invite code, or nil.
func (r *ChallengeRepository) FindByInviteCode(code string) (*models.Challenge, error) {
	return r.findOne("invite_code = ?", code)
}

func (r *ChallengeRepository) findOne(query string, arg interface{}) (*models.Challenge, error) {
	var challenge models.Challenge
	err := r.db.Where(query, arg).Take(&challenge).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &challenge, nil
}

// Delete deletes a challenge; its participants, days, cheers and invites go with it (ON DELETE
// CASCADE).
func (r *ChallengeRepository) Delete(id uint) error {
	return r.db.Where("id = ?", id).Delete(&models.Challenge{}).Error
}

// ListForUser returns every challenge the user takes part in that has not ended (end_date >=
// today) plus the endedLimit most recently ended ones.
func (r *ChallengeRepository) ListForUser(userID uint, today time.Time, endedLimit int) ([]UserChallengeRow, error) {
	const columns = `c.*, p.joined_on, p.final_rank, p.final_days_met, p.final_total_hours, p.completed,
		(SELECT COUNT(*) FROM challenge_participants cp WHERE cp.challenge_id = c.id) AS participant_count
		FROM challenge_participants p JOIN challenges c ON c.id = p.challenge_id`
	var rows []UserChallengeRow
	err := r.db.Raw(`
		(SELECT `+columns+` WHERE p.user_id = ? AND c.end_date >= ?)
		UNION ALL
		(SELECT `+columns+` WHERE p.user_id = ? AND c.end_date < ? ORDER BY c.end_date DESC, c.id DESC LIMIT ?)`,
		userID, today, userID, today, endedLimit).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// CountOpenForUser counts the challenges the user takes part in that have not ended.
func (r *ChallengeRepository) CountOpenForUser(userID uint, today time.Time) (int64, error) {
	var count int64
	err := r.db.Model(&models.ChallengeParticipant{}).
		Joins("JOIN challenges c ON c.id = challenge_participants.challenge_id").
		Where("challenge_participants.user_id = ? AND c.end_date >= ?", userID, today).
		Count(&count).Error
	return count, err
}

// ChallengeIDsToLock returns the unfinalized challenges with days up to through that are not
// locked yet.
func (r *ChallengeRepository) ChallengeIDsToLock(through time.Time) ([]uint, error) {
	var ids []uint
	err := r.db.Model(&models.Challenge{}).
		Where("finalized_at IS NULL AND start_date <= ? AND (locked_through IS NULL OR locked_through < LEAST(end_date, ?))",
			through, through).
		Order("id").
		Pluck("id", &ids).Error
	return ids, err
}

// ChallengeIDsToFinalize returns the challenges whose every day is locked but whose results
// are not stored yet.
func (r *ChallengeRepository) ChallengeIDsToFinalize() ([]uint, error) {
	var ids []uint
	err := r.db.Model(&models.Challenge{}).
		Where("finalized_at IS NULL AND locked_through IS NOT NULL AND locked_through >= end_date").
		Order("id").
		Pluck("id", &ids).Error
	return ids, err
}

// SetLockedThrough advances the challenge's locked_through date (never backwards).
func (r *ChallengeRepository) SetLockedThrough(id uint, through, at time.Time) error {
	return r.db.Model(&models.Challenge{}).
		Where("id = ? AND (locked_through IS NULL OR locked_through < ?)", id, through).
		Updates(map[string]interface{}{"locked_through": through, "updated_at": at}).Error
}

// MarkFinalized sets finalized_at once.
func (r *ChallengeRepository) MarkFinalized(id uint, at time.Time) error {
	return r.db.Model(&models.Challenge{}).
		Where("id = ? AND finalized_at IS NULL", id).
		Updates(map[string]interface{}{"finalized_at": at, "updated_at": at}).Error
}

// ==================== Participants ====================

// AddParticipant inserts a participant.
func (r *ChallengeRepository) AddParticipant(participant *models.ChallengeParticipant) error {
	return r.db.Create(participant).Error
}

// FindParticipant returns the user's participation in the challenge, or nil.
func (r *ChallengeRepository) FindParticipant(challengeID, userID uint) (*models.ChallengeParticipant, error) {
	var participant models.ChallengeParticipant
	err := r.db.Where("challenge_id = ? AND user_id = ?", challengeID, userID).Take(&participant).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &participant, nil
}

// CountParticipants counts the participants of a challenge.
func (r *ChallengeRepository) CountParticipants(challengeID uint) (int64, error) {
	var count int64
	err := r.db.Model(&models.ChallengeParticipant{}).Where("challenge_id = ?", challengeID).Count(&count).Error
	return count, err
}

// ListParticipants returns the participants of the challenges with their user fields, by
// challenge and then in joining order.
func (r *ChallengeRepository) ListParticipants(challengeIDs []uint) ([]ChallengeParticipantRow, error) {
	if len(challengeIDs) == 0 {
		return nil, nil
	}
	var rows []ChallengeParticipantRow
	err := r.db.Raw(`
		SELECT p.id, p.challenge_id, p.user_id, p.joined_at, p.joined_on,
			p.final_rank, p.final_days_met, p.final_total_hours, p.completed,
			u.username, u.profile_pic, u.profile_pic_thumb, u.is_verified
		FROM challenge_participants p
		JOIN users u ON u.id = p.user_id
		WHERE p.challenge_id IN ?
		ORDER BY p.challenge_id, p.joined_at, p.id`, challengeIDs).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// RemoveParticipant removes a participant together with their locked days, so a later re-join
// starts a clean window, and with their invite to the challenge, so they can be invited again.
// Cheers and the invites they sent are kept.
func (r *ChallengeRepository) RemoveParticipant(challengeID, userID uint) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("challenge_id = ? AND user_id = ?", challengeID, userID).
			Delete(&models.ChallengeDay{}).Error; err != nil {
			return err
		}
		if err := tx.Where("challenge_id = ? AND invitee_id = ?", challengeID, userID).
			Delete(&models.ChallengeInvite{}).Error; err != nil {
			return err
		}
		return tx.Where("challenge_id = ? AND user_id = ?", challengeID, userID).
			Delete(&models.ChallengeParticipant{}).Error
	})
}

// SaveFinalResults stores the final standings in one statement.
func (r *ChallengeRepository) SaveFinalResults(results []ChallengeFinalResult) error {
	if len(results) == 0 {
		return nil
	}
	values := make([]string, len(results))
	args := make([]interface{}, 0, 5*len(results))
	for i, res := range results {
		values[i] = "(?::bigint, ?::integer, ?::integer, ?::numeric, ?::boolean)"
		args = append(args, res.ParticipantID, res.Rank, res.DaysMet, res.TotalHours, res.Completed)
	}
	return r.db.Exec(`
		UPDATE challenge_participants AS p
		SET final_rank = v.final_rank, final_days_met = v.days_met,
			final_total_hours = v.total_hours, completed = v.completed
		FROM (VALUES `+strings.Join(values, ", ")+`) AS v(id, final_rank, days_met, total_hours, completed)
		WHERE p.id = v.id`, args...).Error
}

// ==================== Days ====================

// ActivityDays returns, in one query, what the participants of the challenges logged on every
// date that is not locked yet: from the day after locked_through (or the start date, or the
// participant's joining date if later) through the earlier of the end date and through. Only
// dates with activity rows are returned; hours counts the challenge activity only (capped at
// 24) and logged reports whether any hours at all were logged.
func (r *ChallengeRepository) ActivityDays(challengeIDs []uint, through time.Time) ([]ChallengeActivityDay, error) {
	if len(challengeIDs) == 0 {
		return nil, nil
	}
	var rows []ChallengeActivityDay
	err := r.db.Raw(`
		SELECT p.challenge_id, p.user_id, a.activity_date AS day_date,
			LEAST(COALESCE(SUM(a.duration_hours) FILTER (WHERE a.name = c.activity), 0), 24) AS hours,
			COALESCE(SUM(a.duration_hours), 0) > 0 AS logged
		FROM challenge_participants p
		JOIN challenges c ON c.id = p.challenge_id
		JOIN activities a ON a.user_id = p.user_id
			AND a.activity_date >= GREATEST(c.start_date, p.joined_on, COALESCE(c.locked_through + 1, c.start_date))
			AND a.activity_date <= LEAST(c.end_date, ?)
		WHERE p.challenge_id IN ?
		GROUP BY p.challenge_id, p.user_id, a.activity_date
		ORDER BY p.challenge_id, p.user_id, a.activity_date`, through, challengeIDs).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// InsertDays stores locked days, skipping (participant, date) pairs that are already stored, and
// returns the number of new rows.
func (r *ChallengeRepository) InsertDays(days []models.ChallengeDay) (int64, error) {
	if len(days) == 0 {
		return 0, nil
	}
	result := r.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "challenge_id"}, {Name: "user_id"}, {Name: "day_date"}},
		DoNothing: true,
	}).CreateInBatches(days, 500)
	return result.RowsAffected, result.Error
}

// ListDays returns the locked days of every participant of a challenge.
func (r *ChallengeRepository) ListDays(challengeID uint) ([]models.ChallengeDay, error) {
	var days []models.ChallengeDay
	err := r.db.Where("challenge_id = ?", challengeID).Order("user_id, day_date").Find(&days).Error
	return days, err
}

// ListUserDays returns one user's locked days in the challenges.
func (r *ChallengeRepository) ListUserDays(userID uint, challengeIDs []uint) ([]models.ChallengeDay, error) {
	if len(challengeIDs) == 0 {
		return nil, nil
	}
	var days []models.ChallengeDay
	err := r.db.Where("user_id = ? AND challenge_id IN ?", userID, challengeIDs).
		Order("challenge_id, day_date").Find(&days).Error
	return days, err
}

// LockedTotals sums the locked days of the current participants of the challenges: days met
// and hours, counting only dates inside each participant's window and up to locked_through.
func (r *ChallengeRepository) LockedTotals(challengeIDs []uint) ([]ChallengeLockedTotal, error) {
	if len(challengeIDs) == 0 {
		return nil, nil
	}
	var rows []ChallengeLockedTotal
	err := r.db.Raw(`
		SELECT d.challenge_id, d.user_id,
			COUNT(*) FILTER (WHERE d.met) AS days_met,
			COALESCE(SUM(d.hours), 0) AS total_hours
		FROM challenge_days d
		JOIN challenge_participants p ON p.challenge_id = d.challenge_id AND p.user_id = d.user_id
		JOIN challenges c ON c.id = d.challenge_id
		WHERE d.challenge_id IN ?
			AND d.day_date >= GREATEST(c.start_date, p.joined_on)
			AND d.day_date <= c.locked_through
		GROUP BY d.challenge_id, d.user_id
		ORDER BY d.challenge_id, d.user_id`, challengeIDs).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	return rows, nil
}

// ==================== Cheers ====================

// CreateCheer stores a cheer unless the same one was already given that day; created reports
// whether it is new.
func (r *ChallengeRepository) CreateCheer(cheer *models.ChallengeCheer) (created bool, err error) {
	result := r.db.Clauses(clause.OnConflict{DoNothing: true}).Create(cheer)
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected == 1, nil
}

// CheeredUserIDs returns the participants fromUserID cheered in the challenge on date.
func (r *ChallengeRepository) CheeredUserIDs(challengeID, fromUserID uint, date time.Time) ([]uint, error) {
	var ids []uint
	err := r.db.Model(&models.ChallengeCheer{}).
		Where("challenge_id = ? AND from_user_id = ? AND cheer_date = ?", challengeID, fromUserID, date).
		Order("to_user_id").
		Pluck("to_user_id", &ids).Error
	return ids, err
}

// ==================== Invites ====================

// CreateInvites invites, in one statement, every user in userIDs who exists, is not the inviter,
// is not a participant, has an ACTIVE follow relationship with the inviter in either direction
// and has no invite to the challenge yet (from anyone; leaving a challenge removes the leaver's
// invite). It returns the new invites ordered by invitee ID.
func (r *ChallengeRepository) CreateInvites(challengeID, inviterID uint, userIDs []uint, at time.Time) ([]models.ChallengeInvite, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}
	var invites []models.ChallengeInvite
	err := r.db.Raw(`
		INSERT INTO challenge_invites (challenge_id, inviter_id, invitee_id, created_at)
		SELECT ?, ?, u.id, ?
		FROM users u
		WHERE u.id IN ?
			AND u.id <> ?
			AND NOT EXISTS (SELECT 1 FROM challenge_participants p WHERE p.challenge_id = ? AND p.user_id = u.id)
			AND (EXISTS (SELECT 1 FROM follow_edges_by_follower f
					WHERE f.follower_id = ? AND f.followee_id = u.id AND f.state = ?)
				OR EXISTS (SELECT 1 FROM follow_edges_by_followee f
					WHERE f.followee_id = ? AND f.follower_id = u.id AND f.state = ?))
		ORDER BY u.id
		ON CONFLICT (challenge_id, invitee_id) DO NOTHING
		RETURNING id, challenge_id, inviter_id, invitee_id, created_at`,
		challengeID, inviterID, at, userIDs, inviterID, challengeID,
		inviterID, models.FollowStateActive, inviterID, models.FollowStateActive).Scan(&invites).Error
	if err != nil {
		return nil, err
	}
	slices.SortFunc(invites, func(a, b models.ChallengeInvite) int { return cmp.Compare(a.InviteeID, b.InviteeID) })
	return invites, nil
}

// DeleteStaleInvites deletes invites that were used to join a challenge the invitee has left
// since. Leaving used to keep the invite, which blocked inviting that person to the challenge
// again (RemoveParticipant now deletes it). A join is recognised by the creator's "joined"
// notification record, which is created right after the join and never deleted. Invites newer
// than that record were sent after a later leave and are open, so they stay, and running this
// again deletes nothing new. Returns the number of invites deleted.
func (r *ChallengeRepository) DeleteStaleInvites() (int64, error) {
	result := r.db.Exec(`
		DELETE FROM challenge_invites i
		USING challenges c
		WHERE c.id = i.challenge_id
			AND NOT EXISTS (SELECT 1 FROM challenge_participants p
				WHERE p.challenge_id = i.challenge_id AND p.user_id = i.invitee_id)
			AND EXISTS (SELECT 1 FROM notification_dedupes d
				WHERE d.user_id = c.creator_id
					AND d.actor_id = i.invitee_id
					AND d.type = ?
					AND d.entity_type = ?
					AND d.entity_key = i.challenge_id::text
					AND d.created_at >= i.created_at)`,
		models.NotifTypeChallengeJoined, models.NotifEntityChallenge)
	return result.RowsAffected, result.Error
}

// InviteCandidates returns the users the viewer follows or who follow the viewer (ACTIVE edges),
// excluding the viewer and the challenge's participants, whose username starts with prefix
// (case-insensitive; LIKE wildcards in prefix match literally), ordered by username.
func (r *ChallengeRepository) InviteCandidates(challengeID, viewerID uint, prefix string, limit int) ([]InviteCandidateRow, error) {
	pattern := likeEscaper.Replace(strings.ToLower(prefix)) + "%"
	var rows []InviteCandidateRow
	err := r.db.Raw(`
		SELECT u.id, u.username, u.profile_pic, u.profile_pic_thumb, u.is_verified,
			EXISTS (SELECT 1 FROM challenge_invites i WHERE i.challenge_id = ? AND i.invitee_id = u.id) AS invited
		FROM users u
		WHERE u.id IN (
				SELECT f.followee_id FROM follow_edges_by_follower f WHERE f.follower_id = ? AND f.state = ?
				UNION
				SELECT f.follower_id FROM follow_edges_by_followee f WHERE f.followee_id = ? AND f.state = ?
			)
			AND u.id <> ?
			AND NOT EXISTS (SELECT 1 FROM challenge_participants p WHERE p.challenge_id = ? AND p.user_id = u.id)
			AND lower(u.username) LIKE ? ESCAPE '\'
		ORDER BY u.username, u.id
		LIMIT ?`,
		challengeID, viewerID, models.FollowStateActive, viewerID, models.FollowStateActive,
		viewerID, challengeID, pattern, limit).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	return rows, nil
}
