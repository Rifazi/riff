import { describe, expect, test } from 'bun:test';

import {
  effectiveVerdict,
  previousReviewNote,
  uiFiles,
  visualFixMessage,
} from '../../../harness-server/backend/src/agents/visual-review-core';

describe('uiFiles', () => {
  test('keeps what changes a screen and drops tests, types and server code', () => {
    expect(
      uiFiles([
        'src/app/page.tsx',
        'src/styles/app.scss',
        'theme/theme.json',
        'src/app/page.test.tsx',
        'src/__tests__/a.tsx',
        'src/Button.stories.tsx',
        'src/types.d.ts',
        'server/routes.ts',
        'README.md',
      ]),
    ).toEqual(['src/app/page.tsx', 'src/styles/app.scss', 'theme/theme.json']);
  });
});

describe('effectiveVerdict', () => {
  test('needs-changes holds only with a blocker', () => {
    expect(effectiveVerdict('needs-changes', [{ severity: 'minor', text: 'x' }])).toBe('good');
    expect(effectiveVerdict('needs-changes', [{ severity: 'blocker', text: 'x' }])).toBe('needs-changes');
    expect(effectiveVerdict('good', [{ severity: 'blocker', text: 'x' }])).toBe('good');
  });
});

describe('visualFixMessage', () => {
  test('names who asked, the human note and every finding', () => {
    const msg = visualFixMessage({ summary: 'Header overflows.', findings: [{ severity: 'blocker', text: 'Title clipped on phone.' }], humanNote: 'Also bigger logo' }, 'human');
    expect(msg).toContain('The human looked');
    expect(msg).toContain('Also bigger logo');
    expect(msg).toContain('1. [blocker] Title clipped on phone.');
    expect(visualFixMessage({ summary: '', findings: [] }, 'agent')).toContain('UI/UX agent');
  });
});

describe('previousReviewNote', () => {
  test('is empty unless the last review sent the branch back', () => {
    expect(previousReviewNote(null)).toBe('');
    expect(previousReviewNote({ status: 'approved', findings: [] } as never)).toBe('');
    expect(previousReviewNote({ status: 'changes-requested', findings: [{ severity: 'blocker', text: 'Low contrast' }] } as never)).toContain('Low contrast');
  });
});
