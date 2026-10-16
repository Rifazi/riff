import path from 'node:path';
import ts from 'typescript';

// Where a named thing lives in a file, so read_file can return just it:
// agents found a range with outline_file or search_code and then read it,
// two requests where one does (1,617 outline-then-read pairs in the Oct 2026
// sessions, plus searches like "N1: \{" for an object key).

export interface SymbolRange {
  start: number;
  end: number;
  // What matched, e.g. "function parse856" or "N1 (in SEGMENTS)".
  label: string;
}

const TS_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']);
const TEST_CALLS = new Set(['describe', 'it', 'test', 'suite']);

function kindOf(ext: string): ts.ScriptKind {
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (ext.endsWith('js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined, sf: ts.SourceFile): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return name.expression.getText(sf);
  return null;
}

// The name a node declares, and the node whose lines it spans (a variable's
// whole statement, so `export const` comes with it).
function declared(node: ts.Node, sf: ts.SourceFile): { name: string; span: ts.Node } | null {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isEnumMember(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node)
  ) {
    const name = propertyNameText(node.name as ts.PropertyName | undefined, sf);
    return name ? { name, span: node } : null;
  }
  if (ts.isVariableDeclaration(node)) {
    const name = propertyNameText(node.name, sf);
    if (!name) return null;
    const list = node.parent;
    const statement = list?.parent;
    const span =
      ts.isVariableDeclarationList(list) && statement && ts.isVariableStatement(statement) && list.declarations.length === 1
        ? statement
        : node;
    return { name, span };
  }
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
    const call = node.expression;
    const callee = call.expression.getText(sf).split('.')[0];
    const first = call.arguments[0];
    if (TEST_CALLS.has(callee) && first && ts.isStringLiteralLike(first)) return { name: first.text, span: node };
  }
  return null;
}

function tsRanges(content: string, fileName: string, symbol: string): SymbolRange[] {
  const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, kindOf(path.extname(fileName).toLowerCase()));
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  // "Class.method" / "OBJ.key": every part but the last must name an enclosing declaration.
  const parts = symbol.split('.').map((p) => p.trim()).filter(Boolean);
  const target = parts.at(-1)!;
  const owners = parts.slice(0, -1);
  const out: SymbolRange[] = [];

  const visit = (node: ts.Node, ancestors: string[]) => {
    const d = declared(node, sf);
    if (d && d.name === target && owners.every((o) => ancestors.includes(o))) {
      const owner = ancestors.at(-1);
      out.push({
        start: lineOf(d.span.getStart(sf)),
        end: lineOf(d.span.end),
        label: owner ? `${d.name} (in ${owner})` : d.name,
      });
    }
    const next = d ? [...ancestors, d.name] : ancestors;
    ts.forEachChild(node, (child) => visit(child, next));
  };
  ts.forEachChild(sf, (child) => visit(child, []));
  return out;
}

function markdownRanges(lines: string[], symbol: string): SymbolRange[] {
  const wanted = symbol.replace(/^#+\s*/, '').trim().toLowerCase();
  const headings: { line: number; level: number; text: string }[] = [];
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s+(.*)$/.exec(l);
    if (m) headings.push({ line: i + 1, level: m[1].length, text: m[2].trim() });
  });
  return headings
    .filter((h) => h.text.toLowerCase() === wanted)
    .map((h) => {
      const next = headings.find((x) => x.line > h.line && x.level <= h.level);
      return { start: h.line, end: next ? next.line - 1 : lines.length, label: h.text };
    });
}

/** Every place `symbol` is declared in the file, outermost first. Empty when the file type isn't supported or nothing matches. */
export function symbolRanges(content: string, fileName: string, symbol: string): SymbolRange[] {
  const ext = path.extname(fileName).toLowerCase();
  if (!symbol.trim()) return [];
  if (TS_EXTENSIONS.has(ext)) return tsRanges(content, fileName, symbol.trim());
  if (ext === '.md' || ext === '.mdx') return markdownRanges(content.split('\n'), symbol);
  return [];
}
