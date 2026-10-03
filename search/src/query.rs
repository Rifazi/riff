//! What someone types → FTS5 match expressions. Every term is quoted, so FTS5
//! syntax in the input (AND, NEAR, column filters, stray quotes) is just text.

/// English filler that would match nearly every chunk. Dropped unless the
/// query is nothing but filler.
const STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "did", "do", "does", "for", "from", "had", "has", "have",
    "how", "i", "in", "is", "it", "its", "me", "my", "of", "on", "or", "our", "so", "that", "the", "their", "them",
    "then", "there", "these", "they", "this", "to", "um", "uh", "was", "we", "were", "what", "when", "where", "which",
    "who", "why", "will", "with", "you", "your", "about", "any", "can", "could", "should", "would",
];

#[derive(Debug, PartialEq)]
pub struct MatchExpressions {
    /// Every term (and quoted phrase) must appear.
    pub all: String,
    /// Any term may appear; `None` when there is only one term.
    pub any: Option<String>,
}

pub fn match_expressions(input: &str) -> Option<MatchExpressions> {
    let mut parts: Vec<String> = Vec::new();
    // Quoted phrases stay phrases.
    for (i, piece) in input.split('"').enumerate() {
        let words = words(piece);
        if i % 2 == 1 {
            if !words.is_empty() {
                parts.push(format!("\"{}\"", words.join(" ")));
            }
            continue;
        }
        let meaningful: Vec<&String> = words.iter().filter(|w| !STOPWORDS.contains(&w.as_str())).collect();
        let kept: Vec<&String> = if meaningful.is_empty() { words.iter().collect() } else { meaningful };
        parts.extend(kept.into_iter().map(|w| format!("\"{w}\"")));
    }
    if parts.is_empty() {
        return None;
    }
    // Still typing the last word: match it as a prefix.
    let typing = !input.ends_with(char::is_whitespace) && !input.trim_end().ends_with('"');
    if typing {
        if let Some(last) = parts.last_mut() {
            // Quoted, so a 4-letter word is 6 characters.
            if !last.contains(' ') && last.chars().count() >= 6 {
                last.push('*');
            }
        }
    }
    Some(MatchExpressions {
        all: parts.join(" AND "),
        any: (parts.len() > 1).then(|| parts.join(" OR ")),
    })
}

fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// Reciprocal rank fusion: each list contributes 1/(K + rank).
pub const RRF_K: f64 = 60.0;

pub fn rrf(rank: usize) -> f64 {
    1.0 / (RRF_K + rank as f64 + 1.0)
}

/// For results with no keyword match: the stretch of the chunk around its
/// first query word, else its opening.
pub fn plain_snippet(text: &str, query: &str, chars: usize) -> String {
    let lower = text.to_lowercase();
    let at = words(query)
        .iter()
        .filter(|w| w.len() >= 3 && !STOPWORDS.contains(&w.as_str()))
        .filter_map(|w| lower.find(w.as_str()))
        .min()
        .unwrap_or(0);
    let begin = text[..at.min(text.len())]
        .char_indices()
        .rev()
        .nth(chars / 4)
        .map_or(0, |(i, _)| i);
    let excerpt: String = text[begin..].chars().take(chars).collect();
    let mut out = String::new();
    if begin > 0 {
        out.push('…');
    }
    out.push_str(excerpt.trim());
    if begin + excerpt.len() < text.len() {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_terms_drops_filler_and_prefixes_the_last_word() {
        let m = match_expressions("what did we decide about pricing").unwrap();
        assert_eq!(m.all, "\"decide\" AND \"pricing\"*");
        assert_eq!(m.any.as_deref(), Some("\"decide\" OR \"pricing\"*"));
        assert_eq!(match_expressions("pricing ").unwrap().all, "\"pricing\"");
        assert_eq!(match_expressions("the").unwrap().all, "\"the\"");
    }

    #[test]
    fn keeps_phrases_and_neutralises_fts_syntax() {
        let m = match_expressions("\"launch date\" NEAR(x) title:foo").unwrap();
        assert_eq!(m.all, "\"launch date\" AND \"near\" AND \"x\" AND \"title\" AND \"foo\"");
        assert!(match_expressions("  ...  ").is_none());
    }

    #[test]
    fn snippet_centres_on_a_query_word() {
        let text = format!("{} the budget was cut {}", "lorem ".repeat(100), "ipsum ".repeat(100));
        let s = plain_snippet(&text, "budget", 80);
        assert!(s.starts_with('…') && s.contains("budget"));
    }
}
