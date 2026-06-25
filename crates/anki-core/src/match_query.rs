//! Parser for the `MATCH` semantic-query DSL (see `docs/match-dsl.md`).
//!
//! Grammar (regex-inspired suffix):
//! ```text
//! match     := query [ "/" directive ]
//! query     := '"' ...literal... '"'  | bare-text
//! directive := mode [ ":" candidates ]    mode := "hnsw" | "exact"
//! ```
//! A bare trailing `/directive` is recognized only if it's a valid directive
//! (keyword-gated), so slashy queries like `TCP/IP` stay literal. Quote the
//! query to force any string literal.

/// Search strategy selected by the MATCH string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Approximate nearest-neighbor via HNSW (default).
    Hnsw,
    /// Brute-force cosine over the applicable rows; exact + complete.
    Exact,
}

/// Parsed `MATCH` value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchQuery {
    pub query: String,
    pub mode: Mode,
    /// HNSW candidate budget (`hnsw` only); `None` uses the default cap.
    pub candidates: Option<usize>,
}

/// Classifies the text after a `/`:
/// - `None` → not a directive (unknown mode keyword) → caller treats as literal.
/// - `Some(Ok(..))` → a valid directive.
/// - `Some(Err(..))` → a directive attempt that is malformed → error.
fn classify_directive(tail: &str) -> Option<Result<(Mode, Option<usize>), String>> {
    let (mode_s, cand_s) = match tail.split_once(':') {
        Some((m, c)) => (m, Some(c)),
        None => (tail, None),
    };
    match mode_s {
        "hnsw" => Some(match cand_s {
            None => Ok((Mode::Hnsw, None)),
            Some(c) => match c.parse::<usize>() {
                Ok(n) if n > 0 => Ok((Mode::Hnsw, Some(n))),
                _ => Err(format!("invalid candidates '{c}' (expected a positive integer)")),
            },
        }),
        "exact" => Some(match cand_s {
            None => Ok((Mode::Exact, None)),
            Some(_) => Err("candidates (`:N`) is only valid with `hnsw` mode".to_string()),
        }),
        _ => None, // unknown keyword: not a directive
    }
}

/// Parses a `MATCH` string into a [`MatchQuery`].
///
/// # Errors
///
/// Returns a message for malformed directives or quoting.
pub fn parse_match(s: &str) -> Result<MatchQuery, String> {
    let s = s.trim();

    // Quoted query: verbatim content, optional `/directive` after the close.
    if let Some(rest) = s.strip_prefix('"') {
        let end = rest
            .find('"')
            .ok_or_else(|| "unterminated quote in MATCH string".to_string())?;
        let query = rest[..end].to_string();
        let after = rest[end + 1..].trim();
        let (mode, candidates) = if after.is_empty() {
            (Mode::Hnsw, None)
        } else if let Some(d) = after.strip_prefix('/') {
            match classify_directive(d) {
                Some(Ok(md)) => md,
                Some(Err(e)) => return Err(e),
                None => return Err(format!("invalid directive after quoted query: '{after}'")),
            }
        } else {
            return Err(format!("unexpected text after quoted query: '{after}'"));
        };
        return Ok(MatchQuery {
            query,
            mode,
            candidates,
        });
    }

    // Bare query: a trailing `/directive` is stripped only if it's valid.
    if let Some(idx) = s.rfind('/') {
        match classify_directive(&s[idx + 1..]) {
            Some(Ok((mode, candidates))) => {
                return Ok(MatchQuery {
                    query: s[..idx].trim().to_string(),
                    mode,
                    candidates,
                })
            }
            Some(Err(e)) => return Err(e),
            None => {} // not a directive — fall through to literal
        }
    }

    Ok(MatchQuery {
        query: s.to_string(),
        mode: Mode::Hnsw,
        candidates: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(s: &str) -> MatchQuery {
        parse_match(s).expect("parse")
    }

    #[test]
    fn bare_query_defaults() {
        assert_eq!(ok("apple"), MatchQuery { query: "apple".into(), mode: Mode::Hnsw, candidates: None });
    }

    #[test]
    fn directives() {
        assert_eq!(ok("apple/exact"), MatchQuery { query: "apple".into(), mode: Mode::Exact, candidates: None });
        assert_eq!(ok("apple/hnsw"), MatchQuery { query: "apple".into(), mode: Mode::Hnsw, candidates: None });
        assert_eq!(ok("apple/hnsw:256"), MatchQuery { query: "apple".into(), mode: Mode::Hnsw, candidates: Some(256) });
    }

    #[test]
    fn slashy_queries_stay_literal() {
        assert_eq!(ok("TCP/IP").query, "TCP/IP");
        assert_eq!(ok("24/7 support").query, "24/7 support");
        assert_eq!(ok("a/b/c").query, "a/b/c");
        // unknown mode keyword is not a directive
        assert_eq!(ok("apple/hsnw").query, "apple/hsnw");
    }

    #[test]
    fn quoted_escape_hatch() {
        assert_eq!(ok("\"apple/tcp/ip:45/hnsw\"").query, "apple/tcp/ip:45/hnsw");
        let q = ok("\"apple/tcp/ip:45/hnsw\"/hnsw:256");
        assert_eq!(q.query, "apple/tcp/ip:45/hnsw");
        assert_eq!(q.mode, Mode::Hnsw);
        assert_eq!(q.candidates, Some(256));
    }

    #[test]
    fn errors() {
        assert!(parse_match("apple/hnsw:abc").is_err());
        assert!(parse_match("apple/exact:256").is_err());
        assert!(parse_match("\"apple\" extra").is_err());
        assert!(parse_match("\"apple").is_err());
    }

    #[test]
    fn whitespace_and_empty() {
        assert_eq!(ok("  apple  ").query, "apple");
        assert_eq!(ok("").query, "");
        // a directive with an empty query is allowed (yields no results at runtime)
        assert_eq!(ok("/exact"), MatchQuery { query: "".into(), mode: Mode::Exact, candidates: None });
    }

    #[test]
    fn bare_uses_only_the_last_segment() {
        let q = ok("a/b/exact");
        assert_eq!(q.query, "a/b");
        assert_eq!(q.mode, Mode::Exact);
    }

    #[test]
    fn modes_are_lowercase_only() {
        // unknown-case keyword isn't a directive -> whole string is the query
        assert_eq!(ok("apple/HNSW").query, "apple/HNSW");
        assert_eq!(ok("apple/Exact").query, "apple/Exact");
    }

    #[test]
    fn candidates_must_be_a_positive_integer() {
        assert!(parse_match("apple/hnsw:0").is_err()); // zero
        assert!(parse_match("apple/hnsw:").is_err()); // missing
        assert!(parse_match("apple/hnsw:-3").is_err()); // negative
        assert_eq!(ok("apple/hnsw:1").candidates, Some(1));
    }

    #[test]
    fn quoted_empty_and_slashes() {
        assert_eq!(ok("\"\"").query, "");
        assert_eq!(ok("\"a/b\"").query, "a/b");
        assert_eq!(ok("\"a/b\"").mode, Mode::Hnsw);
    }
}
