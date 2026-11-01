//! Go string semantics that the challenge code relies on.

/// Go's `strings.ToUpper`: per-character *simple* case mapping. Characters whose full mapping
/// expands to several characters (`ß` -> `SS`) have no simple mapping and stay unchanged.
pub fn to_upper(s: &str) -> String {
    s.chars()
        .map(|ch| {
            let mut upper = ch.to_uppercase();
            match (upper.next(), upper.next()) {
                (Some(single), None) => single,
                _ => ch,
            }
        })
        .collect()
}

/// Go's `strings.ToLower`: per-character simple case mapping (`İ` -> `i`, `Σ` -> `σ` even at the
/// end of a word).
pub fn to_lower(s: &str) -> String {
    s.chars().map(|ch| ch.to_lowercase().next().unwrap_or(ch)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_case_mapping() {
        assert_eq!(to_upper("straße k7q"), "STRAßE K7Q");
        assert_eq!(to_upper("ſ"), "S");
        assert_eq!(to_lower("İSTANBUL"), "istanbul");
        assert_eq!(to_lower("ΑΣ"), "ασ");
    }
}
