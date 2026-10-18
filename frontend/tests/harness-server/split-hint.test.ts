import { describe, expect, test } from 'bun:test';

import { sameFile, soloReason, stepFiles, stepFilesMap } from '../../../harness-server/backend/src/agents/team/split-hint';

const plan = (sections: string[]) =>
  [
    '---',
    'steps:',
    ...sections.map((_, i) => `  - id: s${i + 1}\n    title: Step ${i + 1}`),
    '---',
    '# Plan',
    '## Steps',
    ...sections.map((body, i) => `### ${i + 1}. Step ${i + 1}\n${body}`),
  ].join('\n');

// Jack decides team or solo from the files each step names, not the whole
// plan, and a plan whose steps form one chain is built solo without asking.
describe('split hint', () => {
  test('each step section’s backticked files and folders', () => {
    const steps = stepFiles(plan(['Edit `src/a.ts` and `./lib/b.ts`. Run `npm test`.', 'Add `docs/x.md`, then `foo`.']));
    expect(steps).toEqual([
      { id: 's1', title: 'Step 1', files: ['src/a.ts', 'lib/b.ts'] },
      { id: 's2', title: 'Step 2', files: ['docs/x.md'] },
    ]);
  });

  test('a short name and a full path are the same file', () => {
    expect(sameFile('lib/parser.ts', 'client/src/lib/parser.ts')).toBe(true);
    expect(sameFile('parser.ts', 'lib/parser.ts')).toBe(true);
    expect(sameFile('aparser.ts', 'lib/parser.ts')).toBe(false);
  });

  test('solo when every step touches a file the step before it does', () => {
    const chain = stepFiles(plan(['`src/a.ts`', '`src/a.ts`, `src/b.ts`', 'uses `b.ts`']));
    expect(soloReason(chain)).toContain('one after another');
    // Two steps off a shared foundation can run side by side: the lead decides.
    expect(soloReason(stepFiles(plan(['`src/a.ts`', '`src/b.ts`', '`src/a.ts`, `src/b.ts`'])))).toBeNull();
  });

  test('the lead decides when two neighbours share nothing, or for one step', () => {
    expect(soloReason(stepFiles(plan(['`src/a.ts`', '`src/b.ts`'])))).toBeNull();
    expect(soloReason(stepFiles(plan(['`src/a.ts`', 'no files here'])))).toBeNull();
    expect(soloReason(stepFiles(plan(['`src/a.ts`'])))).toBe('The plan has a single step.');
  });

  test('a doc or config every step names does not chain them', () => {
    const domains = stepFiles(
      plan([
        '`src/ui/Button.tsx`, `DOMAIN.md`, `service.ts`',
        '`src/auth/jwt.ts`, `DOMAIN.md`, `service.ts`, `../ui/service`',
        '`src/projects/list.ts`, `DOMAIN.md`, `package.json`',
      ])
    );
    expect(soloReason(domains)).toBeNull();
  });

  test('the map lists every step', () => {
    expect(stepFilesMap(stepFiles(plan(['`src/a.ts`', 'nothing'])))).toBe(
      '- s1 (Step 1): `src/a.ts`\n- s2 (Step 2): no files named'
    );
  });
});
