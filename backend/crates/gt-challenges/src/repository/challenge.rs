//! Challenge data access (port of `repository/challenge_repository.go`). The SQL is the Go
//! backend's, with `NUMERIC` results cast to `float8` and `IN ?` lists bound as arrays.
//!
//! [`ChallengeRepository`] owns the pool. Queries run on a [`ChallengeStore`] bound to either a
//! pooled connection ([`ChallengeRepository::conn`]) or a transaction
//! ([`ChallengeRepository::begin`], [`ChallengeRepository::lock_challenge`]), mirroring Go's
//! repository bound to `db` or to a `tx`. A transaction that is dropped without
//! [`ChallengeTx::commit`] rolls back.

use std::ops::DerefMut;

use chrono::{DateTime, NaiveDate, Utc};
use gt_core::models::{
    Challenge, ChallengeDay, ChallengeInvite, ChallengeParticipant, FOLLOW_STATE_ACTIVE, NOTIF_ENTITY_CHALLENGE,
    NOTIF_TYPE_CHALLENGE_JOINED,
};
use sqlx::pool::PoolConnection;
use sqlx::{Connection, PgConnection, PgPool, Postgres, QueryBuilder, Transaction};

use crate::gostr;

/// Errors of the locking helpers; every other method returns plain `sqlx::Error`s.
#[derive(Debug, thiserror::Error)]
pub enum ChallengeRepoError {
    /// [`ChallengeRepository::lock_challenge`]: the challenge does not exist.
    #[error("challenge not found")]
    ChallengeNotFound,
    /// [`ChallengeStore::lock_user`]: the user does not exist.
    #[error("user not found")]
    UserNotFound,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

// ==================== Rows ====================

/// A challenge a user takes part in, with the user's participation and the challenge's
/// participant count.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct UserChallengeRow {
    #[sqlx(flatten)]
    pub challenge: Challenge,
    pub participant_count: i64,
    pub joined_on: NaiveDate,
    pub final_rank: Option<i64>,
    pub final_days_met: Option<i64>,
    pub final_total_hours: Option<f64>,
    pub completed: Option<bool>,
}

/// A participant with the user fields shown in challenge views.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct ChallengeParticipantRow {
    pub id: i64,
    pub challenge_id: i64,
    pub user_id: i64,
    pub joined_at: DateTime<Utc>,
    pub joined_on: NaiveDate,
    pub final_rank: Option<i64>,
    pub final_days_met: Option<i64>,
    pub final_total_hours: Option<f64>,
    pub completed: Option<bool>,
    pub username: String,
    pub profile_pic: Option<String>,
    pub profile_pic_thumb: Option<String>,
    pub is_verified: bool,
}

/// What a participant logged on one challenge date that is not locked yet.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct ChallengeActivityDay {
    pub challenge_id: i64,
    pub user_id: i64,
    pub day_date: NaiveDate,
    /// Hours of the challenge activity (capped at 24).
    pub hours: f64,
    /// Whether any activity at all was logged that day.
    pub logged: bool,
}

/// The sum of a participant's locked (snapshotted) days.
#[derive(Debug, Clone, Default, PartialEq, sqlx::FromRow)]
pub struct ChallengeLockedTotal {
    pub challenge_id: i64,
    pub user_id: i64,
    pub days_met: i64,
    pub total_hours: f64,
}

/// The final standing of one participant.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChallengeFinalResult {
    pub participant_id: i64,
    pub rank: i64,
    pub days_met: i64,
    pub total_hours: f64,
    pub completed: bool,
}

/// A user the viewer can invite to a challenge.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct InviteCandidateRow {
    pub id: i64,
    pub username: String,
    pub profile_pic: Option<String>,
    pub profile_pic_thumb: Option<String>,
    pub is_verified: bool,
    /// Has an invite to the challenge (from anyone); leaving removes it.
    pub invited: bool,
}

// ==================== Inserts ====================

/// A challenge to insert; `created_at`/`updated_at` are set by the database.
#[derive(Debug, Clone, PartialEq)]
pub struct NewChallenge {
    pub creator_id: i64,
    pub title: String,
    pub activity: String,
    pub goal_type: String,
    pub target_hours: f64,
    pub start_date: NaiveDate,
    pub end_date: NaiveDate,
    pub invite_code: String,
}

/// A participant to insert (the final results start out `NULL`).
#[derive(Debug, Clone, PartialEq)]
pub struct NewChallengeParticipant {
    pub challenge_id: i64,
    pub user_id: i64,
    pub joined_at: DateTime<Utc>,
    /// IST date of `joined_at`.
    pub joined_on: NaiveDate,
}

/// A locked day to insert.
#[derive(Debug, Clone, PartialEq)]
pub struct NewChallengeDay {
    pub challenge_id: i64,
    pub user_id: i64,
    pub day_date: NaiveDate,
    pub hours: f64,
    pub logged: bool,
    pub met: bool,
    pub locked_at: DateTime<Utc>,
}

/// A cheer to insert.
#[derive(Debug, Clone, PartialEq)]
pub struct NewChallengeCheer {
    pub challenge_id: i64,
    pub from_user_id: i64,
    pub to_user_id: i64,
    pub cheer_date: NaiveDate,
    pub created_at: DateTime<Utc>,
}

// ==================== Repository ====================

/// Rows per `INSERT` when storing locked days (GORM `CreateInBatches(days, 500)`).
const INSERT_DAYS_BATCH: usize = 500;

/// Hands out [`ChallengeStore`]s bound to pooled connections or transactions.
#[derive(Debug, Clone)]
pub struct ChallengeRepository {
    pool: PgPool,
}

/// Queries bound to one connection (`C` is a pooled connection or a transaction).
#[derive(Debug)]
pub struct ChallengeStore<C> {
    conn: C,
}

/// A [`ChallengeStore`] on a pooled connection: every statement commits on its own.
pub type ChallengeConn = ChallengeStore<PoolConnection<Postgres>>;

/// A [`ChallengeStore`] inside a transaction; dropping it without committing rolls back.
pub type ChallengeTx = ChallengeStore<Transaction<'static, Postgres>>;

impl ChallengeRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    /// Queries on a pooled connection (Go: the repository bound to `db`).
    pub async fn conn(&self) -> Result<ChallengeConn, sqlx::Error> {
        Ok(ChallengeStore { conn: self.pool.acquire().await? })
    }

    /// Starts a transaction (Go: `WithTransaction`).
    pub async fn begin(&self) -> Result<ChallengeTx, sqlx::Error> {
        Ok(ChallengeStore { conn: self.pool.begin().await? })
    }

    /// Starts a transaction holding a row lock (`SELECT ... FOR UPDATE`) on the challenge, so
    /// joins, leaves, deletes and the daily job on one challenge never interleave (Go:
    /// `WithLockedChallenge`). Fails with [`ChallengeRepoError::ChallengeNotFound`] when the
    /// challenge does not exist.
    pub async fn lock_challenge(&self, id: i64) -> Result<(ChallengeTx, Challenge), ChallengeRepoError> {
        let mut tx = self.begin().await?;
        let sql = format!("SELECT {} FROM challenges WHERE id = $1 LIMIT 1 FOR UPDATE", Challenge::COLUMNS);
        let challenge = sqlx::query_as::<_, Challenge>(&sql)
            .bind(id)
            .fetch_optional(tx.db())
            .await?
            .ok_or(ChallengeRepoError::ChallengeNotFound)?;
        Ok((tx, challenge))
    }
}

impl ChallengeTx {
    pub async fn commit(self) -> Result<(), sqlx::Error> {
        self.conn.commit().await
    }

    pub async fn rollback(self) -> Result<(), sqlx::Error> {
        self.conn.rollback().await
    }
}

impl<C> ChallengeStore<C>
where
    C: DerefMut<Target = PgConnection> + Send,
{
    fn db(&mut self) -> &mut PgConnection {
        &mut self.conn
    }

    /// Locks the user's row until the surrounding transaction ends, which serialises the
    /// open-challenge limit check of concurrent creates and joins by the same user. `FOR NO KEY
    /// UPDATE` does not block foreign key checks of other writers.
    pub async fn lock_user(&mut self, user_id: i64) -> Result<(), ChallengeRepoError> {
        let id: Option<i64> = sqlx::query_scalar("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE")
            .bind(user_id)
            .fetch_optional(self.db())
            .await?;
        id.map(|_| ()).ok_or(ChallengeRepoError::UserNotFound)
    }

    // ==================== Challenges ====================

    /// Inserts a challenge. `None` when the invite code is already taken, so the caller can
    /// retry with another code.
    pub async fn create_challenge(&mut self, challenge: &NewChallenge) -> Result<Option<Challenge>, sqlx::Error> {
        let sql = format!(
            "INSERT INTO challenges (creator_id, title, activity, goal_type, target_hours, start_date, end_date, \
             invite_code, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW()) \
             ON CONFLICT (invite_code) DO NOTHING RETURNING {}",
            Challenge::COLUMNS
        );
        sqlx::query_as(&sql)
            .bind(challenge.creator_id)
            .bind(&challenge.title)
            .bind(&challenge.activity)
            .bind(&challenge.goal_type)
            .bind(challenge.target_hours)
            .bind(challenge.start_date)
            .bind(challenge.end_date)
            .bind(&challenge.invite_code)
            .fetch_optional(self.db())
            .await
    }

    /// The challenge, or `None`.
    pub async fn find_by_id(&mut self, id: i64) -> Result<Option<Challenge>, sqlx::Error> {
        let sql = format!("SELECT {} FROM challenges WHERE id = $1 LIMIT 1", Challenge::COLUMNS);
        sqlx::query_as(&sql).bind(id).fetch_optional(self.db()).await
    }

    /// The challenge with the (normalised) invite code, or `None`.
    pub async fn find_by_invite_code(&mut self, code: &str) -> Result<Option<Challenge>, sqlx::Error> {
        let sql = format!("SELECT {} FROM challenges WHERE invite_code = $1 LIMIT 1", Challenge::COLUMNS);
        sqlx::query_as(&sql).bind(code).fetch_optional(self.db()).await
    }

    /// Deletes a challenge; its participants, days, cheers and invites go with it (`ON DELETE
    /// CASCADE`).
    pub async fn delete(&mut self, id: i64) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM challenges WHERE id = $1").bind(id).execute(self.db()).await?;
        Ok(())
    }

    /// Every challenge the user takes part in that has not ended (`end_date >= today`) plus the
    /// `ended_limit` most recently ended ones.
    pub async fn list_for_user(
        &mut self,
        user_id: i64,
        today: NaiveDate,
        ended_limit: i64,
    ) -> Result<Vec<UserChallengeRow>, sqlx::Error> {
        let columns = format!(
            "{}, p.joined_on, p.final_rank, p.final_days_met, p.final_total_hours::float8 AS final_total_hours, \
             p.completed, (SELECT COUNT(*) FROM challenge_participants cp WHERE cp.challenge_id = c.id) AS participant_count \
             FROM challenge_participants p JOIN challenges c ON c.id = p.challenge_id",
            Challenge::columns_with_alias("c")
        );
        let sql = format!(
            "(SELECT {columns} WHERE p.user_id = $1 AND c.end_date >= $2) \
             UNION ALL \
             (SELECT {columns} WHERE p.user_id = $3 AND c.end_date < $4 ORDER BY c.end_date DESC, c.id DESC LIMIT $5)"
        );
        sqlx::query_as(&sql)
            .bind(user_id)
            .bind(today)
            .bind(user_id)
            .bind(today)
            .bind(ended_limit)
            .fetch_all(self.db())
            .await
    }

    /// Counts the challenges the user takes part in that have not ended.
    pub async fn count_open_for_user(&mut self, user_id: i64, today: NaiveDate) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT count(*) FROM challenge_participants \
             JOIN challenges c ON c.id = challenge_participants.challenge_id \
             WHERE challenge_participants.user_id = $1 AND c.end_date >= $2",
        )
        .bind(user_id)
        .bind(today)
        .fetch_one(self.db())
        .await
    }

    /// The unfinalized challenges with days up to `through` that are not locked yet.
    pub async fn challenge_ids_to_lock(&mut self, through: NaiveDate) -> Result<Vec<i64>, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT id FROM challenges WHERE finalized_at IS NULL AND start_date <= $1 \
             AND (locked_through IS NULL OR locked_through < LEAST(end_date, $2)) ORDER BY id",
        )
        .bind(through)
        .bind(through)
        .fetch_all(self.db())
        .await
    }

    /// The challenges whose every day is locked but whose results are not stored yet.
    pub async fn challenge_ids_to_finalize(&mut self) -> Result<Vec<i64>, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT id FROM challenges \
             WHERE finalized_at IS NULL AND locked_through IS NOT NULL AND locked_through >= end_date ORDER BY id",
        )
        .fetch_all(self.db())
        .await
    }

    /// Advances the challenge's `locked_through` date (never backwards).
    pub async fn set_locked_through(
        &mut self,
        id: i64,
        through: NaiveDate,
        at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE challenges SET locked_through = $1, updated_at = $2 \
             WHERE id = $3 AND (locked_through IS NULL OR locked_through < $4)",
        )
        .bind(through)
        .bind(at)
        .bind(id)
        .bind(through)
        .execute(self.db())
        .await?;
        Ok(())
    }

    /// Sets `finalized_at` once.
    pub async fn mark_finalized(&mut self, id: i64, at: DateTime<Utc>) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE challenges SET finalized_at = $1, updated_at = $2 WHERE id = $3 AND finalized_at IS NULL")
            .bind(at)
            .bind(at)
            .bind(id)
            .execute(self.db())
            .await?;
        Ok(())
    }

    // ==================== Participants ====================

    /// Inserts a participant and returns its id.
    pub async fn add_participant(&mut self, participant: &NewChallengeParticipant) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar(
            "INSERT INTO challenge_participants (challenge_id, user_id, joined_at, joined_on) \
             VALUES ($1, $2, $3, $4) RETURNING id",
        )
        .bind(participant.challenge_id)
        .bind(participant.user_id)
        .bind(participant.joined_at)
        .bind(participant.joined_on)
        .fetch_one(self.db())
        .await
    }

    /// The user's participation in the challenge, or `None`.
    pub async fn find_participant(
        &mut self,
        challenge_id: i64,
        user_id: i64,
    ) -> Result<Option<ChallengeParticipant>, sqlx::Error> {
        let sql = format!(
            "SELECT {} FROM challenge_participants WHERE challenge_id = $1 AND user_id = $2 LIMIT 1",
            ChallengeParticipant::COLUMNS
        );
        sqlx::query_as(&sql).bind(challenge_id).bind(user_id).fetch_optional(self.db()).await
    }

    /// Counts the participants of a challenge.
    pub async fn count_participants(&mut self, challenge_id: i64) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar("SELECT count(*) FROM challenge_participants WHERE challenge_id = $1")
            .bind(challenge_id)
            .fetch_one(self.db())
            .await
    }

    /// The participants of the challenges with their user fields, by challenge and then in
    /// joining order.
    pub async fn list_participants(
        &mut self,
        challenge_ids: &[i64],
    ) -> Result<Vec<ChallengeParticipantRow>, sqlx::Error> {
        if challenge_ids.is_empty() {
            return Ok(Vec::new());
        }
        sqlx::query_as(
            "SELECT p.id, p.challenge_id, p.user_id, p.joined_at, p.joined_on, \
                 p.final_rank, p.final_days_met, p.final_total_hours::float8 AS final_total_hours, p.completed, \
                 u.username, u.profile_pic, u.profile_pic_thumb, COALESCE(u.is_verified, false) AS is_verified \
             FROM challenge_participants p \
             JOIN users u ON u.id = p.user_id \
             WHERE p.challenge_id = ANY($1) \
             ORDER BY p.challenge_id, p.joined_at, p.id",
        )
        .bind(challenge_ids)
        .fetch_all(self.db())
        .await
    }

    /// Removes a participant together with their locked days, so a later re-join starts a clean
    /// window, and with their invite to the challenge, so they can be invited again. Cheers and
    /// the invites they sent are kept. Runs in its own (sub)transaction.
    pub async fn remove_participant(&mut self, challenge_id: i64, user_id: i64) -> Result<(), sqlx::Error> {
        let mut tx = self.db().begin().await?;
        sqlx::query("DELETE FROM challenge_days WHERE challenge_id = $1 AND user_id = $2")
            .bind(challenge_id)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM challenge_invites WHERE challenge_id = $1 AND invitee_id = $2")
            .bind(challenge_id)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM challenge_participants WHERE challenge_id = $1 AND user_id = $2")
            .bind(challenge_id)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await
    }

    /// Stores the final standings in one statement.
    pub async fn save_final_results(&mut self, results: &[ChallengeFinalResult]) -> Result<(), sqlx::Error> {
        if results.is_empty() {
            return Ok(());
        }
        let values: Vec<String> = (0..results.len())
            .map(|i| {
                let n = i * 5;
                format!(
                    "(${}::bigint, ${}::integer, ${}::integer, ${}::numeric, ${}::boolean)",
                    n + 1,
                    n + 2,
                    n + 3,
                    n + 4,
                    n + 5
                )
            })
            .collect();
        let sql = format!(
            "UPDATE challenge_participants AS p \
             SET final_rank = v.final_rank, final_days_met = v.days_met, \
                 final_total_hours = v.total_hours, completed = v.completed \
             FROM (VALUES {}) AS v(id, final_rank, days_met, total_hours, completed) \
             WHERE p.id = v.id",
            values.join(", ")
        );
        let query = results.iter().fold(sqlx::query(&sql), |q, r| {
            q.bind(r.participant_id).bind(r.rank).bind(r.days_met).bind(r.total_hours).bind(r.completed)
        });
        query.execute(self.db()).await?;
        Ok(())
    }

    // ==================== Days ====================

    /// What the participants of the challenges logged on every date that is not locked yet, in
    /// one query: from the day after `locked_through` (or the start date, or the participant's
    /// joining date if later) through the earlier of the end date and `through`. Only dates
    /// with activity rows are returned; `hours` counts the challenge activity only (capped at
    /// 24) and `logged` reports whether any hours at all were logged.
    pub async fn activity_days(
        &mut self,
        challenge_ids: &[i64],
        through: NaiveDate,
    ) -> Result<Vec<ChallengeActivityDay>, sqlx::Error> {
        if challenge_ids.is_empty() {
            return Ok(Vec::new());
        }
        sqlx::query_as(
            "SELECT p.challenge_id, p.user_id, a.activity_date AS day_date, \
                 LEAST(COALESCE(SUM(a.duration_hours) FILTER (WHERE a.name = c.activity), 0), 24)::float8 AS hours, \
                 COALESCE(SUM(a.duration_hours), 0) > 0 AS logged \
             FROM challenge_participants p \
             JOIN challenges c ON c.id = p.challenge_id \
             JOIN activities a ON a.user_id = p.user_id \
                 AND a.activity_date >= GREATEST(c.start_date, p.joined_on, COALESCE(c.locked_through + 1, c.start_date)) \
                 AND a.activity_date <= LEAST(c.end_date, $1) \
             WHERE p.challenge_id = ANY($2) \
             GROUP BY p.challenge_id, p.user_id, a.activity_date \
             ORDER BY p.challenge_id, p.user_id, a.activity_date",
        )
        .bind(through)
        .bind(challenge_ids)
        .fetch_all(self.db())
        .await
    }

    /// Stores locked days, skipping (participant, date) pairs that are already stored, and
    /// returns the number of new rows. Batches of 500 rows; several batches run in one
    /// (sub)transaction.
    pub async fn insert_days(&mut self, days: &[NewChallengeDay]) -> Result<u64, sqlx::Error> {
        if days.len() <= INSERT_DAYS_BATCH {
            return insert_day_batch(self.db(), days).await;
        }
        let mut tx = self.db().begin().await?;
        let mut inserted = 0;
        for batch in days.chunks(INSERT_DAYS_BATCH) {
            inserted += insert_day_batch(&mut tx, batch).await?;
        }
        tx.commit().await?;
        Ok(inserted)
    }

    /// The locked days of every participant of a challenge.
    pub async fn list_days(&mut self, challenge_id: i64) -> Result<Vec<ChallengeDay>, sqlx::Error> {
        let sql = format!(
            "SELECT {} FROM challenge_days WHERE challenge_id = $1 ORDER BY user_id, day_date",
            ChallengeDay::COLUMNS
        );
        sqlx::query_as(&sql).bind(challenge_id).fetch_all(self.db()).await
    }

    /// One user's locked days in the challenges.
    pub async fn list_user_days(
        &mut self,
        user_id: i64,
        challenge_ids: &[i64],
    ) -> Result<Vec<ChallengeDay>, sqlx::Error> {
        if challenge_ids.is_empty() {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT {} FROM challenge_days WHERE user_id = $1 AND challenge_id = ANY($2) ORDER BY challenge_id, day_date",
            ChallengeDay::COLUMNS
        );
        sqlx::query_as(&sql).bind(user_id).bind(challenge_ids).fetch_all(self.db()).await
    }

    /// Sums the locked days of the current participants of the challenges: days met and hours,
    /// counting only dates inside each participant's window and up to `locked_through`.
    pub async fn locked_totals(&mut self, challenge_ids: &[i64]) -> Result<Vec<ChallengeLockedTotal>, sqlx::Error> {
        if challenge_ids.is_empty() {
            return Ok(Vec::new());
        }
        sqlx::query_as(
            "SELECT d.challenge_id, d.user_id, \
                 COUNT(*) FILTER (WHERE d.met) AS days_met, \
                 COALESCE(SUM(d.hours), 0)::float8 AS total_hours \
             FROM challenge_days d \
             JOIN challenge_participants p ON p.challenge_id = d.challenge_id AND p.user_id = d.user_id \
             JOIN challenges c ON c.id = d.challenge_id \
             WHERE d.challenge_id = ANY($1) \
                 AND d.day_date >= GREATEST(c.start_date, p.joined_on) \
                 AND d.day_date <= c.locked_through \
             GROUP BY d.challenge_id, d.user_id \
             ORDER BY d.challenge_id, d.user_id",
        )
        .bind(challenge_ids)
        .fetch_all(self.db())
        .await
    }

    // ==================== Cheers ====================

    /// Stores a cheer unless the same one was already given that day; `true` when it is new.
    pub async fn create_cheer(&mut self, cheer: &NewChallengeCheer) -> Result<bool, sqlx::Error> {
        let result = sqlx::query(
            "INSERT INTO challenge_cheers (challenge_id, from_user_id, to_user_id, cheer_date, created_at) \
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
        )
        .bind(cheer.challenge_id)
        .bind(cheer.from_user_id)
        .bind(cheer.to_user_id)
        .bind(cheer.cheer_date)
        .bind(cheer.created_at)
        .execute(self.db())
        .await?;
        Ok(result.rows_affected() == 1)
    }

    /// The participants `from_user_id` cheered in the challenge on `date`.
    pub async fn cheered_user_ids(
        &mut self,
        challenge_id: i64,
        from_user_id: i64,
        date: NaiveDate,
    ) -> Result<Vec<i64>, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT to_user_id FROM challenge_cheers \
             WHERE challenge_id = $1 AND from_user_id = $2 AND cheer_date = $3 ORDER BY to_user_id",
        )
        .bind(challenge_id)
        .bind(from_user_id)
        .bind(date)
        .fetch_all(self.db())
        .await
    }

    // ==================== Invites ====================

    /// Invites, in one statement, every user in `user_ids` who exists, is not the inviter, is
    /// not a participant, has an ACTIVE follow relationship with the inviter in either direction
    /// and has no invite to the challenge yet (from anyone; leaving a challenge removes the
    /// leaver's invite). Returns the new invites ordered by invitee id.
    pub async fn create_invites(
        &mut self,
        challenge_id: i64,
        inviter_id: i64,
        user_ids: &[i64],
        at: DateTime<Utc>,
    ) -> Result<Vec<ChallengeInvite>, sqlx::Error> {
        if user_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut invites: Vec<ChallengeInvite> = sqlx::query_as(
            "INSERT INTO challenge_invites (challenge_id, inviter_id, invitee_id, created_at) \
             SELECT $1, $2, u.id, $3 \
             FROM users u \
             WHERE u.id = ANY($4) \
                 AND u.id <> $5 \
                 AND NOT EXISTS (SELECT 1 FROM challenge_participants p WHERE p.challenge_id = $6 AND p.user_id = u.id) \
                 AND (EXISTS (SELECT 1 FROM follow_edges_by_follower f \
                         WHERE f.follower_id = $7 AND f.followee_id = u.id AND f.state = $8) \
                     OR EXISTS (SELECT 1 FROM follow_edges_by_followee f \
                         WHERE f.followee_id = $9 AND f.follower_id = u.id AND f.state = $10)) \
             ORDER BY u.id \
             ON CONFLICT (challenge_id, invitee_id) DO NOTHING \
             RETURNING id, challenge_id, inviter_id, invitee_id, created_at",
        )
        .bind(challenge_id)
        .bind(inviter_id)
        .bind(at)
        .bind(user_ids)
        .bind(inviter_id)
        .bind(challenge_id)
        .bind(inviter_id)
        .bind(FOLLOW_STATE_ACTIVE)
        .bind(inviter_id)
        .bind(FOLLOW_STATE_ACTIVE)
        .fetch_all(self.db())
        .await?;
        invites.sort_by_key(|invite| invite.invitee_id);
        Ok(invites)
    }

    /// Deletes invites that were used to join a challenge the invitee has left since. Leaving
    /// used to keep the invite, which blocked inviting that person to the challenge again
    /// (`remove_participant` now deletes it). A join is recognised by the creator's "joined"
    /// notification record, which is created right after the join and never deleted. Invites
    /// newer than that record were sent after a later leave and are open, so they stay, and
    /// running this again deletes nothing new. Returns the number of invites deleted.
    pub async fn delete_stale_invites(&mut self) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            "DELETE FROM challenge_invites i \
             USING challenges c \
             WHERE c.id = i.challenge_id \
                 AND NOT EXISTS (SELECT 1 FROM challenge_participants p \
                     WHERE p.challenge_id = i.challenge_id AND p.user_id = i.invitee_id) \
                 AND EXISTS (SELECT 1 FROM notification_dedupes d \
                     WHERE d.user_id = c.creator_id \
                         AND d.actor_id = i.invitee_id \
                         AND d.type = $1 \
                         AND d.entity_type = $2 \
                         AND d.entity_key = i.challenge_id::text \
                         AND d.created_at >= i.created_at)",
        )
        .bind(NOTIF_TYPE_CHALLENGE_JOINED)
        .bind(NOTIF_ENTITY_CHALLENGE)
        .execute(self.db())
        .await?;
        Ok(result.rows_affected())
    }

    /// The users the viewer follows or who follow the viewer (ACTIVE edges), excluding the
    /// viewer and the challenge's participants, whose username starts with `prefix`
    /// (case-insensitive; LIKE wildcards in `prefix` match literally), ordered by username.
    pub async fn invite_candidates(
        &mut self,
        challenge_id: i64,
        viewer_id: i64,
        prefix: &str,
        limit: i64,
    ) -> Result<Vec<InviteCandidateRow>, sqlx::Error> {
        sqlx::query_as(
            r"SELECT u.id, u.username, u.profile_pic, u.profile_pic_thumb, COALESCE(u.is_verified, false) AS is_verified,
                EXISTS (SELECT 1 FROM challenge_invites i WHERE i.challenge_id = $1 AND i.invitee_id = u.id) AS invited
            FROM users u
            WHERE u.id IN (
                    SELECT f.followee_id FROM follow_edges_by_follower f WHERE f.follower_id = $2 AND f.state = $3
                    UNION
                    SELECT f.follower_id FROM follow_edges_by_followee f WHERE f.followee_id = $4 AND f.state = $5
                )
                AND u.id <> $6
                AND NOT EXISTS (SELECT 1 FROM challenge_participants p WHERE p.challenge_id = $7 AND p.user_id = u.id)
                AND lower(u.username) LIKE $8 ESCAPE '\'
            ORDER BY u.username, u.id
            LIMIT $9",
        )
        .bind(challenge_id)
        .bind(viewer_id)
        .bind(FOLLOW_STATE_ACTIVE)
        .bind(viewer_id)
        .bind(FOLLOW_STATE_ACTIVE)
        .bind(viewer_id)
        .bind(challenge_id)
        .bind(like_prefix_pattern(prefix))
        .bind(limit)
        .fetch_all(self.db())
        .await
    }
}

async fn insert_day_batch(conn: &mut PgConnection, days: &[NewChallengeDay]) -> Result<u64, sqlx::Error> {
    if days.is_empty() {
        return Ok(0);
    }
    let mut query: QueryBuilder<'_, Postgres> = QueryBuilder::new(
        "INSERT INTO challenge_days (challenge_id, user_id, day_date, hours, logged, met, locked_at) ",
    );
    query.push_values(days, |mut row, d| {
        row.push_bind(d.challenge_id)
            .push_bind(d.user_id)
            .push_bind(d.day_date)
            .push_bind(d.hours)
            .push_bind(d.logged)
            .push_bind(d.met)
            .push_bind(d.locked_at);
    });
    query.push(" ON CONFLICT (challenge_id, user_id, day_date) DO NOTHING");
    Ok(query.build().execute(conn).await?.rows_affected())
}

/// `lower(prefix)` with the LIKE wildcards (and the escape character) escaped, plus `%`.
fn like_prefix_pattern(prefix: &str) -> String {
    let lowered = gostr::to_lower(prefix);
    let mut pattern = String::with_capacity(lowered.len() + 1);
    for ch in lowered.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(ch);
    }
    pattern.push('%');
    pattern
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_patterns_escape_wildcards() {
        assert_eq!(like_prefix_pattern(""), "%");
        assert_eq!(like_prefix_pattern("AN"), "an%");
        assert_eq!(like_prefix_pattern("z_"), r"z\_%");
        assert_eq!(like_prefix_pattern("z%"), r"z\%%");
        assert_eq!(like_prefix_pattern(r"z\"), r"z\\%");
    }
}
