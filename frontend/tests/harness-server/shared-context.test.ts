import { describe, expect, test } from 'bun:test';

import { numberedCriteria, requirementsDigest } from '../../../harness-server/backend/src/context/requirements-digest';
import { cleanModelSummary, docsMapFingerprint, renderDocsMap, ruleSummary, type DocEntry } from '../../../harness-server/backend/src/context/docs-map';
import { docsCheckNote } from '../../../harness-server/backend/src/context/docs-check';
import { criteriaCount, soloFirstReview } from '../../../harness-server/backend/src/context/qa-solo';
import { gateByRule } from '../../../harness-server/backend/src/agents/coordinator-agent';
import type { TranscriptEntry } from '../../../harness-server/backend/src/sessions/session';

const LONG_PROBLEM = 'Operators cannot see which partner a failed file belongs to. '.repeat(30);
const REQUIREMENTS = `---
status: approved
related-docs:
  - docs/edi.md
---
# Partner on failures

## Problem statement
${LONG_PROBLEM}

## Affected areas
- failure list view
- the ingest handler

## Acceptance criteria
- [ ] The failure list shows the partner name
- [ ] A failure with no partner shows "Unknown"
- [x] The ingest handler records the partner id

## Open questions / decisions
- Q: show the id too? — A: no, name only

## Non-goals
Reworking the retry flow.

## Docs to update
- docs/edi.md — describe the new column
- \`docs/ops.md\` — failure triage

## Links
- docs/edi.md
${'Filler paragraph about nothing in particular.\n'.repeat(30)}`;

describe('requirements digest', () => {
  test('numbers criteria and drops checkbox state', () => {
    expect(numberedCriteria('- [ ] one\n- [x] two\n3. three')).toEqual(['AC1. one', 'AC2. two', 'AC3. three']);
  });

  test('a long document keeps criteria, decisions, non-goals and docs, and cuts the problem statement', () => {
    const digest = requirementsDigest(REQUIREMENTS, 'coding');
    expect(digest).toContain('AC1. The failure list shows the partner name');
    expect(digest).toContain('AC3. The ingest handler records the partner id');
    expect(digest).toContain('A: no, name only');
    expect(digest).toContain('Reworking the retry flow.');
    expect(digest).toContain('- docs/edi.md');
    expect(digest).toContain('- docs/ops.md');
    expect(digest).toContain('session/requirements.md');
    expect(digest).not.toContain('Filler paragraph');
    expect(digest.length).toBeLessThan(REQUIREMENTS.length / 2);
    expect(digest.match(/Operators cannot see/g)!.length).toBeLessThan(LONG_PROBLEM.match(/Operators cannot see/g)!.length);
  });

  test('QA is told the docs check is computed for it', () => {
    expect(requirementsDigest(REQUIREMENTS, 'qa')).toContain('Docs check');
    expect(requirementsDigest(REQUIREMENTS, 'coding')).toContain('pre-QA gate');
  });

  test('a short document, or one with no criteria list, passes through', () => {
    const short = '# T\n\n## Acceptance criteria\n- [ ] a\n';
    expect(requirementsDigest(short, 'qa')).toBe(short.trim());
    const noCriteria = `# T\n\n## Problem statement\n${'x '.repeat(2000)}`;
    expect(requirementsDigest(noCriteria, 'coding')).toBe(noCriteria.trim());
  });
});

describe('docs map', () => {
  test('ruleSummary is the title and first sentence, skipping code, lists and front matter', () => {
    const md = '---\na: b\n---\n# Retries\n\n```\n# not a heading\n```\n\n- a bullet\n\nFailed files are retried three times. Then they park.\n';
    expect(ruleSummary(md)).toBe('Retries — Failed files are retried three times.');
  });

  test('cleanModelSummary strips think blocks and rejects empties', () => {
    expect(cleanModelSummary('<think>hm</think>Summary: Covers how retries work and when to read it.')).toBe(
      'Covers how retries work and when to read it.'
    );
    expect(cleanModelSummary('ok')).toBeNull();
  });

  const entry = (path: string, hash = 'h', summary = `about ${path}`): DocEntry => ({ path, hash, summary, by: 'rule' });

  test('cited docs come first and the budget leaves a count', () => {
    const many = Array.from({ length: 80 }, (_, i) => entry(`docs/d${String(i).padStart(2, '0')}.md`, 'h', 'x'.repeat(100)));
    const map = renderDocsMap(many, 'coding', ['d79.md']);
    expect(map.indexOf('docs/d79.md')).toBeLessThan(map.indexOf('docs/d00.md'));
    expect(map).toMatch(/and \d+ more: use search_docs/);
    expect(map.length).toBeLessThan(3000);
  });

  test('no docs, no section', () => {
    expect(renderDocsMap([], 'plan')).toBe('');
  });

  test('the fingerprint follows content hashes, not summaries', () => {
    const a = [entry('docs/a.md', '1')];
    expect(docsMapFingerprint(a)).toBe(docsMapFingerprint([{ ...a[0], summary: 'better', by: 'local' }]));
    expect(docsMapFingerprint(a)).not.toBe(docsMapFingerprint([entry('docs/a.md', '2')]));
    expect(docsMapFingerprint([])).toBe('none');
  });
});

describe('docs check note', () => {
  test('lists changed and untouched docs from the diff', () => {
    const note = docsCheckNote(REQUIREMENTS, ['src/a.ts', 'docs/edi.md']);
    expect(note).toContain('Changed on this branch: docs/edi.md');
    expect(note).toContain('Listed but not changed: docs/ops.md');
  });

  test('nothing when no docs are listed', () => {
    expect(docsCheckNote('# T\n\n## Docs to update\n- none\n', [])).toBe('');
  });
});

describe('QA solo first review', () => {
  test('counts criteria', () => {
    expect(criteriaCount(REQUIREMENTS)).toBe(3);
    expect(criteriaCount('# nothing')).toBe(0);
  });

  test('small branch and few criteria is solo; big or unknown is left to the lead', () => {
    expect(soloFirstReview(3, 5)).toBe(true);
    expect(soloFirstReview(3, 20)).toBe(false);
    expect(soloFirstReview(9, 5)).toBe(false);
    expect(soloFirstReview(3, null)).toBe(false);
    expect(soloFirstReview(0, 3)).toBe(false);
  });
});

let n = 0;
const e = (role: TranscriptEntry['role'], extra: Partial<TranscriptEntry> = {}): TranscriptEntry =>
  ({ id: String(n++), timestamp: '2026-10-10T00:00:00Z', role, ...extra }) as TranscriptEntry;

describe('gate by rule', () => {
  test('a short report with nothing open is approved without a model', () => {
    expect(gateByRule([e('user', { text: 'go' }), e('assistant', { text: 'Wrote the requirements document.' })])?.action).toBe('approve');
  });

  test('a question or a worrying phrase stops', () => {
    expect(gateByRule([e('user', { text: 'go' }), e('assistant', { text: 'Which partner should this use?' })])?.action).toBe('stop');
    expect(gateByRule([e('user', { text: 'go' }), e('assistant', { text: 'Tests are still failing.' }), e('assistant', { text: 'Done.' })])?.action).toBe(
      'stop'
    );
  });

  test('an erroring tool, a long closing message or no message goes to the model', () => {
    expect(gateByRule([e('user', { text: 'go' }), e('tool_result', { isError: true }), e('assistant', { text: 'Done.' })])).toBeNull();
    expect(gateByRule([e('user', { text: 'go' }), e('assistant', { text: 'word '.repeat(200) })])).toBeNull();
    expect(gateByRule([e('user', { text: 'go' })])).toBeNull();
  });
});
