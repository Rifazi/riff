import { promises as fs } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { tool } from 'ai';
import { z } from 'zod';
import { assertPathAllowed } from '../../repo/guardrails.js';

// A file's layout with line ranges, so an agent can read_file just the part
// it needs instead of the whole file. It only points at ranges — read_file
// stays the source of truth for the code itself.

const OUTLINE_CHAR_LIMIT = 6_000;
const SIGNATURE_CHARS = 140;
const TS_EXTENSIONS: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
};
// Calls whose callback body is worth outlining: test suites and cases.
const TEST_CALLS = new Set(['describe', 'it', 'test', 'suite']);

export const outlineFileSchema = z.object({
  path: z.string().describe('Repo-relative path, e.g. src/global/adapters/primary/foo/foo.ts'),
});
export const outlineFileDescription =
  "List a file's layout with line ranges — for TS/JS: imports, exports, functions, classes and their methods, " +
  'types and top-level constants (and describe/it blocks in tests); for markdown: headings; for anything else: its ' +
  'top-level lines. A small fraction of the file\'s size. Use it on a long file (over ~150 lines) before read_file, ' +
  'then read just the range you need with offset/limit.';

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SIGNATURE_CHARS ? `${flat.slice(0, SIGNATURE_CHARS)}…` : flat;
}

function outlineTs(content: string, fileName: string, kind: ts.ScriptKind): string[] {
  const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, kind);
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const range = (node: ts.Node) => {
    const a = lineOf(node.getStart(sf));
    const b = lineOf(node.end);
    return a === b ? `${a}` : `${a}-${b}`;
  };
  // Everything before the body: the signature, without the code.
  const head = (node: ts.Node, body: ts.Node | undefined) =>
    oneLine(content.slice(node.getStart(sf), body ? body.getStart(sf) : node.end));
  const isExported = (node: ts.Node) =>
    ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  const out: string[] = [];
  const imports: string[] = [];
  let importStart = 0;
  let importEnd = 0;

  const visit = (node: ts.Node, indent: string, depth: number) => {
    if (ts.isImportDeclaration(node)) {
      if (!importStart) importStart = lineOf(node.getStart(sf));
      importEnd = lineOf(node.end);
      imports.push((node.moduleSpecifier as ts.StringLiteral).text);
      return;
    }
    if (ts.isFunctionDeclaration(node)) {
      out.push(`${indent}${range(node)}  ${head(node, node.body)}`);
      return;
    }
    if (ts.isClassDeclaration(node)) {
      out.push(`${indent}${range(node)}  ${head(node, node.members[0] ?? undefined).replace(/\{$/, '').trim()}`);
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
          out.push(`${indent}  ${range(member)}  ${head(member, member.body)}`);
        } else if (ts.isPropertyDeclaration(member) && member.initializer && ts.isArrowFunction(member.initializer)) {
          out.push(`${indent}  ${range(member)}  ${head(member, member.initializer.body)}`);
        }
      }
      return;
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
      const text = content.slice(node.getStart(sf), node.end);
      const shown = text.length <= SIGNATURE_CHARS ? oneLine(text) : `${isExported(node) ? 'export ' : ''}${ts.SyntaxKind[node.kind].replace('Declaration', '').toLowerCase()} ${node.name.getText(sf)}`;
      out.push(`${indent}${range(node)}  ${shown}`);
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        const init = decl.initializer;
        const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : undefined;
        const prefix = `${isExported(node) ? 'export ' : ''}${node.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let'} `;
        const sig = fn ? head(decl, fn.body) : oneLine(decl.getText(sf).split('\n')[0]);
        out.push(`${indent}${range(node)}  ${prefix}${sig}`);
      }
      return;
    }
    if (ts.isExportAssignment(node) || ts.isExportDeclaration(node)) {
      out.push(`${indent}${range(node)}  ${oneLine(node.getText(sf).split('\n')[0])}`);
      return;
    }
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      const callee = call.expression.getText(sf);
      const name = callee.split('.')[0];
      const label = call.arguments[0] && ts.isStringLiteralLike(call.arguments[0]) ? ` ${JSON.stringify(call.arguments[0].text)}` : '';
      out.push(`${indent}${range(node)}  ${oneLine(callee)}(${label.trim()}…)`);
      const cb = call.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)) as ts.ArrowFunction | undefined;
      if (TEST_CALLS.has(name) && depth < 2 && cb && ts.isBlock(cb.body)) {
        for (const stmt of cb.body.statements) {
          if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) visit(stmt, `${indent}  `, depth + 1);
        }
      }
    }
  };

  for (const stmt of sf.statements) visit(stmt, '', 0);
  if (imports.length) {
    const where = importStart === importEnd ? `${importStart}` : `${importStart}-${importEnd}`;
    out.unshift(`${where}  imports: ${oneLine(imports.join(', '))}`);
  }
  return out;
}

function outlineMarkdown(lines: string[]): string[] {
  const out: string[] = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^#{1,6}\s/.test(line)) out.push(`${i + 1}  ${oneLine(line)}`);
  });
  return out;
}

// Anything else (JSON, YAML, CSS, Python, Rust, …): the lines at the
// shallowest indentation that carry content, which are its top-level
// entries in every one of those formats.
function outlineByIndent(lines: string[]): string[] {
  const isContent = (l: string) => /[A-Za-z0-9_"'@.#:-]/.test(l) && !/^\s*(\/\/|#(?!\w)|\/\*|\*)/.test(l);
  const indents = lines.filter((l) => l.trim() && isContent(l)).map((l) => l.length - l.trimStart().length);
  if (!indents.length) return [];
  const top = Math.min(...indents);
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (line.trim() && isContent(line) && line.length - line.trimStart().length === top) out.push(`${i + 1}  ${oneLine(line)}`);
  });
  return out;
}

export function outlineText(content: string, fileName: string): string[] {
  const ext = path.extname(fileName).toLowerCase();
  const lines = content.split('\n');
  if (TS_EXTENSIONS[ext] !== undefined) return outlineTs(content, fileName, TS_EXTENSIONS[ext]);
  if (ext === '.md' || ext === '.mdx') return outlineMarkdown(lines);
  return outlineByIndent(lines);
}

export function createOutlineFileExecute(deps: { repoRoot: string }) {
  return async ({ path: requestedPath }: z.infer<typeof outlineFileSchema>): Promise<string> => {
    const absolute = assertPathAllowed(requestedPath, ['.'], deps.repoRoot);
    const content = await fs.readFile(absolute, 'utf8');
    const total = content.split('\n').length;
    const entries = outlineText(content, requestedPath);
    if (!entries.length) return `${requestedPath}: ${total} lines, no outline found — read_file it in ranges.`;
    let body = entries.join('\n');
    if (body.length > OUTLINE_CHAR_LIMIT) {
      body = `${body.slice(0, body.lastIndexOf('\n', OUTLINE_CHAR_LIMIT))}\n[outline cut at ${OUTLINE_CHAR_LIMIT} chars]`;
    }
    return `${requestedPath}: ${total} lines\n${body}`;
  };
}

export function createOutlineFileTool(deps: { repoRoot: string }) {
  return tool({
    description: outlineFileDescription,
    inputSchema: outlineFileSchema,
    execute: createOutlineFileExecute(deps),
  });
}
