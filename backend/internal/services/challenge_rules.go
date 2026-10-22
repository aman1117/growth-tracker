package services

import (
	"cmp"
	"crypto/rand"
	"math"
	"slices"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/pkg/models"
)

// This file holds the pure challenge rules: dates, statuses, participation windows, day
// evaluation, scoring and ranking. Dates are calendar dates represented as midnight UTC, the
// representation of DATE columns; "today" is the current IST date.

// Challenge statuses as returned by the API (finalized is reported separately).
const (
	ChallengeStatusUpcoming = "upcoming"
	ChallengeStatusActive   = "active"
	ChallengeStatusEnded    = "ended"
)

// Day statuses as returned by the API.
const (
	DayStatusMet      = "met"
	DayStatusMissed   = "missed"
	DayStatusPending  = "pending"
	DayStatusUpcoming = "upcoming"
	DayStatusNone     = "none" // before the participant's window
)

// Reasons why a user cannot join a challenge (ChallengePreview.join_blocked_reason).
const (
	JoinBlockedEnded = "ended"
	JoinBlockedFull  = "full"
	JoinBlockedLimit = "limit"
)

// dayLetters encodes day statuses in ChallengeParticipant.days.
var dayLetters = map[string]byte{
	DayStatusMet:      'M',
	DayStatusMissed:   'X',
	DayStatusPending:  'P',
	DayStatusUpcoming: 'U',
	DayStatusNone:     '-',
}

// ==================== Dates ====================

// civilDate returns the calendar date of t, read in t's own location, as midnight UTC.
func civilDate(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

// istDate returns the IST calendar date of the instant t.
func istDate(t time.Time) time.Time {
	return civilDate(t.In(istLocation))
}

// daysBetween returns the number of days from a to b (both dates).
func daysBetween(a, b time.Time) int {
	return int(b.Sub(a) / (24 * time.Hour))
}

func minDate(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

func maxDate(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

func formatDate(d time.Time) string {
	return d.Format(constants.DateFormat)
}

// ==================== Hours ====================

// hoursToCenti converts hours to hundredths of an hour, the precision of the decimal(4,2)
// columns, so that sums and comparisons are exact.
func hoursToCenti(hours float64) int64 {
	return int64(math.Round(hours * 100))
}

func centiToHours(centi int64) float64 {
	return float64(centi) / 100
}

// ==================== Status and windows ====================

// challengeStatus returns upcoming before the start date, ended after the end date and active
// in between (inclusive).
func challengeStatus(start, end, today time.Time) string {
	switch {
	case today.Before(start):
		return ChallengeStatusUpcoming
	case today.After(end):
		return ChallengeStatusEnded
	default:
		return ChallengeStatusActive
	}
}

// challengeDayNumber returns today's day number (1 on the start date) while the challenge is
// active, nil otherwise.
func challengeDayNumber(start, end, today time.Time) *int {
	if challengeStatus(start, end, today) != ChallengeStatusActive {
		return nil
	}
	n := daysBetween(start, today) + 1
	return &n
}

// participationWindow is the run of dates a participant takes part in: from the later of the
// start date and the joining date through the end date.
type participationWindow struct {
	start        time.Time
	daysPossible int // days in [start, end]
	daysElapsed  int // days in [start, min(end, today)]; 0 before the window starts
}

func newParticipationWindow(challengeStart, challengeEnd, joinedOn, today time.Time) participationWindow {
	w := participationWindow{start: maxDate(challengeStart, joinedOn)}
	if !w.start.After(challengeEnd) {
		w.daysPossible = daysBetween(w.start, challengeEnd) + 1
	}
	if last := minDate(challengeEnd, today); !w.start.After(last) {
		w.daysElapsed = daysBetween(w.start, last) + 1
	}
	return w
}

// completionThreshold is the number of days to meet to complete a challenge of the given
// length: ceil(80% of the days), in integer arithmetic.
func completionThreshold(days int) int {
	return (days*constants.ChallengeCompletionPercent + 99) / 100
}

// ==================== Day evaluation ====================

// dayMet applies the goal to one day. An at_most day only counts when something was logged
// that day, so days without any logging are never met.
func dayMet(goalType string, targetCenti, hoursCenti int64, logged bool) bool {
	if goalType == models.ChallengeGoalAtMost {
		return logged && hoursCenti <= targetCenti
	}
	return hoursCenti >= targetCenti
}

// liveDayStatus is the status of a day that is not locked yet (and not in the future): an
// unmet at_least day is pending (hours can still be logged), an at_most day is missed once the
// logged hours exceed the target and pending while nothing is logged.
func liveDayStatus(goalType string, targetCenti, hoursCenti int64, logged bool) string {
	switch {
	case dayMet(goalType, targetCenti, hoursCenti, logged):
		return DayStatusMet
	case goalType == models.ChallengeGoalAtMost && logged:
		return DayStatusMissed
	default:
		return DayStatusPending
	}
}

// dayFacts is what is known about one participant on one challenge date.
type dayFacts struct {
	snapshot   bool  // a locked row exists
	snapMet    bool  // locked result
	snapCenti  int64 // locked hours
	liveCenti  int64 // hours of the activity in the activity log (unlocked dates)
	liveLogged bool  // anything logged that day (unlocked dates)
}

// evaluatedDay is the outcome of one challenge date for one participant.
type evaluatedDay struct {
	date   time.Time
	status string
	centi  int64 // hours; meaningful for met, missed and pending days
	locked bool
}

// hasHours reports whether the day counts towards hours (it is in the window and not in the
// future).
func (d evaluatedDay) hasHours() bool {
	return d.status != DayStatusUpcoming && d.status != DayStatusNone
}

// challengeRules evaluates the days of one challenge as of today.
type challengeRules struct {
	start         time.Time
	end           time.Time
	goalType      string
	targetCenti   int64
	lockedThrough *time.Time
	today         time.Time
}

func newChallengeRules(c *models.Challenge, today time.Time) challengeRules {
	r := challengeRules{
		start:       civilDate(c.StartDate),
		end:         civilDate(c.EndDate),
		goalType:    c.GoalType,
		targetCenti: hoursToCenti(c.TargetHours),
		today:       today,
	}
	if c.LockedThrough != nil {
		locked := civilDate(*c.LockedThrough)
		r.lockedThrough = &locked
	}
	return r
}

func (r challengeRules) durationDays() int {
	return daysBetween(r.start, r.end) + 1
}

func (r challengeRules) status() string {
	return challengeStatus(r.start, r.end, r.today)
}

func (r challengeRules) dayNumber() *int {
	return challengeDayNumber(r.start, r.end, r.today)
}

func (r challengeRules) isLocked(d time.Time) bool {
	return r.lockedThrough != nil && !d.After(*r.lockedThrough)
}

// window returns the participation window of a participant who joined on joinedOn.
func (r challengeRules) window(joinedOn time.Time) participationWindow {
	return newParticipationWindow(r.start, r.end, civilDate(joinedOn), r.today)
}

// hasLiveDays reports whether some dates up to today are not locked yet, so the activity log
// must be read.
func (r challengeRules) hasLiveDays() bool {
	first := r.start
	if r.lockedThrough != nil {
		first = maxDate(first, r.lockedThrough.AddDate(0, 0, 1))
	}
	return !first.After(minDate(r.end, r.today))
}

// evaluateDay classifies date d: upcoming after today, none before the participant's window,
// the snapshot result when locked (a missing snapshot counts as missed with no hours) and the
// live result from the activity log otherwise.
func (r challengeRules) evaluateDay(d, windowStart time.Time, facts dayFacts) evaluatedDay {
	day := evaluatedDay{date: d, locked: r.isLocked(d)}
	switch {
	case d.After(r.today):
		day.status = DayStatusUpcoming
	case d.Before(windowStart):
		day.status = DayStatusNone
	case day.locked:
		day.centi = facts.snapCenti
		day.status = DayStatusMissed
		if facts.snapshot && facts.snapMet {
			day.status = DayStatusMet
		}
	default:
		day.centi = facts.liveCenti
		day.status = liveDayStatus(r.goalType, r.targetCenti, facts.liveCenti, facts.liveLogged)
	}
	return day
}

// evaluateDays evaluates every date from the start date through the end date. facts is indexed
// by the offset of the date from the start date; a short or nil slice means nothing is known.
func (r challengeRules) evaluateDays(windowStart time.Time, facts []dayFacts) []evaluatedDay {
	days := make([]evaluatedDay, r.durationDays())
	for i := range days {
		var f dayFacts
		if i < len(facts) {
			f = facts[i]
		}
		days[i] = r.evaluateDay(r.start.AddDate(0, 0, i), windowStart, f)
	}
	return days
}

// ==================== Scores ====================

// participantScore is a participant's progress computed from their evaluated days.
type participantScore struct {
	daysMet       int
	totalCenti    int64
	currentStreak int
	today         *evaluatedDay // only for active challenges when today is in the window
}

// score sums the met days and hours of the window up to today, counts the current streak and
// picks today's day.
func (r challengeRules) score(days []evaluatedDay, window participationWindow) participantScore {
	var s participantScore
	for _, d := range days {
		if d.status == DayStatusMet {
			s.daysMet++
		}
		if d.hasHours() {
			s.totalCenti += d.centi
		}
	}
	s.currentStreak = r.currentStreak(days)
	if r.status() == ChallengeStatusActive && !r.today.Before(window.start) {
		today := days[daysBetween(r.start, r.today)]
		s.today = &today
	}
	return s
}

// currentStreak counts consecutive met days back from today, or from yesterday while today is
// not met yet; after the end date it counts back from the end date. Days outside the window
// are never met, so the count stops there.
func (r challengeRules) currentStreak(days []evaluatedDay) int {
	last := daysBetween(r.start, r.today)
	if last >= len(days) {
		last = len(days) - 1
	} else if last >= 0 && days[last].status != DayStatusMet {
		last--
	}
	streak := 0
	for i := last; i >= 0 && days[i].status == DayStatusMet; i-- {
		streak++
	}
	return streak
}

// daysString encodes the days with one letter each (see dayLetters).
func daysString(days []evaluatedDay) string {
	letters := make([]byte, len(days))
	for i, d := range days {
		letters[i] = dayLetters[d.status]
	}
	return string(letters)
}

// ==================== Ranking ====================

// rankEntry is one participant's score for ranking.
type rankEntry struct {
	userID     uint
	daysMet    int
	totalCenti int64
}

// rankParticipants applies competition ranking (1, 2, 2, 4): more days met first, then more
// hours for at_least goals or fewer hours for at_most goals. Equal scores share a rank.
func rankParticipants(goalType string, entries []rankEntry) map[uint]int {
	sorted := slices.Clone(entries)
	compareHours := func(a, b rankEntry) int { return cmp.Compare(b.totalCenti, a.totalCenti) }
	if goalType == models.ChallengeGoalAtMost {
		compareHours = func(a, b rankEntry) int { return cmp.Compare(a.totalCenti, b.totalCenti) }
	}
	slices.SortStableFunc(sorted, func(a, b rankEntry) int {
		if c := cmp.Compare(b.daysMet, a.daysMet); c != 0 {
			return c
		}
		return compareHours(a, b)
	})

	ranks := make(map[uint]int, len(sorted))
	for i, e := range sorted {
		if i > 0 && e.daysMet == sorted[i-1].daysMet && e.totalCenti == sorted[i-1].totalCenti {
			ranks[e.userID] = ranks[sorted[i-1].userID]
			continue
		}
		ranks[e.userID] = i + 1
	}
	return ranks
}

// ==================== Invite codes ====================

// generateInviteCode returns a random invite code. The alphabet has 32 letters, so the low 5
// bits of each random byte pick a letter without bias. crypto/rand.Read never fails (it
// aborts the program if the system's random source does).
func generateInviteCode() string {
	const alphabet = constants.ChallengeInviteCodeAlphabet
	code := make([]byte, constants.ChallengeInviteCodeLength)
	_, _ = rand.Read(code)
	for i, b := range code {
		code[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(code)
}
