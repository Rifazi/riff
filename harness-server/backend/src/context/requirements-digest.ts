import matter from 'gray-matter';
import { docsToUpdate } from '../agents/pre-qa-gate-core.js';
import { SESSION_REQUIREMENTS_DOC } from '../agents/plan-excerpt.js';

export type DigestRole = 'coding' | 'qa';

interface Section {
  title: string;
  body: string;
}

const SHORT_DOC_CHARS = 3000;
const PROBLEM_CHARS = 700;
const DECISIONS_CHARS = 1800;

function sectionsOf(body: string): { title: string; sections: Section[] } {
  const lines = body.split('\n');
  const title = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, '').trim() ?? '';
  const sections: Section[] = [];
  for (const line of lines) {
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) sections.push({ title: heading[1].trim(), body: '' });
    else if (sections.length > 0) sections[sections.length - 1].body += `${line}\n`;
  }
  return { title, sections: sections.map((s) => ({ ...s, body: s.body.trim() })) };
}

const find = (sections: Section[], pattern: RegExp) => sections.find((s) => pattern.test(s.title))?.body ?? '';

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  return `${(stop > max / 2 ? cut.slice(0, stop + 1) : cut).trimEnd()} …`;
}

/** Acceptance criteria as numbered lines, keeping each one's own text and its checkbox state out. */
export function numberedCriteria(body: string): string[] {
  const items = body
    .split('\n')
    .map((l) => l.match(/^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s*)?(.*\S)\s*$/)?.[1])
    .filter((t): t is string => Boolean(t));
  return items.map((text, i) => `AC${i + 1}. ${text}`);
}

/**
 * The approved requirements as a coding or QA conversation needs them: the
 * criteria with stable ids, the human's decisions, what is out of scope and
 * which docs must change. The problem statement and the affected-areas
 * prose are cut down and the links dropped; the full document stays one
 * `read_doc` away. Short documents are passed through unchanged.
 */
export function requirementsDigest(raw: string, role: DigestRole): string {
  const parsed = matter(raw);
  const body = parsed.content.trim();
  if (body.length <= SHORT_DOC_CHARS) return body;
  const { title, sections } = sectionsOf(body);
  const criteria = numberedCriteria(find(sections, /acceptance/i));
  if (criteria.length === 0) return body;

  const parts: string[] = [`# ${title || 'Requirements'}`];
  const problem = find(sections, /problem/i);
  if (problem) parts.push(`## Problem\n${clip(problem, PROBLEM_CHARS)}`);
  const areas = find(sections, /affected/i);
  if (areas) parts.push(`## Affected areas\n${areas}`);
  parts.push(`## Acceptance criteria\n${criteria.join('\n')}`);
  const decisions = find(sections, /open questions|decisions/i);
  if (decisions) parts.push(`## Decisions the human made\n${clip(decisions, DECISIONS_CHARS)}`);
  const nonGoals = find(sections, /non-?goals/i);
  if (nonGoals) parts.push(`## Non-goals\n${nonGoals}`);
  const docs = docsToUpdate(raw);
  if (docs.length > 0) {
    parts.push(
      `## Docs to update\n${docs.map((d) => `- ${d}`).join('\n')}\n` +
        (role === 'qa'
          ? 'Whether each was changed is checked mechanically before QA (listed under "Docs check" below); judge what it says.'
          : 'The pre-QA gate checks that each of these changed on the branch.')
    );
  }
  parts.push(
    `_Digest of the approved requirements. The full document, with the complete problem statement and links, is ` +
      `read_doc({ path: "${SESSION_REQUIREMENTS_DOC}" })._`
  );
  return parts.join('\n\n');
}
