package services

import (
	"strings"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/constants"
	"github.com/aman1117/backend/internal/dto"
	"github.com/aman1117/backend/internal/repository"
	"github.com/aman1117/backend/internal/testutil"
	"github.com/aman1117/backend/internal/validator"
	"github.com/aman1117/backend/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// cday is the start date most rule tests use.
var cday = testutil.Day(2026, time.March, 9)

// on returns the date offset days after cday.
func on(offset int) time.Time { return cday.AddDate(0, 0, offset) }

func ruleChallenge(goal string, target float64, days int, locked *time.Time) *models.Challenge {
	return &models.Challenge{
		GoalType: goal, TargetHours: target, Activity: string(models.ActivityStudy),
		StartDate: cday, EndDate: on(days - 1), LockedThrough: locked,
	}
}

func statuses(days []evaluatedDay) []string {
	out := make([]string, len(days))
	for i, d := range days {
		out[i] = d.status
	}
	return out
}

func TestChallengeDates(t *testing.T) {
	// IST is UTC+5:30: 18:30 UTC is midnight in India.
	assert.Equal(t, testutil.Day(2026, 3, 9), istDate(time.Date(2026, 3, 8, 18, 30, 0, 0, time.UTC)))
	assert.Equal(t, testutil.Day(2026, 3, 8), istDate(time.Date(2026, 3, 8, 18, 29, 59, 0, time.UTC)))
	assert.Equal(t, testutil.Day(2026, 3, 9), civilDate(time.Date(2026, 3, 9, 23, 59, 0, 0, istLocation)))
	assert.Equal(t, 0, daysBetween(cday, cday))
	assert.Equal(t, 21, daysBetween(cday, on(21)))
	assert.Equal(t, -1, daysBetween(cday, on(-1)))
	assert.Equal(t, cday, minDate(cday, on(1)))
	assert.Equal(t, cday, minDate(on(1), cday))
	assert.Equal(t, on(1), maxDate(cday, on(1)))
	assert.Equal(t, on(1), maxDate(on(1), cday))
	assert.Equal(t, "2026-03-09", formatDate(cday))
}

func TestChallengeHours(t *testing.T) {
	assert.Equal(t, int64(225), hoursToCenti(2.25))
	assert.Equal(t, int64(30), hoursToCenti(0.1+0.2), "no floating point drift")
	assert.Equal(t, int64(2400), hoursToCenti(24))
	assert.Equal(t, 2.25, centiToHours(225))
	assert.Equal(t, 0.0, centiToHours(0))
}

func TestChallengeStatusAndDayNumber(t *testing.T) {
	start, end := cday, on(20)
	tests := []struct {
		name      string
		today     time.Time
		status    string
		dayNumber *int
	}{
		{"day before the start", on(-1), ChallengeStatusUpcoming, nil},
		{"start date", cday, ChallengeStatusActive, testutil.Ptr(1)},
		{"second day", on(1), ChallengeStatusActive, testutil.Ptr(2)},
		{"end date", end, ChallengeStatusActive, testutil.Ptr(21)},
		{"day after the end", on(21), ChallengeStatusEnded, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.status, challengeStatus(start, end, tt.today))
			assert.Equal(t, tt.dayNumber, challengeDayNumber(start, end, tt.today))
			rules := newChallengeRules(ruleChallenge(models.ChallengeGoalAtLeast, 2, 21, nil), tt.today)
			assert.Equal(t, tt.status, rules.status())
			assert.Equal(t, tt.dayNumber, rules.dayNumber())
			assert.Equal(t, 21, rules.durationDays())
		})
	}
}

func TestParticipationWindow(t *testing.T) {
	start, end := cday, on(9) // 10 days
	tests := []struct {
		name                  string
		joinedOn, today       time.Time
		windowStart           time.Time
		possible, elapsedDays int
	}{
		{"joined before an upcoming challenge", on(-5), on(-1), cday, 10, 0},
		{"joined before the start, day 4", on(-5), on(3), cday, 10, 4},
		{"joined on the start date, start date", cday, cday, cday, 10, 1},
		{"late joiner", on(4), on(6), on(4), 6, 3},
		{"late joiner on their first day", on(4), on(4), on(4), 6, 1},
		{"late joiner after the end", on(4), on(20), on(4), 6, 6},
		{"joined on the end date", end, end, end, 1, 1},
		{"before the window starts", on(4), on(3), on(4), 6, 0},
		{"after the end", on(-5), on(15), cday, 10, 10},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := newParticipationWindow(start, end, tt.joinedOn, tt.today)
			assert.Equal(t, tt.windowStart, w.start)
			assert.Equal(t, tt.possible, w.daysPossible)
			assert.Equal(t, tt.elapsedDays, w.daysElapsed)
		})
	}
	// A join after the end leaves an empty window.
	w := newParticipationWindow(start, end, on(12), on(12))
	assert.Zero(t, w.daysPossible)
	assert.Zero(t, w.daysElapsed)
}

func TestCompletionThreshold(t *testing.T) {
	for days, want := range map[int]int{0: 0, 1: 1, 3: 3, 4: 4, 5: 4, 7: 6, 10: 8, 21: 17, 30: 24, 59: 48, 60: 48} {
		assert.Equal(t, want, completionThreshold(days), "ceil(0.8 * %d)", days)
	}
}

func TestDayEvaluation(t *testing.T) {
	tests := []struct {
		name   string
		goal   string
		target float64
		hours  float64
		logged bool
		met    bool
		live   string
	}{
		{"at_least reached", models.ChallengeGoalAtLeast, 2, 2, true, true, DayStatusMet},
		{"at_least exceeded", models.ChallengeGoalAtLeast, 2, 5.5, true, true, DayStatusMet},
		{"at_least short by a quarter", models.ChallengeGoalAtLeast, 2, 1.75, true, false, DayStatusPending},
		{"at_least nothing logged", models.ChallengeGoalAtLeast, 2, 0, false, false, DayStatusPending},
		{"at_least other activities only", models.ChallengeGoalAtLeast, 0.25, 0, true, false, DayStatusPending},
		{"at_most under", models.ChallengeGoalAtMost, 1, 0.5, true, true, DayStatusMet},
		{"at_most exactly", models.ChallengeGoalAtMost, 1, 1, true, true, DayStatusMet},
		{"at_most over", models.ChallengeGoalAtMost, 1, 1.25, true, false, DayStatusMissed},
		{"at_most other activities only", models.ChallengeGoalAtMost, 1, 0, true, true, DayStatusMet},
		{"at_most nothing logged", models.ChallengeGoalAtMost, 1, 0, false, false, DayStatusPending},
		{"at_most zero, none of it", models.ChallengeGoalAtMost, 0, 0, true, true, DayStatusMet},
		{"at_most zero, some of it", models.ChallengeGoalAtMost, 0, 0.25, true, false, DayStatusMissed},
		{"at_most zero, nothing logged", models.ChallengeGoalAtMost, 0, 0, false, false, DayStatusPending},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			target, hours := hoursToCenti(tt.target), hoursToCenti(tt.hours)
			assert.Equal(t, tt.met, dayMet(tt.goal, target, hours, tt.logged))
			assert.Equal(t, tt.live, liveDayStatus(tt.goal, target, hours, tt.logged))
		})
	}
}

func TestChallengeRules_EvaluateDays(t *testing.T) {
	locked := on(2)
	today := on(4)
	facts := []dayFacts{
		{snapshot: true, snapMet: true, snapCenti: 500},   // before the window: ignored
		{snapshot: true, snapMet: true, snapCenti: 300},   // locked, met
		{liveCenti: 900, liveLogged: true},                // locked without a snapshot: missed
		{liveCenti: 250, liveLogged: true},                // live, met
		{liveCenti: 100, liveLogged: true},                // today, pending
		{liveCenti: 400, liveLogged: true, snapMet: true}, // future: upcoming
	}

	t.Run("at_least", func(t *testing.T) {
		rules := newChallengeRules(ruleChallenge(models.ChallengeGoalAtLeast, 2, 7, &locked), today)
		days := rules.evaluateDays(on(1), facts)
		require.Len(t, days, 7)
		assert.Equal(t, []string{DayStatusNone, DayStatusMet, DayStatusMissed, DayStatusMet, DayStatusPending,
			DayStatusUpcoming, DayStatusUpcoming}, statuses(days))
		assert.Equal(t, []bool{true, true, true, false, false, false, false},
			[]bool{days[0].locked, days[1].locked, days[2].locked, days[3].locked, days[4].locked, days[5].locked, days[6].locked})
		assert.Equal(t, int64(300), days[1].centi, "locked hours come from the snapshot")
		assert.Equal(t, int64(0), days[2].centi, "a missing snapshot counts no hours")
		assert.Equal(t, int64(250), days[3].centi)
		assert.Equal(t, on(6), days[6].date)
		assert.Equal(t, "-MXMPUU", daysString(days))

		score := rules.score(days, rules.window(on(1)))
		assert.Equal(t, 2, score.daysMet)
		assert.Equal(t, int64(300+0+250+100), score.totalCenti)
		assert.Equal(t, 1, score.currentStreak, "today is pending: counted from yesterday")
		require.NotNil(t, score.today)
		assert.Equal(t, DayStatusPending, score.today.status)
		assert.Equal(t, int64(100), score.today.centi)
	})

	t.Run("at_most", func(t *testing.T) {
		rules := newChallengeRules(ruleChallenge(models.ChallengeGoalAtMost, 1, 7, &locked), today)
		days := rules.evaluateDays(cday, []dayFacts{
			{snapshot: true, snapMet: false, snapCenti: 150},
			{snapshot: true, snapMet: true, snapCenti: 50},
			{snapshot: true, snapMet: true, snapCenti: 0},
			{liveCenti: 0, liveLogged: false},
			{liveCenti: 200, liveLogged: true},
		})
		assert.Equal(t, "XMMPXUU", daysString(days))
		score := rules.score(days, rules.window(cday))
		assert.Equal(t, 2, score.daysMet)
		assert.Equal(t, int64(400), score.totalCenti)
		assert.Equal(t, 0, score.currentStreak, "yesterday is pending")
		require.NotNil(t, score.today)
		assert.Equal(t, DayStatusMissed, score.today.status)
	})

	t.Run("nothing known", func(t *testing.T) {
		rules := newChallengeRules(ruleChallenge(models.ChallengeGoalAtLeast, 2, 3, nil), on(1))
		assert.Equal(t, "PPU", daysString(rules.evaluateDays(cday, nil)))
	})
}

func TestChallengeRules_HasLiveDays(t *testing.T) {
	ptr := func(d time.Time) *time.Time { return &d }
	tests := []struct {
		name   string
		locked *time.Time
		today  time.Time
		want   bool
	}{
		{"upcoming", nil, on(-1), false},
		{"first day", nil, cday, true},
		{"partly locked", ptr(on(1)), on(3), true},
		{"locked up to today", ptr(on(3)), on(3), false},
		{"ended, end not locked yet", ptr(on(5)), on(8), true},
		{"ended, fully locked", ptr(on(6)), on(9), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rules := newChallengeRules(ruleChallenge(models.ChallengeGoalAtLeast, 1, 7, tt.locked), tt.today)
			assert.Equal(t, tt.want, rules.hasLiveDays())
		})
	}
}

func TestChallengeRules_CurrentStreak(t *testing.T) {
	tests := []struct {
		name  string
		days  string // M met, X missed, P pending, U upcoming, - none
		today int    // offset of today from the start date
		want  int
	}{
		{"today met", "MMMMUUU", 3, 4},
		{"today pending keeps yesterday's streak", "MMMPUUU", 3, 3},
		{"today missed counts from yesterday", "MMMXUUU", 3, 3},
		{"broken streak", "MXMMPUU", 4, 2},
		{"yesterday missed", "MMXPUUU", 3, 0},
		{"first day pending", "PUUUUUU", 0, 0},
		{"first day met", "MUUUUUU", 0, 1},
		{"stops at the window start", "--MMPUU", 4, 2},
		{"upcoming", "UUUUUUU", -2, 0},
		{"ended: counted back from the end date", "XMMMMMM", 9, 6},
		{"ended on a missed day", "MMMMMMX", 12, 0},
	}
	letters := map[byte]string{'M': DayStatusMet, 'X': DayStatusMissed, 'P': DayStatusPending, 'U': DayStatusUpcoming, '-': DayStatusNone}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			days := make([]evaluatedDay, len(tt.days))
			for i := range days {
				days[i] = evaluatedDay{date: on(i), status: letters[tt.days[i]]}
			}
			rules := newChallengeRules(ruleChallenge(models.ChallengeGoalAtLeast, 1, len(tt.days), nil), on(tt.today))
			assert.Equal(t, tt.want, rules.currentStreak(days))
			assert.Equal(t, tt.days, daysString(days))
		})
	}
}

func TestChallengeRules_ScoreTodayOnlyInsideTheWindow(t *testing.T) {
	rules := newChallengeRules(ruleChallenge(models.ChallengeGoalAtLeast, 1, 5, nil), on(1))
	window := rules.window(on(1))
	assert.NotNil(t, rules.score(rules.evaluateDays(window.start, nil), window).today)

	upcoming := newChallengeRules(ruleChallenge(models.ChallengeGoalAtLeast, 1, 5, nil), on(-1))
	assert.Nil(t, upcoming.score(upcoming.evaluateDays(cday, nil), upcoming.window(cday)).today)

	ended := newChallengeRules(ruleChallenge(models.ChallengeGoalAtLeast, 1, 5, nil), on(7))
	assert.Nil(t, ended.score(ended.evaluateDays(cday, nil), ended.window(cday)).today)
}

func TestRankParticipants(t *testing.T) {
	entry := func(id uint, days int, hours float64) rankEntry {
		return rankEntry{userID: id, daysMet: days, totalCenti: hoursToCenti(hours)}
	}

	t.Run("at_least: more hours rank higher", func(t *testing.T) {
		ranks := rankParticipants(models.ChallengeGoalAtLeast, []rankEntry{
			entry(1, 5, 10), entry(2, 5, 12), entry(3, 5, 12), entry(4, 3, 20), entry(5, 0, 0),
		})
		assert.Equal(t, map[uint]int{2: 1, 3: 1, 1: 3, 4: 4, 5: 5}, ranks)
	})

	t.Run("at_most: fewer hours rank higher", func(t *testing.T) {
		ranks := rankParticipants(models.ChallengeGoalAtMost, []rankEntry{
			entry(1, 5, 10), entry(2, 5, 12), entry(3, 5, 10), entry(4, 6, 30),
		})
		assert.Equal(t, map[uint]int{4: 1, 1: 2, 3: 2, 2: 4}, ranks)
	})

	t.Run("everybody tied", func(t *testing.T) {
		ranks := rankParticipants(models.ChallengeGoalAtLeast, []rankEntry{entry(1, 0, 0), entry(2, 0, 0), entry(3, 0, 0)})
		assert.Equal(t, map[uint]int{1: 1, 2: 1, 3: 1}, ranks)
	})

	t.Run("nobody", func(t *testing.T) {
		assert.Empty(t, rankParticipants(models.ChallengeGoalAtLeast, nil))
	})
}

func TestRankFromTotals(t *testing.T) {
	rules := newChallengeRules(ruleChallenge(models.ChallengeGoalAtLeast, 2, 7, nil), on(3))
	participants := []repository.ChallengeParticipantRow{{UserID: 1}, {UserID: 2}, {UserID: 3}}
	totals := map[uint]repository.ChallengeLockedTotal{
		1: {UserID: 1, DaysMet: 2, TotalHours: 4},
		2: {UserID: 2, DaysMet: 1, TotalHours: 9},
	}
	live := []repository.ChallengeActivityDay{
		{UserID: 2, DayDate: on(2), Hours: 3, Logged: true}, // met: 2 days, 12 hours
		{UserID: 3, DayDate: on(2), Hours: 1, Logged: true}, // not met
		{UserID: 9, DayDate: on(2), Hours: 8, Logged: true}, // not a participant
	}
	// The viewer's own score replaces their totals.
	ranks := rankFromTotals(rules, 3, participantScore{daysMet: 3, totalCenti: 100}, participants, totals, live)
	assert.Equal(t, map[uint]int{3: 1, 2: 2, 1: 3}, ranks)
}

func TestProgressOf(t *testing.T) {
	window := participationWindow{start: cday, daysPossible: 10, daysElapsed: 4}
	today := evaluatedDay{status: DayStatusMet, centi: 250}
	score := participantScore{daysMet: 3, totalCenti: 725, currentStreak: 2, today: &today}

	p := progressOf(window, score, testutil.Ptr(2), nil)
	assert.Equal(t, dto.ChallengeProgress{
		Rank: testutil.Ptr(2), DaysMet: 3, DaysElapsed: 4, DaysPossible: 10, CurrentStreak: 2, TotalHours: 7.25,
		TodayHours: testutil.Ptr(2.5), TodayStatus: testutil.Ptr(DayStatusMet),
	}, p, "completion is unknown until finalized")

	assert.Nil(t, finalResultOf(false, testutil.Ptr(1), testutil.Ptr(1), testutil.Ptr(1.0), testutil.Ptr(true)))

	final := finalResultOf(true, testutil.Ptr(1), testutil.Ptr(9), testutil.Ptr(20.5), testutil.Ptr(false))
	p = progressOf(window, participantScore{daysMet: 3}, testutil.Ptr(4), final)
	assert.Equal(t, 1, *p.Rank, "stored results win")
	assert.Equal(t, 9, p.DaysMet)
	assert.Equal(t, 20.5, p.TotalHours)
	require.NotNil(t, p.Completed)
	assert.False(t, *p.Completed)

	// Missing stored values fall back to the computed ones.
	p = progressOf(window, participantScore{daysMet: 8, totalCenti: 100}, testutil.Ptr(4), finalResultOf(true, nil, nil, nil, nil))
	assert.Equal(t, 4, *p.Rank)
	assert.Equal(t, 8, p.DaysMet)
	assert.Equal(t, 1.0, p.TotalHours)
	require.NotNil(t, p.Completed)
	assert.True(t, *p.Completed, "8 of 10 days is 80%")
}

func TestParticipantLess(t *testing.T) {
	p := func(id uint, name string, rank *int) dto.ChallengeParticipant {
		return dto.ChallengeParticipant{ChallengeProgress: dto.ChallengeProgress{Rank: rank}, User: dto.ChallengeUser{ID: id, Username: name}}
	}
	tests := []struct {
		name string
		a, b dto.ChallengeParticipant
		want bool
	}{
		{"better rank first", p(2, "zed", testutil.Ptr(1)), p(1, "amy", testutil.Ptr(2)), true},
		{"worse rank later", p(1, "amy", testutil.Ptr(2)), p(2, "zed", testutil.Ptr(1)), false},
		{"ranked before unranked", p(2, "zed", testutil.Ptr(9)), p(1, "amy", nil), true},
		{"unranked after ranked", p(1, "amy", nil), p(2, "zed", testutil.Ptr(9)), false},
		{"same rank: by username", p(2, "amy", testutil.Ptr(1)), p(1, "bob", testutil.Ptr(1)), true},
		{"unranked: by username", p(2, "bob", nil), p(1, "amy", nil), false},
		{"same username: by ID", p(1, "amy", nil), p(2, "amy", nil), true},
		{"same participant", p(1, "amy", testutil.Ptr(1)), p(1, "amy", testutil.Ptr(1)), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, participantLess(tt.a, tt.b))
		})
	}
}

func TestSortSummaries(t *testing.T) {
	s := func(id uint, status, start, end string) dto.ChallengeSummary {
		return dto.ChallengeSummary{ID: id, Status: status, StartDate: start, EndDate: end}
	}
	summaries := []dto.ChallengeSummary{
		s(1, ChallengeStatusEnded, "2026-01-01", "2026-01-10"),
		s(2, ChallengeStatusUpcoming, "2026-04-01", "2026-04-10"),
		s(3, ChallengeStatusActive, "2026-03-01", "2026-03-20"),
		s(4, ChallengeStatusEnded, "2026-02-01", "2026-02-10"),
		s(5, ChallengeStatusUpcoming, "2026-03-20", "2026-04-30"),
		s(6, ChallengeStatusActive, "2026-03-05", "2026-03-12"),
		s(7, ChallengeStatusEnded, "2026-01-05", "2026-02-10"),
		s(8, ChallengeStatusActive, "2026-03-06", "2026-03-12"),
		s(9, ChallengeStatusUpcoming, "2026-03-20", "2026-03-25"),
	}
	sortSummaries(summaries)
	ids := make([]uint, len(summaries))
	for i, x := range summaries {
		ids[i] = x.ID
	}
	assert.Equal(t, []uint{6, 8, 3, 5, 9, 2, 7, 4, 1}, ids)
}

func TestChallengeDaysOf(t *testing.T) {
	days := challengeDaysOf([]evaluatedDay{
		{date: cday, status: DayStatusNone},
		{date: on(1), status: DayStatusMet, centi: 250, locked: true},
		{date: on(2), status: DayStatusPending},
		{date: on(3), status: DayStatusUpcoming},
	})
	assert.Equal(t, []dto.ChallengeDay{
		{Date: "2026-03-09", Hours: nil, Status: DayStatusNone},
		{Date: "2026-03-10", Hours: testutil.Ptr(2.5), Status: DayStatusMet, Locked: true},
		{Date: "2026-03-11", Hours: testutil.Ptr(0.0), Status: DayStatusPending},
		{Date: "2026-03-12", Hours: nil, Status: DayStatusUpcoming},
	}, days)
}

func TestChallengeUserHelpers(t *testing.T) {
	pic, thumb := "https://cdn/a.jpg", "https://cdn/a_thumb.jpg"
	rows := []repository.ChallengeParticipantRow{
		{UserID: 1, Username: "ann", ProfilePic: &pic, ProfilePicThumb: &thumb, IsVerified: true},
		{UserID: 2, Username: "ben"},
	}
	assert.Equal(t, dto.ChallengeUser{ID: 1, Username: "ann", ProfilePic: &pic, ProfilePicThumb: &thumb, IsVerified: true},
		creatorOf(&models.Challenge{CreatorID: 1}, rows))
	assert.Equal(t, dto.ChallengeUser{ID: 7}, creatorOf(&models.Challenge{CreatorID: 7}, rows), "unknown creator")
	assert.Nil(t, findParticipantRow(rows, 3))
	assert.Equal(t, "ben", findParticipantRow(rows, 2).Username)
	assert.Equal(t, pic, avatarOf(&pic))
	assert.Empty(t, avatarOf(nil))
}

func TestGenerateInviteCode(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 2000; i++ {
		code := generateInviteCode()
		require.Len(t, code, constants.ChallengeInviteCodeLength)
		for _, r := range code {
			require.True(t, strings.ContainsRune(constants.ChallengeInviteCodeAlphabet, r), "%q in %s", r, code)
		}
		normalized, ok := validator.NormalizeInviteCode(strings.ToLower(code))
		require.True(t, ok)
		require.Equal(t, code, normalized)
		seen[code] = true
	}
	assert.Len(t, seen, 2000, "codes are random")
}
