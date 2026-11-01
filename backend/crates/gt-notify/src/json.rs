//! JSON helpers reproducing `encoding/json` decoding quirks the Go code relied on.

use serde::{Deserialize, Deserializer};

/// Deserializes `null` as the type's zero value, like Go's `json.Unmarshal`, which leaves a
/// field untouched when it receives `null`. Use with `#[serde(default, deserialize_with = ...)]`.
pub fn null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Option::unwrap_or_default)
}

/// Re-encodes a JSON document the way Go's `json.Marshal` emits a `json.RawMessage`: the
/// document is validated, whitespace outside strings is removed and `<`, `>`, `&`, U+2028 and
/// U+2029 inside strings are escaped. Returns `None` for invalid JSON (Go's marshal error).
pub fn go_compact(raw: &str) -> Option<String> {
    serde_json::from_str::<serde::de::IgnoredAny>(raw).ok()?;
    let mut out = String::with_capacity(raw.len());
    let mut in_string = false;
    let mut escaped = false;
    for ch in raw.chars() {
        if in_string {
            match ch {
                _ if escaped => {
                    escaped = false;
                    out.push(ch);
                }
                '\\' => {
                    escaped = true;
                    out.push(ch);
                }
                '"' => {
                    in_string = false;
                    out.push(ch);
                }
                '<' => out.push_str("\\u003c"),
                '>' => out.push_str("\\u003e"),
                '&' => out.push_str("\\u0026"),
                '\u{2028}' => out.push_str("\\u2028"),
                '\u{2029}' => out.push_str("\\u2029"),
                _ => out.push(ch),
            }
        } else if ch == '"' {
            in_string = true;
            out.push(ch);
        } else if !matches!(ch, ' ' | '\t' | '\n' | '\r') {
            out.push(ch);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compacts_like_go_raw_message() {
        assert_eq!(
            go_compact(r#" { "a" : [1, 2] , "b":"x y<&>" } "#).unwrap(),
            r#"{"a":[1,2],"b":"x y\u003c\u0026\u003e"}"#
        );
        assert_eq!(go_compact(r#"{"q":"say \"hi\" \\"}"#).unwrap(), r#"{"q":"say \"hi\" \\"}"#);
        assert!(go_compact("not json").is_none());
        assert!(go_compact("").is_none());
    }

    #[test]
    fn null_is_the_zero_value() {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct S {
            #[serde(deserialize_with = "null_default")]
            name: String,
        }
        let s: S = serde_json::from_str(r#"{"name":null}"#).unwrap();
        assert_eq!(s.name, "");
    }
}
