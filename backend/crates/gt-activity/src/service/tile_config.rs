//! `TileConfigService` (port of the tile config part of `internal/services/services.go`).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use gt_core::constants as c;
use gt_core::models::{validate_color, CustomTile, TileConfig, TileConfigData};
use gt_users::UserRepository;
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

use crate::repository::{ActivityPhotoLabels, TileConfigRepository};

/// A configuration rejected by [`TileConfigService::validate_config`]; message and code are
/// returned to the client.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct TileConfigValidationError {
    pub message: String,
    pub code: &'static str,
}

impl TileConfigValidationError {
    fn new(message: impl Into<String>, code: &'static str) -> Self {
        Self { message: message.into(), code }
    }
}

/// Errors of the tile configuration service.
#[derive(Debug, thiserror::Error)]
pub enum TileConfigError {
    #[error(transparent)]
    Validation(#[from] TileConfigValidationError),
    /// The username lookup failed or found nobody.
    #[error("user not found")]
    UserNotFound,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

// ==================== Go-compatible decoding of TileConfigData ====================

/// `TileConfigData` as Go's `json.Unmarshal` reads it: `null` values (fields, list elements,
/// map values, custom tiles and their fields) keep their zero value instead of failing.
#[derive(Default, Deserialize)]
#[serde(default)]
struct RawConfigData {
    #[serde(deserialize_with = "string_list")]
    order: Option<Vec<String>>,
    #[serde(deserialize_with = "string_map")]
    sizes: Option<BTreeMap<String, String>>,
    #[serde(deserialize_with = "string_list")]
    hidden: Option<Vec<String>>,
    #[serde(deserialize_with = "string_map")]
    colors: Option<BTreeMap<String, String>>,
    #[serde(rename = "customTiles", deserialize_with = "custom_tiles")]
    custom_tiles: Option<Vec<CustomTile>>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct RawCustomTile {
    #[serde(deserialize_with = "null_string")]
    id: String,
    #[serde(deserialize_with = "null_string")]
    name: String,
    #[serde(deserialize_with = "null_string")]
    icon: String,
    #[serde(deserialize_with = "null_string")]
    color: String,
}

fn null_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}

fn string_list<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<String>>, D::Error> {
    let list = Option::<Vec<Option<String>>>::deserialize(d)?;
    Ok(list.map(|items| items.into_iter().map(Option::unwrap_or_default).collect()))
}

fn string_map<'de, D: Deserializer<'de>>(d: D) -> Result<Option<BTreeMap<String, String>>, D::Error> {
    let map = Option::<BTreeMap<String, Option<String>>>::deserialize(d)?;
    Ok(map.map(|entries| entries.into_iter().map(|(k, v)| (k, v.unwrap_or_default())).collect()))
}

fn custom_tiles<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<CustomTile>>, D::Error> {
    let tiles = Option::<Vec<Option<RawCustomTile>>>::deserialize(d)?;
    Ok(tiles.map(|items| {
        items
            .into_iter()
            .map(|tile| {
                let tile = tile.unwrap_or_default();
                CustomTile { id: tile.id, name: tile.name, icon: tile.icon, color: tile.color }
            })
            .collect()
    }))
}

/// Parses a `models.JSONB` configuration into its structured form like Go's
/// `TileConfig.GetConfigData` (`None` or JSON `null` yields an empty configuration).
pub fn parse_config_data(config: Option<&Value>) -> Result<TileConfigData, serde_json::Error> {
    let raw = match config {
        None | Some(Value::Null) => RawConfigData::default(),
        Some(value) => RawConfigData::deserialize(value)?,
    };
    Ok(TileConfigData {
        order: raw.order,
        sizes: raw.sizes,
        hidden: raw.hidden,
        colors: raw.colors,
        custom_tiles: raw.custom_tiles,
    })
}

// ==================== Service ====================

/// Dashboard tile configuration: validation, storage and photo relabeling.
#[derive(Debug, Clone)]
pub struct TileConfigService {
    tile_repo: Arc<TileConfigRepository>,
    user_repo: Arc<UserRepository>,
    /// `None` skips relabeling photos of renamed custom tiles (Go: a nil photo repository).
    photo_labels: Option<Arc<ActivityPhotoLabels>>,
}

impl TileConfigService {
    /// Go `NewTileConfigService`.
    pub fn new(
        tile_repo: Arc<TileConfigRepository>,
        user_repo: Arc<UserRepository>,
        photo_labels: Option<Arc<ActivityPhotoLabels>>,
    ) -> Self {
        Self { tile_repo, user_repo, photo_labels }
    }

    /// The user's configuration, or `None`.
    pub async fn get_config(&self, user_id: i64) -> Result<Option<TileConfig>, sqlx::Error> {
        self.tile_repo.find_by_user_id(user_id).await
    }

    /// The configuration of `username`; [`TileConfigError::UserNotFound`] when the user lookup
    /// fails or finds nobody.
    pub async fn get_config_by_username(&self, username: &str) -> Result<Option<TileConfig>, TileConfigError> {
        let Ok(Some(user)) = self.user_repo.find_by_username(username).await else {
            return Err(TileConfigError::UserNotFound);
        };
        Ok(self.tile_repo.find_by_user_id(user.id).await?)
    }

    /// Checks the structure, at most 5 valid custom tiles with unique ids, and the color
    /// overrides (Go `ValidateConfig`).
    pub fn validate_config(&self, config: Option<&Map<String, Value>>) -> Result<(), TileConfigValidationError> {
        validate_config(config)
    }

    /// Validates and stores the configuration. Photos of custom tiles whose name changed are
    /// relabeled first; a relabeling failure aborts the save.
    pub async fn save_config(&self, user_id: i64, config: Option<Map<String, Value>>) -> Result<(), TileConfigError> {
        validate_config(config.as_ref())?;
        self.relabel_renamed_tiles(user_id, config.as_ref()).await?;
        self.tile_repo.save(user_id, config.as_ref()).await?;
        Ok(())
    }

    /// Cascades renamed custom tile labels to activity photos. Problems reading the stored or
    /// new configuration skip the cascade, as in Go.
    async fn relabel_renamed_tiles(
        &self,
        user_id: i64,
        config: Option<&Map<String, Value>>,
    ) -> Result<(), sqlx::Error> {
        let Ok(Some(existing)) = self.tile_repo.find_by_user_id(user_id).await else {
            return Ok(());
        };
        let Ok(existing_data) = parse_config_data(existing.config.as_ref()) else {
            return Ok(());
        };
        let new_value = config.map(|map| Value::Object(map.clone()));
        let Ok(new_data) = parse_config_data(new_value.as_ref()) else {
            return Ok(());
        };

        let existing_names: HashMap<&str, &str> =
            existing_data.custom_tiles.iter().flatten().map(|tile| (tile.id.as_str(), tile.name.as_str())).collect();
        for tile in new_data.custom_tiles.iter().flatten() {
            let renamed = existing_names.get(tile.id.as_str()).is_some_and(|old| *old != tile.name);
            if let (true, Some(photo_labels)) = (renamed, &self.photo_labels) {
                let activity_name = format!("{}{}", c::CUSTOM_TILE_PREFIX, tile.id);
                photo_labels.update_label_by_activity_name(user_id, &activity_name, &tile.name).await?;
            }
        }
        Ok(())
    }
}

/// Go `TileConfigService.ValidateConfig` (it does not use the service's state).
pub fn validate_config(config: Option<&Map<String, Value>>) -> Result<(), TileConfigValidationError> {
    let value = config.map(|map| Value::Object(map.clone()));
    let data = parse_config_data(value.as_ref())
        .map_err(|_| TileConfigValidationError::new("Invalid configuration format", c::ERR_CODE_INVALID_TILE_CONFIG))?;

    let tiles = data.custom_tiles.unwrap_or_default();
    if tiles.len() > c::MAX_CUSTOM_TILES {
        return Err(TileConfigValidationError::new(
            "Maximum of 5 custom tiles allowed",
            c::ERR_CODE_TILE_LIMIT_EXCEEDED,
        ));
    }
    let mut ids = HashSet::new();
    for tile in &tiles {
        tile.validate().map_err(|message| TileConfigValidationError::new(message, c::ERR_CODE_INVALID_TILE_CONFIG))?;
        if !ids.insert(tile.id.as_str()) {
            return Err(TileConfigValidationError::new(
                "Duplicate custom tile ID found",
                c::ERR_CODE_INVALID_TILE_CONFIG,
            ));
        }
    }

    // Go walked a map (random order); with several invalid colors any of them may be reported.
    for color in data.colors.iter().flat_map(BTreeMap::values) {
        if !validate_color(color) {
            return Err(TileConfigValidationError::new(
                format!("Invalid color format: {color}"),
                c::ERR_CODE_INVALID_COLOR,
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TILE_A: &str = "8a0d6c2e-1f3b-4c5d-9e7f-0a1b2c3d4e5f";
    const TILE_B: &str = "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b";

    fn tile(id: &str, name: &str) -> Value {
        json!({"id": id, "name": name, "icon": "Music", "color": "#22c55e"})
    }

    fn code(config: Value) -> Option<&'static str> {
        let map = match config {
            Value::Object(map) => Some(map),
            _ => None,
        };
        validate_config(map.as_ref()).err().map(|e| e.code)
    }

    #[test]
    fn validates_like_go() {
        let six: Vec<Value> = (0..6).map(|i| tile(&format!("00000000-0000-4000-8000-00000000000{i}"), "t")).collect();
        assert_eq!(
            code(
                json!({"order": ["study"], "colors": {"study": "#abc"}, "customTiles": [tile(TILE_A, "Guitar"), tile(TILE_B, "Chess")]})
            ),
            None
        );
        assert_eq!(code(Value::Null), None);
        assert_eq!(code(json!({"order": "study"})), Some("INVALID_TILE_CONFIG"));
        assert_eq!(code(json!({"customTiles": six})), Some("TILE_LIMIT_EXCEEDED"));
        assert_eq!(code(json!({"customTiles": [tile("not-a-uuid", "x")]})), Some("INVALID_TILE_CONFIG"));
        assert_eq!(code(json!({"customTiles": [tile(TILE_A, "a"), tile(TILE_A, "b")]})), Some("INVALID_TILE_CONFIG"));
        assert_eq!(code(json!({"colors": {"study": "red"}})), Some("INVALID_COLOR"));
        let err = validate_config(json!({"colors": {"study": "red"}}).as_object()).unwrap_err();
        assert_eq!(err.to_string(), "Invalid color format: red");
    }

    #[test]
    fn nulls_keep_zero_values_like_go() {
        let data = parse_config_data(Some(&json!({
            "order": ["a", null], "sizes": {"a": null}, "hidden": null, "customTiles": [null, {"id": null, "name": "x"}]
        })))
        .unwrap();
        assert_eq!(data.order, Some(vec!["a".to_string(), String::new()]));
        assert_eq!(data.sizes.unwrap()["a"], "");
        assert_eq!(data.hidden, None);
        let tiles = data.custom_tiles.unwrap();
        assert_eq!(tiles[0], CustomTile::default());
        assert_eq!(tiles[1].name, "x");
        let err = validate_config(json!({"customTiles": [null]}).as_object()).unwrap_err();
        assert_eq!(err.message, "custom tile ID is required");
        assert!(parse_config_data(Some(&json!({"customTiles": [1]}))).is_err());
        assert!(parse_config_data(Some(&json!({"sizes": []}))).is_err());
    }
}
