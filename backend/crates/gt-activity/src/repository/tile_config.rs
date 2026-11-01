//! `TileConfigRepository` (port of the tile config part of `internal/repository/repository.go`).

use gt_core::gojson;
use gt_core::models::TileConfig;
use serde_json::{Map, Value};
use sqlx::PgPool;

/// Handles tile configuration data operations.
#[derive(Debug, Clone)]
pub struct TileConfigRepository {
    pool: PgPool,
}

/// Go's `models.JSONB` (a map) could only scan JSON objects and `null`; anything else stored in
/// the column made the lookup fail.
fn check_scannable(config: &TileConfig) -> Result<(), sqlx::Error> {
    match &config.config {
        None | Some(Value::Null) | Some(Value::Object(_)) => Ok(()),
        Some(_) => Err(sqlx::Error::Decode("tile config is not a JSON object".into())),
    }
}

/// The JSON text Go's `JSONB.Value` stored (`json.Marshal`: sorted keys, Go escaping and number
/// formatting); `None` stores SQL `NULL`.
fn config_json(config: Option<&Map<String, Value>>) -> Result<Option<String>, sqlx::Error> {
    config.map(|map| gojson::to_string(map).map_err(|e| sqlx::Error::Encode(Box::new(e)))).transpose()
}

impl TileConfigRepository {
    /// A repository over `pool`.
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// The user's configuration, or `None` (GORM `First`).
    pub async fn find_by_user_id(&self, user_id: i64) -> Result<Option<TileConfig>, sqlx::Error> {
        let sql = format!("SELECT {} FROM tile_configs WHERE user_id = $1 ORDER BY id LIMIT 1", TileConfig::COLUMNS);
        let config = sqlx::query_as::<_, TileConfig>(&sql).bind(user_id).fetch_optional(&self.pool).await?;
        if let Some(config) = &config {
            check_scannable(config)?;
        }
        Ok(config)
    }

    /// Creates or replaces the user's configuration. As in Go, any failure to load the existing
    /// row (not only "not found") leads to an insert.
    pub async fn save(&self, user_id: i64, config: Option<&Map<String, Value>>) -> Result<(), sqlx::Error> {
        let json = config_json(config)?;
        let Ok(Some(existing)) = self.find_by_user_id(user_id).await else {
            return sqlx::query(
                "INSERT INTO tile_configs (user_id, config, created_at, updated_at) VALUES ($1, $2::jsonb, NOW(), NOW())",
            )
            .bind(user_id)
            .bind(json)
            .execute(&self.pool)
            .await
            .map(|_| ());
        };
        // GORM `Save`: every column by primary key (re-inserted if the row vanished meanwhile).
        sqlx::query(
            "INSERT INTO tile_configs (id, user_id, config, created_at, updated_at) VALUES ($1, $2, $3::jsonb, $4, NOW()) \
             ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, config = EXCLUDED.config, \
             created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at",
        )
        .bind(existing.id)
        .bind(existing.user_id)
        .bind(json)
        .bind(existing.created_at)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }
}
