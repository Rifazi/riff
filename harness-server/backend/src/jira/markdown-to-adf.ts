// A deliberately small markdown -> Atlassian Document Format converter.
// Jira Cloud's v3 API requires `description` as ADF, not a markdown string.
// This covers what the plan agent's own step sections actually produce
// (see prompts/plan-agent.md's step template): headings, paragraphs, bullet
// and ordered lists, fenced code blocks, and inline bold/code/links. It is
// not a general-purpose markdown parser — tables and nested lists fall back
// to a plain paragraph rather than failing.

interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export interface AdfDocument {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

function parseInline(text: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  // Order matters: code spans first so `**` inside backticks isn't treated
  // as emphasis, then links, then bold, then italic.
  const pattern = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      nodes.push({ type: 'text', text: match[1], marks: [{ type: 'code' }] });
    } else if (match[2] !== undefined) {
      nodes.push({ type: 'text', text: match[2], marks: [{ type: 'link', attrs: { href: match[3] } }] });
    } else if (match[4] !== undefined || match[5] !== undefined) {
      nodes.push({ type: 'text', text: (match[4] ?? match[5])!, marks: [{ type: 'strong' }] });
    } else if (match[6] !== undefined || match[7] !== undefined) {
      nodes.push({ type: 'text', text: (match[6] ?? match[7])!, marks: [{ type: 'em' }] });
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push({ type: 'text', text: text.slice(lastIndex) });
  }
  return nodes.length > 0 ? nodes : [{ type: 'text', text: '' }];
}

function paragraph(text: string): AdfNode {
  return { type: 'paragraph', content: parseInline(text) };
}

export function markdownToAdf(markdown: string): AdfDocument {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const content: AdfNode[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      content.push({ type: 'heading', attrs: { level: Math.min(heading[1].length, 6) }, content: parseInline(heading[2]) });
      i++;
      continue;
    }

    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      content.push({
        type: 'codeBlock',
        attrs: lang ? { language: lang } : {},
        content: [{ type: 'text', text: codeLines.join('\n') }],
      });
      continue;
    }

    const bulletMatch = /^[-*]\s+(.+)$/.exec(line);
    const orderedMatch = /^\d+[.)]\s+(.+)$/.exec(line);
    if (bulletMatch || orderedMatch) {
      const isOrdered = Boolean(orderedMatch);
      const items: AdfNode[] = [];
      while (i < lines.length) {
        const itemMatch = isOrdered ? /^\d+[.)]\s+(.+)$/.exec(lines[i]) : /^[-*]\s+(.+)$/.exec(lines[i]);
        if (!itemMatch) break;
        // Fold any indented continuation lines into the same list item as a
        // second paragraph, rather than trying to model nested lists.
        const itemLines = [itemMatch[1]];
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
          itemLines.push(lines[i].trim());
          i++;
        }
        items.push({ type: 'listItem', content: [paragraph(itemLines.join(' '))] });
      }
      content.push({ type: isOrdered ? 'orderedList' : 'bulletList', content: items });
      continue;
    }

    // Table rows: not modelled as ADF tables (rare in a step's own body,
    // mostly used in the plan's Reuse audit which isn't copied per-ticket)
    // — rendered as a plain paragraph so content isn't silently dropped.
    const paragraphLines = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s+/.test(lines[i]) && !/^```/.test(lines[i]) && !/^[-*]\s+/.test(lines[i]) && !/^\d+[.)]\s+/.test(lines[i])) {
      paragraphLines.push(lines[i]);
      i++;
    }
    content.push(paragraph(paragraphLines.join(' ')));
  }

  return { type: 'doc', version: 1, content: content.length > 0 ? content : [paragraph('')] };
}
