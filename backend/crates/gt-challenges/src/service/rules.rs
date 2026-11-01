//! Pure challenge rules (port of `services/challenge_rules.go`): dates, statuses,
//! participation windows, day evaluation, scoring, ranking and invite codes. Dates are IST
//! calendar dates (`NaiveDate`, the representation of `DATE` columns); "today" is the current
//! IST date.

use std::cmp::Ordering;
use std::collections::HashMap;

use chrono::{DateTime, Days, NaiveDate, TimeZone};
use gt_core::constants as c;
use gt_core::models::{Challenge, CHALLENGE_GOAL_AT_MOST};
use gt_core::timeutil::IST;
use rand::RngCore;

// ==================== Statuses ====================

/// A challenge's status as returned by the API (finalized is reported separately).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChallengeStatus {
    Upcoming,
    Active,
    Ended,
}

impl ChallengeStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Upcoming => "upcoming",
            Self::Active => "active",
            Self::Ended => "ended",
        }
    }
}

/// The status of one challenge date for one participant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DayStatus {
    Met,
    Missed,
    Pending,
    Upcoming,
    /// Before the participant's window.
    None,
}

impl DayStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Met => "met",
            Self::Missed => "missed",
            Self::Pending => "pending",
            Self::Upcoming => "upcoming",
            Self::None => "none",
        }
    }

    /// The letter encoding the status in `ChallengeParticipant.days`.
    pub const fn letter(self) -> char {
        match self {
            Self::Met => 'M',
            Self::Missed => 'X',
            Self::Pending => 'P',
            Self::Upcoming => 'U',
            Self::None => '-',
        }
    }
}

/// Why a user cannot join a challenge (`ChallengePreview.join_blocked_reason`).
pub const JOIN_BLOCKED_ENDED: &str = "ended";
pub const JOIN_BLOCKED_FULL: &str = "full";
pub const JOIN_BLOCKED_LIMIT: &str = "limit";

// ==================== Dates ====================

/// The IST calendar date of the instant `t`.
pub fn ist_date<Tz: TimeZone>(t: &DateTime<Tz>) -> NaiveDate {
    t.with_timezone(&IST).date_naive()
}

/// The number of days from `a` to `b`.
pub fn days_between(a: NaiveDate, b: NaiveDate) -> i64 {
    (b - a).num_days()
}

/// `d` moved by `days` (which may be negative).
pub fn add_days(d: NaiveDate, days: i64) -> NaiveDate {
    let shifted = if days >= 0 {
        d.checked_add_days(Days::new(days.unsigned_abs()))
    } else {
        d.checked_sub_days(Days::new(days.unsigned_abs()))
    };
    // Challenge dates are a few months around today, far from chrono's limits.
    shifted.unwrap_or(d)
}

/// `YYYY-MM-DD` (Go: `d.Format("2006-01-02")`).
pub fn format_date(d: NaiveDate) -> String {
    d.format(c::DATE_FORMAT).to_string()
}

// ==================== Hours ====================

/// Converts hours to hundredths of an hour, the precision of the `numeric(4,2)` columns, so
/// that sums and comparisons are exact.
pub fn hours_to_centi(hours: f64) -> i64 {
    (hours * 100.0).round() as i64
}

pub fn centi_to_hours(centi: i64) -> f64 {
    centi as f64 / 100.0
}

// ==================== Status and windows ====================

/// Upcoming before the start date, ended after the end date, active in between (inclusive).
pub fn challenge_status(start: NaiveDate, end: NaiveDate, today: NaiveDate) -> ChallengeStatus {
    if today < start {
        ChallengeStatus::Upcoming
    } else if today > end {
        ChallengeStatus::Ended
    } else {
        ChallengeStatus::Active
    }
}

/// Today's day number (1 on the start date) while the challenge is active.
pub fn challenge_day_number(start: NaiveDate, end: NaiveDate, today: NaiveDate) -> Option<i64> {
    (challenge_status(start, end, today) == ChallengeStatus::Active).then(|| days_between(start, today) + 1)
}

/// The run of dates a participant takes part in: from the later of the start date and the
/// joining date through the end date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParticipationWindow {
    pub start: NaiveDate,
    /// Days in `[start, end]`.
    pub days_possible: i64,
    /// Days in `[start, min(end, today)]`; 0 before the window starts.
    pub days_elapsed: i64,
}

impl ParticipationWindow {
    pub fn new(challenge_start: NaiveDate, challenge_end: NaiveDate, joined_on: NaiveDate, today: NaiveDate) -> Self {
        let start = challenge_start.max(joined_on);
        let mut window = Self { start, days_possible: 0, days_elapsed: 0 };
        if start <= challenge_end {
            window.days_possible = days_between(start, challenge_end) + 1;
        }
        let last = challenge_end.min(today);
        if start <= last {
            window.days_elapsed = days_between(start, last) + 1;
        }
        window
    }
}

/// The number of days to meet to complete a challenge of `days` days: ceil(80% of the days),
/// in integer arithmetic.
pub fn completion_threshold(days: i64) -> i64 {
    (days * c::CHALLENGE_COMPLETION_PERCENT + 99) / 100
}

// ==================== Day evaluation ====================

/// Applies the goal to one day. An `at_most` day only counts when something was logged that
/// day, so days without any logging are never met.
pub fn day_met(goal_type: &str, target_centi: i64, hours_centi: i64, logged: bool) -> bool {
    if goal_type == CHALLENGE_GOAL_AT_MOST {
        return logged && hours_centi <= target_centi;
    }
    hours_centi >= target_centi
}

/// The status of a day that is not locked yet (and not in the future): an unmet `at_least`
/// day is pending (hours can still be logged); an `at_most` day is missed once the logged
/// hours exceed the target and pending while nothing is logged.
pub fn live_day_status(goal_type: &str, target_centi: i64, hours_centi: i64, logged: bool) -> DayStatus {
    if day_met(goal_type, target_centi, hours_centi, logged) {
        DayStatus::Met
    } else if goal_type == CHALLENGE_GOAL_AT_MOST && logged {
        DayStatus::Missed
    } else {
        DayStatus::Pending
    }
}

/// What is known about one participant on one challenge date.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DayFacts {
    /// A locked row exists.
    pub snapshot: bool,
    /// Locked result.
    pub snap_met: bool,
    /// Locked hours.
    pub snap_centi: i64,
    /// Hours of the activity in the activity log (unlocked dates).
    pub live_centi: i64,
    /// Anything logged that day (unlocked dates).
    pub live_logged: bool,
}

/// The outcome of one challenge date for one participant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EvaluatedDay {
    pub date: NaiveDate,
    pub status: DayStatus,
    /// Hours; meaningful for met, missed and pending days.
    pub centi: i64,
    pub locked: bool,
}

impl EvaluatedDay {
    /// Whether the day counts towards hours (it is in the window and not in the future).
    pub fn has_hours(&self) -> bool {
        !matches!(self.status, DayStatus::Upcoming | DayStatus::None)
    }
}

/// A participant's progress computed from their evaluated days.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ParticipantScore {
    pub days_met: i64,
    pub total_centi: i64,
    pub current_streak: i64,
    /// Only for active challenges when today is in the window.
    pub today: Option<EvaluatedDay>,
}

/// Evaluates the days of one challenge as of `today`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChallengeRules {
    pub start: NaiveDate,
    pub end: NaiveDate,
    pub goal_type: String,
    pub target_centi: i64,
    pub locked_through: Option<NaiveDate>,
    pub today: NaiveDate,
}

impl ChallengeRules {
    pub fn new(challenge: &Challenge, today: NaiveDate) -> Self {
        Self {
            start: challenge.start_date,
            end: challenge.end_date,
            goal_type: challenge.goal_type.clone(),
            target_centi: hours_to_centi(challenge.target_hours),
            locked_through: challenge.locked_through,
            today,
        }
    }

    pub fn duration_days(&self) -> i64 {
        days_between(self.start, self.end) + 1
    }

    pub fn status(&self) -> ChallengeStatus {
        challenge_status(self.start, self.end, self.today)
    }

    pub fn day_number(&self) -> Option<i64> {
        challenge_day_number(self.start, self.end, self.today)
    }

    pub fn is_locked(&self, d: NaiveDate) -> bool {
        self.locked_through.is_some_and(|locked| d <= locked)
    }

    /// The participation window of a participant who joined on `joined_on`.
    pub fn window(&self, joined_on: NaiveDate) -> ParticipationWindow {
        ParticipationWindow::new(self.start, self.end, joined_on, self.today)
    }

    /// The first date that is not locked yet.
    pub fn first_unlocked(&self) -> NaiveDate {
        match self.locked_through {
            Some(locked) => self.start.max(add_days(locked, 1)),
            None => self.start,
        }
    }

    /// Whether some dates up to today are not locked yet, so the activity log must be read.
    pub fn has_live_days(&self) -> bool {
        self.first_unlocked() <= self.end.min(self.today)
    }

    /// Classifies date `d`: upcoming after today, none before the participant's window, the
    /// snapshot result when locked (a missing snapshot counts as missed with no hours) and the
    /// live result from the activity log otherwise.
    pub fn evaluate_day(&self, d: NaiveDate, window_start: NaiveDate, facts: DayFacts) -> EvaluatedDay {
        let locked = self.is_locked(d);
        let (status, centi) = if d > self.today {
            (DayStatus::Upcoming, 0)
        } else if d < window_start {
            (DayStatus::None, 0)
        } else if locked {
            let status = if facts.snapshot && facts.snap_met { DayStatus::Met } else { DayStatus::Missed };
            (status, facts.snap_centi)
        } else {
            let status = live_day_status(&self.goal_type, self.target_centi, facts.live_centi, facts.live_logged);
            (status, facts.live_centi)
        };
        EvaluatedDay { date: d, status, centi, locked }
    }

    /// Evaluates every date from the start date through the end date. `facts` is indexed by the
    /// offset of the date from the start date; a short slice means nothing is known.
    pub fn evaluate_days(&self, window_start: NaiveDate, facts: &[DayFacts]) -> Vec<EvaluatedDay> {
        (0..self.duration_days().max(0))
            .map(|i| {
                let f = usize::try_from(i).ok().and_then(|i| facts.get(i)).copied().unwrap_or_default();
                self.evaluate_day(add_days(self.start, i), window_start, f)
            })
            .collect()
    }

    /// Sums the met days and hours of the window up to today, counts the current streak and
    /// picks today's day.
    pub fn score(&self, days: &[EvaluatedDay], window: &ParticipationWindow) -> ParticipantScore {
        let mut score = ParticipantScore {
            days_met: days.iter().filter(|d| d.status == DayStatus::Met).count() as i64,
            total_centi: days.iter().filter(|d| d.has_hours()).map(|d| d.centi).sum(),
            current_streak: self.current_streak(days),
            today: None,
        };
        if self.status() == ChallengeStatus::Active && self.today >= window.start {
            score.today = usize::try_from(days_between(self.start, self.today)).ok().and_then(|i| days.get(i)).copied();
        }
        score
    }

    /// Counts consecutive met days back from today, or from yesterday while today is not met
    /// yet; after the end date it counts back from the end date. Days outside the window are
    /// never met, so the count stops there.
    pub fn current_streak(&self, days: &[EvaluatedDay]) -> i64 {
        let is_met =
            |i: i64| usize::try_from(i).ok().and_then(|i| days.get(i)).is_some_and(|d| d.status == DayStatus::Met);
        let len = days.len() as i64;
        let mut last = days_between(self.start, self.today);
        if last >= len {
            last = len - 1;
        } else if last >= 0 && !is_met(last) {
            last -= 1;
        }
        let mut streak = 0;
        while last >= 0 && is_met(last) {
            streak += 1;
            last -= 1;
        }
        streak
    }
}

/// Encodes the days with one letter each (see [`DayStatus::letter`]).
pub fn days_string(days: &[EvaluatedDay]) -> String {
    days.iter().map(|d| d.status.letter()).collect()
}

// ==================== Ranking ====================

/// One participant's score for ranking.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RankEntry {
    pub user_id: i64,
    pub days_met: i64,
    pub total_centi: i64,
}

/// Competition ranking (1, 2, 2, 4): more days met first, then more hours for `at_least` goals
/// or fewer hours for `at_most` goals. Equal scores share a rank.
pub fn rank_participants(goal_type: &str, entries: &[RankEntry]) -> HashMap<i64, i64> {
    let fewer_hours_first = goal_type == CHALLENGE_GOAL_AT_MOST;
    let mut sorted = entries.to_vec();
    // `sort_by` is stable, like Go's slices.SortStableFunc.
    sorted.sort_by(|a, b| {
        b.days_met.cmp(&a.days_met).then_with(|| {
            if fewer_hours_first {
                a.total_centi.cmp(&b.total_centi)
            } else {
                b.total_centi.cmp(&a.total_centi)
            }
        })
    });

    let mut ranks = HashMap::with_capacity(sorted.len());
    for (i, e) in sorted.iter().enumerate() {
        let position = i as i64 + 1;
        let rank = match i.checked_sub(1).map(|p| &sorted[p]) {
            Some(prev) if prev.days_met == e.days_met && prev.total_centi == e.total_centi => {
                ranks.get(&prev.user_id).copied().unwrap_or(position)
            }
            _ => position,
        };
        ranks.insert(e.user_id, rank);
    }
    ranks
}

/// The ordering a Go `less` function defines for a stable sort.
pub(crate) fn ordering_from_less<T>(a: &T, b: &T, less: impl Fn(&T, &T) -> bool) -> Ordering {
    if less(a, b) {
        Ordering::Less
    } else if less(b, a) {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

// ==================== Invite codes ====================

/// A random invite code. The alphabet has 32 letters, so each random byte modulo 32 picks a
/// letter without bias.
pub fn generate_invite_code() -> String {
    let alphabet = c::CHALLENGE_INVITE_CODE_ALPHABET.as_bytes();
    let mut bytes = [0u8; c::CHALLENGE_INVITE_CODE_LENGTH];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| char::from(alphabet[usize::from(*b) % alphabet.len()])).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::test_support::{cday, on, rule_challenge};
    use chrono::{FixedOffset, Utc};
    use gt_core::models::CHALLENGE_GOAL_AT_LEAST;
    use std::collections::HashSet;

    fn statuses(days: &[EvaluatedDay]) -> Vec<DayStatus> {
        days.iter().map(|d| d.status).collect()
    }

    #[test]
    fn dates() {
        // IST is UTC+5:30: 18:30 UTC is midnight in India.
        let utc = |h, m, s| Utc.with_ymd_and_hms(2026, 3, 8, h, m, s).unwrap();
        assert_eq!(ist_date(&utc(18, 30, 0)), cday());
        assert_eq!(ist_date(&utc(18, 29, 59)), on(-1));
        let ist = FixedOffset::east_opt(19_800).unwrap();
        assert_eq!(ist_date(&ist.with_ymd_and_hms(2026, 3, 9, 23, 59, 0).unwrap()), cday());
        assert_eq!(days_between(cday(), cday()), 0);
        assert_eq!(days_between(cday(), on(21)), 21);
        assert_eq!(days_between(cday(), on(-1)), -1);
        assert_eq!(add_days(on(3), -3), cday());
        assert_eq!(format_date(cday()), "2026-03-09");
    }

    #[test]
    fn hours() {
        assert_eq!(hours_to_centi(2.25), 225);
        assert_eq!(hours_to_centi(0.1 + 0.2), 30, "no floating point drift");
        assert_eq!(hours_to_centi(24.0), 2400);
        assert_eq!(centi_to_hours(225), 2.25);
        assert_eq!(centi_to_hours(0), 0.0);
    }

    #[test]
    fn status_and_day_number() {
        let (start, end) = (cday(), on(20));
        let cases = [
            (on(-1), ChallengeStatus::Upcoming, None),
            (cday(), ChallengeStatus::Active, Some(1)),
            (on(1), ChallengeStatus::Active, Some(2)),
            (end, ChallengeStatus::Active, Some(21)),
            (on(21), ChallengeStatus::Ended, None),
        ];
        for (today, status, day_number) in cases {
            assert_eq!(challenge_status(start, end, today), status);
            assert_eq!(challenge_day_number(start, end, today), day_number);
            let rules = ChallengeRules::new(&rule_challenge(CHALLENGE_GOAL_AT_LEAST, 2.0, 21, None), today);
            assert_eq!(rules.status(), status);
            assert_eq!(rules.day_number(), day_number);
            assert_eq!(rules.duration_days(), 21);
        }
    }

    #[test]
    fn participation_window() {
        let (start, end) = (cday(), on(9)); // 10 days
        let cases = [
            ("joined before an upcoming challenge", on(-5), on(-1), cday(), 10, 0),
            ("joined before the start, day 4", on(-5), on(3), cday(), 10, 4),
            ("joined on the start date, start date", cday(), cday(), cday(), 10, 1),
            ("late joiner", on(4), on(6), on(4), 6, 3),
            ("late joiner on their first day", on(4), on(4), on(4), 6, 1),
            ("late joiner after the end", on(4), on(20), on(4), 6, 6),
            ("joined on the end date", end, end, end, 1, 1),
            ("before the window starts", on(4), on(3), on(4), 6, 0),
            ("after the end", on(-5), on(15), cday(), 10, 10),
        ];
        for (name, joined_on, today, window_start, possible, elapsed) in cases {
            let w = ParticipationWindow::new(start, end, joined_on, today);
            let want = ParticipationWindow { start: window_start, days_possible: possible, days_elapsed: elapsed };
            assert_eq!(w, want, "{name}");
        }
        let w = ParticipationWindow::new(start, end, on(12), on(12));
        assert_eq!((w.days_possible, w.days_elapsed), (0, 0), "a join after the end leaves an empty window");
    }

    #[test]
    fn completion() {
        let cases = [(0, 0), (1, 1), (3, 3), (4, 4), (5, 4), (7, 6), (10, 8), (21, 17), (30, 24), (59, 48), (60, 48)];
        for (days, want) in cases {
            assert_eq!(completion_threshold(days), want, "ceil(0.8 * {days})");
        }
    }

    #[test]
    fn day_evaluation() {
        use DayStatus::*;
        let (least, most) = (CHALLENGE_GOAL_AT_LEAST, CHALLENGE_GOAL_AT_MOST);
        let cases = [
            ("at_least reached", least, 2.0, 2.0, true, true, Met),
            ("at_least exceeded", least, 2.0, 5.5, true, true, Met),
            ("at_least short by a quarter", least, 2.0, 1.75, true, false, Pending),
            ("at_least nothing logged", least, 2.0, 0.0, false, false, Pending),
            ("at_least other activities only", least, 0.25, 0.0, true, false, Pending),
            ("at_most under", most, 1.0, 0.5, true, true, Met),
            ("at_most exactly", most, 1.0, 1.0, true, true, Met),
            ("at_most over", most, 1.0, 1.25, true, false, Missed),
            ("at_most other activities only", most, 1.0, 0.0, true, true, Met),
            ("at_most nothing logged", most, 1.0, 0.0, false, false, Pending),
            ("at_most zero, none of it", most, 0.0, 0.0, true, true, Met),
            ("at_most zero, some of it", most, 0.0, 0.25, true, false, Missed),
            ("at_most zero, nothing logged", most, 0.0, 0.0, false, false, Pending),
        ];
        for (name, goal, target, hours, logged, met, live) in cases {
            let (target, hours) = (hours_to_centi(target), hours_to_centi(hours));
            assert_eq!(day_met(goal, target, hours, logged), met, "{name}");
            assert_eq!(live_day_status(goal, target, hours, logged), live, "{name}");
        }
    }

    #[test]
    fn evaluate_days_at_least() {
        use DayStatus::*;
        let snap = |met, centi| DayFacts { snapshot: true, snap_met: met, snap_centi: centi, ..Default::default() };
        let live = |centi| DayFacts { live_centi: centi, live_logged: true, ..Default::default() };
        let facts = [
            snap(true, 500),                          // before the window: ignored
            snap(true, 300),                          // locked, met
            live(900),                                // locked without a snapshot: missed
            live(250),                                // live, met
            live(100),                                // today, pending
            DayFacts { snap_met: true, ..live(400) }, // future: upcoming
        ];
        let rules = ChallengeRules::new(&rule_challenge(CHALLENGE_GOAL_AT_LEAST, 2.0, 7, Some(on(2))), on(4));
        let days = rules.evaluate_days(on(1), &facts);
        assert_eq!(statuses(&days), [None, Met, Missed, Met, Pending, Upcoming, Upcoming]);
        let locked: Vec<bool> = days.iter().map(|d| d.locked).collect();
        assert_eq!(locked, [true, true, true, false, false, false, false]);
        assert_eq!(days[1].centi, 300, "locked hours come from the snapshot");
        assert_eq!(days[2].centi, 0, "a missing snapshot counts no hours");
        assert_eq!(days[3].centi, 250);
        assert_eq!(days[6].date, on(6));
        assert_eq!(days_string(&days), "-MXMPUU");

        let score = rules.score(&days, &rules.window(on(1)));
        assert_eq!(score.days_met, 2);
        assert_eq!(score.total_centi, 300 + 250 + 100);
        assert_eq!(score.current_streak, 1, "today is pending: counted from yesterday");
        let today = score.today.expect("today is in the window");
        assert_eq!((today.status, today.centi), (Pending, 100));
    }

    #[test]
    fn evaluate_days_at_most() {
        let snap = |met, centi| DayFacts { snapshot: true, snap_met: met, snap_centi: centi, ..Default::default() };
        let rules = ChallengeRules::new(&rule_challenge(CHALLENGE_GOAL_AT_MOST, 1.0, 7, Some(on(2))), on(4));
        let days = rules.evaluate_days(
            cday(),
            &[
                snap(false, 150),
                snap(true, 50),
                snap(true, 0),
                DayFacts::default(),
                DayFacts { live_centi: 200, live_logged: true, ..Default::default() },
            ],
        );
        assert_eq!(days_string(&days), "XMMPXUU");
        let score = rules.score(&days, &rules.window(cday()));
        assert_eq!(score.days_met, 2);
        assert_eq!(score.total_centi, 400);
        assert_eq!(score.current_streak, 0, "yesterday is pending");
        assert_eq!(score.today.map(|d| d.status), Some(DayStatus::Missed));

        let rules = ChallengeRules::new(&rule_challenge(CHALLENGE_GOAL_AT_LEAST, 2.0, 3, None), on(1));
        assert_eq!(days_string(&rules.evaluate_days(cday(), &[])), "PPU", "nothing known");
    }

    #[test]
    fn has_live_days() {
        let cases = [
            ("upcoming", None, on(-1), false),
            ("first day", None, cday(), true),
            ("partly locked", Some(on(1)), on(3), true),
            ("locked up to today", Some(on(3)), on(3), false),
            ("ended, end not locked yet", Some(on(5)), on(8), true),
            ("ended, fully locked", Some(on(6)), on(9), false),
        ];
        for (name, locked, today, want) in cases {
            let rules = ChallengeRules::new(&rule_challenge(CHALLENGE_GOAL_AT_LEAST, 1.0, 7, locked), today);
            assert_eq!(rules.has_live_days(), want, "{name}");
        }
    }

    #[test]
    fn current_streak() {
        let cases = [
            ("today met", "MMMMUUU", 3, 4),
            ("today pending keeps yesterday's streak", "MMMPUUU", 3, 3),
            ("today missed counts from yesterday", "MMMXUUU", 3, 3),
            ("broken streak", "MXMMPUU", 4, 2),
            ("yesterday missed", "MMXPUUU", 3, 0),
            ("first day pending", "PUUUUUU", 0, 0),
            ("first day met", "MUUUUUU", 0, 1),
            ("stops at the window start", "--MMPUU", 4, 2),
            ("upcoming", "UUUUUUU", -2, 0),
            ("ended: counted back from the end date", "XMMMMMM", 9, 6),
            ("ended on a missed day", "MMMMMMX", 12, 0),
        ];
        for (name, letters, today, want) in cases {
            let days: Vec<EvaluatedDay> = letters
                .chars()
                .zip(0..)
                .map(|(letter, i)| EvaluatedDay {
                    date: on(i),
                    status: match letter {
                        'M' => DayStatus::Met,
                        'X' => DayStatus::Missed,
                        'P' => DayStatus::Pending,
                        'U' => DayStatus::Upcoming,
                        _ => DayStatus::None,
                    },
                    centi: 0,
                    locked: false,
                })
                .collect();
            let challenge = rule_challenge(CHALLENGE_GOAL_AT_LEAST, 1.0, days.len() as i64, None);
            let rules = ChallengeRules::new(&challenge, on(today));
            assert_eq!(rules.current_streak(&days), want, "{name}");
            assert_eq!(days_string(&days), letters, "{name}");
        }
    }

    #[test]
    fn score_today_only_inside_the_window() {
        let challenge = rule_challenge(CHALLENGE_GOAL_AT_LEAST, 1.0, 5, None);
        let rules = ChallengeRules::new(&challenge, on(1));
        let window = rules.window(on(1));
        assert!(rules.score(&rules.evaluate_days(window.start, &[]), &window).today.is_some());

        let upcoming = ChallengeRules::new(&challenge, on(-1));
        let window = upcoming.window(cday());
        assert!(upcoming.score(&upcoming.evaluate_days(cday(), &[]), &window).today.is_none());

        let ended = ChallengeRules::new(&challenge, on(7));
        let window = ended.window(cday());
        assert!(ended.score(&ended.evaluate_days(cday(), &[]), &window).today.is_none());
    }

    fn entry(user_id: i64, days_met: i64, hours: f64) -> RankEntry {
        RankEntry { user_id, days_met, total_centi: hours_to_centi(hours) }
    }

    #[test]
    fn ranking() {
        let ranks = rank_participants(
            CHALLENGE_GOAL_AT_LEAST,
            &[entry(1, 5, 10.0), entry(2, 5, 12.0), entry(3, 5, 12.0), entry(4, 3, 20.0), entry(5, 0, 0.0)],
        );
        assert_eq!(ranks, HashMap::from([(2, 1), (3, 1), (1, 3), (4, 4), (5, 5)]), "at_least: more hours rank higher");

        let ranks = rank_participants(
            CHALLENGE_GOAL_AT_MOST,
            &[entry(1, 5, 10.0), entry(2, 5, 12.0), entry(3, 5, 10.0), entry(4, 6, 30.0)],
        );
        assert_eq!(ranks, HashMap::from([(4, 1), (1, 2), (3, 2), (2, 4)]), "at_most: fewer hours rank higher");

        let ranks = rank_participants(CHALLENGE_GOAL_AT_LEAST, &[entry(1, 0, 0.0), entry(2, 0, 0.0), entry(3, 0, 0.0)]);
        assert_eq!(ranks, HashMap::from([(1, 1), (2, 1), (3, 1)]), "everybody tied");

        assert!(rank_participants(CHALLENGE_GOAL_AT_LEAST, &[]).is_empty());
    }

    #[test]
    fn invite_codes_are_random_and_well_formed() {
        let mut seen = HashSet::new();
        for _ in 0..2000 {
            let code = generate_invite_code();
            assert_eq!(code.len(), c::CHALLENGE_INVITE_CODE_LENGTH);
            assert!(code.chars().all(|ch| c::CHALLENGE_INVITE_CODE_ALPHABET.contains(ch)), "{code}");
            let normalized = crate::validator::normalize_invite_code(&code.to_lowercase());
            assert_eq!(normalized.as_deref(), Some(code.as_str()));
            seen.insert(code);
        }
        assert_eq!(seen.len(), 2000, "codes are random");
    }
}
