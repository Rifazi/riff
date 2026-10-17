import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DOMAIN_DOC, MAP_PATH, interfaceStem, type WayfindingConfig } from './architecture.js';
import { publicSignatures } from './signatures.js';

// The mechanical guardrails and doc checks of a Wayfinding codebase (paper
// sections 10 and 12), generalized from the reference repo's
// example/tools/check.ts: any source folder, any interface file name,
// JS/TS imports including tsconfig path aliases, and table checks only when
// the repo defines TypeORM entities. Semantic checks (duplicate authority,
// undeclared mirrors, misplaced decisions) need judgment and are left to
// the QA agent. Read-only, unless asked to regenerate the generated
// Consumers and Files sections. Shared by the audit_architecture tool and the Apps page.

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
  // The app's source folders, as configured.
  srcDirs: string[];
  interfaceFile: string;
  // Configured source folders that don't exist.
  missingSrcDirs: string[];
  // True when every configured source folder exists.
  srcDirExists: boolean;
  mapExists: boolean;
  domains: WayfindingDomainSummary[];
  // Top-level folders under the source folders with no domain in them: legacy code not on the map yet.
  offMap: string[];
  // Folders inside a domain that hold code but have no DOMAIN.md of their
  // own. Every such folder (a component, a page's part, a module) is meant to
  // be a child domain, so a parent's DOMAIN.md never has to describe it.
  undocumented: { folder: string; parent: string }[];
  problems: WayfindingProblem[];
  // DOMAIN.md files whose generated sections were rewritten (regenerate: true).
  regenerated: string[];
  usesTypeOrm: boolean;
  // Folders outside every audited source folder that hold domains: the app's
  // source folder setting is missing them (or points at the wrong place).
  srcDirCandidates?: string[];
  // Set when no configured folder exists and there is exactly one candidate:
  // it is audited in their place, so a wrong setting doesn't switch the checks off.
  inferredSrcDir?: string;
}

interface Domain {
  dir: string; // absolute
  rel: string; // repo-relative dir
  id: string; // relative to its source folder
  name: string;
  parent: Domain | null;
  children: Domain[];
  doc: string;
}

const CODE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', 'cdk.out', 'target', 'vendor']);
const MAX_DEPTH = 10;
// Folders of tests and fixtures are part of the domain they sit in, never a child domain.
const TEST_DIRS = new Set(['__tests__', '__mocks__', '__snapshots__', '__fixtures__', 'fixtures', 'test', 'tests']);
const GENERATED_BLOCK = /<!-- generated: do not edit -->[\s\S]*?<!-- end generated -->/;
const FILES_BLOCK = /<!-- generated: files, do not edit -->[\s\S]*?<!-- end generated -->/;
const MAX_FILES_LISTED = 60;
const MAX_EXPORTS_LISTED = 8;

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
    .map((s) => s.trim().replace(/`/g, '').split(/\s/)[0])
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

/**
 * The test in `body` whose name shares the most words with `name`, for a rule
 * anchored to a name that doesn't exist (usually a reworded or retyped
 * title), so the fix needs no search. Null when nothing is close.
 */
export function closestTestName(body: string, name: string): string | null {
  const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const wanted = words(name);
  if (!wanted.size) return null;
  let best: { name: string; score: number } | null = null;
  for (const m of body.matchAll(/\b(?:it|test|describe)(?:\.\w+)?\(\s*(['"`])((?:(?!\1).)+)\1/g)) {
    const have = words(m[2]);
    const shared = [...wanted].filter((w) => have.has(w)).length;
    const score = shared / new Set([...wanted, ...have]).size;
    if (score > (best?.score ?? 0)) best = { name: m[2], score };
  }
  return best && best.score >= 0.5 ? best.name : null;
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

/** Every domain under the app's source folders (just their ids and folders: no checks). */
export function listDomains(repoRoot: string, config: WayfindingConfig): { id: string; dir: string }[] {
  return config.srcDirs
    .map((d) => path.resolve(repoRoot, d))
    .filter(isDir)
    .flatMap((root) => discoverDomains(root, repoRoot).domains)
    .map((d) => ({ id: d.id, dir: d.rel }));
}

/**
 * Folders inside a domain that directly hold (non-test) code and have no
 * DOMAIN.md, at any depth: each should be a child domain of the nearest
 * domain above it. Child domains are left to their own pass.
 */
function undocumentedFolders(d: Domain, repoRoot: string): { folder: string; parent: string }[] {
  const found: { folder: string; parent: string }[] = [];
  const childDirs = new Set(d.children.map((c) => c.dir));
  const visit = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const entry of listDir(dir).sort()) {
      if (entry.startsWith('.') || SKIP_DIRS.has(entry) || TEST_DIRS.has(entry)) continue;
      const p = path.join(dir, entry);
      if (!isDir(p) || childDirs.has(p) || existsSync(path.join(p, DOMAIN_DOC))) continue;
      const holdsCode = listDir(p).some((f) => isCode(f) && !isTest(path.join(p, f)) && !isDir(path.join(p, f)));
      if (holdsCode) found.push({ folder: toPosix(path.relative(repoRoot, p)), parent: d.id });
      visit(p, depth + 1);
    }
  };
  visit(d.dir, 0);
  return found;
}

// Markdown formatters (prettier, run by git_commit and finish_step) put blank lines around the list.
const withoutBlankLines = (block: string) => block.replace(/\n\s*\n/g, '\n');

/** Empty when nothing imports the domain: the section is left out of its DOMAIN.md. */
function consumersBlock(consumers: string[]): string {
  return consumers.length ? `<!-- generated: do not edit -->\n- ${consumers.join(', ')}\n<!-- end generated -->` : '';
}

const EXPORT_DECL =
  /^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST = /^export\s+(?:type\s+)?\{([^}]*)\}/gm;

/** The names a JS/TS module exports, in source order ("default" for an unnamed default export). */
export function exportedNames(source: string): string[] {
  const found: { name: string; at: number }[] = [];
  for (const m of source.matchAll(EXPORT_DECL)) found.push({ name: m[1], at: m.index ?? 0 });
  for (const m of source.matchAll(EXPORT_LIST)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) found.push({ name, at: m.index ?? 0 });
    }
  }
  for (const m of source.matchAll(/^export\s+default\s+(?!(?:async\s+)?(?:function|class|abstract)\b)/gm)) found.push({ name: 'default', at: m.index ?? 0 });
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.name))];
}

/**
 * The generated Files section: one line per file the domain itself holds
 * (child domains list their own), with what each code file exports, so an
 * agent goes from DOMAIN.md straight to the file it needs. `api` is the
 * public file's signatures (publicSignatures), listed under it so another
 * domain can call this one without opening its code. Empty when the domain
 * holds no files: the section is left out of its DOMAIN.md.
 */
export function filesBlock(files: { path: string; source: string | null }[], publicStem: string, api: string[] = []): string {
  const isInterface = (file: string) => !file.includes('/') && isCode(file) && stemOf(file) === publicStem;
  const tests = files.filter((f) => isTest(f.path)).map((f) => `\`${f.path}\``);
  // The interface first: it's what other domains call.
  const lines = files
    .filter((f) => !isTest(f.path))
    .sort((a, b) => Number(isInterface(b.path)) - Number(isInterface(a.path)) || a.path.localeCompare(b.path))
    .map((f) => {
      if (isInterface(f.path) && api.length) {
        const entries = api.map((line) => (line.startsWith('… ') ? `  - ${line}` : `  - \`${line}\``));
        return `- \`${f.path}\` (interface):\n${entries.join('\n')}`;
      }
      const names = f.source === null ? [] : exportedNames(f.source);
      const shown = names.slice(0, MAX_EXPORTS_LISTED).join(', ') + (names.length > MAX_EXPORTS_LISTED ? ', …' : '');
      return `- \`${f.path}\`${isInterface(f.path) ? ' (interface)' : ''}${shown ? `: ${shown}` : ''}`;
    });
  const listed = lines.slice(0, MAX_FILES_LISTED);
  if (lines.length > MAX_FILES_LISTED) listed.push(`- … ${lines.length - MAX_FILES_LISTED} more`);
  if (tests.length) listed.push(`- tests: ${tests.join(', ')}`);
  return listed.length ? `<!-- generated: files, do not edit -->\n${listed.join('\n')}\n<!-- end generated -->` : '';
}

/**
 * The stem of a domain's one public file: the configured interface file
 * (service.ts) when the domain has one, else the file named after its folder
 * (a React page's ProjectListPage/ProjectListPage.tsx), which needs no extra
 * re-export file to be the interface.
 */
export function publicStemOf(dir: string, config: WayfindingConfig): string {
  const stem = interfaceStem(config);
  const hasInterfaceFile = CODE_EXTS.some((ext) => existsSync(path.join(dir, stem + ext)));
  return hasInterfaceFile ? stem : path.basename(dir);
}

/** Files a domain holds itself, relative to its folder: its child domains' files are theirs. */
function ownFiles(d: Domain): string[] {
  const childDirs = d.children.map((c) => c.dir + path.sep);
  return walkFiles(d.dir)
    .filter((f) => path.basename(f) !== DOMAIN_DOC && !childDirs.some((c) => f.startsWith(c)))
    .map((f) => toPosix(path.relative(d.dir, f)))
    .sort();
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
  const mapFile = path.join(repoRoot, MAP_PATH);
  const missing = config.srcDirs.filter((d) => !isDir(path.resolve(repoRoot, d)));
  const audit: WayfindingAudit = {
    srcDirs: config.srcDirs,
    interfaceFile: config.interfaceFile,
    missingSrcDirs: missing,
    srcDirExists: missing.length === 0,
    mapExists: existsSync(mapFile),
    domains: [],
    offMap: [],
    undocumented: [],
    problems: [],
    regenerated: [],
    usesTypeOrm: false,
  };
  let srcRoots = config.srcDirs.filter((d) => !missing.includes(d)).map((d) => path.resolve(repoRoot, d));

  // Domains outside every source folder get no checks, so name the folders they're in.
  const inRoots = (file: string) => srcRoots.some((r) => file.startsWith(r + path.sep));
  const candidates = walkFiles(repoRoot)
    .filter((f) => path.basename(f) === DOMAIN_DOC && !inRoots(f))
    .map((f) => toPosix(path.relative(repoRoot, path.dirname(path.dirname(f)))))
    // A child domain's grandparent is its parent domain, not a source folder.
    .filter((dir) => dir && dir !== '.' && !existsSync(path.join(repoRoot, dir, DOMAIN_DOC)));
  if (candidates.length) audit.srcDirCandidates = [...new Set(candidates)].sort();
  if (!srcRoots.length) {
    if (audit.srcDirCandidates?.length !== 1) return audit;
    audit.inferredSrcDir = audit.srcDirCandidates[0];
    srcRoots = [path.resolve(repoRoot, audit.inferredSrcDir)];
  }

  const domains: Domain[] = [];
  for (const root of srcRoots) {
    const found = discoverDomains(root, repoRoot);
    domains.push(...found.domains);
    audit.offMap.push(...found.offMap);
  }
  const problems = audit.problems;
  const fail = (kind: ProblemKind, file: string, domain: Domain | null, message: string) =>
    problems.push({ kind, file, domain: domain?.id ?? null, message });
  const rel = (p: string) => toPosix(path.relative(repoRoot, p));
  const docPath = (d: Domain) => `${d.rel}/${DOMAIN_DOC}`;
  const publicStems = new Map(domains.map((d) => [d, publicStemOf(d.dir, config)]));

  const ownerOf = (file: string): Domain | undefined =>
    domains.filter((d) => file.startsWith(d.dir + path.sep)).sort((a, b) => b.dir.length - a.dir.length)[0];
  const isAncestor = (a: Domain, b: Domain): boolean => {
    for (let p = b.parent; p; p = p.parent) if (p === a) return true;
    return false;
  };

  for (const d of domains) audit.undocumented.push(...undocumentedFolders(d, repoRoot));

  // Several source folders can each have a domain with the same id.
  const seenIds = new Map<string, Domain>();
  for (const d of domains) {
    const other = seenIds.get(d.id);
    if (other) fail('map', `${d.rel}/${DOMAIN_DOC}`, d, `${d.id} is also a domain at ${other.rel}; domain names must be unique across source folders`);
    else seenIds.set(d.id, d);
  }

  // ---- import guardrails
  const resolver = loadAliases(repoRoot);
  const edges = new Map<Domain, Set<Domain>>();
  const codeFiles = srcRoots.flatMap((root) => walkFiles(root)).filter(isCode);
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
      const publicStem = publicStems.get(to)!;
      if (!(path.dirname(target) === to.dir && isCode(target) && stemOf(target) === publicStem)) {
        const publicFile = publicStem === interfaceStem(config) ? config.interfaceFile : `${publicStem} file`;
        fail('structure', rel(file), from, `${where}: reaches a private file of ${to.id}; import its ${publicFile}`);
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
    if (parent ? !(parent.startsWith(expectedParent) || (d.parent && parent.startsWith(d.parent.id))) : d.parent) {
      fail('docs', here, d, `Parent is "${parent ?? '(missing)'}", but the folder says ${expectedParent}`);
    }
    const declaredChildren = listOf(headerField(doc, 'Child domains')).sort().join(', ');
    const actualChildren = d.children.map((c) => c.name).sort().join(', ');
    if (declaredChildren !== actualChildren) {
      fail('docs', here, d, `Child domains lists [${declaredChildren}], folders are [${actualChildren}]`);
    }
    for (const field of ['Owns', 'Does not own', 'Interface', 'Checkpoint']) {
      const value = headerField(doc, field);
      if (!value) {
        if (field !== 'Does not own') fail('docs', here, d, `missing "${field}:"`);
      } else if (isPlaceholder(value)) fail('docs', here, d, `"${field}:" is still the template placeholder`);
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
        const body = testFile ? readText(testFile) : '';
        if (!testFile) {
          fail('docs', here, d, `rule anchored to a test file that doesn't exist: ${rule.anchor.file} › "${rule.anchor.test}"`);
        } else if (!testExists(body, rule.anchor.test)) {
          const closest = closestTestName(body, rule.anchor.test);
          fail('docs', here, d, `rule anchored to a missing test: ${rule.anchor.file} › "${rule.anchor.test}"${closest ? ` (closest test there: "${closest}")` : ''}`);
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
        ? existsSync(path.join(d.dir, name)) || existsSync(path.join(repoRoot, name)) || srcRoots.some((r) => existsSync(path.join(r, name)))
        : domainFiles.has(name) || srcFileNames.has(name) || existsSync(path.join(repoRoot, name));
      if (!ok) fail('docs', here, d, `Recipes mention ${name}, which does not exist`);
    }

    // The generated sections match the code: Consumers (who imports this
    // domain) and Files (what it holds and exports).
    const regenerate = typeof opts.regenerate === 'function' ? opts.regenerate(here) : Boolean(opts.regenerate);
    const consumers = domains
      .filter((other) => edges.get(other)?.has(d))
      .map((other) => (other.parent && other.parent !== d.parent ? other.id : other.name))
      .sort();
    const files = ownFiles(d).map((f) => ({ path: f, source: isCode(f) ? readText(path.join(d.dir, f)) : null }));
    const publicFile = files.find((f) => !f.path.includes('/') && isCode(f.path) && stemOf(f.path) === publicStems.get(d));
    const api = publicFile ? publicSignatures(path.join(d.dir, publicFile.path), (spec, from) => resolveImport(spec, from, resolver)) : [];
    const sections = [
      { title: 'Files', pattern: FILES_BLOCK, expected: filesBlock(files, publicStems.get(d)!, api), stale: 'Files section is stale (a file was added, removed or changed its exports)' },
      { title: 'Consumers', pattern: GENERATED_BLOCK, expected: consumersBlock(consumers), stale: `Consumers section is stale (should be: ${consumers.join(', ') || 'none'})` },
    ];
    let rewritten = false;
    for (const section of sections) {
      const block = doc.match(section.pattern);
      if (!section.expected) {
        if (!block) continue;
        if (!regenerate) {
          fail('docs', here, d, `${section.title} section is empty: remove it`);
          continue;
        }
        doc = dropSection(doc, section.title, section.pattern);
        rewritten = true;
        continue;
      }
      if (block && withoutBlankLines(block[0]) === withoutBlankLines(section.expected)) continue;
      if (!regenerate) {
        fail('docs', here, d, block ? section.stale : `missing the generated ${section.title} block`);
        continue;
      }
      doc = block ? doc.replace(section.pattern, section.expected) : insertSection(doc, section.title, section.expected);
      rewritten = true;
    }
    if (rewritten) {
      writeFileSync(path.join(d.dir, DOMAIN_DOC), doc);
      audit.regenerated.push(here);
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

/** Removes a generated block and, once nothing else is under it, its heading. */
function dropSection(doc: string, title: string, pattern: RegExp): string {
  const lines = doc.replace(pattern, '').split('\n');
  const heading = lines.findIndex((l) => new RegExp(`^##\\s+${title}\\s*$`, 'i').test(l));
  if (heading !== -1 && !sectionBody(lines.join('\n'), title).trim()) lines.splice(heading, 1);
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '')}\n`;
}

/**
 * Adds a generated block under its heading: an existing "## <title>" keeps
 * its place, else Files goes before Consumers (or Mirrors) and anything else at the end.
 */
function insertSection(doc: string, title: string, block: string): string {
  const lines = doc.replace(/\s*$/, '').split('\n');
  const heading = lines.findIndex((l) => new RegExp(`^##\\s+${title}\\s*$`, 'i').test(l));
  if (heading !== -1) {
    lines.splice(heading + 1, 0, block);
    return `${lines.join('\n')}\n`;
  }
  if (title === 'Files') {
    const before = ['Mirrors', 'Consumers'].map((t) => lines.findIndex((l) => new RegExp(`^##\\s+${t}\\s*$`, 'i').test(l))).find((i) => i !== -1);
    if (before !== undefined) {
      lines.splice(before, 0, `## Files`, block, '');
      return `${lines.join('\n')}\n`;
    }
  }
  return `${lines.join('\n')}\n\n## ${title}\n${block}\n`;
}

export function parseMapRows(map: string): { name: string; owns: string }[] {
  // Only the first table: the domain index. Later sections hold other lists.
  const body = map.replace(/<!--[\s\S]*?-->/g, '');
  // The name may be plain, `code`, or a link to its DOMAIN.md: [name](path).
  return [...body.matchAll(/^\|\s*(?:\[\s*`?([\w./-]+)`?\s*\]\([^)]*\)|`?([\w./-]+)`?)\s*\|\s*([^|]*)\|/gm)]
    .map((m) => ({ name: m[1] ?? m[2], owns: m[3].trim() }))
    .filter((r) => r.name.toLowerCase() !== 'domain' && /[a-z]/i.test(r.name) && !/^-+$/.test(r.name));
}

// ------------------------------------------------------------- branch scope

export interface BranchScope {
  base: string;
  byDomain: { domain: string; files: string[] }[];
  outside: string[];
  // Changed files in a folder that should have a DOMAIN.md and doesn't: a
  // top-level folder under a source folder with no domain (no parent), or a
  // folder of code inside a domain (parent = that domain's id, the child
  // domain it should become).
  offMap: { folder: string; parent: string | null; files: string[] }[];
  // Changed code files sitting directly in a source folder, next to the
  // domain folders, that aren't an entry point: each belongs in a domain's
  // own subfolder.
  looseFiles: string[];
  // DOMAIN.md files whose ownership lines (Owns, Does not own, Owns data, Kind, Inputs, Parent, Child domains) changed.
  ownershipEdits: { file: string; fields: string[] }[];
  // DOMAIN.md files added or deleted: structural changes, logged in MAP.md.
  structural: { file: string; change: 'added' | 'removed' }[];
}

const ENTRY_STEMS = ['index', 'main', 'app', 'server', 'cli'];

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

  // Entry points (src/index.ts, src/app.ts) may sit straight under a source
  // folder; any other code file there should be in a domain's own folder.
  const looseFiles: string[] = [];
  const roots = auditedSrcDirs(audit).filter((d) => d !== '.');
  const offMap = new Map<string, { parent: string | null; files: string[] }>();
  const flag = (folder: string, parent: string | null, file: string) =>
    offMap.set(folder, { parent, files: [...(offMap.get(folder)?.files ?? []), file] });
  for (const file of outside) {
    const root = roots.find((r) => file.startsWith(`${r}/`));
    const rest = root ? file.slice(root.length + 1) : null;
    if (!rest || path.posix.basename(file) === DOMAIN_DOC) continue;
    if (!rest.includes('/')) {
      if (isCode(rest) && !isTest(file) && !ENTRY_STEMS.includes(path.posix.parse(rest).name)) looseFiles.push(file);
      continue;
    }
    flag(`${root}/${rest.split('/')[0]}`, null, file);
  }
  // Inside a domain, the outermost folder without a DOMAIN.md comes first: its
  // own subfolders become its children once it is a domain.
  const undocumented = [...(audit.undocumented ?? [])].sort((a, b) => a.folder.length - b.folder.length);
  for (const file of changedFiles) {
    if (path.posix.basename(file) === DOMAIN_DOC) continue;
    const missing = undocumented.find((u) => file.startsWith(`${u.folder}/`));
    if (missing) flag(missing.folder, missing.parent, file);
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
    looseFiles: looseFiles.sort(),
    offMap: [...offMap]
      .map(([folder, { parent, files }]) => ({ folder, parent, files: files.sort() }))
      .sort((a, b) => a.folder.localeCompare(b.folder)),
    ownershipEdits,
    structural,
  };
}

/** The source folders the audit actually walked. */
function auditedSrcDirs(audit: WayfindingAudit): string[] {
  return audit.inferredSrcDir ? [audit.inferredSrcDir] : audit.srcDirs.filter((d) => !audit.missingSrcDirs.includes(d));
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
  const audited = auditedSrcDirs(audit);
  const folders = (dirs: string[]) => dirs.map((d) => `${d}/`).join(', ');
  const lines: string[] = [`Wayfinding audit: domains under ${folders(audited.length ? audited : audit.srcDirs)}, public interface ${audit.interfaceFile} (or the file named after the domain's folder)`];
  if (audit.inferredSrcDir) {
    lines.push(
      `The app's source folder setting is ${folders(audit.srcDirs)}, which doesn't exist; every ${DOMAIN_DOC} is under ${audit.inferredSrcDir}/, ` +
        `so that folder was audited instead. Tell the human to set the source folder to ${audit.inferredSrcDir} on the Apps page (Architecture).`
    );
  } else if (!audited.length) {
    if (audit.srcDirCandidates?.length) {
      lines.push(
        `${folders(audit.srcDirs)} doesn't exist, but there are ${DOMAIN_DOC} files under ${folders(audit.srcDirCandidates)}. ` +
          `The app's source folder setting is probably wrong: the human sets it on the Apps page (Architecture). ` +
          'Until then those domains get no mechanical checks; mention this in your summary.'
      );
    } else {
      lines.push(`${folders(audit.srcDirs)} doesn't exist yet, so there are no domains. The first domain is a folder under it with a ${DOMAIN_DOC}.`);
    }
    if (!audit.mapExists) lines.push(`${MAP_PATH} is missing too.`);
    return lines.join('\n');
  } else {
    if (audit.missingSrcDirs.length) lines.push(`Configured but missing (no domains there yet): ${folders(audit.missingSrcDirs)}`);
    if (audit.srcDirCandidates?.length) {
      lines.push(
        `${DOMAIN_DOC} files outside the source folders, under ${folders(audit.srcDirCandidates)}, get no checks. ` +
          'Tell the human to add those folders to the app\'s source folders on the Apps page (Architecture).'
      );
    }
  }
  const srcDir = folders(audited);

  const children = audit.domains.filter((d) => d.parent).length;
  const junctions = audit.domains.filter((d) => d.junction).length;
  lines.push(
    audit.domains.length
      ? `${audit.domains.length} domain(s)${children ? `, ${children} of them child domains` : ''}${junctions ? `, ${junctions} junction(s)` : ''}. ${MAP_PATH}: ${audit.mapExists ? 'present' : 'missing'}.`
      : `No domains yet (no ${DOMAIN_DOC} under ${srcDir}). ${MAP_PATH}: ${audit.mapExists ? 'present' : 'missing'}. ` +
          `A decision gets a domain when a second place needs it; start with the ones this work changes.`
  );
  if (audit.domains.length) {
    lines.push('', 'Domains:');
    for (const d of audit.domains.slice(0, MAX_LISTED)) {
      lines.push(`- ${d.id} (${d.dir}/)${d.junction ? ' (junction)' : ''}: owns ${d.owns ?? '?'}; interface ${d.interface ?? '?'}; checkpoint \`${d.checkpoint ?? '?'}\``);
    }
    if (audit.domains.length > MAX_LISTED) lines.push(`- … ${audit.domains.length - MAX_LISTED} more (see ${MAP_PATH})`);
  }

  if (audit.regenerated.length) lines.push('', `Regenerated the Files/Consumers sections in: ${audit.regenerated.join(', ')}`);

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
  const offMap = scope?.offMap ?? [];
  const loose = scope?.looseFiles ?? [];
  if (loose.length) {
    lines.push(
      '',
      `✗ This branch put ${loose.length} code file(s) loose in a source folder: ${loose.slice(0, 5).join(', ')}${loose.length > 5 ? ', …' : ''}`,
      `  Every domain is its own subfolder with its ${DOMAIN_DOC}, its code and its tests together; only an entry point (index, main, app, server, cli) ` +
        `may sit directly under a source folder. Move each file into the subfolder of the domain that owns its decision (a new domain gets a new ` +
        `subfolder and ${DOMAIN_DOC}, logged in ${MAP_PATH}).`
    );
  }
  if (!audit.problems.length && !offMap.length && !loose.length) lines.push('', '✓ No problems: structure, data ownership, rules, recipes, files, consumers and map all check out.');
  else if (!touched) listProblems(`✗ ${audit.problems.length} problem(s):`, audit.problems);
  else {
    if (inScope.length) listProblems(`✗ ${inScope.length} problem(s) in MAP.md or domains this branch touched:`, inScope);
    else if (!offMap.length && !loose.length) lines.push('', '✓ No problems in MAP.md or the domains this branch touched.');
    if (offMap.length) {
      lines.push('', `✗ This branch changed code in ${offMap.length} folder(s) with no ${DOMAIN_DOC}:`);
      for (const o of offMap) {
        const shown = o.files.slice(0, 5).join(', ');
        const what = o.parent ? `child domain of ${o.parent}` : `top-level domain, add it to ${MAP_PATH}`;
        lines.push(`- ${o.folder}/: ${what} (${shown}${o.files.length > 5 ? ', …' : ''})`);
      }
      lines.push(
        `  Give each one a ${DOMAIN_DOC}, created before you change its code (a folder you're adding gets one with it): fill ` +
          `it in from the code (Owns, Interface, Checkpoint, and only what has content: the Rules its code implements anchored to tests that exist, ` +
          `Hidden behavior, Recipes); leave out any line or section with nothing in it, never write "none". A child domain's Parent is the domain above it; add it to that parent's "Child ` +
          `domains" and move the parent's rules about it into the new ${DOMAIN_DOC}. Its public file is the code file named ` +
          `after its folder unless it has a service.ts. Log it under Structural changes in ${MAP_PATH}, then run ` +
          'audit_architecture({ regenerate: true }).'
      );
    }
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

  if (audit.undocumented.length) {
    const shown = audit.undocumented.slice(0, 12).map((u) => `${u.folder}/ (in ${u.parent})`).join(', ');
    lines.push(
      '',
      `Folders of code inside a domain with no ${DOMAIN_DOC} of their own (each becomes a child domain when a change touches it): ` +
        `${shown}${audit.undocumented.length > 12 ? ', …' : ''}`
    );
  }
  if (audit.offMap.length) {
    const shown = audit.offMap.slice(0, 12).join(', ');
    lines.push('', `Not on the map yet (legacy code, fine until a change needs a domain there): ${shown}${audit.offMap.length > 12 ? ', …' : ''}`);
  }
  return lines.join('\n');
}
