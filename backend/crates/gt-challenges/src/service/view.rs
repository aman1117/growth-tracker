//! Builders turning loaded challenge data into API views (the pure parts of
//! `services/challenge_service.go`: list, detail and preview assembly, ranking from totals,
//! progress, ordering).

use std::collections::{HashMap, HashSet};

use chrono::NaiveDate;
use gt_core::constants as c;
use gt_core::models::{Challenge, ChallengeDay as LockedDay};

use crate::dto::{
    ChallengeDay, ChallengeDetail, ChallengeParticipant, ChallengePreview, ChallengeProgress, ChallengeSummary,
    ChallengeUser,
};
use crate::repository::{ChallengeActivityDay, ChallengeLockedTotal, ChallengeParticipantRow, UserChallengeRow};
use crate::service::rules::{
    add_days, centi_to_hours, completion_threshold, day_met, days_between, days_string, format_date, hours_to_centi,
    ordering_from_less, rank_participants, ChallengeRules, ChallengeStatus, DayFacts, EvaluatedDay, ParticipantScore,
    ParticipationWindow, RankEntry, JOIN_BLOCKED_ENDED, JOIN_BLOCKED_FULL,
};

// ==================== Facts ====================

/// The offset of `date` in a facts slice of the challenge, if it falls inside it.
fn fact_index(rules: &ChallengeRules, len: usize, date: NaiveDate) -> Option<usize> {
    usize::try_from(days_between(rules.start, date)).ok().filter(|i| *i < len)
}

/// Records locked days in `facts` (indexed by offset from the start date).
pub fn add_snapshots<'a>(
    rules: &ChallengeRules,
    facts: &mut [DayFacts],
    days: impl IntoIterator<Item = &'a LockedDay>,
) {
    for d in days {
        if let Some(i) = fact_index(rules, facts.len(), d.day_date) {
            facts[i].snapshot = true;
            facts[i].snap_met = d.met;
            facts[i].snap_centi = hours_to_centi(d.hours);
        }
    }
}

/// Records what was logged on unlocked dates in `facts`.
pub fn add_live_days<'a>(
    rules: &ChallengeRules,
    facts: &mut [DayFacts],
    days: impl IntoIterator<Item = &'a ChallengeActivityDay>,
) {
    for d in days {
        if let Some(i) = fact_index(rules, facts.len(), d.day_date) {
            facts[i].live_centi = hours_to_centi(d.hours);
            facts[i].live_logged = d.logged;
        }
    }
}

// ==================== Ranking and progress ====================

/// Ranks the participants of a challenge from their locked totals plus their unlocked days,
/// for lists that do not load every participant's days. The viewer's own score, computed from
/// their days, is used as is.
pub fn rank_from_totals(
    rules: &ChallengeRules,
    viewer_id: i64,
    viewer_score: &ParticipantScore,
    participants: &[ChallengeParticipantRow],
    totals: &HashMap<i64, ChallengeLockedTotal>,
    live: &[ChallengeActivityDay],
) -> HashMap<i64, i64> {
    let mut entries: HashMap<i64, RankEntry> = participants
        .iter()
        .map(|p| {
            let (days_met, total_hours) = totals.get(&p.user_id).map_or((0, 0.0), |t| (t.days_met, t.total_hours));
            (p.user_id, RankEntry { user_id: p.user_id, days_met, total_centi: hours_to_centi(total_hours) })
        })
        .collect();
    for a in live {
        let Some(entry) = entries.get_mut(&a.user_id) else { continue };
        let centi = hours_to_centi(a.hours);
        entry.total_centi += centi;
        if day_met(&rules.goal_type, rules.target_centi, centi, a.logged) {
            entry.days_met += 1;
        }
    }
    let list: Vec<RankEntry> = participants
        .iter()
        .filter_map(|p| entries.get(&p.user_id).copied())
        .map(|mut e| {
            if e.user_id == viewer_id {
                e.days_met = viewer_score.days_met;
                e.total_centi = viewer_score.total_centi;
            }
            e
        })
        .collect();
    rank_participants(&rules.goal_type, &list)
}

/// A participant's stored final standing.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct FinalResult {
    pub rank: Option<i64>,
    pub days_met: Option<i64>,
    pub total_hours: Option<f64>,
    pub completed: Option<bool>,
}

/// The stored results of a finalized challenge's participant, or `None`.
pub fn final_result_of(
    finalized: bool,
    rank: Option<i64>,
    days_met: Option<i64>,
    total_hours: Option<f64>,
    completed: Option<bool>,
) -> Option<FinalResult> {
    finalized.then_some(FinalResult { rank, days_met, total_hours, completed })
}

/// A participant's progress from their score. Once a challenge is finalized the stored results
/// replace the computed days met, hours, rank and completion (a missing stored value falls
/// back to the computed one).
pub fn progress_of(
    window: &ParticipationWindow,
    score: &ParticipantScore,
    rank: Option<i64>,
    final_result: Option<&FinalResult>,
) -> ChallengeProgress {
    let mut progress = ChallengeProgress {
        rank,
        days_met: score.days_met,
        days_elapsed: window.days_elapsed,
        days_possible: window.days_possible,
        current_streak: score.current_streak,
        total_hours: centi_to_hours(score.total_centi),
        ..Default::default()
    };
    if let Some(today) = &score.today {
        progress.today_hours = Some(centi_to_hours(today.centi));
        progress.today_status = Some(today.status.as_str().to_string());
    }
    let Some(stored) = final_result else {
        return progress;
    };
    if stored.rank.is_some() {
        progress.rank = stored.rank;
    }
    if let Some(days_met) = stored.days_met {
        progress.days_met = days_met;
    }
    if let Some(hours) = stored.total_hours {
        progress.total_hours = centi_to_hours(hours_to_centi(hours));
    }
    let computed = progress.days_met >= completion_threshold(window.days_possible);
    progress.completed = Some(stored.completed.unwrap_or(computed));
    progress
}

// ==================== Users ====================

pub fn challenge_user_of(p: &ChallengeParticipantRow) -> ChallengeUser {
    ChallengeUser {
        id: p.user_id,
        username: p.username.clone(),
        profile_pic: p.profile_pic.clone(),
        profile_pic_thumb: p.profile_pic_thumb.clone(),
        is_verified: p.is_verified,
    }
}

/// The creator, from the participants (the creator cannot leave).
pub fn creator_of(challenge: &Challenge, participants: &[ChallengeParticipantRow]) -> ChallengeUser {
    match find_participant_row(participants, challenge.creator_id) {
        Some(p) => challenge_user_of(p),
        None => ChallengeUser { id: challenge.creator_id, ..Default::default() },
    }
}

pub fn find_participant_row(
    participants: &[ChallengeParticipantRow],
    user_id: i64,
) -> Option<&ChallengeParticipantRow> {
    participants.iter().find(|p| p.user_id == user_id)
}

/// The profile picture URL used in notification metadata (`""` without one).
pub fn avatar_of(profile_pic: Option<&str>) -> String {
    profile_pic.unwrap_or_default().to_string()
}

// ==================== Summaries ====================

/// The summary shared by the list and the detail.
pub fn summary_of(
    challenge: &Challenge,
    rules: &ChallengeRules,
    participant_count: i64,
    viewer_id: i64,
    me: ChallengeProgress,
) -> ChallengeSummary {
    ChallengeSummary {
        id: challenge.id,
        title: challenge.title.clone(),
        activity: challenge.activity.clone(),
        goal_type: challenge.goal_type.clone(),
        target_hours: challenge.target_hours,
        start_date: format_date(rules.start),
        end_date: format_date(rules.end),
        duration_days: rules.duration_days(),
        status: rules.status().as_str().to_string(),
        finalized: challenge.finalized_at.is_some(),
        day_number: rules.day_number(),
        participant_count,
        is_creator: challenge.creator_id == viewer_id,
        me,
    }
}

/// Orders participants by rank (unranked last), then username, then id.
pub fn participant_less(a: &ChallengeParticipant, b: &ChallengeParticipant) -> bool {
    match (a.progress.rank, b.progress.rank) {
        (Some(_), None) => return true,
        (None, Some(_)) => return false,
        (Some(ra), Some(rb)) if ra != rb => return ra < rb,
        _ => {}
    }
    if a.user.username != b.user.username {
        return a.user.username < b.user.username;
    }
    a.user.id < b.user.id
}

fn status_group(status: &str) -> u8 {
    match status {
        "upcoming" => 1,
        "ended" => 2,
        // Go's map lookup yields 0 for active (and for unknown statuses).
        _ => 0,
    }
}

fn summary_less(a: &ChallengeSummary, b: &ChallengeSummary) -> bool {
    if a.status != b.status {
        return status_group(&a.status) < status_group(&b.status);
    }
    match a.status.as_str() {
        "active" if a.end_date != b.end_date => return a.end_date < b.end_date,
        "upcoming" if a.start_date != b.start_date => return a.start_date < b.start_date,
        "active" | "upcoming" => {}
        _ => {
            if a.end_date != b.end_date {
                return a.end_date > b.end_date;
            }
            return a.id > b.id;
        }
    }
    a.id < b.id
}

/// Orders the list: active by end date, upcoming by start date, then ended with the most recent
/// first.
pub fn sort_summaries(summaries: &mut [ChallengeSummary]) {
    summaries.sort_by(|a, b| ordering_from_less(a, b, summary_less));
}

/// The viewer's evaluated days for the API.
pub fn challenge_days_of(days: &[EvaluatedDay]) -> Vec<ChallengeDay> {
    days.iter()
        .map(|d| ChallengeDay {
            date: format_date(d.date),
            hours: d.has_hours().then(|| centi_to_hours(d.centi)),
            status: d.status.as_str().to_string(),
            locked: d.locked,
        })
        .collect()
}

// ==================== List ====================

/// Which challenges of a list need extra data: live ranks need every participant of the
/// active and ended (not finalized) challenges (`rank_ids`); streaks need the viewer's locked
/// days of every started challenge (`day_ids`).
pub fn list_query_ids(rows: &[UserChallengeRow], today: NaiveDate) -> (Vec<i64>, Vec<i64>) {
    let mut rank_ids = Vec::new();
    let mut day_ids = Vec::new();
    for row in rows {
        if ChallengeRules::new(&row.challenge, today).status() == ChallengeStatus::Upcoming {
            continue;
        }
        day_ids.push(row.challenge.id);
        if row.challenge.finalized_at.is_none() {
            rank_ids.push(row.challenge.id);
        }
    }
    (rank_ids, day_ids)
}

/// Everything [`build_summaries`] needs, loaded for the ids from [`list_query_ids`].
#[derive(Debug, Clone, Copy)]
pub struct ListData<'a> {
    pub rows: &'a [UserChallengeRow],
    /// Participants of the `rank_ids` challenges.
    pub participants: &'a [ChallengeParticipantRow],
    /// Locked totals of the `rank_ids` challenges.
    pub totals: &'a [ChallengeLockedTotal],
    /// Unlocked activity days of the `rank_ids` challenges up to today.
    pub live: &'a [ChallengeActivityDay],
    /// The viewer's locked days of the `day_ids` challenges.
    pub my_days: &'a [LockedDay],
}

/// The viewer's challenge list (Go: the second half of `ChallengeService.List`), sorted.
pub fn build_summaries(data: ListData<'_>, viewer_id: i64, today: NaiveDate) -> Vec<ChallengeSummary> {
    let mut participants_by: HashMap<i64, Vec<ChallengeParticipantRow>> = HashMap::new();
    for p in data.participants {
        participants_by.entry(p.challenge_id).or_default().push(p.clone());
    }
    let mut totals_by: HashMap<i64, HashMap<i64, ChallengeLockedTotal>> = HashMap::new();
    for t in data.totals {
        totals_by.entry(t.challenge_id).or_default().insert(t.user_id, t.clone());
    }
    let mut live_by: HashMap<i64, Vec<ChallengeActivityDay>> = HashMap::new();
    for a in data.live {
        live_by.entry(a.challenge_id).or_default().push(a.clone());
    }
    let mut my_days_by: HashMap<i64, Vec<&LockedDay>> = HashMap::new();
    for d in data.my_days {
        my_days_by.entry(d.challenge_id).or_default().push(d);
    }
    let no_totals = HashMap::new();

    let mut summaries: Vec<ChallengeSummary> = data
        .rows
        .iter()
        .map(|row| {
            let id = row.challenge.id;
            let rules = ChallengeRules::new(&row.challenge, today);
            let window = rules.window(row.joined_on);
            let live = live_by.get(&id).map(Vec::as_slice).unwrap_or_default();

            let mut facts = vec![DayFacts::default(); usize::try_from(rules.duration_days()).unwrap_or(0)];
            add_snapshots(&rules, &mut facts, my_days_by.get(&id).into_iter().flatten().copied());
            add_live_days(&rules, &mut facts, live.iter().filter(|a| a.user_id == viewer_id));
            let score = rules.score(&rules.evaluate_days(window.start, &facts), &window);

            let mut rank = None;
            if rules.status() != ChallengeStatus::Upcoming && row.challenge.finalized_at.is_none() {
                let participants = participants_by.get(&id).map(Vec::as_slice).unwrap_or_default();
                let totals = totals_by.get(&id).unwrap_or(&no_totals);
                rank = rank_from_totals(&rules, viewer_id, &score, participants, totals, live).get(&viewer_id).copied();
            }
            let stored = final_result_of(
                row.challenge.finalized_at.is_some(),
                row.final_rank,
                row.final_days_met,
                row.final_total_hours,
                row.completed,
            );
            let me = progress_of(&window, &score, rank, stored.as_ref());
            summary_of(&row.challenge, &rules, row.participant_count, viewer_id, me)
        })
        .collect();
    sort_summaries(&mut summaries);
    summaries
}

// ==================== Detail ====================

/// Everything [`build_detail`] needs about a challenge the viewer takes part in.
#[derive(Debug, Clone, Copy)]
pub struct DetailData<'a> {
    pub challenge: &'a Challenge,
    pub participants: &'a [ChallengeParticipantRow],
    /// Every locked day of the challenge.
    pub snapshots: &'a [LockedDay],
    /// Unlocked activity days up to today; load them only when
    /// [`ChallengeRules::has_live_days`] (Go skips the query otherwise).
    pub live: &'a [ChallengeActivityDay],
    /// Participants the viewer cheered today; load them only while the challenge is active.
    pub cheered: &'a HashSet<i64>,
}

/// A challenge with every participant's progress (Go: the second half of `loadDetail`).
pub fn build_detail(data: DetailData<'_>, viewer_id: i64, today: NaiveDate) -> ChallengeDetail {
    let DetailData { challenge, participants, snapshots, live, cheered } = data;
    let rules = ChallengeRules::new(challenge, today);
    let duration = usize::try_from(rules.duration_days()).unwrap_or(0);

    let mut facts: HashMap<i64, Vec<DayFacts>> =
        participants.iter().map(|p| (p.user_id, vec![DayFacts::default(); duration])).collect();
    for d in snapshots {
        if let Some(f) = facts.get_mut(&d.user_id) {
            add_snapshots(&rules, f, [d]);
        }
    }
    if rules.has_live_days() {
        for a in live {
            if let Some(f) = facts.get_mut(&a.user_id) {
                add_live_days(&rules, f, [a]);
            }
        }
    }

    struct Scored<'a> {
        row: &'a ChallengeParticipantRow,
        window: ParticipationWindow,
        days: Vec<EvaluatedDay>,
        score: ParticipantScore,
    }
    let scored: Vec<Scored<'_>> = participants
        .iter()
        .map(|row| {
            let window = rules.window(row.joined_on);
            let days =
                rules.evaluate_days(window.start, facts.get(&row.user_id).map(Vec::as_slice).unwrap_or_default());
            let score = rules.score(&days, &window);
            Scored { row, window, days, score }
        })
        .collect();
    let status = rules.status();
    let ranks = if status == ChallengeStatus::Upcoming {
        HashMap::new()
    } else {
        let entries: Vec<RankEntry> = scored
            .iter()
            .map(|s| RankEntry { user_id: s.row.user_id, days_met: s.score.days_met, total_centi: s.score.total_centi })
            .collect();
        rank_participants(&challenge.goal_type, &entries)
    };

    let finalized = challenge.finalized_at.is_some();
    let mut me = ChallengeProgress::default();
    let mut my_days = None;
    let mut result: Vec<ChallengeParticipant> = Vec::with_capacity(scored.len());
    for s in &scored {
        let row = s.row;
        let stored =
            final_result_of(finalized, row.final_rank, row.final_days_met, row.final_total_hours, row.completed);
        let progress = progress_of(&s.window, &s.score, ranks.get(&row.user_id).copied(), stored.as_ref());
        if row.user_id == viewer_id {
            me = progress.clone();
            my_days = Some(challenge_days_of(&s.days));
        }
        result.push(ChallengeParticipant {
            progress,
            user: challenge_user_of(row),
            joined_on: format_date(row.joined_on),
            is_me: row.user_id == viewer_id,
            cheered_today: cheered.contains(&row.user_id),
            days: days_string(&s.days),
        });
    }
    result.sort_by(|a, b| ordering_from_less(a, b, participant_less));

    let is_creator = challenge.creator_id == viewer_id;
    let participant_count = participants.len() as i64;
    ChallengeDetail {
        summary: summary_of(challenge, &rules, participant_count, viewer_id, me),
        invite_code: challenge.invite_code.clone(),
        today: format_date(today),
        locked_through: rules.locked_through.map(format_date),
        results_date: format_date(add_days(rules.end, c::CHALLENGE_LOCK_DELAY_DAYS)),
        completion_days: completion_threshold(rules.duration_days()),
        max_participants: c::CHALLENGE_MAX_PARTICIPANTS,
        creator: creator_of(challenge, participants),
        can_invite: status != ChallengeStatus::Ended,
        can_leave: !is_creator && status != ChallengeStatus::Ended,
        can_delete: is_creator && (status == ChallengeStatus::Upcoming || participants.len() == 1),
        participants: result,
        my_days,
    }
}

// ==================== Preview ====================

/// Why a non-participant cannot join, as far as the challenge alone tells: `ended` or `full`.
/// When this is `None` the caller still checks the open-challenge limit (`limit`).
pub fn static_join_block(rules: &ChallengeRules, participant_count: usize) -> Option<&'static str> {
    if rules.status() == ChallengeStatus::Ended {
        Some(JOIN_BLOCKED_ENDED)
    } else if participant_count as i64 >= c::CHALLENGE_MAX_PARTICIPANTS {
        Some(JOIN_BLOCKED_FULL)
    } else {
        None
    }
}

/// What an invite link shows. `join_blocked_reason` is `None` for participants.
pub fn build_preview(
    challenge: &Challenge,
    participants: &[ChallengeParticipantRow],
    viewer_id: i64,
    today: NaiveDate,
    join_blocked_reason: Option<&str>,
) -> ChallengePreview {
    let rules = ChallengeRules::new(challenge, today);
    let is_participant = find_participant_row(participants, viewer_id).is_some();
    let preview_len = usize::try_from(c::CHALLENGE_PREVIEW_PARTICIPANTS).unwrap_or(0);
    ChallengePreview {
        id: challenge.id,
        title: challenge.title.clone(),
        activity: challenge.activity.clone(),
        goal_type: challenge.goal_type.clone(),
        target_hours: challenge.target_hours,
        start_date: format_date(rules.start),
        end_date: format_date(rules.end),
        duration_days: rules.duration_days(),
        status: rules.status().as_str().to_string(),
        finalized: challenge.finalized_at.is_some(),
        participant_count: participants.len() as i64,
        max_participants: c::CHALLENGE_MAX_PARTICIPANTS,
        creator: creator_of(challenge, participants),
        participants_preview: participants.iter().take(preview_len).map(challenge_user_of).collect(),
        is_participant,
        can_join: !is_participant && join_blocked_reason.is_none(),
        join_blocked_reason: join_blocked_reason.map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::rules::DayStatus;
    use crate::service::test_support::{cday, on, rule_challenge};
    use chrono::Utc;
    use gt_core::models::{CHALLENGE_GOAL_AT_LEAST, CHALLENGE_GOAL_AT_MOST};

    fn participant_row(user_id: i64, username: &str, joined_on: NaiveDate) -> ChallengeParticipantRow {
        ChallengeParticipantRow {
            id: user_id * 10,
            challenge_id: 1,
            user_id,
            joined_at: Utc::now(),
            joined_on,
            final_rank: None,
            final_days_met: None,
            final_total_hours: None,
            completed: None,
            username: username.into(),
            profile_pic: None,
            profile_pic_thumb: None,
            is_verified: false,
        }
    }

    fn live_day(user_id: i64, date: NaiveDate, hours: f64, logged: bool) -> ChallengeActivityDay {
        ChallengeActivityDay { challenge_id: 1, user_id, day_date: date, hours, logged }
    }

    fn locked_day(user_id: i64, date: NaiveDate, hours: f64, met: bool) -> LockedDay {
        LockedDay {
            id: 0,
            challenge_id: 1,
            user_id,
            day_date: date,
            hours,
            logged: hours > 0.0,
            met,
            locked_at: Utc::now(),
        }
    }

    #[test]
    fn rank_from_locked_totals_and_live_days() {
        let rules = ChallengeRules::new(&rule_challenge(CHALLENGE_GOAL_AT_LEAST, 2.0, 7, None), on(3));
        let participants =
            [participant_row(1, "a", cday()), participant_row(2, "b", cday()), participant_row(3, "c", cday())];
        let totals = HashMap::from([
            (1, ChallengeLockedTotal { challenge_id: 1, user_id: 1, days_met: 2, total_hours: 4.0 }),
            (2, ChallengeLockedTotal { challenge_id: 1, user_id: 2, days_met: 1, total_hours: 9.0 }),
        ]);
        let live = [
            live_day(2, on(2), 3.0, true), // met: 2 days, 12 hours
            live_day(3, on(2), 1.0, true), // not met
            live_day(9, on(2), 8.0, true), // not a participant
        ];
        // The viewer's own score replaces their totals.
        let viewer = ParticipantScore { days_met: 3, total_centi: 100, ..Default::default() };
        let ranks = rank_from_totals(&rules, 3, &viewer, &participants, &totals, &live);
        assert_eq!(ranks, HashMap::from([(3, 1), (2, 2), (1, 3)]));
    }

    #[test]
    fn progress_and_final_results() {
        let window = ParticipationWindow { start: cday(), days_possible: 10, days_elapsed: 4 };
        let today = EvaluatedDay { date: cday(), status: DayStatus::Met, centi: 250, locked: false };
        let score = ParticipantScore { days_met: 3, total_centi: 725, current_streak: 2, today: Some(today) };

        let p = progress_of(&window, &score, Some(2), None);
        let want = ChallengeProgress {
            rank: Some(2),
            days_met: 3,
            days_elapsed: 4,
            days_possible: 10,
            current_streak: 2,
            total_hours: 7.25,
            today_hours: Some(2.5),
            today_status: Some("met".into()),
            completed: None,
        };
        assert_eq!(p, want, "completion is unknown until finalized");

        assert_eq!(final_result_of(false, Some(1), Some(1), Some(1.0), Some(true)), None);

        let stored = final_result_of(true, Some(1), Some(9), Some(20.5), Some(false));
        let p = progress_of(&window, &ParticipantScore { days_met: 3, ..Default::default() }, Some(4), stored.as_ref());
        assert_eq!(p.rank, Some(1), "stored results win");
        assert_eq!(p.days_met, 9);
        assert_eq!(p.total_hours, 20.5);
        assert_eq!(p.completed, Some(false));

        // Missing stored values fall back to the computed ones.
        let stored = final_result_of(true, None, None, None, None);
        let computed = ParticipantScore { days_met: 8, total_centi: 100, ..Default::default() };
        let p = progress_of(&window, &computed, Some(4), stored.as_ref());
        assert_eq!((p.rank, p.days_met, p.total_hours), (Some(4), 8, 1.0));
        assert_eq!(p.completed, Some(true), "8 of 10 days is 80%");
    }

    fn ranked(id: i64, name: &str, rank: Option<i64>) -> ChallengeParticipant {
        ChallengeParticipant {
            progress: ChallengeProgress { rank, ..Default::default() },
            user: ChallengeUser { id, username: name.into(), ..Default::default() },
            ..Default::default()
        }
    }

    #[test]
    fn participant_order() {
        let cases = [
            ("better rank first", ranked(2, "zed", Some(1)), ranked(1, "amy", Some(2)), true),
            ("worse rank later", ranked(1, "amy", Some(2)), ranked(2, "zed", Some(1)), false),
            ("ranked before unranked", ranked(2, "zed", Some(9)), ranked(1, "amy", None), true),
            ("unranked after ranked", ranked(1, "amy", None), ranked(2, "zed", Some(9)), false),
            ("same rank: by username", ranked(2, "amy", Some(1)), ranked(1, "bob", Some(1)), true),
            ("unranked: by username", ranked(2, "bob", None), ranked(1, "amy", None), false),
            ("same username: by id", ranked(1, "amy", None), ranked(2, "amy", None), true),
            ("same participant", ranked(1, "amy", Some(1)), ranked(1, "amy", Some(1)), false),
        ];
        for (name, a, b, want) in cases {
            assert_eq!(participant_less(&a, &b), want, "{name}");
        }
    }

    #[test]
    fn summary_order() {
        let s = |id: i64, status: &str, start: &str, end: &str| ChallengeSummary {
            id,
            status: status.into(),
            start_date: start.into(),
            end_date: end.into(),
            ..Default::default()
        };
        let mut summaries = vec![
            s(1, "ended", "2026-01-01", "2026-01-10"),
            s(2, "upcoming", "2026-04-01", "2026-04-10"),
            s(3, "active", "2026-03-01", "2026-03-20"),
            s(4, "ended", "2026-02-01", "2026-02-10"),
            s(5, "upcoming", "2026-03-20", "2026-04-30"),
            s(6, "active", "2026-03-05", "2026-03-12"),
            s(7, "ended", "2026-01-05", "2026-02-10"),
            s(8, "active", "2026-03-06", "2026-03-12"),
            s(9, "upcoming", "2026-03-20", "2026-03-25"),
        ];
        sort_summaries(&mut summaries);
        let ids: Vec<i64> = summaries.iter().map(|s| s.id).collect();
        assert_eq!(ids, [6, 8, 3, 5, 9, 2, 7, 4, 1]);
    }

    #[test]
    fn challenge_days_for_the_api() {
        let day = |date, status, centi, locked| EvaluatedDay { date, status, centi, locked };
        let days = challenge_days_of(&[
            day(cday(), DayStatus::None, 0, false),
            day(on(1), DayStatus::Met, 250, true),
            day(on(2), DayStatus::Pending, 0, false),
            day(on(3), DayStatus::Upcoming, 0, false),
        ]);
        let want = |date: &str, hours, status: &str, locked| ChallengeDay {
            date: date.into(),
            hours,
            status: status.into(),
            locked,
        };
        assert_eq!(
            days,
            [
                want("2026-03-09", None, "none", false),
                want("2026-03-10", Some(2.5), "met", true),
                want("2026-03-11", Some(0.0), "pending", false),
                want("2026-03-12", None, "upcoming", false),
            ]
        );
    }

    #[test]
    fn user_helpers() {
        let mut ann = participant_row(1, "ann", cday());
        ann.profile_pic = Some("https://cdn/a.jpg".into());
        ann.profile_pic_thumb = Some("https://cdn/a_thumb.jpg".into());
        ann.is_verified = true;
        let rows = [ann, participant_row(2, "ben", cday())];
        let mut challenge = rule_challenge(CHALLENGE_GOAL_AT_LEAST, 1.0, 3, None);
        challenge.creator_id = 1;
        assert_eq!(
            creator_of(&challenge, &rows),
            ChallengeUser {
                id: 1,
                username: "ann".into(),
                profile_pic: Some("https://cdn/a.jpg".into()),
                profile_pic_thumb: Some("https://cdn/a_thumb.jpg".into()),
                is_verified: true,
            }
        );
        challenge.creator_id = 7;
        assert_eq!(creator_of(&challenge, &rows), ChallengeUser { id: 7, ..Default::default() }, "unknown creator");
        assert!(find_participant_row(&rows, 3).is_none());
        assert_eq!(find_participant_row(&rows, 2).map(|r| r.username.as_str()), Some("ben"));
        assert_eq!(avatar_of(Some("https://cdn/a.jpg")), "https://cdn/a.jpg");
        assert_eq!(avatar_of(None), "");
    }

    /// Study 2h+ over 5 days, locked through day 2, viewed on day 4 (S+3). Ann joined before the
    /// start, Ben on S+2.
    #[test]
    fn detail_of_an_active_challenge() {
        let mut challenge = rule_challenge(CHALLENGE_GOAL_AT_LEAST, 2.0, 5, Some(on(1)));
        challenge.id = 1;
        challenge.creator_id = 1;
        challenge.invite_code = "K7Q2M9XA".into();
        let participants = [participant_row(1, "ann", on(-1)), participant_row(2, "ben", on(2))];
        let snapshots = [locked_day(1, cday(), 2.0, true), locked_day(1, on(1), 1.0, false)];
        let live = [live_day(1, on(2), 3.0, true), live_day(1, on(3), 0.5, true), live_day(2, on(2), 2.5, true)];
        let cheered = HashSet::from([2]);
        let data = DetailData {
            challenge: &challenge,
            participants: &participants,
            snapshots: &snapshots,
            live: &live,
            cheered: &cheered,
        };

        let detail = build_detail(data, 1, on(3));
        assert_eq!(detail.summary.status, "active");
        assert_eq!(detail.summary.day_number, Some(4));
        assert_eq!(detail.summary.participant_count, 2);
        assert!(detail.summary.is_creator);
        assert_eq!(detail.today, "2026-03-12");
        assert_eq!(detail.locked_through.as_deref(), Some("2026-03-10"));
        assert_eq!(detail.results_date, "2026-03-15");
        assert_eq!(detail.completion_days, 4);
        assert_eq!(detail.creator.username, "ann");
        assert!(detail.can_invite && !detail.can_leave && !detail.can_delete);

        let names: Vec<&str> = detail.participants.iter().map(|p| p.user.username.as_str()).collect();
        assert_eq!(names, ["ann", "ben"], "2 days met beat 1");
        let ann = &detail.participants[0];
        assert_eq!(ann.days, "MXMPU");
        assert_eq!(ann.progress.rank, Some(1));
        assert_eq!(ann.progress.total_hours, 6.5);
        assert_eq!(ann.progress.today_status.as_deref(), Some("pending"));
        assert!(ann.is_me && !ann.cheered_today);
        let ben = &detail.participants[1];
        assert_eq!(ben.days, "--MPU");
        assert_eq!(ben.joined_on, "2026-03-11");
        assert!(ben.cheered_today);
        assert_eq!(detail.summary.me, ann.progress);
        let my_days = detail.my_days.as_ref().expect("the viewer takes part");
        assert_eq!(my_days.len(), 5);
        assert_eq!(
            my_days[1],
            ChallengeDay { date: "2026-03-10".into(), hours: Some(1.0), status: "missed".into(), locked: true }
        );
    }

    #[test]
    fn detail_of_an_upcoming_challenge_has_no_ranks() {
        let mut challenge = rule_challenge(CHALLENGE_GOAL_AT_MOST, 1.0, 3, None);
        challenge.creator_id = 1;
        let participants = [participant_row(2, "bob", on(-2)), participant_row(1, "amy", on(-1))];
        let data = DetailData {
            challenge: &challenge,
            participants: &participants,
            snapshots: &[],
            live: &[],
            cheered: &HashSet::new(),
        };
        let detail = build_detail(data, 2, on(-1));
        assert_eq!(detail.summary.status, "upcoming");
        assert!(detail.participants.iter().all(|p| p.progress.rank.is_none()));
        let names: Vec<&str> = detail.participants.iter().map(|p| p.user.username.as_str()).collect();
        assert_eq!(names, ["amy", "bob"], "unranked: by username");
        assert!(!detail.summary.is_creator && detail.can_leave && !detail.can_delete);
        assert_eq!(detail.participants[1].days, "UUU");

        let outsider = build_detail(data, 99, on(-1));
        assert_eq!(outsider.my_days, None, "Go leaves my_days nil for non-participants");
    }

    #[test]
    fn summaries_rank_live_and_use_stored_results() {
        let base = |id: i64, start: NaiveDate, days: i64| {
            let mut c = rule_challenge(CHALLENGE_GOAL_AT_LEAST, 2.0, days, None);
            c.id = id;
            c.start_date = start;
            c.end_date = add_days(start, days - 1);
            c
        };
        let row = |challenge: Challenge, count: i64| UserChallengeRow {
            joined_on: challenge.start_date,
            challenge,
            participant_count: count,
            final_rank: None,
            final_days_met: None,
            final_total_hours: None,
            completed: None,
        };
        let active = row(base(1, cday(), 5), 2);
        let upcoming = row(base(2, on(10), 3), 1);
        let mut finalized = row(base(3, on(-20), 3), 1);
        finalized.challenge.finalized_at = Some(Utc::now());
        finalized.challenge.locked_through = Some(finalized.challenge.end_date);
        finalized.final_rank = Some(1);
        finalized.final_days_met = Some(3);
        finalized.final_total_hours = Some(7.5);
        finalized.completed = Some(true);
        let rows = vec![finalized, upcoming, active];

        let today = on(1);
        let (rank_ids, day_ids) = list_query_ids(&rows, today);
        assert_eq!(rank_ids, [1]);
        assert_eq!(day_ids, [3, 1]);

        let mut ben = participant_row(2, "ben", cday());
        ben.challenge_id = 1;
        let participants = [participant_row(1, "ann", cday()), ben];
        let totals = [];
        let live = [live_day(1, cday(), 2.0, true), live_day(2, cday(), 3.0, true), live_day(2, on(1), 2.0, true)];
        let data = ListData { rows: &rows, participants: &participants, totals: &totals, live: &live, my_days: &[] };
        let summaries = build_summaries(data, 1, today);

        let ids: Vec<i64> = summaries.iter().map(|s| s.id).collect();
        assert_eq!(ids, [1, 2, 3], "active, upcoming, ended");
        let me = &summaries[0].me;
        assert_eq!((me.rank, me.days_met, me.current_streak), (Some(2), 1, 1));
        assert_eq!(me.today_status.as_deref(), Some("pending"));
        assert_eq!(summaries[1].me.rank, None, "upcoming challenges are not ranked");
        let ended = &summaries[2].me;
        assert_eq!((ended.rank, ended.days_met, ended.total_hours, ended.completed), (Some(1), 3, 7.5, Some(true)));
    }

    #[test]
    fn preview() {
        let mut challenge = rule_challenge(CHALLENGE_GOAL_AT_LEAST, 2.0, 5, None);
        challenge.creator_id = 1;
        let participants: Vec<ChallengeParticipantRow> =
            (1..=7).map(|i| participant_row(i, &format!("user{i}"), cday())).collect();
        let rules = ChallengeRules::new(&challenge, on(1));
        assert_eq!(static_join_block(&rules, participants.len()), None);
        assert_eq!(static_join_block(&rules, 50), Some(JOIN_BLOCKED_FULL));
        let ended = ChallengeRules::new(&challenge, on(9));
        assert_eq!(static_join_block(&ended, 50), Some(JOIN_BLOCKED_ENDED));

        let p = build_preview(&challenge, &participants, 99, on(1), None);
        assert_eq!(p.participant_count, 7);
        assert_eq!(p.participants_preview.len(), 5, "up to 5, earliest joined first");
        assert_eq!(p.participants_preview[0].username, "user1");
        assert_eq!(p.creator.username, "user1");
        assert!(!p.is_participant && p.can_join);
        assert_eq!(p.status, "active");

        let p = build_preview(&challenge, &participants, 99, on(1), Some("limit"));
        assert!(!p.can_join);
        assert_eq!(p.join_blocked_reason.as_deref(), Some("limit"));
        let p = build_preview(&challenge, &participants, 3, on(1), None);
        assert!(p.is_participant && !p.can_join);
    }
}
