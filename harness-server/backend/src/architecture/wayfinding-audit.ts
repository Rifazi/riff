import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DOMAIN_DOC, MAP_PATH, interfaceStem, type WayfindingConfig } from './architecture.js';

// The mechanical guardrails and doc checks of a Wayfinding codebase (paper
// sections 10 and 12), generalized from the reference repo's
// example/tools/check.ts: any source folder, any interface file name,
// JS/TS imports including tsconfig path aliases, and table checks only when
// the repo defines TypeORM entities. Semantic checks (duplicate authority,
// undeclared mirrors, misplaced decisions) need judgment and are left to
// the QA agent. Read-only, unless asked to regenerate the generated
// Consumers sections. Shared by the audit_architecture tool and the Apps page.

export type ProblemKind = 'structure' | 'docs' | 'map' | 'data';

export interface WayfindingProblem {
  kind: ProblemKind;
  // Repo-relative file the problem is in.
  file: string;
  // The domain it belongs to (its id, e.g. "pricing/promotions"); null for MAP.md.
  domain: string | null;
  message: string;
}

export interface WayfindingDomainSummary {
  id: string;
  dir: string;
  parent: string | null;
  junction: boolean;
  owns: string | null;
  interface: string | null;
  checkpoint: string | null;
}

export interface WayfindingAudit {
  srcDir: string;
  interfaceFile: string;
  srcDirExists: boolean;
  mapExists: boolean;
  domains: WayfindingDomainSummary[];
  // Top-level folders under srcDir with no domain in them: legacy code not on the map yet.
  offMap: string[];
  problems: WayfindingProblem[];
  // DOMAIN.md files whose Consumers section was rewritten (regenerate: true).
  regenerated: string[];
  usesTypeOrm: boolean;
  // Only when srcDir doesn't exist: folders elsewhere that hold domains, i.e.
  // the app's source folder setting probably points at the wrong place.
  srcDirCandidates?: string[];
}

interface Domain {
  dir: string; // absolute
  rel: string; // repo-relative dir
  id: string; // relative to srcDir
  name: string;
  parent: Domain | null;
  children: Domain[];
  doc: string;
}

const CODE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', 'cdk.out', 'target', 'vendor']);
const MAX_DEPTH = 10;
const GENERATED_BLOCK = /<!-- generated: do not edit -->[\s\S]*?<!-- end generated -->/;

const toPosix = (p: string) => p.split(path.sep).join('/');
const isCode = (file: string) => CODE_EXTS.includes(path.extname(file)) && !file.endsWith('.d.ts');
const isTest = (file: string) => /\.(test|spec)\.[^./]+$/.test(file) || file.split(path.sep).includes('__tests__');
const stemOf = (file: string) => path.basename(file).replace(/\.[^.]+$/, '');

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function walkFiles(dir: string, depth = 0): string[] {
  if (depth > MAX_DEPTH) return [];
  return listDir(dir).flatMap((entry) => {
    if (entry.startsWith('.') || SKIP_DIRS.has(entry)) return [];
    const p = path.join(dir, entry);
    return isDir(p) ? walkFiles(p, depth + 1) : [p];
  });
}

// ------------------------------------------------------------ DOMAIN.md parsing

export function headerField(doc: string, field: string): string | undefined {
  return doc.match(new RegExp(`^${field}:[ \\t]*(.+)$`, 'm'))?.[1].trim();
}

export function sectionBody(doc: string, title: string): string {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${title}\\s*$`, 'i').test(l));
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

function listOf(value: string | undefined): string[] {
  if (!value || /^none\b/i.test(value)) return [];
  return value
    .split(',')
    .map((s) => s.trim().split(/\s/)[0])
    .filter(Boolean);
}

const isPlaceholder = (value: string | undefined) => Boolean(value && /^<[^>]+>/.test(value));

export interface ParsedRule {
  text: string;
  anchor: { file: string; test: string } | null;
}

export function parseRules(doc: string): ParsedRule[] {
  return sectionBody(doc, 'Rules')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/^- /m)
    .slice(1)
    .map((rule) => {
      const anchor = rule.match(/Enforced by:\s*`?([^\s`]+)`?\s*(?:›|>|»)\s*["“]([^"”]+)["”]/);
      return { text: rule.split('\n')[0].trim(), anchor: anchor ? { file: anchor[1], test: anchor[2] } : null };
    })
    .filter((r) => r.text && !isPlaceholder(r.text));
}

function testExists(body: string, name: string): boolean {
  if (!body) return false;
  if ([`'${name}'`, `"${name}"`, `\`${name}\``].some((q) => body.includes(q))) return true;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b(?:def|fn|func|function)\\s+${escaped}\\b`).test(body);
}

// ----------------------------------------------------------- import resolution

interface AliasRule {
  prefix: string;
  wildcard: boolean;
  targets: string[]; // absolute, without the trailing *
}

// tsconfig/jsconfig is JSONC: drop comments and trailing commas outside strings.
function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function loadAliases(repoRoot: string): { aliases: AliasRule[]; baseUrl: string | null } {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(repoRoot, name);
    if (!existsSync(file)) continue;
    try {
      const options = ((parseJsonc(readText(file)) as { compilerOptions?: Record<string, unknown> }).compilerOptions ?? {}) as {
        baseUrl?: string;
        paths?: Record<string, string[]>;
      };
      const base = path.resolve(repoRoot, options.baseUrl ?? '.');
      const aliases = Object.entries(options.paths ?? {}).map(([key, targets]) => ({
        prefix: key.replace(/\*$/, ''),
        wildcard: key.endsWith('*'),
        targets: (targets ?? []).map((t) => path.resolve(base, t.replace(/\*$/, ''))),
      }));
      return { aliases, baseUrl: options.baseUrl ? base : null };
    } catch {
      // an unparseable tsconfig only means aliased imports go unchecked
    }
  }
  return { aliases: [], baseUrl: null };
}

function resolveFile(candidate: string): string | null {
  const tries = [candidate];
  const ext = path.extname(candidate);
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    const bare = candidate.slice(0, -ext.length);
    tries.push(...CODE_EXTS.map((e) => bare + e));
  }
  tries.push(...CODE_EXTS.map((e) => candidate + e), ...CODE_EXTS.map((e) => path.join(candidate, `index${e}`)));
  for (const t of tries) {
    try {
      if (statSync(t).isFile()) return t;
    } catch {
      // try the next
    }
  }
  return null;
}

const IMPORT_PATTERNS = [
  /\b(?:import|export)\s[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

export function importSpecifiers(source: string): string[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const found = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) for (const m of withoutComments.matchAll(pattern)) found.add(m[1]);
  return [...found];
}

function resolveImport(
  spec: string,
  fromFile: string,
  resolver: { aliases: AliasRule[]; baseUrl: string | null }
): string | null {
  if (spec.startsWith('.')) return resolveFile(path.resolve(path.dirname(fromFile), spec));
  for (const alias of resolver.aliases) {
    const matches = alias.wildcard ? spec.startsWith(alias.prefix) : spec === alias.prefix;
    if (!matches) continue;
    const rest = alias.wildcard ? spec.slice(alias.prefix.length) : '';
    for (const target of alias.targets) {
      const hit = resolveFile(path.join(target, rest));
      if (hit) return hit;
    }
  }
  if (resolver.baseUrl && !spec.startsWith('@') && !spec.includes(':')) {
    return resolveFile(path.join(resolver.baseUrl, spec));
  }
  return null;
}

// ------------------------------------------------------------------- the audit

function discoverDomains(srcRoot: string, repoRoot: string): { domains: Domain[]; offMap: string[] } {
  const domains: Domain[] = [];
  const visit = (dir: string, parent: Domain | null, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    let found = false;
    for (const entry of listDir(dir).sort()) {
      if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
      const p = path.join(dir, entry);
      if (!isDir(p)) continue;
      if (existsSync(path.join(p, DOMAIN_DOC))) {
        const d: Domain = {
          dir: p,
          rel: toPosix(path.relative(repoRoot, p)),
          id: toPosix(path.relative(srcRoot, p)),
          name: entry,
          parent,
          children: [],
          doc: readText(path.join(p, DOMAIN_DOC)),
        };
        domains.push(d);
        parent?.children.push(d);
        visit(p, d, depth + 1);
        found = true;
      } else if (visit(p, parent, depth + 1)) {
        found = true;
      }
    }
    return found;
  };

  const offMap: string[] = [];
  for (const entry of listDir(srcRoot).sort()) {
    if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
    const p = path.join(srcRoot, entry);
    if (!isDir(p)) continue;
    const before = domains.length;
    if (existsSync(path.join(p, DOMAIN_DOC))) {
      // A top-level domain; visit it via the same path as nested ones.
      const d: Domain = {
        dir: p,
        rel: toPosix(path.relative(repoRoot, p)),
        id: entry,
        name: entry,
        parent: null,
        children: [],
        doc: readText(path.join(p, DOMAIN_DOC)),
      };
      domains.push(d);
      visit(p, d, 1);
    } else {
      visit(p, null, 1);
    }
    if (domains.length === before) offMap.push(toPosix(path.relative(repoRoot, p)));
  }
  return { domains, offMap };
}

function consumersBlock(consumers: string[]): string {
  return `<!-- generated: do not edit -->\n${consumers.length ? `- ${consumers.join(', ')}\n` : '- none\n'}<!-- end generated -->`;
}

/**
 * `regenerate` rewrites stale generated Consumers sections instead of
 * reporting them; a function limits it to the DOMAIN.md paths (repo-relative)
 * it accepts, e.g. a team member's owned paths.
 */
export function auditWayfinding(
  repoRoot: string,
  config: WayfindingConfig,
  opts: { regenerate?: boolean | ((docPath: string) => boolean) } = {}
): WayfindingAudit {
  const srcRoot = path.resolve(repoRoot, config.srcDir);
  const mapFile = path.join(repoRoot, MAP_PATH);
  const audit: WayfindingAudit = {
    srcDir: config.srcDir,
    interfaceFile: config.interfaceFile,
    srcDirExists: isDir(srcRoot),
    mapExists: existsSync(mapFile),
    domains: [],
    offMap: [],
    problems: [],
    regenerated: [],
    usesTypeOrm: false,
  };
  if (!audit.srcDirExists) {
    const candidates = walkFiles(repoRoot)
      .filter((f) => path.basename(f) === DOMAIN_DOC)
      .map((f) => path.relative(repoRoot, path.dirname(path.dirname(f))).split(path.sep).join('/'))
      .filter((dir) => dir && dir !== '.');
    if (candidates.length) audit.srcDirCandidates = [...new Set(candidates)].sort();
    return audit;
  }

  const { domains, offMap } = discoverDomains(srcRoot, repoRoot);
  audit.offMap = offMap;
  const problems = audit.problems;
  const fail = (kind: ProblemKind, file: string, domain: Domain | null, message: string) =>
    problems.push({ kind, file, domain: domain?.id ?? null, message });
  const rel = (p: string) => toPosix(path.relative(repoRoot, p));
  const docPath = (d: Domain) => `${d.rel}/${DOMAIN_DOC}`;
  const stem = interfaceStem(config);

  const ownerOf = (file: string): Domain | undefined =>
    domains.filter((d) => file.startsWith(d.dir + path.sep)).sort((a, b) => b.dir.length - a.dir.length)[0];
  const isAncestor = (a: Domain, b: Domain): boolean => {
    for (let p = b.parent; p; p = p.parent) if (p === a) return true;
    return false;
  };

  // ---- import guardrails
  const resolver = loadAliases(repoRoot);
  const edges = new Map<Domain, Set<Domain>>();
  const codeFiles = walkFiles(srcRoot).filter(isCode);
  const entitiesByDomain = new Map<Domain, string[]>();

  for (const file of codeFiles) {
    const from = ownerOf(file);
    const text = readText(file);
    if (from && !isTest(file)) {
      const entities = [...text.matchAll(/@Entity\(\s*(?:\{\s*name:\s*)?['"](\w+)['"]/g)].map((m) => m[1]);
      if (entities.length) {
        audit.usesTypeOrm = true;
        entitiesByDomain.set(from, [...(entitiesByDomain.get(from) ?? []), ...entities]);
      }
    }
    if (!from) continue;
    for (const spec of importSpecifiers(text)) {
      const target = resolveImport(spec, file, resolver);
      if (!target) continue;
      const to = ownerOf(target);
      if (!to || to === from) continue;
      const where = `${rel(file)} imports ${rel(target)}`;
      if (isAncestor(to, from)) {
        fail('structure', rel(file), from, `${where}: a child domain may not depend on its parent (${to.id})`);
        continue;
      }
      if (!(path.dirname(target) === to.dir && stemOf(target) === stem)) {
        fail('structure', rel(file), from, `${where}: reaches a private file of ${to.id}; import its ${config.interfaceFile}`);
      }
      if (to.parent && from !== to.parent && from.parent !== to.parent) {
        fail('structure', rel(file), from, `${where}: ${to.id} is a child domain, visible only inside ${to.parent.id}`);
      }
      // Tests may reach other domains to set up scenarios, but they aren't consumers.
      if (!isTest(file)) {
        if (!edges.has(from)) edges.set(from, new Set());
        edges.get(from)!.add(to);
      }
    }
  }

  // ---- dependency cycles between domains
  {
    const state = new Map<Domain, 'visiting' | 'done'>();
    const reported = new Set<string>();
    const visit = (d: Domain, trail: Domain[]) => {
      if (state.get(d) === 'done') return;
      if (state.get(d) === 'visiting') {
        const loop = trail.slice(trail.indexOf(d));
        const key = loop.map((x) => x.id).sort().join('|');
        if (!reported.has(key)) {
          reported.add(key);
          fail('structure', docPath(d), d, `dependency cycle: ${[...loop, d].map((x) => x.id).join(' → ')}`);
        }
        return;
      }
      state.set(d, 'visiting');
      for (const next of edges.get(d) ?? []) visit(next, [...trail, d]);
      state.set(d, 'done');
    };
    for (const d of domains) visit(d, []);
  }

  // ---- DOMAIN.md
  const ruleOwners = new Map<string, string>();
  const tableOwners = new Map<string, string>();
  const srcFileNames = new Set(codeFiles.map((f) => path.basename(f)));

  for (const d of domains) {
    let doc = d.doc;
    const here = docPath(d);

    const parent = headerField(doc, 'Parent');
    const expectedParent = d.parent ? d.parent.name : 'none';
    if (!parent || !(parent.startsWith(expectedParent) || (d.parent && parent.startsWith(d.parent.id)))) {
      fail('docs', here, d, `Parent is "${parent ?? '(missing)'}", but the folder says ${expectedParent}`);
    }
    const declaredChildren = listOf(headerField(doc, 'Child domains')).sort().join(', ');
    const actualChildren = d.children.map((c) => c.name).sort().join(', ');
    if (declaredChildren !== actualChildren) {
      fail('docs', here, d, `Child domains lists [${declaredChildren}], folders are [${actualChildren}]`);
    }
    for (const field of ['Owns', 'Does not own', 'Interface', 'Checkpoint']) {
      const value = headerField(doc, field);
      if (!value) fail('docs', here, d, `missing "${field}:"`);
      else if (isPlaceholder(value)) fail('docs', here, d, `"${field}:" is still the template placeholder`);
    }
    const junction = /^Kind:\s*junction/im.test(doc);
    if (junction && !headerField(doc, 'Inputs')) fail('docs', here, d, 'a junction needs "Inputs:" (the decisions it combines)');

    // One writer per table (only checkable where entities are declared in code).
    if (audit.usesTypeOrm) {
      const tables = entitiesByDomain.get(d) ?? [];
      const declared = listOf(headerField(doc, 'Owns data')).sort().join(', ');
      if (declared !== [...tables].sort().join(', ')) {
        fail('data', here, d, `Owns data lists [${declared}], the code defines [${tables.join(', ')}]`);
      }
      let top = d;
      while (top.parent) top = top.parent;
      const prefix = top.name.replace(/-/g, '_');
      for (const t of tables) {
        if (t !== prefix && !t.startsWith(`${prefix}_`)) fail('data', here, d, `table ${t} should start with ${prefix}_`);
        if (tableOwners.has(t)) fail('data', here, d, `table ${t} is also defined by ${tableOwners.get(t)}`);
        tableOwners.set(t, d.id);
      }
    }

    // Every rule is anchored to a test that exists; no rule appears in two domains.
    for (const rule of parseRules(doc)) {
      if (!rule.anchor) {
        fail('docs', here, d, `rule has no "Enforced by" test: ${rule.text}`);
      } else {
        const candidates = [path.join(d.dir, rule.anchor.file), path.join(repoRoot, rule.anchor.file)];
        const testFile = candidates.find((c) => existsSync(c));
        if (!testFile || !testExists(readText(testFile), rule.anchor.test)) {
          fail('docs', here, d, `rule anchored to a missing test: ${rule.anchor.file} › "${rule.anchor.test}"`);
        }
      }
      const key = rule.text.toLowerCase();
      if (ruleOwners.has(key)) fail('docs', here, d, `rule also appears in ${ruleOwners.get(key)}: ${rule.text}`);
      else ruleOwners.set(key, here);
    }

    // Files named in Recipes still exist.
    const domainFiles = new Set(walkFiles(d.dir).map((f) => path.basename(f)));
    const recipes = sectionBody(doc, 'Recipes').replace(/<!--[\s\S]*?-->/g, '');
    for (const m of recipes.matchAll(/(?<![\w/.-])([\w./-]+\.(?:tsx?|jsx?|mjs|cjs|sql|py|go|rs|java|kt|rb|cs))\b/g)) {
      const name = m[1];
      const ok = name.includes('/')
        ? existsSync(path.join(d.dir, name)) || existsSync(path.join(repoRoot, name)) || existsSync(path.join(srcRoot, name))
        : domainFiles.has(name) || srcFileNames.has(name) || existsSync(path.join(repoRoot, name));
      if (!ok) fail('docs', here, d, `Recipes mention ${name}, which does not exist`);
    }

    // The generated Consumers section matches the discovered consumers.
    const regenerate = typeof opts.regenerate === 'function' ? opts.regenerate(here) : Boolean(opts.regenerate);
    const consumers = domains
      .filter((other) => edges.get(other)?.has(d))
      .map((other) => (other.parent && other.parent !== d.parent ? other.id : other.name))
      .sort();
    const expected = consumersBlock(consumers);
    const block = doc.match(GENERATED_BLOCK);
    if (!block) {
      if (regenerate) {
        doc = `${doc.replace(/\s*$/, '')}\n\n${/^##\s+Consumers\s*$/im.test(doc) ? '' : '## Consumers\n'}${expected}\n`;
        writeFileSync(path.join(d.dir, DOMAIN_DOC), doc);
        audit.regenerated.push(here);
      } else {
        fail('docs', here, d, 'missing the generated Consumers block');
      }
    } else if (block[0] !== expected) {
      if (regenerate) {
        doc = doc.replace(GENERATED_BLOCK, expected);
        writeFileSync(path.join(d.dir, DOMAIN_DOC), doc);
        audit.regenerated.push(here);
      } else {
        fail('docs', here, d, `Consumers section is stale (should be: ${consumers.join(', ') || 'none'})`);
      }
    }

    audit.domains.push({
      id: d.id,
      dir: d.rel,
      parent: d.parent?.id ?? null,
      junction,
      owns: headerField(doc, 'Owns') ?? null,
      interface: headerField(doc, 'Interface') ?? null,
      checkpoint: headerField(doc, 'Checkpoint') ?? null,
    });
  }

  // ---- MAP.md
  const topLevel = domains.filter((d) => d.parent === null);
  if (!audit.mapExists) {
    if (topLevel.length) fail('map', MAP_PATH, null, `${MAP_PATH} is missing; it should list the ${topLevel.length} top-level domain(s)`);
  } else {
    const rows = parseMapRows(readText(mapFile));
    for (const d of topLevel) {
      const row = rows.find((r) => r.name === d.name || r.name === d.id);
      if (!row) {
        fail('map', MAP_PATH, null, `top-level domain ${d.id} is not on the map`);
        continue;
      }
      const isJunction = /^Kind:\s*junction/im.test(d.doc);
      if (isJunction !== row.owns.toLowerCase().startsWith('junction')) {
        fail('map', MAP_PATH, null, `${d.id} is ${isJunction ? '' : 'not '}a junction, but the map says otherwise`);
      }
    }
    for (const r of rows) {
      if (!topLevel.some((d) => d.name === r.name || d.id === r.name)) {
        fail('map', MAP_PATH, null, `${r.name} is on the map but has no top-level domain folder with a ${DOMAIN_DOC}`);
      }
    }
  }
  return audit;
}

export function parseMapRows(map: string): { name: string; owns: string }[] {
  // Only the first table: the domain index. Later sections hold other lists.
  const body = map.replace(/<!--[\s\S]*?-->/g, '');
  return [...body.matchAll(/^\|\s*`?([\w./-]+)`?\s*\|\s*([^|]*)\|/gm)]
    .map((m) => ({ name: m[1], owns: m[2].trim() }))
    .filter((r) => r.name.toLowerCase() !== 'domain' && /[a-z]/i.test(r.name) && !/^-+$/.test(r.name));
}

// ------------------------------------------------------------- branch scope

export interface BranchScope {
  base: string;
  byDomain: { domain: string; files: string[] }[];
  outside: string[];
  // DOMAIN.md files whose ownership lines (Owns, Does not own, Owns data, Kind, Inputs, Parent, Child domains) changed.
  ownershipEdits: { file: string; fields: string[] }[];
  // DOMAIN.md files added or deleted: structural changes, logged in MAP.md.
  structural: { file: string; change: 'added' | 'removed' }[];
}

const OWNERSHIP_FIELDS = ['Owns', 'Owns data', 'Does not own', 'Kind', 'Inputs', 'Parent', 'Child domains'];

/** Which domains a branch's changed files fall in, and what its DOMAIN.md diff says about ownership. */
export function branchScope(audit: WayfindingAudit, base: string, changedFiles: string[], domainDocDiff: string): BranchScope {
  const domains = [...audit.domains].sort((a, b) => b.dir.length - a.dir.length);
  const byDomain = new Map<string, string[]>();
  const outside: string[] = [];
  for (const file of changedFiles) {
    const owner = domains.find((d) => file.startsWith(`${d.dir}/`));
    if (owner) byDomain.set(owner.id, [...(byDomain.get(owner.id) ?? []), file]);
    else outside.push(file);
  }

  const ownershipEdits: BranchScope['ownershipEdits'] = [];
  const structural: BranchScope['structural'] = [];
  for (const chunk of domainDocDiff.split(/^diff --git /m).slice(1)) {
    const file = chunk.match(/^a\/(\S+) b\/(\S+)/)?.[2];
    if (!file) continue;
    if (/^new file mode/m.test(chunk)) structural.push({ file, change: 'added' });
    else if (/^deleted file mode/m.test(chunk)) structural.push({ file, change: 'removed' });
    else {
      const fields = OWNERSHIP_FIELDS.filter((f) => new RegExp(`^[+-]${f}:`, 'm').test(chunk));
      if (/^[+-].*$/m.test(sectionDiff(chunk, 'Mirrors'))) fields.push('Mirrors');
      if (fields.length) ownershipEdits.push({ file, fields });
    }
  }
  return {
    base,
    byDomain: [...byDomain].map(([domain, files]) => ({ domain, files })).sort((a, b) => a.domain.localeCompare(b.domain)),
    outside,
    ownershipEdits,
    structural,
  };
}

// The +/- lines of a diff chunk that fall under a "## <title>" heading (as far
// as the hunk's context shows it).
function sectionDiff(chunk: string, title: string): string {
  const lines = chunk.split('\n');
  let inside = false;
  const out: string[] = [];
  for (const line of lines) {
    const content = line.slice(1);
    if (/^##\s/.test(content)) inside = new RegExp(`^##\\s+${title}\\s*$`, 'i').test(content);
    else if (line.startsWith('@@')) inside = new RegExp(`##\\s+${title}`, 'i').test(line);
    else if (inside && (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      out.push(line);
    }
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ report

const MAX_LISTED = 40;

export function formatWayfindingAudit(audit: WayfindingAudit, scope?: BranchScope | null): string {
  const lines: string[] = [`Wayfinding audit: domains under ${audit.srcDir}/, public interface ${audit.interfaceFile}`];
  if (!audit.srcDirExists) {
    if (audit.srcDirCandidates?.length) {
      lines.push(
        `${audit.srcDir}/ doesn't exist, but there are ${DOMAIN_DOC} files under ${audit.srcDirCandidates.map((d) => `${d}/`).join(', ')}. ` +
          `The app's source folder setting is probably wrong: the human sets it on the Apps page (Architecture). ` +
          'Until then those domains get no mechanical checks; mention this in your summary.'
      );
    } else {
      lines.push(`${audit.srcDir}/ doesn't exist yet, so there are no domains. The first domain is a folder under it with a ${DOMAIN_DOC}.`);
    }
    if (!audit.mapExists) lines.push(`${MAP_PATH} is missing too.`);
    return lines.join('\n');
  }

  const children = audit.domains.filter((d) => d.parent).length;
  const junctions = audit.domains.filter((d) => d.junction).length;
  lines.push(
    audit.domains.length
      ? `${audit.domains.length} domain(s)${children ? `, ${children} of them child domains` : ''}${junctions ? `, ${junctions} junction(s)` : ''}. ${MAP_PATH}: ${audit.mapExists ? 'present' : 'missing'}.`
      : `No domains yet (no ${DOMAIN_DOC} under ${audit.srcDir}/). ${MAP_PATH}: ${audit.mapExists ? 'present' : 'missing'}. ` +
          `A decision gets a domain when a second place needs it; start with the ones this work changes.`
  );
  if (audit.domains.length) {
    lines.push('', 'Domains:');
    for (const d of audit.domains.slice(0, MAX_LISTED)) {
      lines.push(`- ${d.id}${d.junction ? ' (junction)' : ''}: owns ${d.owns ?? '?'}; interface ${d.interface ?? '?'}; checkpoint \`${d.checkpoint ?? '?'}\``);
    }
    if (audit.domains.length > MAX_LISTED) lines.push(`- … ${audit.domains.length - MAX_LISTED} more (see ${MAP_PATH})`);
  }

  if (audit.regenerated.length) lines.push('', `Regenerated the Consumers section in: ${audit.regenerated.join(', ')}`);

  const touched = scope ? new Set(scope.byDomain.map((d) => d.domain)) : null;
  const inScope = touched ? audit.problems.filter((p) => p.domain === null || touched.has(p.domain)) : audit.problems;
  const elsewhere = touched ? audit.problems.filter((p) => p.domain !== null && !touched.has(p.domain)) : [];
  const listProblems = (title: string, problems: WayfindingProblem[]) => {
    lines.push('', title);
    for (const p of problems.slice(0, MAX_LISTED)) {
      lines.push(`- [${p.kind}] ${p.message.startsWith(p.file) ? p.message : `${p.file}: ${p.message}`}`);
    }
    if (problems.length > MAX_LISTED) lines.push(`- … ${problems.length - MAX_LISTED} more`);
  };
  if (!audit.problems.length) lines.push('', '✓ No problems: structure, data ownership, rules, recipes, consumers and map all check out.');
  else if (!touched) listProblems(`✗ ${audit.problems.length} problem(s):`, audit.problems);
  else {
    if (inScope.length) listProblems(`✗ ${inScope.length} problem(s) in MAP.md or domains this branch touched:`, inScope);
    else lines.push('', '✓ No problems in MAP.md or the domains this branch touched.');
    if (elsewhere.length) listProblems(`${elsewhere.length} problem(s) in domains this branch didn't touch (pre-existing, or knock-on from an interface change):`, elsewhere);
  }

  if (scope) {
    lines.push('', `Branch scope (vs ${scope.base}):`);
    if (!scope.byDomain.length && !scope.outside.length) lines.push('- no changes yet');
    for (const d of scope.byDomain) lines.push(`- ${d.domain}: ${d.files.length} file(s)`);
    if (scope.outside.length) {
      const shown = scope.outside.slice(0, 8).join(', ');
      lines.push(`- outside any domain: ${scope.outside.length} file(s) (${shown}${scope.outside.length > 8 ? ', …' : ''})`);
    }
    for (const s of scope.structural) lines.push(`- structural change: ${s.file} ${s.change} (log it under "Structural changes" in ${MAP_PATH}; its own segment)`);
    for (const o of scope.ownershipEdits) lines.push(`- ownership change: ${o.file} (${o.fields.join(', ')}); must be its own segment`);
  }

  if (audit.offMap.length) {
    const shown = audit.offMap.slice(0, 12).join(', ');
    lines.push('', `Not on the map yet (legacy code, fine until a change needs a domain there): ${shown}${audit.offMap.length > 12 ? ', …' : ''}`);
  }
  return lines.join('\n');
}
