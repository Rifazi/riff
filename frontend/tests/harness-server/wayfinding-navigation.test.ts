import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { promptForArchitecture } from '../../../harness-server/backend/src/architecture/architecture-context';
import { domainsNamedIn, domainsOfFiles, listByDomain } from '../../../harness-server/backend/src/architecture/focus';
import { createSearchCodeExecute, isListAllQuery } from '../../../harness-server/backend/src/agents/tool-defs/code-search-tool';
import { planStepSection } from '../../../harness-server/backend/src/agents/plan-excerpt';

// How agents in a Wayfinding app find code: from MAP.md and DOMAIN.md down,
// with searches that start in the domains the work is about.

const DOMAINS = [
  { id: 'comic-projects', dir: 'server/src/comic-projects' },
  { id: 'pricing', dir: 'src/pricing' },
  { id: 'pricing/promotions', dir: 'src/pricing/promotions' },
];

describe('search focus', () => {
  test('a domain is named by its folder or by its id as a whole word', () => {
    expect(domainsNamedIn(DOMAINS, 'Step 2: comic-projects adds soft delete')).toEqual(['server/src/comic-projects']);
    expect(domainsNamedIn(DOMAINS, 'edit src/pricing/promotions/service.ts')).toEqual(['src/pricing', 'src/pricing/promotions']);
    expect(domainsNamedIn(DOMAINS, 'repricing the cart')).toEqual([]);
  });

  test('changed files map to their innermost domain', () => {
    expect(
      domainsOfFiles(DOMAINS, ['src/pricing/promotions/a.ts', 'src/pricing/b.ts', 'package.json', 'server/src/comic-projects/x.ts'])
    ).toEqual(['server/src/comic-projects', 'src/pricing', 'src/pricing/promotions']);
  });
});

describe('promptForArchitecture', () => {
  const prompt = 'Intro.\n<!-- nav -->\nSearch docs/ first.\n<!-- nav: wayfinding -->\nRead MAP.md first.\n<!-- /nav -->\nOutro.\n';

  test('keeps the general guidance for an app without an architecture', () => {
    expect(promptForArchitecture(prompt, { architecture: undefined })).toBe('Intro.\nSearch docs/ first.\nOutro.\n');
    expect(promptForArchitecture(prompt, null)).toBe('Intro.\nSearch docs/ first.\nOutro.\n');
  });

  test('swaps in the Wayfinding guidance for an app that follows it', () => {
    const app = { architecture: { kind: 'wayfinding' as const, srcDirs: ['src'], interfaceFile: 'service.ts' } };
    expect(promptForArchitecture(prompt, app)).toBe('Intro.\nRead MAP.md first.\nOutro.\n');
  });

  test('leaves a prompt override without blocks alone', () => {
    expect(promptForArchitecture('Just my rules.', null)).toBe('Just my rules.');
  });
});

describe('search_code with a focus', () => {
  let repo: string;
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), text);
  };

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'search-focus-'));
    write('src/pricing/service.ts', 'export const priceFor = () => 1\n');
    write('src/invoice/service.ts', "import { priceFor } from '../pricing/service'\nexport const render = () => priceFor()\n");
    write('config/settings.ts', 'export const currency = "EUR"\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const search = createSearchCodeExecute({
    get repoRoot() {
      return repo;
    },
    focus: async () => ({ label: 'the domains your current step names', paths: ['src/pricing'] }),
  });

  test('searches the focus first and says so', async () => {
    const result = await search({ query: 'priceFor' });
    expect(result).toContain('Searched src/pricing (the domains your current step names). Pass glob: "." to search the whole repo.');
    expect(result).toContain('src/pricing/service.ts');
    expect(result).not.toContain('src/invoice/service.ts');
  });

  test('widens to the whole repo when the focus has nothing', async () => {
    const result = await search({ query: 'currency' });
    expect(result).toContain('Nothing in src/pricing (the domains your current step names); searched the whole repo.');
    expect(result).toContain('config/settings.ts');
  });

  test('a glob skips the focus', async () => {
    const result = await search({ query: 'priceFor', glob: '.' });
    expect(result).not.toContain('Searched src/pricing');
    expect(result).toContain('src/invoice/service.ts');
  });
});

describe('listing files with search_code', () => {
  let repo: string;
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), text);
  };
  const domains = [
    { id: 'pages', dir: 'client/src/pages' },
    { id: 'pages/ListPage', dir: 'client/src/pages/ListPage' },
  ];

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'search-listing-'));
    write(
      'client/src/pages/DOMAIN.md',
      '# pages\n\n## Files\n<!-- generated: files, do not edit -->\n- `service.ts` (interface): ListPage\n<!-- end generated -->\n'
    );
    write('client/src/pages/service.ts', "export { ListPage } from './ListPage/ListPage'\n");
    write('client/src/pages/ListPage/DOMAIN.md', '# ListPage\n');
    write('client/src/pages/ListPage/ListPage.tsx', 'export const ListPage = () => null\n');
    write('client/src/main.tsx', 'render()\n');
    write('client/package-lock.json', '{}\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test('a pattern that matches every line is a listing', () => {
    for (const q of ['.', '.*', '^', '^.*$', '', ' . ']) expect(isListAllQuery(q)).toBe(true);
    for (const q of ['a.b', '\\.', 'ListPage', '.ts']) expect(isListAllQuery(q)).toBe(false);
  });

  test("answers from the domains' Files sections, plus files on no domain", async () => {
    const result = (await listByDomain(repo, domains, 'client/**'))!;
    expect(result).toContain('client/src/pages/DOMAIN.md\n- `service.ts` (interface): ListPage');
    // No Files section yet: its tracked files instead.
    expect(result).toContain('client/src/pages/ListPage/DOMAIN.md (no Files section yet');
    expect(result).toContain('- `ListPage.tsx`');
    expect(result).toContain('On no domain yet:\nclient/src/main.tsx');
    expect(result).not.toContain('package-lock.json');
    expect(result).not.toContain('render()');
  });

  test('a glob over DOMAIN.md files lists the domains', async () => {
    const result = (await listByDomain(repo, domains, 'client/**/DOMAIN.md'))!;
    expect(result).toContain('client/src/pages/DOMAIN.md');
    expect(result).toContain('client/src/pages/ListPage/DOMAIN.md');
    expect(result).not.toContain('On no domain yet');
  });

  test('null when nothing under the glob is on a domain', async () => {
    expect(await listByDomain(repo, domains, 'client/src/main.tsx')).toBeNull();
  });

  test('search_code lists files instead of every line', async () => {
    const plain = createSearchCodeExecute({
      get repoRoot() {
        return repo;
      },
    });
    const result = await plain({ query: '.', glob: 'client/src/**' });
    expect(result).toContain('only lists files');
    expect(result).toContain('client/src/main.tsx');
    expect(result).not.toContain('render()');

    const mapped = createSearchCodeExecute({
      get repoRoot() {
        return repo;
      },
      listing: (glob) => listByDomain(repo, domains, glob),
    });
    expect(await mapped({ query: '.*', glob: 'client/src/pages/**' })).toContain('generated from the code');
  });
});

describe('planStepSection', () => {
  const plan = `---
steps:
  - id: s1
    title: Add soft delete
  - id: s2
    title: Wire the delete button
---
# Plan

## Steps

### 1. Add soft delete
Domain: comic-projects. Checkpoint: npm test.

### 2. Wire the delete button
Client only.

## Notes
`;

  test("returns one step's own section", () => {
    expect(planStepSection(plan, 's1')).toBe('### 1. Add soft delete\nDomain: comic-projects. Checkpoint: npm test.');
    expect(planStepSection(plan, 's2')).toBe('### 2. Wire the delete button\nClient only.');
    expect(planStepSection(plan, 'nope')).toBeNull();
  });
});
