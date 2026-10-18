import path from 'node:path';
import ts from 'typescript';

const MIN_TOKENS = 30;

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
};

export interface DuplicateSource {
  file: string;
  domain: string;
  source: string;
}

export interface DuplicateCopy {
  file: string;
  domain: string;
  name: string;
}

function tokenKey(text: string, variant: ts.LanguageVariant): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, variant, text);
  const tokens: string[] = [];
  for (let t = scanner.scan(); t !== ts.SyntaxKind.EndOfFileToken; t = scanner.scan()) tokens.push(scanner.getTokenText());
  return tokens.length >= MIN_TOKENS ? tokens.join(' ') : '';
}

function topLevelFunctions(source: string, file: string): { name: string; text: string }[] {
  const kind = SCRIPT_KINDS[path.extname(file)] ?? ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const out: { name: string; text: string }[] = [];
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      out.push({ name: stmt.name.text, text: stmt.getText(sf) });
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        const init = decl.initializer;
        if (ts.isIdentifier(decl.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          out.push({ name: decl.name.text, text: stmt.getText(sf) });
        }
      }
    }
  }
  return out;
}

/**
 * Top-level functions (and arrow-function consts) that appear in more than
 * one domain with the same tokens, whatever their formatting or comments.
 * Each group is every copy. Two copies in one domain aren't reported: that
 * is a refactor inside the domain, not a second owner of the decision.
 */
export function findDuplicateFunctions(files: DuplicateSource[]): DuplicateCopy[][] {
  const groups = new Map<string, DuplicateCopy[]>();
  for (const f of files) {
    const variant = path.extname(f.file).endsWith('x') ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
    for (const fn of topLevelFunctions(f.source, f.file)) {
      const key = tokenKey(fn.text, variant);
      if (!key) continue;
      const copies = groups.get(key) ?? [];
      copies.push({ file: f.file, domain: f.domain, name: fn.name });
      groups.set(key, copies);
    }
  }
  return [...groups.values()].filter((copies) => new Set(copies.map((c) => c.domain)).size > 1);
}
