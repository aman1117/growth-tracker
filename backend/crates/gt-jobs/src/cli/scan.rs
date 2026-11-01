//! Interactive input with Go `fmt.Scan` semantics: whitespace-separated tokens (newlines count
//! as space) and Go's integer syntax for `uint` targets.

use std::io::BufRead;

/// Reads the next whitespace-separated token from `input`; empty at end of input (Go leaves the
/// target unchanged, which for the prompts means "no").
pub fn read_token(input: &mut impl BufRead) -> String {
    let mut token = Vec::new();
    loop {
        let (consumed, done) = {
            let Ok(buf) = input.fill_buf() else { break };
            if buf.is_empty() {
                break;
            }
            let mut consumed = 0;
            let mut done = false;
            for &byte in buf {
                consumed += 1;
                if byte.is_ascii_whitespace() {
                    if !token.is_empty() {
                        done = true;
                        break;
                    }
                } else {
                    token.push(byte);
                }
            }
            (consumed, done)
        };
        input.consume(consumed);
        if done {
            break;
        }
    }
    String::from_utf8_lossy(&token).into_owned()
}

/// The value `fmt.Scan` stores in a `uint` for `token`, or `None` when it reports an error (the
/// target then keeps its zero value). Like Go it accepts the `0b`/`0o`/`0x` prefixes, a leading
/// `0` for octal and `_` separators, and stops at the first character that is not a digit
/// (`12abc` scans as 12).
pub fn parse_scanned_uint(token: &str) -> Option<u64> {
    let bytes = token.as_bytes();
    // fmt's scanBasePrefix: the prefix is consumed and decides which digits are accepted.
    let (radix, prefix_len, zero_found) = if bytes.first() == Some(&b'0') {
        match bytes.get(1).map(u8::to_ascii_lowercase) {
            Some(b'b') => (2, 2, true),
            Some(b'o') => (8, 2, true),
            Some(b'x') => (16, 2, true),
            _ => (8, 1, true),
        }
    } else {
        (10, 0, false)
    };
    let digits = bytes[prefix_len..].iter().take_while(|&&b| b == b'_' || char::from(b).is_digit(radix)).count();
    if digits == 0 && !zero_found {
        return None; // "expected integer"
    }
    parse_uint_base0(&token[..prefix_len + digits])
}

/// Go `strconv.ParseUint(s, 0, 64)`.
fn parse_uint_base0(s: &str) -> Option<u64> {
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    let (radix, digits) = if bytes[0] == b'0' {
        match (bytes.len() >= 3).then(|| bytes[1].to_ascii_lowercase()) {
            Some(b'b') => (2, &s[2..]),
            Some(b'o') => (8, &s[2..]),
            Some(b'x') => (16, &s[2..]),
            _ => (8, &s[1..]),
        }
    } else {
        (10, s)
    };
    if !underscores_ok(s) {
        return None;
    }
    digits.chars().filter(|&c| c != '_').try_fold(0_u64, |n, c| {
        let digit = c.to_digit(radix)?;
        n.checked_mul(u64::from(radix))?.checked_add(u64::from(digit))
    })
}

/// Go `strconv.underscoreOK`: underscores only between digits (a base prefix counts as a digit).
fn underscores_ok(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    let mut saw = b'^';
    let mut hex = false;
    if bytes.len() >= 2 && bytes[0] == b'0' && matches!(bytes[1].to_ascii_lowercase(), b'b' | b'o' | b'x') {
        i = 2;
        saw = b'0';
        hex = bytes[1].eq_ignore_ascii_case(&b'x');
    }
    for &b in &bytes[i..] {
        if b.is_ascii_digit() || (hex && b.is_ascii_hexdigit()) {
            saw = b'0';
        } else if b == b'_' {
            if saw != b'0' {
                return false;
            }
            saw = b'_';
        } else {
            if saw == b'_' {
                return false;
            }
            saw = b'!';
        }
    }
    saw != b'_'
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn tokens_are_whitespace_separated() {
        let mut input = Cursor::new("  \n 42 y\nrest");
        assert_eq!(read_token(&mut input), "42");
        assert_eq!(read_token(&mut input), "y");
        assert_eq!(read_token(&mut input), "rest");
        assert_eq!(read_token(&mut input), "");
        assert_eq!(read_token(&mut Cursor::new("Y\r\n")), "Y");
    }

    #[test]
    fn uints_scan_like_go() {
        for (token, want) in [
            ("5", Some(5)),
            ("0", Some(0)),
            ("12abc", Some(12)),
            ("0x1F", Some(31)),
            ("010", Some(8)),
            ("08", Some(0)),
            ("0b101", Some(5)),
            ("1_000", Some(1000)),
            ("18446744073709551615", Some(u64::MAX)),
            ("abc", None),
            ("-5", None),
            ("", None),
            ("0x", None),
            ("1__0", None),
            ("1_", None),
            ("18446744073709551616", None),
        ] {
            assert_eq!(parse_scanned_uint(token), want, "{token:?}");
        }
    }
}
