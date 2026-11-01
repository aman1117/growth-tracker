use std::collections::BTreeMap;
use std::sync::LazyLock;

use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::gojson;

/// A user's dashboard tile configuration (`tile_configs`).
#[derive(Debug, Clone, PartialEq, Serialize, sqlx::FromRow)]
pub struct TileConfig {
    pub id: i64,
    pub user_id: i64,
    /// Free-form JSON object (Go `JSONB` map; `null` when unset).
    pub config: Option<Value>,
    #[serde(with = "gojson::time")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "gojson::time")]
    pub updated_at: DateTime<Utc>,
}

impl TileConfig {
    pub const COLUMNS: &'static str = "id, user_id, config, created_at, updated_at";

    /// Parses the JSON config into its structured form (Go `GetConfigData`).
    pub fn config_data(&self) -> Result<TileConfigData, serde_json::Error> {
        match &self.config {
            None | Some(Value::Null) => Ok(TileConfigData::default()),
            Some(v) => serde_json::from_value(v.clone()),
        }
    }

    /// Stores `data` as the JSON config (Go `SetConfigData`).
    pub fn set_config_data(&mut self, data: &TileConfigData) -> Result<(), serde_json::Error> {
        self.config = Some(serde_json::to_value(data)?);
        Ok(())
    }
}

/// A user-defined custom tile.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CustomTile {
    /// UUID v4.
    pub id: String,
    /// Display name (max 20 characters).
    pub name: String,
    /// Lucide icon name.
    pub icon: String,
    /// Hex color.
    pub color: String,
}

fn is_none_or_empty_vec<T>(v: &Option<Vec<T>>) -> bool {
    v.as_ref().is_none_or(Vec::is_empty)
}

fn is_none_or_empty_map<K, V>(v: &Option<BTreeMap<K, V>>) -> bool {
    v.as_ref().is_none_or(BTreeMap::is_empty)
}

/// Structured tile configuration. `None` fields marshal as `null` (Go nil slices/maps);
/// `omitempty` fields are omitted when `None` or empty.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TileConfigData {
    pub order: Option<Vec<String>>,
    pub sizes: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "is_none_or_empty_vec")]
    pub hidden: Option<Vec<String>>,
    #[serde(skip_serializing_if = "is_none_or_empty_map")]
    pub colors: Option<BTreeMap<String, String>>,
    #[serde(rename = "customTiles", skip_serializing_if = "is_none_or_empty_vec")]
    pub custom_tiles: Option<Vec<CustomTile>>,
}

static HEX_COLOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$").expect("valid regex"));
static UUID_FORMAT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$").expect("valid regex")
});

/// `#RGB`, `#RRGGBB` or `#RRGGBBAA`.
pub fn validate_color(color: &str) -> bool {
    !color.is_empty() && HEX_COLOR.is_match(color)
}

impl CustomTile {
    /// Go `CustomTile.Validate`; the error strings are returned to clients.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.id.is_empty() {
            return Err("custom tile ID is required");
        }
        if !UUID_FORMAT.is_match(&self.id) {
            return Err("custom tile ID must be a valid UUID");
        }
        if self.name.is_empty() {
            return Err("custom tile name is required");
        }
        if self.name.chars().count() > 20 {
            return Err("custom tile name cannot exceed 20 characters");
        }
        if self.icon.is_empty() {
            return Err("custom tile icon is required");
        }
        if !validate_color(&self.color) {
            return Err("custom tile color must be a valid hex color");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_data_marshals_like_go() {
        let data = TileConfigData { order: Some(vec!["study".into()]), hidden: Some(vec![]), ..Default::default() };
        assert_eq!(gojson::to_string(&data).unwrap(), r#"{"order":["study"],"sizes":null}"#);
    }

    #[test]
    fn custom_tile_validation() {
        let mut t = CustomTile {
            id: "123e4567-e89b-12d3-a456-426614174000".into(),
            name: "Guitar".into(),
            icon: "Music".into(),
            color: "#fff".into(),
        };
        assert!(t.validate().is_ok());
        t.color = "red".into();
        assert_eq!(t.validate().unwrap_err(), "custom tile color must be a valid hex color");
    }
}
