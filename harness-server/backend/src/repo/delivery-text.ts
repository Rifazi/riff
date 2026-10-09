import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { config } from '../config.js';
import { generateLocal } from '../agents/local-llm.js';
import { commitLogAgainstBase, diffStatAgainstBase } from './git.js';
import type { SessionRecord } from '../sessions/session.js';
import type { DeliveryText } from './delivery.js';

// The MR/PR title and description for a reviewed branch. The prose summary
// comes from Riff's built-in local model (free — no provider tokens spent on
// it); everything else (QA table, commits, files) is filled in from the
// repo and the QA report directly. If the local model isn't available the
// summary falls back to the requirements doc's own opening text.

const SUMMARY_SYSTEM = `You write the summary section of a merge request description for code reviewers.
Output GitHub-flavoured Markdown only, exactly in this shape:

<one or two plain sentences saying what this change does and why>

### Changes
- <one bullet per meaningful change, most important first, at most 8>

Rules: be concrete and factual, use only what the input says, no headings other than "### Changes", no preamble, no sign-off, and never mention who or what wrote the change.`;

async function readDoc(relPath: string | null): Promise<{ data: Record<string, unknown>; content: string } | null> {
  if (!relPath) return null;
  try {
    const parsed = matter(await fs.readFile(path.join(config.harnessRoot, relPath), 'utf8'));
    return { data: parsed.data as Record<string, unknown>, content: parsed.content.trim() };
  } catch {
    return null;
  }
}

/** The doc's first real paragraph — used when the local model can't write a summary. */
function firstParagraph(markdown: string): string {
  for (const block of markdown.split(/\n\s*\n/)) {
    const text = block.trim();
    if (text && !text.startsWith('#') && !text.startsWith('|') && !text.startsWith('```')) return text;
  }
  return '';
}

function cleanModelOutput(raw: string): string | null {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^```(?:markdown|md)?\s*|\s*```$/g, '').trim();
  return text.length >= 20 ? text : null;
}

async function localSummary(input: string): Promise<string | null> {
  try {
    return cleanModelOutput(await generateLocal({ system: SUMMARY_SYSTEM, prompt: input, maxTokens: 700 }));
  } catch (err) {
    console.warn('[delivery] local model unavailable for the MR summary —', err instanceof Error ? err.message : err);
    return null;
  }
}

const cell = (v: unknown) => String(v ?? '—').replace(/\|/g, '\\|');

export async function buildDeliveryText(session: SessionRecord, repoRoot: string, baseBranch: string): Promise<DeliveryText> {
  const branch = session.branch!;
  const [requirements, qa, commits, diffStat] = await Promise.all([
    readDoc(session.requirementsPath),
    readDoc(session.qaReportPath),
    commitLogAgainstBase(repoRoot, branch, baseBranch).catch(() => []),
    diffStatAgainstBase(repoRoot, branch, baseBranch).catch(() => ''),
  ]);

  const commitLines = commits.map((c) => `- ${c.message.split('\n')[0]}`).reverse();

  // Kept well inside the local model's 16k context.
  const modelInput = [
    `Title: ${session.title}`,
    requirements ? `Requirements:\n${requirements.content.slice(0, 9_000)}` : null,
    commitLines.length ? `Commits:\n${commitLines.slice(0, 40).join('\n')}` : null,
    diffStat ? `Files changed:\n${diffStat.trim().split('\n').slice(-40).join('\n')}` : null,
    qa ? `QA summary:\n${qa.content.slice(0, 3_000)}` : null,
  ].filter(Boolean).join('\n\n');

  const summary =
    (await localSummary(modelInput)) ??
    [
      firstParagraph(requirements?.content ?? '') || session.title,
      commitLines.length ? `### Changes\n${commitLines.slice(0, 15).join('\n')}` : null,
    ].filter(Boolean).join('\n\n');

  const sections = [`## Summary\n\n${summary}`];

  if (qa) {
    const d = qa.data;
    sections.push(
      [
        '## Testing',
        '',
        '| Check | Result |',
        '| --- | --- |',
        `| QA overall | ${cell(d.result)} |`,
        `| Lint | ${cell(d.lint)} |`,
        `| Unit tests | ${cell(d['unit-tests'])} |`,
        `| Integration tests | ${cell(d['integration-tests'])} |`,
      ].join('\n')
    );
  }

  if (commitLines.length) {
    sections.push(`<details>\n<summary>Commits (${commitLines.length})</summary>\n\n${commitLines.join('\n')}\n\n</details>`);
  }
  if (diffStat.trim()) {
    sections.push(`<details>\n<summary>Files changed</summary>\n\n\`\`\`\n${diffStat.trim()}\n\`\`\`\n\n</details>`);
  }
  if (qa) {
    sections.push(`<details>\n<summary>Full QA report</summary>\n\n${qa.content}\n\n</details>`);
  }

  return {
    title: session.ticket ? `${session.ticket}: ${session.title}` : session.title,
    description: sections.join('\n\n').slice(0, 60_000),
    summary: (firstParagraph(summary) || session.title).replace(/\s+/g, ' ').trim(),
  };
}
