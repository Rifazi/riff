import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseArchitectureConfig } from '../../../harness-server/backend/src/architecture/architecture';
import {
  auditWayfinding,
  branchScope,
  exportedNames,
  formatWayfindingAudit,
  importSpecifiers,
  listDomains,
  parseMapRows,
  parseRules,
} from '../../../harness-server/backend/src/architecture/wayfinding-audit';
import { branchChanges } from '../../../harness-server/backend/src/repo/git';

const CONFIG = { kind: 'wayfinding' as const, srcDirs: ['src'], interfaceFile: 'service.ts' };

function domainDoc(name: string, opts: { parent?: string; children?: string; rules?: string; consumers?: string; extra?: string } = {}) {
  return `# ${name}

Parent: ${opts.parent ?? 'none (top-level domain)'}
Owns: ${name} decisions
Owns data: none
Child domains: ${opts.children ?? 'none'}
Does not own: everything else
Interface: ${name}Fn()
Checkpoint: npm run checkpoint -- ${name}
${opts.extra ?? ''}
## Rules
${opts.rules ?? ''}
## Recipes

## Consumers
<!-- generated: do not edit -->
- ${opts.consumers ?? 'none'}
<!-- end generated -->
`;
}

let repo: string;
const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), text);
};

// pricing (with child promotions) and invoice, which consumes pricing.
function seedCleanRepo() {
  write('MAP.md', '# Map\n\n| Domain | Owns | Interface |\n| --- | --- | --- |\n| pricing | prices | priceFor() |\n| invoice | layout | render() |\n');
  write(
    'src/pricing/DOMAIN.md',
    domainDoc('pricing', {
      children: 'promotions',
      consumers: 'invoice',
      rules: '- Discounts are capped at $50.\n  Enforced by: service.test.ts › "caps discount at $50"\n',
    })
  );
  write('src/pricing/service.ts', "import { promoFor } from './promotions/service.ts'\nexport const priceFor = () => promoFor()\n");
  write('src/pricing/service.test.ts', "test('caps discount at $50', () => {})\n");
  write('src/pricing/model.ts', 'export const table = 1\n');
  write('src/pricing/promotions/DOMAIN.md', domainDoc('promotions', { parent: 'pricing', consumers: 'pricing' }));
  write('src/pricing/promotions/service.ts', 'export const promoFor = () => 0\n');
  write('src/invoice/DOMAIN.md', domainDoc('invoice'));
  write('src/invoice/service.ts', "import { priceFor } from '../pricing/service'\nexport const render = () => priceFor()\n");
  write('src/lib/util.ts', 'export const x = 1\n');
  // Writes each DOMAIN.md's generated Files section.
  auditWayfinding(repo, CONFIG, { regenerate: true });
}

const messages = () => auditWayfinding(repo, CONFIG).problems.map((p) => p.message);

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'wayfinding-'));
  seedCleanRepo();
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('auditWayfinding', () => {
  test('a repo that follows the rules has no problems', () => {
    const audit = auditWayfinding(repo, CONFIG);
    expect(audit.problems).toEqual([]);
    expect(audit.domains.map((d) => d.id)).toEqual(['invoice', 'pricing', 'pricing/promotions']);
    expect(audit.offMap).toEqual(['src/lib']);
  });

  test("flags an import of another domain's private file", () => {
    write('src/invoice/service.ts', "import { table } from '../pricing/model'\nexport const render = () => table\n");
    expect(messages().some((m) => m.includes('reaches a private file of pricing'))).toBe(true);
  });

  test('flags a child domain reached from outside its parent', () => {
    write('src/invoice/service.ts', "import { promoFor } from '../pricing/promotions/service.ts'\nexport const render = () => promoFor()\n");
    expect(messages().some((m) => m.includes('visible only inside pricing'))).toBe(true);
  });

  test('resolves tsconfig path aliases', () => {
    write('tsconfig.json', '{ // comments are allowed\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], }, }, }\n');
    write('src/invoice/service.ts', "import { table } from '@/pricing/model'\nexport const render = () => table\n");
    expect(messages().some((m) => m.includes('reaches a private file of pricing'))).toBe(true);
  });

  test('flags a rule whose test is gone, and a rule without an anchor', () => {
    write('src/pricing/service.test.ts', "test('something else', () => {})\n");
    write('src/invoice/DOMAIN.md', domainDoc('invoice', { rules: '- Invoices show every discount line.\n' }));
    const found = messages();
    expect(found.some((m) => m.includes('rule anchored to a missing test: service.test.ts › "caps discount at $50"'))).toBe(true);
    expect(found.some((m) => m.includes('rule has no "Enforced by" test: Invoices show every discount line.'))).toBe(true);
  });

  test('flags a stale Consumers section, and regenerate rewrites it', () => {
    write('src/pricing/DOMAIN.md', readFileSync(path.join(repo, 'src/pricing/DOMAIN.md'), 'utf8').replace('- invoice', '- none'));
    expect(messages().some((m) => m.startsWith('Consumers section is stale (should be: invoice)'))).toBe(true);

    const fixed = auditWayfinding(repo, CONFIG, { regenerate: (doc) => doc.startsWith('src/pricing/') });
    expect(fixed.regenerated).toEqual(['src/pricing/DOMAIN.md']);
    expect(readFileSync(path.join(repo, 'src/pricing/DOMAIN.md'), 'utf8')).toContain('<!-- generated: do not edit -->\n- invoice\n');
    expect(messages()).toEqual([]);
  });

  test('flags a top-level domain missing from MAP.md, and a map row without a folder', () => {
    write('MAP.md', '| Domain | Owns | Interface |\n| --- | --- | --- |\n| pricing | prices | priceFor() |\n| billing | bills | bill() |\n');
    const found = messages();
    expect(found).toContain('top-level domain invoice is not on the map');
    expect(found.some((m) => m.startsWith('billing is on the map but has no top-level domain folder'))).toBe(true);
  });

  test('flags the wrong Parent and undeclared child domains', () => {
    write('src/pricing/DOMAIN.md', domainDoc('pricing', { consumers: 'invoice' }));
    write('src/pricing/promotions/DOMAIN.md', domainDoc('promotions', { consumers: 'pricing' }));
    const found = messages();
    expect(found.some((m) => m.startsWith('Child domains lists [], folders are [promotions]'))).toBe(true);
    expect(found.some((m) => m.includes('but the folder says pricing'))).toBe(true);
  });

  test('a missing source folder is reported, not thrown', () => {
    rmSync(path.join(repo, 'src'), { recursive: true });
    const audit = auditWayfinding(repo, { ...CONFIG, srcDirs: ['app'] });
    expect(audit.srcDirExists).toBe(false);
    expect(formatWayfindingAudit(audit)).toContain("app/ doesn't exist yet");
  });

  test('a wrong source folder is audited from the one folder that holds every DOMAIN.md', () => {
    const audit = auditWayfinding(repo, { ...CONFIG, srcDirs: ['app'] });
    expect(audit.inferredSrcDir).toBe('src');
    expect(audit.domains.map((d) => d.id).sort()).toEqual(['invoice', 'pricing', 'pricing/promotions']);
    expect(audit.problems).toEqual([]);
    expect(formatWayfindingAudit(audit)).toContain('set the source folder to src on the Apps page');
  });

  test('a wrong source folder with domains in several folders is reported, not guessed', () => {
    write('server/src/projects/DOMAIN.md', domainDoc('projects'));
    const audit = auditWayfinding(repo, { ...CONFIG, srcDirs: ['app'] });
    expect(audit.inferredSrcDir).toBeUndefined();
    expect(audit.srcDirCandidates).toEqual(['server/src', 'src']);
    expect(formatWayfindingAudit(audit)).toContain('probably wrong');
  });

  test('Owns data matches tables written as code', () => {
    write('src/invoice/DOMAIN.md', domainDoc('invoice').replace('Owns data: none', 'Owns data: `invoice_headers`, `invoice_lines`'));
    write('src/invoice/entities.ts', "@Entity('invoice_headers')\nclass A {}\n@Entity({ name: 'invoice_lines' })\nclass B {}\n");
    auditWayfinding(repo, CONFIG, { regenerate: true });
    expect(messages()).toEqual([]);
  });

  test('a Consumers block reformatted with blank lines is not stale', () => {
    const doc = readFileSync(path.join(repo, 'src/pricing/DOMAIN.md'), 'utf8');
    write('src/pricing/DOMAIN.md', doc.replace('<!-- generated: do not edit -->\n- invoice\n', '<!-- generated: do not edit -->\n\n- invoice\n\n'));
    expect(messages()).toEqual([]);
  });
});

describe('generated Files section', () => {
  const doc = (rel: string) => readFileSync(path.join(repo, rel), 'utf8');

  test("lists the domain's own files with their exports, interface first, tests last, child domains left out", () => {
    expect(doc('src/pricing/DOMAIN.md')).toContain(
      '## Files\n<!-- generated: files, do not edit -->\n' +
        '- `service.ts` (interface): priceFor\n- `model.ts`: table\n- tests: `service.test.ts`\n<!-- end generated -->'
    );
    expect(doc('src/pricing/DOMAIN.md')).not.toContain('promotions/service.ts');
    // Placed before Consumers.
    expect(doc('src/pricing/DOMAIN.md').indexOf('## Files')).toBeLessThan(doc('src/pricing/DOMAIN.md').indexOf('## Consumers'));
  });

  test('a new file or export makes it stale, and regenerate rewrites it', () => {
    write('src/invoice/layout.ts', 'export function pageSize() {}\nexport { pageSize as size }\n');
    expect(messages()).toContain('Files section is stale (a file was added, removed or changed its exports)');
    auditWayfinding(repo, CONFIG, { regenerate: true });
    expect(doc('src/invoice/DOMAIN.md')).toContain('- `layout.ts`: pageSize, size\n');
    expect(messages()).toEqual([]);
  });

  test('a DOMAIN.md without one is reported, and regenerate adds it', () => {
    write('src/invoice/DOMAIN.md', domainDoc('invoice'));
    expect(messages()).toContain('missing the generated Files block');
    auditWayfinding(repo, CONFIG, { regenerate: true });
    expect(doc('src/invoice/DOMAIN.md')).toContain('## Files\n<!-- generated: files, do not edit -->\n- `service.ts` (interface): render\n');
  });

  test('exportedNames covers declarations, lists, aliases and anonymous defaults', () => {
    const src =
      'export async function a() {}\nexport default class B {}\nexport const c = 1\nexport type D = 1\n' +
      "export { e, f as g }\nexport type { H } from './h'\nconst x = 1\n";
    expect(exportedNames(src)).toEqual(['a', 'B', 'c', 'D', 'e', 'g', 'H']);
    expect(exportedNames('export default () => 1\n')).toEqual(['default']);
  });
});

describe('several source folders', () => {
  const TWO = { ...CONFIG, srcDirs: ['src', 'client/src'] };

  test('audits the domains under every folder', () => {
    write('client/src/editor/DOMAIN.md', domainDoc('editor'));
    write('client/src/editor/service.ts', 'export const open = () => 1\n');
    write('MAP.md', readFileSync(path.join(repo, 'MAP.md'), 'utf8') + '| editor | editing | open() |\n');
    auditWayfinding(repo, TWO, { regenerate: true });
    const audit = auditWayfinding(repo, TWO);
    expect(audit.domains.map((d) => d.dir)).toEqual([
      'src/invoice',
      'src/pricing',
      'src/pricing/promotions',
      'client/src/editor',
    ]);
    expect(audit.problems).toEqual([]);
    expect(listDomains(repo, TWO).map((d) => d.id)).toEqual(['invoice', 'pricing', 'pricing/promotions', 'editor']);
  });

  test('names folders with domains outside the source folders', () => {
    write('client/src/editor/DOMAIN.md', domainDoc('editor'));
    const audit = auditWayfinding(repo, CONFIG);
    expect(audit.srcDirCandidates).toEqual(['client/src']);
    expect(formatWayfindingAudit(audit)).toContain('outside the source folders, under client/src/, get no checks');
  });

  test('a configured folder that is missing is listed while the others are audited', () => {
    const audit = auditWayfinding(repo, TWO);
    expect(audit.missingSrcDirs).toEqual(['client/src']);
    expect(audit.domains.length).toBe(3);
    expect(formatWayfindingAudit(audit)).toContain('Configured but missing (no domains there yet): client/src/');
  });

  test('the same domain name under two folders is a problem', () => {
    write('client/src/invoice/DOMAIN.md', domainDoc('invoice'));
    expect(auditWayfinding(repo, TWO).problems.map((p) => p.message)).toContain(
      'invoice is also a domain at src/invoice; domain names must be unique across source folders'
    );
  });
});

describe('parsing', () => {
  test('rules accept a plain > as the anchor separator', () => {
    expect(parseRules('## Rules\n- A rule.\n  Enforced by: a.test.ts > "a rule"\n')).toEqual([
      { text: 'A rule.', anchor: { file: 'a.test.ts', test: 'a rule' } },
    ]);
  });

  test('map rows skip the header, separator and placeholders', () => {
    expect(parseMapRows('| Domain | Owns |\n| --- | --- |\n| `pricing` | prices |\n<!-- | <domain> | x | -->\n')).toEqual([
      { name: 'pricing', owns: 'prices' },
    ]);
  });

  test('map rows accept a domain name linked to its DOMAIN.md', () => {
    expect(parseMapRows('| Domain | Owns |\n| --- | --- |\n| [pricing](src/pricing/DOMAIN.md) | prices |\n| [`invoice`](x) | layout |\n')).toEqual([
      { name: 'pricing', owns: 'prices' },
      { name: 'invoice', owns: 'layout' },
    ]);
  });

  test('import specifiers cover from, side-effect, dynamic and require, and skip comments', () => {
    const src = "import a from './a'\nexport * from \"./b\"\nimport './c'\nconst d = await import('./d')\nconst e = require('./e')\n// import x from './x'\n";
    expect(importSpecifiers(src).sort()).toEqual(['./a', './b', './c', './d', './e']);
  });
});

describe('parseArchitectureConfig', () => {
  test('null turns it off and defaults fill in', () => {
    expect(parseArchitectureConfig(null)).toBeNull();
    expect(parseArchitectureConfig({ kind: 'wayfinding' })).toEqual(CONFIG);
    expect(parseArchitectureConfig({ kind: 'wayfinding', srcDirs: ['./app/', 'client/src', ' '], interfaceFile: 'index.ts' })).toEqual({
      kind: 'wayfinding',
      srcDirs: ['app', 'client/src'],
      interfaceFile: 'index.ts',
    });
  });

  test("reads an older app's single srcDir", () => {
    expect(parseArchitectureConfig({ kind: 'wayfinding', srcDir: 'server/src', interfaceFile: 'service.ts' })).toEqual({
      ...CONFIG,
      srcDirs: ['server/src'],
    });
  });

  test('rejects a folder inside another', () => {
    expect(() => parseArchitectureConfig({ kind: 'wayfinding', srcDirs: ['src', 'src/client'] })).toThrow();
  });

  test('rejects paths outside the repo and unknown kinds', () => {
    expect(() => parseArchitectureConfig({ kind: 'wayfinding', srcDirs: ['../elsewhere'] })).toThrow();
    expect(() => parseArchitectureConfig({ kind: 'wayfinding', interfaceFile: 'a/service.ts' })).toThrow();
    expect(() => parseArchitectureConfig({ kind: 'hexagonal' })).toThrow();
  });
});

describe('branch scope', () => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

  test('lists touched domains, ownership edits and new domains against the base branch', async () => {
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    git('checkout', '-qb', 'feature');
    write('src/pricing/DOMAIN.md', readFileSync(path.join(repo, 'src/pricing/DOMAIN.md'), 'utf8').replace('Owns: pricing decisions', 'Owns: pricing decisions; loyalty'));
    write('src/invoice/service.ts', "import { priceFor } from '../pricing/service'\nexport const render = () => priceFor() + 1\n");
    write('src/tax/DOMAIN.md', domainDoc('tax'));
    write('package.json', '{}\n');

    const changes = await branchChanges(repo, 'main', ':(glob)**/DOMAIN.md');
    expect(changes).not.toBeNull();
    const audit = auditWayfinding(repo, CONFIG);
    const scope = branchScope(audit, 'main', changes!.files, changes!.docDiff);

    expect(scope.byDomain).toEqual([
      { domain: 'invoice', files: ['src/invoice/service.ts'] },
      { domain: 'pricing', files: ['src/pricing/DOMAIN.md'] },
      { domain: 'tax', files: ['src/tax/DOMAIN.md'] },
    ]);
    expect(scope.outside).toEqual(['package.json']);
    expect(scope.ownershipEdits).toEqual([{ file: 'src/pricing/DOMAIN.md', fields: ['Owns'] }]);
    expect(scope.structural).toEqual([{ file: 'src/tax/DOMAIN.md', change: 'added' }]);

    const report = formatWayfindingAudit(audit, scope);
    expect(report).toContain('top-level domain tax is not on the map');
    expect(report).toContain('ownership change: src/pricing/DOMAIN.md (Owns); must be its own segment');
  });
});
