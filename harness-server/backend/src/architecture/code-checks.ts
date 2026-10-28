import { builtinModules } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

export const DOC_KINDS = ['domain', 'child domain', 'junction', 'adapter', 'shared'] as const;
export const README_REVIEW_LINES = 80;

// Adapters that receive calls from outside (HTTP, queues, webhooks): they may call only their domain's public file.
const INBOUND_ADAPTERS = new Set(['routes', 'handlers', 'controllers', 'api', 'consumers', 'listeners', 'webhooks']);

export interface DomainRef {
  id: string;
  name: string;
  dir: string;
  kind?: string;
  parent: DomainRef | null;
}

export interface ImportEdge {
  file: string;
  abs: string;
  from: DomainRef;
  to: DomainRef;
  target: string;
}

export interface PackageImport {
  file: string;
  from: DomainRef;
  pkg: string;
}

export interface CheckProblem {
  file: string;
  domain: DomainRef | null;
  message: string;
}

export const CONTAINS_BLOCK = /<!-- generated: contains, do not edit -->[\s\S]*?<!-- end generated -->/;
const GENERATED_BLOCKS = /<!-- generated: (?:files, |contains, )?do not edit -->[\s\S]*?<!-- end generated -->/g;

export const docKind = (doc: string): string | undefined => doc.match(/^Kind:[ \t]*(.+)$/m)?.[1].trim().toLowerCase();

const isAdapter = (d: DomainRef) => d.kind === 'adapter';
export const isInbound = (d: DomainRef) => isAdapter(d) && INBOUND_ADAPTERS.has(d.name);
const isShared = (d: DomainRef) => d.kind === 'shared' || d.name === 'shared';

export function containsBlock(items: { name: string; kind: string }[]): string {
  if (!items.length) return '';
  const lines = [...items].sort((a, b) => a.name.localeCompare(b.name)).map((i) => `- ${i.name} (${i.kind})`);
  return `<!-- generated: contains, do not edit -->\n${lines.join('\n')}\n<!-- end generated -->`;
}

/** Lines of a README.md that a person writes: generated sections and blank lines don't count. */
export function handWrittenLines(doc: string): number {
  return doc.replace(GENERATED_BLOCKS, '').split('\n').filter((l) => l.trim()).length;
}

// ---------------------------------------------------------------- comments

// Comments a tool reads: lint and compiler directives, generated markers, license headers.
const TOOL_COMMENT =
  /^(?:\/\/+|\/\*+!?)\s*(?:eslint|@ts-|prettier-ignore|istanbul|c8\b|v8\b|jshint|tslint|biome|@vitest|vitest|@jest|jest-|@jsx|@refresh|webpack|<reference|#|generated\b)/i;
const LICENSE_COMMENT = /@license|@preserve|copyright|spdx-license/i;

const scriptKind = (file: string) =>
  /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?js$|\.jsx$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TS;

/** The comments in a JS/TS file other than the ones a tool reads, each squeezed to one short line. */
export function codeComments(source: string, file: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  const seen = new Set<number>();
  const ranges: ts.CommentRange[] = [];
  const jsxText: [number, number][] = [];
  const add = (found?: ts.CommentRange[]) => {
    for (const r of found ?? []) {
      if (seen.has(r.pos)) continue;
      seen.add(r.pos);
      ranges.push(r);
    }
  };
  const visit = (node: ts.Node) => {
    const children = node.getChildren(sf);
    if (children.length) return children.forEach(visit);
    if (node.kind === ts.SyntaxKind.JsxText) return void jsxText.push([node.getFullStart(), node.getEnd()]);
    add(ts.getLeadingCommentRanges(sf.text, node.getFullStart()));
    add(ts.getTrailingCommentRanges(sf.text, node.getEnd()));
  };
  visit(sf);
  const texts = ranges
    .filter((r) => !jsxText.some(([a, b]) => r.pos >= a && r.pos < b))
    .map((r) => sf.text.slice(r.pos, r.end))
    .filter((t) => !TOOL_COMMENT.test(t) && !LICENSE_COMMENT.test(t))
    .map((t) => t.replace(/^\/\/+|^\/\*+|\*+\/$/g, '').replace(/\s*\n\s*\*?\s*/g, ' ').trim())
    .filter(Boolean)
    .map((t) => (t.length > 60 ? `${t.slice(0, 57)}...` : t));
  return [...new Set(texts)];
}

// ----------------------------------------------------------------- dead code

// Exports a framework or runtime reads by name or by file name, so no import names them.
const CONVENTION_NAMES = new Set(['default', 'handler', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'metadata', 'config', 'middleware', 'generateStaticParams', 'generateMetadata', 'getServerSideProps', 'getStaticProps']);
const CONVENTION_STEMS = new Set(['index', 'main', 'app', 'server', 'cli', 'page', 'layout', 'route', 'loading', 'error', 'not-found', 'template', 'middleware', 'instrumentation']);

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Exports no other file mentions and their own file uses only where it
 * declares them: nothing calls them, so the segment that stopped needing them
 * deletes them. `declared` is text where a consumer the code can't show (another
 * repository, a deploy script) is named; a name in it is kept.
 */
export function unusedExports(
  candidates: { file: string; names: string[]; declared: string }[],
  sources: { file: string; source: string }[]
): { file: string; name: string }[] {
  const wanted = new Set(candidates.flatMap((c) => c.names));
  const seen = new Map<string, Map<string, number>>();
  for (const { file, source } of sources) {
    for (const word of source.match(/[A-Za-z_$][\w$]*/g) ?? []) {
      if (!wanted.has(word)) continue;
      const perFile = seen.get(word) ?? new Map<string, number>();
      perFile.set(file, (perFile.get(file) ?? 0) + 1);
      seen.set(word, perFile);
    }
  }
  const out: { file: string; name: string }[] = [];
  for (const c of candidates) {
    if (CONVENTION_STEMS.has(path.basename(c.file).replace(/\.[^.]+$/, '')) || /\.config\.[^/]+$/.test(c.file)) continue;
    for (const name of c.names) {
      if (CONVENTION_NAMES.has(name) || new RegExp(`(?<![\\w$])${escapeRegex(name)}(?![\\w$])`).test(c.declared)) continue;
      const perFile = seen.get(name);
      const elsewhere = [...(perFile?.keys() ?? [])].some((f) => f !== c.file);
      if (!elsewhere && (perFile?.get(c.file) ?? 0) <= 1) out.push({ file: c.file, name });
    }
  }
  return out;
}

// ---------------------------------------------------------------- adapters

/**
 * Adapter and shared-code rules (paper section 10): an adapter is called
 * only by its own domain's public file; an inbound adapter calls only that
 * public file (or shared code beside it); shared code imports nothing from
 * its siblings. `isPublic(target, domain)` says whether a file is a domain's
 * public file.
 */
export function adapterProblems(edges: ImportEdge[], isPublic: (target: string, domain: DomainRef) => boolean): CheckProblem[] {
  const out: CheckProblem[] = [];
  for (const { file, abs, from, to, target } of edges) {
    if (isAdapter(to)) {
      const owner = to.parent;
      if (!owner || from !== owner || !isPublic(abs, owner)) {
        out.push({
          file,
          domain: from,
          message: `${file} imports ${to.id}, an adapter: only ${owner ? `${owner.id}'s public file` : 'its own domain'} may call it. Reach it through the domain's public file.`,
        });
      }
    } else if (isInbound(from)) {
      const owner = from.parent;
      const allowed = owner && ((to === owner && isPublic(target, to)) || (isShared(to) && to.parent === owner));
      if (!allowed) {
        out.push({
          file,
          domain: from,
          message: `${file} (inbound adapter ${from.id}) imports ${to.id}: an inbound adapter calls only ${owner ? `${owner.id}'s public file` : 'its domain'}.`,
        });
      }
    }
    if (isShared(from) && to !== from && to.parent === from.parent) {
      out.push({
        file,
        domain: from,
        message: `${file} (shared code) imports ${to.id}, its sibling: shared code makes no decisions and imports nothing from its siblings.`,
      });
    }
  }
  return out;
}

// ----------------------------------------------------------- external systems

/** MAP.md's "External systems" bullets: `- Stripe: payments/stripe` and optionally `(stripe, @stripe/stripe-js)` naming the client packages. */
export function externalSystems(map: string): { name: string; path: string; packages: string[] }[] {
  const lines = map.split('\n');
  const start = lines.findIndex((l) => /^##\s+external systems\s*$/i.test(l.trim()));
  if (start === -1) return [];
  const out: { name: string; path: string; packages: string[] }[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const m = line.match(/^\s*[-*]\s+([^:]+?):\s*`?\[?([\w./-]+)`?\]?(?:\([^)]*\))?\s*(?:\(([^)]*)\))?\s*$/);
    if (!m) continue;
    const packages = (m[3] ?? '').split(',').map((p) => p.trim().replace(/`/g, '')).filter(Boolean);
    out.push({ name: m[1].trim(), path: m[2].replace(/\/+$/, ''), packages });
  }
  return out;
}

const BUILTINS = new Set(builtinModules);

/** The npm package an import specifier names; null for relative paths, node: and built-in modules. */
export function barePackage(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.includes(':')) return null;
  const parts = spec.split('/');
  const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return BUILTINS.has(pkg) ? null : pkg;
}

/**
 * Each external system is reached through one domain's adapter: a file outside
 * that adapter importing the system's client package is a second domain
 * talking to it. The packages are the ones MAP.md lists for the system, else
 * those the adapter imports whose name contains the system's name.
 */
export function externalClientProblems(
  systems: { name: string; path: string; packages: string[] }[],
  domains: DomainRef[],
  rel: (d: DomainRef) => string,
  packages: PackageImport[]
): CheckProblem[] {
  const out: CheckProblem[] = [];
  for (const system of systems) {
    const adapter = domains.find((d) => rel(d) === system.path || rel(d).endsWith(`/${system.path}`) || d.id === system.path);
    if (!adapter) continue;
    const word = system.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const inside = (file: string) => file.startsWith(`${rel(adapter)}/`);
    const clients = new Set(
      system.packages.length
        ? system.packages
        : packages.filter((p) => inside(p.file) && word && p.pkg.toLowerCase().includes(word)).map((p) => p.pkg)
    );
    for (const p of packages) {
      if (!clients.has(p.pkg) || inside(p.file)) continue;
      out.push({
        file: p.file,
        domain: p.from,
        message: `${p.file} imports \`${p.pkg}\`, the client of ${system.name}: only ${adapter.id} talks to it. Call it through ${adapter.parent?.id ?? adapter.id}'s public file.`,
      });
    }
  }
  return out;
}
