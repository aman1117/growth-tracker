package services

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/logger"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/pkg/models"
)

// endedResult is one participant's final standing, notified after the results are stored.
type endedResult struct {
	userID       uint
	rank         int
	daysMet      int
	daysPossible int
	completed    bool
}

// RunDailyJob makes challenge results final. It runs at 00:05 IST and
//  1. locks every day that can no longer change (through today-2) of every challenge that needs
//     it, catching up on days missed by earlier runs: each participant's result is stored in
//     challenge_days and locked_through advances;
//  2. finalizes the challenges whose end date is locked: final ranks, days met, hours and
//     completion are stored, and every participant gets a challenge_ended notification.
//
// One replica runs it per IST day (claimed in cron_job_logs). Re-running it is safe: stored days
// are never rewritten (ON CONFLICT DO NOTHING), each challenge is re-checked under its row lock
// and finalized challenges are skipped. A failing challenge does not stop the others; it is
// retried on the next run.
func (s *ChallengeService) RunDailyJob(ctx context.Context) error {
	started := time.Now()
	today := s.today()
	through := today.AddDate(0, 0, -constants.ChallengeLockDelayDays)
	log := logger.Sugar.With("job", models.CronJobChallengeDaily, "job_date", formatDate(today))

	var jobLog *models.CronJobLog
	if s.jobLogRepo != nil {
		claimed, ok, err := s.jobLogRepo.TryClaimJob(models.CronJobChallengeDaily, today, s.instanceID)
		switch {
		case err != nil:
			// Better to risk a duplicate run (it is idempotent) than to skip the day.
			log.Warnw("Failed to claim the challenge job, running without a job log", "error", err)
		case !ok:
			log.Infow("Challenge job already claimed by another instance, skipping",
				"claimed_by", claimed.InstanceID,
				"claimed_at", claimed.StartedAt,
			)
			return nil
		default:
			jobLog = claimed
			log.Infow("Claimed the challenge job", "instance_id", s.instanceID, "lock_through", formatDate(through))
		}
	}

	var errs []error
	locked := 0
	lockIDs, err := s.repo.ChallengeIDsToLock(through)
	if err != nil {
		log.Errorw("Failed to list challenges to lock; locking is retried on the next run", "error", err)
		errs = append(errs, fmt.Errorf("list challenges to lock: %w", err))
	}
	for _, id := range lockIDs {
		if err := s.lockChallengeDays(id, through); err != nil {
			log.Errorw("Failed to lock challenge days; they are locked on the next run",
				"challenge_id", id,
				"error", err,
			)
			errs = append(errs, fmt.Errorf("lock challenge %d: %w", id, err))
			continue
		}
		locked++
	}

	finalized := 0
	finalizeIDs, err := s.repo.ChallengeIDsToFinalize()
	if err != nil {
		log.Errorw("Failed to list challenges to finalize; finalization is retried on the next run", "error", err)
		errs = append(errs, fmt.Errorf("list challenges to finalize: %w", err))
	}
	for _, id := range finalizeIDs {
		challenge, results, err := s.finalizeChallenge(id)
		if err != nil {
			log.Errorw("Failed to finalize challenge; it is retried on the next run",
				"challenge_id", id,
				"error", err,
			)
			errs = append(errs, fmt.Errorf("finalize challenge %d: %w", id, err))
			continue
		}
		if challenge == nil {
			continue // finalized meanwhile
		}
		finalized++
		for _, r := range results {
			s.notify(challenge.ID, "challenge_ended", r.userID, func(nctx context.Context) error {
				return s.notifSvc.NotifyChallengeEnded(nctx, r.userID, challenge.ID, challenge.Title,
					r.rank, r.daysMet, r.daysPossible, r.completed)
			})
		}
	}

	jobErr := errors.Join(errs...)
	status, message := models.CronJobStatusCompleted, ""
	if jobErr != nil {
		status, message = models.CronJobStatusFailed, jobErr.Error()
	}
	// The job log's users_count holds the number of challenges processed.
	s.updateJobLog(jobLog, status, locked+finalized, message)
	log.Infow("Challenge job finished",
		"status", status,
		"challenges_locked", locked,
		"challenges_finalized", finalized,
		"failures", len(errs),
		"duration_ms", time.Since(started).Milliseconds(),
	)
	return jobErr
}

// lockChallengeDays stores the result of every participant on every unlocked date of the
// challenge up to through (or its end date) and advances locked_through, in one transaction
// holding the challenge's row lock. Each participant gets rows from their window start only.
func (s *ChallengeService) lockChallengeDays(id uint, through time.Time) error {
	return s.repo.WithLockedChallenge(id, func(tx *repository.ChallengeRepository, challenge *models.Challenge) error {
		rules := newChallengeRules(challenge, through)
		first := rules.start
		if rules.lockedThrough != nil {
			first = maxDate(first, rules.lockedThrough.AddDate(0, 0, 1))
		}
		last := minDate(rules.end, through)
		if challenge.FinalizedAt != nil || first.After(last) {
			return nil // locked meanwhile
		}

		participants, err := tx.ListParticipants([]uint{challenge.ID})
		if err != nil {
			return fmt.Errorf("list participants: %w", err)
		}
		live, err := tx.ActivityDays([]uint{challenge.ID}, last)
		if err != nil {
			return fmt.Errorf("read activity days: %w", err)
		}
		type userDay struct {
			userID uint
			offset int
		}
		logged := make(map[userDay]repository.ChallengeActivityDay, len(live))
		for _, a := range live {
			logged[userDay{a.UserID, daysBetween(rules.start, civilDate(a.DayDate))}] = a
		}

		lockedAt := s.now()
		var rows []models.ChallengeDay
		for _, p := range participants {
			for d := maxDate(first, civilDate(p.JoinedOn)); !d.After(last); d = d.AddDate(0, 0, 1) {
				a := logged[userDay{p.UserID, daysBetween(rules.start, d)}]
				centi := hoursToCenti(a.Hours)
				rows = append(rows, models.ChallengeDay{
					ChallengeID: challenge.ID,
					UserID:      p.UserID,
					DayDate:     d,
					Hours:       centiToHours(centi),
					Logged:      a.Logged,
					Met:         dayMet(rules.goalType, rules.targetCenti, centi, a.Logged),
					LockedAt:    lockedAt,
				})
			}
		}
		inserted, err := tx.InsertDays(rows)
		if err != nil {
			return fmt.Errorf("store locked days: %w", err)
		}
		if err := tx.SetLockedThrough(challenge.ID, last, lockedAt); err != nil {
			return fmt.Errorf("advance locked_through: %w", err)
		}
		logger.Sugar.Infow("Challenge days locked",
			"challenge_id", challenge.ID,
			"participants", len(participants),
			"from", formatDate(first),
			"through", formatDate(last),
			"days", daysBetween(first, last)+1,
			"rows_inserted", inserted,
		)
		return nil
	})
}

// finalizeChallenge computes the final standings from the locked days and stores them with
// finalized_at, in one transaction holding the challenge's row lock. It returns a nil
// challenge when there is nothing to do.
func (s *ChallengeService) finalizeChallenge(id uint) (*models.Challenge, []endedResult, error) {
	var finalized *models.Challenge
	var results []endedResult
	err := s.repo.WithLockedChallenge(id, func(tx *repository.ChallengeRepository, challenge *models.Challenge) error {
		rules := newChallengeRules(challenge, s.today())
		if challenge.FinalizedAt != nil || rules.lockedThrough == nil || rules.lockedThrough.Before(rules.end) {
			return nil
		}
		participants, err := tx.ListParticipants([]uint{challenge.ID})
		if err != nil {
			return fmt.Errorf("list participants: %w", err)
		}
		totals, err := tx.LockedTotals([]uint{challenge.ID})
		if err != nil {
			return fmt.Errorf("sum locked days: %w", err)
		}
		byUser := make(map[uint]repository.ChallengeLockedTotal, len(totals))
		for _, t := range totals {
			byUser[t.UserID] = t
		}
		entries := make([]rankEntry, len(participants))
		for i, p := range participants {
			t := byUser[p.UserID]
			entries[i] = rankEntry{userID: p.UserID, daysMet: t.DaysMet, totalCenti: hoursToCenti(t.TotalHours)}
		}
		ranks := rankParticipants(challenge.GoalType, entries)

		finals := make([]repository.ChallengeFinalResult, len(participants))
		completedCount := 0
		for i, p := range participants {
			daysPossible := newParticipationWindow(rules.start, rules.end, civilDate(p.JoinedOn), rules.end).daysPossible
			completed := entries[i].daysMet >= completionThreshold(daysPossible)
			if completed {
				completedCount++
			}
			finals[i] = repository.ChallengeFinalResult{
				ParticipantID: p.ID,
				Rank:          ranks[p.UserID],
				DaysMet:       entries[i].daysMet,
				TotalHours:    centiToHours(entries[i].totalCenti),
				Completed:     completed,
			}
			results = append(results, endedResult{
				userID:       p.UserID,
				rank:         ranks[p.UserID],
				daysMet:      entries[i].daysMet,
				daysPossible: daysPossible,
				completed:    completed,
			})
		}
		if err := tx.SaveFinalResults(finals); err != nil {
			return fmt.Errorf("store final results: %w", err)
		}
		if err := tx.MarkFinalized(challenge.ID, s.now()); err != nil {
			return fmt.Errorf("mark finalized: %w", err)
		}
		logger.Sugar.Infow("Challenge finalized",
			"challenge_id", challenge.ID,
			"participants", len(participants),
			"completed", completedCount,
		)
		finalized = challenge
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return finalized, results, nil
}

// updateJobLog records the outcome of a claimed job run.
func (s *ChallengeService) updateJobLog(jobLog *models.CronJobLog, status string, processed int, errorMsg string) {
	if s.jobLogRepo == nil || jobLog == nil || jobLog.ID == 0 {
		return
	}
	jobLog.Status = status
	jobLog.UsersCount = processed
	jobLog.CompletedAt = time.Now()
	jobLog.Error = errorMsg
	if err := s.jobLogRepo.Update(jobLog); err != nil {
		logger.Sugar.Warnw("Failed to update the challenge job log", "job_log_id", jobLog.ID, "error", err)
	}
}
