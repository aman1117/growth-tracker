//! `ChallengeService` (port of `services/challenge_service.go`): input validation, permissions
//! and live scoring around the repository; the daily job lives in [`super::job`].

use std::collections::HashSet;
use std::fmt::Display;
use std::sync::Arc;

use chrono::{DateTime, NaiveDate, Utc};
use gt_core::constants as c;
use gt_core::models::{Challenge, ChallengeActorMetadata, ChallengeInviteMetadata};
use gt_core::validator::ValidationError;
use gt_notify::{NotificationError, NotificationService};
use gt_users::CronJobLogRepository;

use crate::dto::{
    ChallengeDetail, ChallengePreview, ChallengeSummary, ChallengeUser, CreateChallengeRequest, InviteCandidate,
};
use crate::repository::{
    ChallengeConn, ChallengeParticipantRow, ChallengeRepository, ChallengeTx, NewChallenge, NewChallengeCheer,
    NewChallengeParticipant,
};
use crate::service::error::ChallengeError;
use crate::service::rules::{
    add_days, days_between, format_date, generate_invite_code, ist_date, ChallengeRules, ChallengeStatus,
    JOIN_BLOCKED_LIMIT,
};
use crate::service::view::{
    avatar_of, build_detail, build_preview, build_summaries, find_participant_row, list_query_ids, static_join_block,
    DetailData, ListData,
};
use crate::validator::{
    normalize_challenge_title, normalize_invite_code, parse_challenge_start_date, validate_challenge_activity,
    validate_challenge_duration, validate_challenge_goal, validate_invite_user_ids,
};

/// The wall clock, which decides what "today" (IST) is.
pub type Clock = Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>;

/// Generates invite codes.
pub type CodeGenerator = Arc<dyn Fn() -> String + Send + Sync>;

/// Bounds the retries when a random invite code is already taken.
const MAX_INVITE_CODE_ATTEMPTS: u32 = 5;

/// Holds the challenge rules: input validation, permissions, live scoring from the activity log
/// and the daily job that locks days and stores the final results.
#[derive(Clone)]
pub struct ChallengeService {
    pub(super) repo: Arc<ChallengeRepository>,
    pub(super) job_log_repo: Option<Arc<CronJobLogRepository>>,
    pub(super) notifications: Option<Arc<NotificationService>>,
    now: Clock,
    new_code: CodeGenerator,
    pub(super) instance_id: String,
}

impl std::fmt::Debug for ChallengeService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChallengeService").field("instance_id", &self.instance_id).finish_non_exhaustive()
    }
}

impl ChallengeService {
    /// Go `NewChallengeService`. `job_log_repo` (used to claim the daily job so that one replica
    /// runs it) and `notifications` may be `None`.
    pub fn new(
        repo: Arc<ChallengeRepository>,
        job_log_repo: Option<Arc<CronJobLogRepository>>,
        notifications: Option<Arc<NotificationService>>,
    ) -> Self {
        Self {
            repo,
            job_log_repo,
            notifications,
            now: Arc::new(Utc::now),
            new_code: Arc::new(generate_invite_code),
            instance_id: default_instance_id(),
        }
    }

    /// Replaces the wall clock (Go `WithChallengeClock`).
    pub fn with_clock(mut self, now: impl Fn() -> DateTime<Utc> + Send + Sync + 'static) -> Self {
        self.now = Arc::new(now);
        self
    }

    /// Replaces the invite code generator.
    pub fn with_code_generator(mut self, new_code: impl Fn() -> String + Send + Sync + 'static) -> Self {
        self.new_code = Arc::new(new_code);
        self
    }

    /// Replaces the instance id recorded when claiming the daily job.
    pub fn with_instance_id(mut self, instance_id: impl Into<String>) -> Self {
        self.instance_id = instance_id.into();
        self
    }

    pub fn repository(&self) -> &Arc<ChallengeRepository> {
        &self.repo
    }

    pub(super) fn now(&self) -> DateTime<Utc> {
        (self.now)()
    }

    /// The current IST date.
    pub fn today(&self) -> NaiveDate {
        ist_date(&self.now())
    }

    // ==================== Queries ====================

    /// Every upcoming and active challenge the user takes part in plus the 20 most recently
    /// ended ones: active by end date, then upcoming by start date, then ended, most recent
    /// first.
    pub async fn list(&self, viewer_id: i64) -> Result<Vec<ChallengeSummary>, ChallengeError> {
        let today = self.today();
        let mut db = self.conn().await?;
        let rows = db
            .list_for_user(viewer_id, today, c::CHALLENGE_RECENT_ENDED_LIMIT)
            .await
            .map_err(internal("list challenges"))?;

        let (rank_ids, day_ids) = list_query_ids(&rows, today);
        let participants = db.list_participants(&rank_ids).await.map_err(internal("list participants"))?;
        let totals = db.locked_totals(&rank_ids).await.map_err(internal("sum locked days"))?;
        let live = db.activity_days(&rank_ids, today).await.map_err(internal("read activity days"))?;
        let my_days = db.list_user_days(viewer_id, &day_ids).await.map_err(internal("list locked days"))?;

        let data =
            ListData { rows: &rows, participants: &participants, totals: &totals, live: &live, my_days: &my_days };
        Ok(build_summaries(data, viewer_id, today))
    }

    /// A challenge with every participant's progress. Users who do not take part get
    /// [`ChallengeError::NotFound`].
    pub async fn get_detail(&self, viewer_id: i64, challenge_id: i64) -> Result<ChallengeDetail, ChallengeError> {
        let (detail, _) = self.load_detail(challenge_id, viewer_id, self.today()).await?;
        Ok(detail)
    }

    /// Up to `limit` (default 20, at most 50) people the viewer follows or who follow the
    /// viewer, who are not participants yet, optionally filtered by a username prefix.
    /// `invited` marks people who already have an invite; leaving the challenge removes it.
    pub async fn invite_candidates(
        &self,
        viewer_id: i64,
        challenge_id: i64,
        query: &str,
        limit: i64,
    ) -> Result<Vec<InviteCandidate>, ChallengeError> {
        let mut db = self.conn().await?;
        require_participant(&mut db, challenge_id, viewer_id).await?;
        let limit = if limit <= 0 { c::CHALLENGE_CANDIDATES_DEFAULT } else { limit }.min(c::CHALLENGE_CANDIDATES_MAX);
        let prefix = query.trim();
        if prefix.chars().count() > c::USERNAME_MAX_LENGTH {
            return Ok(Vec::new()); // no username is that long
        }

        let rows = db
            .invite_candidates(challenge_id, viewer_id, prefix, limit)
            .await
            .map_err(internal("list invite candidates"))?;
        Ok(rows
            .into_iter()
            .map(|r| InviteCandidate {
                user: ChallengeUser {
                    id: r.id,
                    username: r.username,
                    profile_pic: r.profile_pic,
                    profile_pic_thumb: r.profile_pic_thumb,
                    is_verified: r.is_verified,
                },
                invited: r.invited,
            })
            .collect())
    }

    /// Describes the challenge behind an invite code to any signed-in user, including whether
    /// they can join it.
    pub async fn preview_by_code(&self, viewer_id: i64, raw_code: &str) -> Result<ChallengePreview, ChallengeError> {
        let challenge = self.find_by_code(raw_code).await?;
        let mut db = self.conn().await?;
        let participants = db.list_participants(&[challenge.id]).await.map_err(internal("list participants"))?;
        let today = self.today();
        let rules = ChallengeRules::new(&challenge, today);

        let mut blocked = None;
        if find_participant_row(&participants, viewer_id).is_none() {
            blocked = static_join_block(&rules, participants.len());
            if blocked.is_none() {
                let open = db.count_open_for_user(viewer_id, today).await.map_err(internal("count open challenges"))?;
                if open >= c::CHALLENGE_MAX_OPEN_PER_USER {
                    blocked = Some(JOIN_BLOCKED_LIMIT);
                }
            }
        }
        Ok(build_preview(&challenge, &participants, viewer_id, today, blocked))
    }

    // ==================== Commands ====================

    /// Validates the input, creates the challenge with a fresh invite code and makes the creator
    /// its first participant. Creators take part, so the open-challenge limit applies.
    pub async fn create(
        &self,
        viewer_id: i64,
        req: &CreateChallengeRequest,
    ) -> Result<ChallengeDetail, ChallengeError> {
        let today = self.today();
        let title = normalize_challenge_title(&req.title)?;
        validate_challenge_activity(&req.activity)?;
        validate_challenge_goal(&req.goal_type, req.target_hours)?;
        validate_challenge_duration(req.duration_days)?;
        let start = parse_challenge_start_date(&req.start_date, today)?;
        let duration_days = req.duration_days.unwrap_or_default();

        let now = self.now();
        let mut new = NewChallenge {
            creator_id: viewer_id,
            title,
            activity: req.activity.clone(),
            goal_type: req.goal_type.clone(),
            target_hours: req.target_hours.unwrap_or_default(),
            start_date: start,
            end_date: add_days(start, duration_days - 1),
            invite_code: String::new(),
        };
        let mut attempt = 1;
        let challenge = loop {
            new.invite_code = (self.new_code)();
            match self.create_in_tx(&new, today, now).await {
                Ok(Some(challenge)) => break challenge,
                Ok(None) if attempt < MAX_INVITE_CODE_ATTEMPTS => {
                    tracing::warn!(
                        user_id = viewer_id,
                        attempt,
                        "Challenge invite code collision, retrying with a new code"
                    );
                    attempt += 1;
                }
                Ok(None) => {
                    return Err(ChallengeError::Internal(anyhow::anyhow!("invite code already taken"))
                        .context("create challenge"))
                }
                Err(err) => return Err(err.context("create challenge")),
            }
        };

        tracing::info!(
            challenge_id = challenge.id,
            user_id = viewer_id,
            duration_days,
            starts_in_days = days_between(today, start),
            "Challenge created"
        );
        let (detail, _) = self.load_detail(challenge.id, viewer_id, today).await?;
        Ok(detail)
    }

    /// One attempt of [`Self::create`]: `None` when the invite code is taken.
    async fn create_in_tx(
        &self,
        new: &NewChallenge,
        today: NaiveDate,
        now: DateTime<Utc>,
    ) -> Result<Option<Challenge>, ChallengeError> {
        let mut tx = self.repo.begin().await?;
        check_open_limit(&mut tx, new.creator_id, today).await?;
        let Some(challenge) = tx.create_challenge(new).await? else {
            return Ok(None);
        };
        tx.add_participant(&NewChallengeParticipant {
            challenge_id: challenge.id,
            user_id: new.creator_id,
            joined_at: now,
            joined_on: today,
        })
        .await?;
        tx.commit().await?;
        Ok(Some(challenge))
    }

    /// Adds the viewer to the challenge behind an invite code and returns its detail. Joining
    /// again is a no-op. The challenge's row lock serialises joins, so the participant cap holds
    /// under concurrency; the user's row lock does the same for the open-challenge limit.
    pub async fn join_by_code(&self, viewer_id: i64, raw_code: &str) -> Result<ChallengeDetail, ChallengeError> {
        let challenge = self.find_by_code(raw_code).await?;
        let today = self.today();
        let now = self.now();
        let joined =
            self.join_locked(challenge.id, viewer_id, today, now).await.map_err(|err| err.context("join challenge"))?;
        if let Some(participant_count) = joined {
            tracing::info!(challenge_id = challenge.id, user_id = viewer_id, participant_count, "Challenge joined");
        }

        let loaded = self.load_detail(challenge.id, viewer_id, today).await;
        if joined.is_some() && challenge.creator_id != viewer_id {
            let joiner =
                loaded.as_ref().ok().and_then(|(_, participants)| find_participant_row(participants, viewer_id));
            match joiner {
                Some(joiner) => {
                    if let Some(notifications) = &self.notifications {
                        let result = notifications
                            .notify_challenge_joined(challenge.creator_id, &actor_of(&challenge, joiner))
                            .await;
                        report_notification(challenge.id, "challenge_joined", challenge.creator_id, result);
                    }
                }
                None => tracing::warn!(
                    challenge_id = challenge.id,
                    user_id = viewer_id,
                    error = %loaded.as_ref().err().map(chain).unwrap_or_default(),
                    "Challenge joined notification skipped: loading the challenge failed after the join"
                ),
            }
        }
        loaded.map(|(detail, _)| detail)
    }

    /// The locked part of [`Self::join_by_code`]: the new participant count when the viewer
    /// joined, `None` when they already took part.
    async fn join_locked(
        &self,
        challenge_id: i64,
        viewer_id: i64,
        today: NaiveDate,
        now: DateTime<Utc>,
    ) -> Result<Option<i64>, ChallengeError> {
        let (mut tx, locked) = self.repo.lock_challenge(challenge_id).await?;
        if tx.find_participant(locked.id, viewer_id).await?.is_some() {
            tx.commit().await?;
            return Ok(None);
        }
        if ChallengeRules::new(&locked, today).status() == ChallengeStatus::Ended {
            return Err(ChallengeError::Ended);
        }
        let count = tx.count_participants(locked.id).await?;
        if count >= c::CHALLENGE_MAX_PARTICIPANTS {
            return Err(ChallengeError::Full);
        }
        check_open_limit(&mut tx, viewer_id, today).await?;
        tx.add_participant(&NewChallengeParticipant {
            challenge_id: locked.id,
            user_id: viewer_id,
            joined_at: now,
            joined_on: today,
        })
        .await?;
        tx.commit().await?;
        Ok(Some(count + 1))
    }

    /// Removes the viewer (who must not be the creator) from a challenge that has not ended,
    /// together with their locked days.
    pub async fn leave(&self, viewer_id: i64, challenge_id: i64) -> Result<(), ChallengeError> {
        let today = self.today();
        self.leave_locked(viewer_id, challenge_id, today).await.map_err(|err| err.context("leave challenge"))?;
        tracing::info!(challenge_id, user_id = viewer_id, "Challenge left");
        Ok(())
    }

    async fn leave_locked(&self, viewer_id: i64, challenge_id: i64, today: NaiveDate) -> Result<(), ChallengeError> {
        let (mut tx, challenge) = self.repo.lock_challenge(challenge_id).await?;
        if tx.find_participant(challenge.id, viewer_id).await?.is_none() {
            return Err(ChallengeError::NotFound);
        }
        if challenge.creator_id == viewer_id {
            return Err(ChallengeError::CreatorCannotLeave);
        }
        if ChallengeRules::new(&challenge, today).status() == ChallengeStatus::Ended {
            return Err(ChallengeError::Ended);
        }
        tx.remove_participant(challenge.id, viewer_id).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Deletes a challenge and everything attached to it. Only the creator may, while the
    /// challenge is upcoming or while they are its only participant.
    pub async fn delete(&self, viewer_id: i64, challenge_id: i64) -> Result<(), ChallengeError> {
        let today = self.today();
        self.delete_locked(viewer_id, challenge_id, today).await.map_err(|err| err.context("delete challenge"))?;
        tracing::info!(challenge_id, user_id = viewer_id, "Challenge deleted");
        Ok(())
    }

    async fn delete_locked(&self, viewer_id: i64, challenge_id: i64, today: NaiveDate) -> Result<(), ChallengeError> {
        let (mut tx, challenge) = self.repo.lock_challenge(challenge_id).await?;
        if tx.find_participant(challenge.id, viewer_id).await?.is_none() {
            return Err(ChallengeError::NotFound);
        }
        if challenge.creator_id != viewer_id {
            return Err(ChallengeError::NotCreator);
        }
        if ChallengeRules::new(&challenge, today).status() != ChallengeStatus::Upcoming
            && tx.count_participants(challenge.id).await? > 1
        {
            return Err(ChallengeError::InProgress);
        }
        tx.delete(challenge.id).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Lets a participant cheer another participant of an active challenge, once per IST day.
    /// Returns `already_cheered`: `true` (and nobody is notified) for a repeat. `target_id` is
    /// the raw request value; ids beyond `i64` belong to nobody.
    pub async fn cheer(&self, viewer_id: i64, challenge_id: i64, target_id: u64) -> Result<bool, ChallengeError> {
        let (challenge, participants) = self.load_participation(challenge_id, viewer_id).await?;
        let target_id = i64::try_from(target_id).ok();
        if target_id == Some(viewer_id) {
            return Err(ChallengeError::CannotCheerSelf);
        }
        let Some(target_id) = target_id.filter(|id| find_participant_row(&participants, *id).is_some()) else {
            return Err(ValidationError::new(
                "user_id must be a participant of this challenge",
                c::ERR_CODE_INVALID_CHALLENGE,
            )
            .into());
        };
        let today = self.today();
        if ChallengeRules::new(&challenge, today).status() != ChallengeStatus::Active {
            return Err(ChallengeError::NotActive);
        }

        let cheer = NewChallengeCheer {
            challenge_id: challenge.id,
            from_user_id: viewer_id,
            to_user_id: target_id,
            cheer_date: today,
            created_at: self.now(),
        };
        let created = self.conn().await?.create_cheer(&cheer).await.map_err(internal("create cheer"))?;
        tracing::info!(
            challenge_id = challenge.id,
            user_id = viewer_id,
            to_user_id = target_id,
            new = created,
            "Challenge cheer"
        );
        if created {
            if let (Some(notifications), Some(cheerer)) =
                (&self.notifications, find_participant_row(&participants, viewer_id))
            {
                let result = notifications
                    .notify_challenge_cheer(target_id, &format_date(today), &actor_of(&challenge, cheerer))
                    .await;
                report_notification(challenge.id, "challenge_cheer", target_id, result);
            }
        }
        Ok(!created)
    }

    /// Invites 1 to 20 users to a challenge that has not ended and returns `(invited,
    /// skipped)`. Users who do not exist, are participants, are the inviter, have no ACTIVE
    /// follow relationship with the inviter (in either direction) or already have an invite
    /// (from anyone) are skipped; invited + skipped = `user_ids.len()`.
    pub async fn invite(
        &self,
        viewer_id: i64,
        challenge_id: i64,
        user_ids: &[u64],
    ) -> Result<(i64, i64), ChallengeError> {
        validate_invite_user_ids(user_ids)?;
        let (challenge, participants) = self.load_participation(challenge_id, viewer_id).await?;
        if ChallengeRules::new(&challenge, self.today()).status() == ChallengeStatus::Ended {
            return Err(ChallengeError::Ended);
        }

        let viewer = u64::try_from(viewer_id).ok();
        let mut seen = HashSet::with_capacity(user_ids.len());
        let mut candidates = Vec::with_capacity(user_ids.len());
        for &id in user_ids {
            if id != 0 && Some(id) != viewer && seen.insert(id) {
                // Go binds the ids as int8 parameters: an id beyond i64 fails the statement.
                let id = i64::try_from(id).map_err(|_| {
                    ChallengeError::Internal(anyhow::anyhow!("{id} is greater than maximum value for int8"))
                        .context("create invites")
                })?;
                candidates.push(id);
            }
        }
        let invites = self
            .conn()
            .await?
            .create_invites(challenge.id, viewer_id, &candidates, self.now())
            .await
            .map_err(internal("create invites"))?;
        let requested = user_ids.len() as i64;
        let invited = invites.len() as i64;
        let skipped = requested - invited;
        tracing::info!(
            challenge_id = challenge.id,
            user_id = viewer_id,
            requested,
            invited,
            skipped,
            "Challenge invites sent"
        );

        if let (Some(notifications), Some(inviter)) =
            (&self.notifications, find_participant_row(&participants, viewer_id))
        {
            let actor = actor_of(&challenge, inviter);
            for invite in &invites {
                let metadata =
                    ChallengeInviteMetadata { actor: actor.clone(), invite_code: challenge.invite_code.clone() };
                let result = notifications.notify_challenge_invite(invite.invitee_id, invite.id, &metadata).await;
                report_notification(challenge.id, "challenge_invite", invite.invitee_id, result);
            }
        }
        Ok((invited, skipped))
    }

    /// Deletes invites still held by people who joined a challenge with them and left it back
    /// when leaving kept the invite, so they can be invited again. Safe to run on every start:
    /// it never deletes an open invite.
    pub async fn delete_stale_invites(&self) -> Result<(), ChallengeError> {
        let deleted =
            self.conn().await?.delete_stale_invites().await.map_err(internal("delete stale challenge invites"))?;
        if deleted > 0 {
            tracing::info!(deleted_count = deleted, "Stale challenge invites deleted");
        }
        Ok(())
    }

    // ==================== Loading ====================

    async fn conn(&self) -> Result<ChallengeConn, ChallengeError> {
        Ok(self.repo.conn().await?)
    }

    /// Resolves an invite code (case-insensitive, surrounding spaces ignored).
    async fn find_by_code(&self, raw_code: &str) -> Result<Challenge, ChallengeError> {
        let Some(code) = normalize_invite_code(raw_code) else {
            return Err(ChallengeError::NotFound);
        };
        let mut db = self.conn().await?;
        db.find_by_invite_code(&code).await.map_err(internal("find challenge by code"))?.ok_or(ChallengeError::NotFound)
    }

    /// The challenge and its participants when the user takes part in it.
    async fn load_participation(
        &self,
        challenge_id: i64,
        user_id: i64,
    ) -> Result<(Challenge, Vec<ChallengeParticipantRow>), ChallengeError> {
        let mut db = self.conn().await?;
        load_participation(&mut db, challenge_id, user_id).await
    }

    /// The detail of a challenge the viewer takes part in, with its participants.
    async fn load_detail(
        &self,
        challenge_id: i64,
        viewer_id: i64,
        today: NaiveDate,
    ) -> Result<(ChallengeDetail, Vec<ChallengeParticipantRow>), ChallengeError> {
        let mut db = self.conn().await?;
        let (challenge, participants) = load_participation(&mut db, challenge_id, viewer_id).await?;
        let rules = ChallengeRules::new(&challenge, today);

        let snapshots = db.list_days(challenge.id).await.map_err(internal("list locked days"))?;
        let live = if rules.has_live_days() {
            db.activity_days(&[challenge.id], today).await.map_err(internal("read activity days"))?
        } else {
            Vec::new()
        };
        let cheered: HashSet<i64> = if rules.status() == ChallengeStatus::Active {
            db.cheered_user_ids(challenge.id, viewer_id, today)
                .await
                .map_err(internal("list cheers"))?
                .into_iter()
                .collect()
        } else {
            HashSet::new()
        };

        let data = DetailData {
            challenge: &challenge,
            participants: &participants,
            snapshots: &snapshots,
            live: &live,
            cheered: &cheered,
        };
        let detail = build_detail(data, viewer_id, today);
        Ok((detail, participants))
    }
}

/// Go: `os.Getenv("HOSTNAME")`, else `instance-<nanos % 10000>`.
fn default_instance_id() -> String {
    instance_id_from(std::env::var("HOSTNAME").ok(), Utc::now().timestamp_nanos_opt().unwrap_or_default())
}

fn instance_id_from(hostname: Option<String>, nanos: i64) -> String {
    match hostname {
        Some(host) if !host.is_empty() => host,
        _ => format!("instance-{}", nanos % 10000),
    }
}

/// Wraps an unexpected error with what was being done (Go `fmt.Errorf("<action>: %w", err)`).
fn internal<E>(action: &'static str) -> impl FnOnce(E) -> ChallengeError
where
    E: std::error::Error + Send + Sync + 'static,
{
    move |err| ChallengeError::Internal(anyhow::Error::new(err).context(action))
}

/// An error with its causes (`outer: inner`), for logs.
pub(crate) fn chain(err: &impl Display) -> String {
    format!("{err:#}")
}

/// The challenge when the user takes part in it.
async fn require_participant(
    db: &mut ChallengeConn,
    challenge_id: i64,
    user_id: i64,
) -> Result<Challenge, ChallengeError> {
    let challenge =
        db.find_by_id(challenge_id).await.map_err(internal("find challenge"))?.ok_or(ChallengeError::NotFound)?;
    db.find_participant(challenge_id, user_id)
        .await
        .map_err(internal("find participant"))?
        .ok_or(ChallengeError::NotFound)?;
    Ok(challenge)
}

async fn load_participation(
    db: &mut ChallengeConn,
    challenge_id: i64,
    user_id: i64,
) -> Result<(Challenge, Vec<ChallengeParticipantRow>), ChallengeError> {
    let challenge =
        db.find_by_id(challenge_id).await.map_err(internal("find challenge"))?.ok_or(ChallengeError::NotFound)?;
    let participants = db.list_participants(&[challenge_id]).await.map_err(internal("list participants"))?;
    if find_participant_row(&participants, user_id).is_none() {
        return Err(ChallengeError::NotFound);
    }
    Ok((challenge, participants))
}

/// Locks the user's row and fails when they already take part in the maximum number of
/// upcoming or active challenges.
async fn check_open_limit(tx: &mut ChallengeTx, user_id: i64, today: NaiveDate) -> Result<(), ChallengeError> {
    tx.lock_user(user_id).await?;
    if tx.count_open_for_user(user_id, today).await? >= c::CHALLENGE_MAX_OPEN_PER_USER {
        return Err(ChallengeError::LimitReached);
    }
    Ok(())
}

/// Notification metadata about `actor` acting on `challenge`.
fn actor_of(challenge: &Challenge, actor: &ChallengeParticipantRow) -> ChallengeActorMetadata {
    ChallengeActorMetadata {
        challenge_id: challenge.id,
        challenge_title: challenge.title.clone(),
        actor_id: actor.user_id,
        actor_username: actor.username.clone(),
        actor_avatar: avatar_of(actor.profile_pic.as_deref()),
    }
}

/// A failed notification is logged and never fails the caller.
pub(super) fn report_notification(
    challenge_id: i64,
    kind: &str,
    recipient_id: i64,
    result: Result<(), NotificationError>,
) {
    if let Err(err) = result {
        tracing::warn!(
            challenge_id,
            r#type = kind,
            recipient_id,
            error = %chain(&err),
            "Challenge notification failed; the action itself succeeded"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use sqlx::postgres::PgPoolOptions;

    fn lazy_service() -> ChallengeService {
        let pool = PgPoolOptions::new().connect_lazy("postgres://localhost/unused").expect("lazy pool");
        ChallengeService::new(Arc::new(ChallengeRepository::new(pool)), None, None)
    }

    #[test]
    fn instance_ids_like_go() {
        assert_eq!(instance_id_from(Some("worker-3".into()), 123_456), "worker-3");
        assert_eq!(instance_id_from(Some(String::new()), 123_456), "instance-3456");
        assert_eq!(instance_id_from(None, 42), "instance-42");
    }

    #[tokio::test]
    async fn defaults_and_ist_today() {
        let svc = lazy_service();
        assert!((Utc::now() - svc.now()).num_seconds().abs() < 60, "the wall clock by default");
        assert_eq!((svc.new_code)().len(), c::CHALLENGE_INVITE_CODE_LENGTH);

        // "today" is the IST date: 19:00 UTC on March 8 is 00:30 on March 9 in India.
        let fixed = Utc.with_ymd_and_hms(2026, 3, 8, 19, 0, 0).unwrap();
        let svc = svc.with_clock(move || fixed);
        assert_eq!(svc.today(), NaiveDate::from_ymd_opt(2026, 3, 9).unwrap());
    }
}
