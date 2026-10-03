//! Markdown → segments: one per paragraph, carrying its heading path
//! ("Decisions > Pricing"), so chunks stay within a section.

use crate::Segment;

pub fn segments(markdown: &str) -> Vec<Segment> {
    let mut out = Vec::new();
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut paragraph: Vec<&str> = Vec::new();
    let mut in_code = false;

    let flush = |paragraph: &mut Vec<&str>, stack: &[(usize, String)], out: &mut Vec<Segment>| {
        let text = paragraph.join("\n").trim().to_string();
        paragraph.clear();
        if !text.is_empty() {
            let heading = (!stack.is_empty()).then(|| stack.iter().map(|(_, h)| h.as_str()).collect::<Vec<_>>().join(" > "));
            out.push(Segment { text, heading, ..Default::default() });
        }
    };

    for line in markdown.lines() {
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
        }
        let level = line.chars().take_while(|&c| c == '#').count();
        let is_heading = !in_code && (1..=6).contains(&level) && line[level..].starts_with(' ');
        if is_heading {
            flush(&mut paragraph, &stack, &mut out);
            while stack.last().map_or(false, |(l, _)| *l >= level) {
                stack.pop();
            }
            stack.push((level, clean_inline(line[level..].trim())));
        } else if line.trim().is_empty() && !in_code {
            flush(&mut paragraph, &stack, &mut out);
        } else {
            paragraph.push(line);
        }
    }
    flush(&mut paragraph, &stack, &mut out);
    out
}

/// "**Owner:** Sam" → "Owner: Sam", for headings shown in results.
fn clean_inline(text: &str) -> String {
    text.replace("**", "").replace('`', "")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paragraphs_carry_heading_paths() {
        let md = "# Budget\n\nIntro line.\n\n## Decisions\n\n- cut travel\n- freeze hiring\n\n```\n# not a heading\n```\n\n# Hiring\nSam owns it.";
        let segs = segments(md);
        assert_eq!(segs[0].heading.as_deref(), Some("Budget"));
        assert_eq!(segs[1].heading.as_deref(), Some("Budget > Decisions"));
        assert!(segs[1].text.contains("freeze hiring"));
        assert!(segs[2].text.contains("# not a heading"));
        assert_eq!(segs.last().unwrap().heading.as_deref(), Some("Hiring"));
    }
}
