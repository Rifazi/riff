//! Segments → chunks of roughly [`TARGET_CHARS`]: big enough to carry a
//! thought, small enough that a hit points at one moment or section and fits
//! the embedding model (≈250 tokens, well under its 512).

use crate::Segment;

pub const TARGET_CHARS: usize = 900;
const MAX_CHARS: usize = 1_400;
/// A transcript chunk starts with the previous chunk's last line when it is
/// at most this long, so a sentence cut at the boundary is still found whole.
const OVERLAP_CHARS: usize = 240;

#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    pub heading: Option<String>,
    pub text: String,
    pub start: Option<f64>,
    pub end: Option<f64>,
}

pub fn chunk_segments(segments: &[Segment]) -> Vec<Chunk> {
    let pieces: Vec<Segment> = segments
        .iter()
        .filter(|s| !s.text.trim().is_empty())
        .flat_map(|s| {
            split_long(s.text.trim(), MAX_CHARS)
                .into_iter()
                .map(|text| Segment { text, ..s.clone() })
                .collect::<Vec<_>>()
        })
        .collect();

    let mut chunks = Vec::new();
    let mut current: Vec<&Segment> = Vec::new();
    let mut len = 0;
    for piece in &pieces {
        let same_heading = current.first().map_or(true, |first| first.heading == piece.heading);
        if !current.is_empty() && (!same_heading || len + piece.text.len() > TARGET_CHARS) {
            chunks.push(join(&current));
            let carry = current
                .last()
                .copied()
                .filter(|last| same_heading && last.start.is_some() && last.text.len() <= OVERLAP_CHARS);
            current.clear();
            len = 0;
            if let Some(last) = carry {
                current.push(last);
                len = last.text.len();
            }
        }
        len += piece.text.len() + 1;
        current.push(piece);
    }
    if !current.is_empty() {
        chunks.push(join(&current));
    }
    chunks
}

fn join(segments: &[&Segment]) -> Chunk {
    // Transcript lines read as running text; paragraphs keep their breaks.
    let separator = if segments[0].start.is_some() { " " } else { "\n\n" };
    Chunk {
        heading: segments[0].heading.clone(),
        text: segments.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(separator),
        start: segments.iter().find_map(|s| s.start),
        end: segments.iter().rev().find_map(|s| s.end.or(s.start)),
    }
}

/// Splits text over `max` at paragraph, then sentence, then word boundaries.
fn split_long(text: &str, max: usize) -> Vec<String> {
    if text.len() <= max {
        return vec![text.to_string()];
    }
    let mut parts = Vec::new();
    let mut current = String::new();
    for unit in text.split("\n\n").flat_map(sentences).flat_map(|s| hard_split(s, max)) {
        if !current.is_empty() && current.len() + unit.len() + 1 > max {
            parts.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push(' ');
        }
        current.push_str(unit.trim());
    }
    if !current.trim().is_empty() {
        parts.push(current);
    }
    parts
}

fn sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut begin = 0;
    let bytes = text.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if matches!(b, b'.' | b'?' | b'!' | b'\n') && bytes.get(i + 1).map_or(false, |n| n.is_ascii_whitespace()) {
            out.push(&text[begin..=i]);
            begin = i + 1;
        }
    }
    if begin < text.len() {
        out.push(&text[begin..]);
    }
    out
}

fn hard_split(text: &str, max: usize) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = text;
    while rest.len() > max {
        let mut cut = max;
        while !rest.is_char_boundary(cut) {
            cut -= 1;
        }
        let at = rest[..cut].rfind(char::is_whitespace).filter(|&i| i > max / 2).unwrap_or(cut);
        out.push(&rest[..at]);
        rest = &rest[at..];
    }
    out.push(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, start: f64) -> Segment {
        Segment { text: text.into(), start: Some(start), end: Some(start + 2.0), heading: None }
    }

    #[test]
    fn transcript_lines_merge_with_overlap_and_times() {
        let lines: Vec<Segment> = (0..60).map(|i| line(&format!("line number {i} says a few words here"), i as f64 * 3.0)).collect();
        let chunks = chunk_segments(&lines);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.text.len() <= TARGET_CHARS + 60));
        assert_eq!(chunks[0].start, Some(0.0));
        // The next chunk repeats the boundary line.
        let last_of_first = chunks[0].text.rsplit("line number").next().unwrap();
        assert!(chunks[1].text.contains(last_of_first.trim()));
    }

    #[test]
    fn chunks_never_cross_headings() {
        let segments = vec![
            Segment { text: "alpha".into(), heading: Some("A".into()), ..Default::default() },
            Segment { text: "beta".into(), heading: Some("B".into()), ..Default::default() },
        ];
        let chunks = chunk_segments(&segments);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[1].heading.as_deref(), Some("B"));
    }

    #[test]
    fn long_text_is_split_under_the_cap() {
        let text = "This is a sentence that goes on. ".repeat(200);
        let chunks = chunk_segments(&[Segment { text, ..Default::default() }]);
        assert!(chunks.len() > 4);
        assert!(chunks.iter().all(|c| c.text.len() <= MAX_CHARS));
        let unbroken = "x".repeat(5_000);
        assert!(chunk_segments(&[Segment { text: unbroken, ..Default::default() }]).iter().all(|c| c.text.len() <= MAX_CHARS));
    }
}
