//! The pure parts of the daily challenge job (`services/challenge_job.go`): which dates to lock,
//! the locked rows to store and the final standings.

use std::collections::HashMap;

use chrono::{DateTime, NaiveDate, Utc};
use gt_core::models::Challenge;

use crate::repository::{
    ChallengeActivityDay, ChallengeFinalResult, ChallengeLockedTotal, ChallengeParticipantRow, NewChallengeDay,
};
use crate::service::rules::{
    add_days, centi_to_hours, completion_threshold, day_met, hours_to_centi, rank_participants, ChallengeRules,
    ParticipationWindow, RankEntry,
};

/// The dates the job locks for a challenge, as of `through` (today - 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LockRange {
    pub first: NaiveDate,
    pub last: NaiveDate,
}

impl LockRange {
    /// From the first unlocked date through the earlier of the end date and `through`; `None`
    /// when there is nothing to lock (finalized, upcoming or locked meanwhile).
    pub fn of(challenge: &Challenge, through: NaiveDate) -> Option<Self> {
        let rules = ChallengeRules::new(challenge, through);
        let range = Self { first: rules.first_unlocked(), last: rules.end.min(through) };
        (challenge.finalized_at.is_none() && range.first <= range.last).then_some(range)
    }

    /// Days in the range.
    pub fn days(&self) -> i64 {
        (self.last - self.first).num_days() + 1
    }
}

/// The result of every participant on every date of `range`, from each participant's window
/// start only. `live` holds what was logged (from `activity_days` through `range.last`); a date
/// without activity rows is stored as nothing logged.
pub fn locked_days(
    challenge: &Challenge,
    range: LockRange,
    participants: &[ChallengeParticipantRow],
    live: &[ChallengeActivityDay],
    locked_at: DateTime<Utc>,
) -> Vec<NewChallengeDay> {
    let rules = ChallengeRules::new(challenge, range.last);
    let logged: HashMap<(i64, NaiveDate), &ChallengeActivityDay> =
        live.iter().map(|a| ((a.user_id, a.day_date), a)).collect();

    let mut rows = Vec::new();
    for p in participants {
        let mut d = range.first.max(p.joined_on);
        while d <= range.last {
            let (hours, any_logged) = logged.get(&(p.user_id, d)).map_or((0.0, false), |a| (a.hours, a.logged));
            let centi = hours_to_centi(hours);
            rows.push(NewChallengeDay {
                challenge_id: challenge.id,
                user_id: p.user_id,
                day_date: d,
                hours: centi_to_hours(centi),
                logged: any_logged,
                met: day_met(&rules.goal_type, rules.target_centi, centi, any_logged),
                locked_at,
            });
            d = add_days(d, 1);
        }
    }
    rows
}

/// Whether the challenge's every day is locked and its results are not stored yet.
pub fn needs_finalizing(challenge: &Challenge) -> bool {
    challenge.finalized_at.is_none() && challenge.locked_through.is_some_and(|locked| locked >= challenge.end_date)
}

/// One participant's final standing, notified after the results are stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EndedResult {
    pub user_id: i64,
    pub rank: i64,
    pub days_met: i64,
    pub days_possible: i64,
    pub completed: bool,
}

/// The final standings computed from the locked totals: the rows to store and the results to
/// notify, both in participant order.
pub fn final_standings(
    challenge: &Challenge,
    participants: &[ChallengeParticipantRow],
    totals: &[ChallengeLockedTotal],
) -> (Vec<ChallengeFinalResult>, Vec<EndedResult>) {
    let by_user: HashMap<i64, &ChallengeLockedTotal> = totals.iter().map(|t| (t.user_id, t)).collect();
    let entries: Vec<RankEntry> = participants
        .iter()
        .map(|p| {
            let (days_met, total_hours) = by_user.get(&p.user_id).map_or((0, 0.0), |t| (t.days_met, t.total_hours));
            RankEntry { user_id: p.user_id, days_met, total_centi: hours_to_centi(total_hours) }
        })
        .collect();
    let ranks = rank_participants(&challenge.goal_type, &entries);

    participants
        .iter()
        .zip(&entries)
        .map(|(p, entry)| {
            let days_possible =
                ParticipationWindow::new(challenge.start_date, challenge.end_date, p.joined_on, challenge.end_date)
                    .days_possible;
            let completed = entry.days_met >= completion_threshold(days_possible);
            let rank = ranks.get(&p.user_id).copied().unwrap_or_default();
            let stored = ChallengeFinalResult {
                participant_id: p.id,
                rank,
                days_met: entry.days_met,
                total_hours: centi_to_hours(entry.total_centi),
                completed,
            };
            let ended = EndedResult { user_id: p.user_id, rank, days_met: entry.days_met, days_possible, completed };
            (stored, ended)
        })
        .unzip()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::test_support::{cday, on, rule_challenge};
    use gt_core::models::{CHALLENGE_GOAL_AT_LEAST, CHALLENGE_GOAL_AT_MOST};

    fn participant(id: i64, user_id: i64, joined_on: NaiveDate) -> ChallengeParticipantRow {
        ChallengeParticipantRow {
            id,
            challenge_id: 1,
            user_id,
            joined_at: Utc::now(),
            joined_on,
            final_rank: None,
            final_days_met: None,
            final_total_hours: None,
            completed: None,
            username: format!("user{user_id}"),
            profile_pic: None,
            profile_pic_thumb: None,
            is_verified: false,
        }
    }

    fn logged(user_id: i64, date: NaiveDate, hours: f64) -> ChallengeActivityDay {
        ChallengeActivityDay { challenge_id: 1, user_id, day_date: date, hours, logged: true }
    }

    #[test]
    fn lock_ranges() {
        let challenge = rule_challenge(CHALLENGE_GOAL_AT_LEAST, 2.0, 5, None);
        assert_eq!(LockRange::of(&challenge, on(1)), Some(LockRange { first: cday(), last: on(1) }));
        assert_eq!(LockRange::of(&challenge, on(9)).map(|r| r.days()), Some(5), "catches up to the end date");
        assert_eq!(LockRange::of(&challenge, on(-1)), None, "nothing before the start");

        let partly = rule_challenge(CHALLENGE_GOAL_AT_LEAST, 2.0, 5, Some(on(1)));
        assert_eq!(LockRange::of(&partly, on(3)), Some(LockRange { first: on(2), last: on(3) }));
        assert_eq!(LockRange::of(&partly, on(1)), None, "locked meanwhile");

        let mut finalized = rule_challenge(CHALLENGE_GOAL_AT_LEAST, 2.0, 5, Some(on(4)));
        assert!(needs_finalizing(&finalized));
        finalized.finalized_at = Some(Utc::now());
        assert_eq!(LockRange::of(&finalized, on(9)), None);
        assert!(!needs_finalizing(&finalized));
        assert!(!needs_finalizing(&partly), "not every day is locked");
    }

    /// Study 2h+ from S to S+4, locked on S+3 through S+1: Ann joined before the start, Ben on
    /// S+2 (nothing to lock for him yet).
    #[test]
    fn locked_rows_start_at_each_window() {
        let mut challenge = rule_challenge(CHALLENGE_GOAL_AT_LEAST, 2.0, 5, None);
        challenge.id = 1;
        let participants = [participant(10, 1, on(-1)), participant(20, 2, on(2))];
        let live = [
            logged(1, cday(), 2.0),
            logged(1, on(1), 1.004), // rounded to the column precision
            logged(2, on(1), 5.0),   // before Ben joined
        ];
        let at = Utc::now();
        let range = LockRange::of(&challenge, on(1)).unwrap();
        let rows = locked_days(&challenge, range, &participants, &live, at);
        let summary: Vec<(i64, NaiveDate, f64, bool, bool)> =
            rows.iter().map(|r| (r.user_id, r.day_date, r.hours, r.logged, r.met)).collect();
        assert_eq!(summary, [(1, cday(), 2.0, true, true), (1, on(1), 1.0, true, false)]);
        assert!(rows.iter().all(|r| r.challenge_id == 1 && r.locked_at == at));

        let range = LockRange::of(&challenge, on(4)).unwrap();
        let rows = locked_days(&challenge, range, &participants, &[], at);
        assert_eq!(rows.len(), 5 + 3);
        assert!(rows.iter().all(|r| !r.logged && !r.met && r.hours == 0.0), "nothing logged is stored as missed");
    }

    #[test]
    fn at_most_days_need_logging() {
        let challenge = rule_challenge(CHALLENGE_GOAL_AT_MOST, 1.0, 3, None);
        let participants = [participant(10, 1, cday())];
        let live = [ChallengeActivityDay { challenge_id: 0, user_id: 1, day_date: on(1), hours: 0.0, logged: true }];
        let range = LockRange::of(&challenge, on(2)).unwrap();
        let met: Vec<bool> =
            locked_days(&challenge, range, &participants, &live, Utc::now()).iter().map(|r| r.met).collect();
        assert_eq!(met, [false, true, false]);
    }

    #[test]
    fn standings() {
        let mut challenge = rule_challenge(CHALLENGE_GOAL_AT_LEAST, 2.0, 5, Some(on(4)));
        challenge.id = 1;
        let participants = [participant(10, 1, on(-1)), participant(20, 2, on(2)), participant(30, 3, cday())];
        let totals = [
            ChallengeLockedTotal { challenge_id: 1, user_id: 1, days_met: 4, total_hours: 10.5 },
            ChallengeLockedTotal { challenge_id: 1, user_id: 2, days_met: 2, total_hours: 6.0 },
        ];
        let (stored, ended) = final_standings(&challenge, &participants, &totals);
        assert_eq!(
            stored,
            [
                ChallengeFinalResult { participant_id: 10, rank: 1, days_met: 4, total_hours: 10.5, completed: true },
                ChallengeFinalResult { participant_id: 20, rank: 2, days_met: 2, total_hours: 6.0, completed: false },
                ChallengeFinalResult { participant_id: 30, rank: 3, days_met: 0, total_hours: 0.0, completed: false },
            ]
        );
        assert_eq!(
            ended,
            [
                EndedResult { user_id: 1, rank: 1, days_met: 4, days_possible: 5, completed: true },
                EndedResult { user_id: 2, rank: 2, days_met: 2, days_possible: 3, completed: false },
                EndedResult { user_id: 3, rank: 3, days_met: 0, days_possible: 5, completed: false },
            ]
        );
    }

    #[test]
    fn at_most_standings_share_ranks() {
        let challenge = rule_challenge(CHALLENGE_GOAL_AT_MOST, 1.0, 3, Some(on(2)));
        let participants: Vec<ChallengeParticipantRow> = (1..=4).map(|u| participant(u * 10, u, cday())).collect();
        let total =
            |user_id, days_met, total_hours| ChallengeLockedTotal { challenge_id: 0, user_id, days_met, total_hours };
        let totals = [total(1, 3, 1.5), total(2, 3, 1.5), total(3, 2, 2.5), total(4, 3, 0.0)];
        let (_, ended) = final_standings(&challenge, &participants, &totals);
        let ranks: Vec<(i64, i64, bool)> = ended.iter().map(|e| (e.user_id, e.rank, e.completed)).collect();
        assert_eq!(ranks, [(1, 2, true), (2, 2, true), (3, 4, false), (4, 1, true)]);
    }
}
