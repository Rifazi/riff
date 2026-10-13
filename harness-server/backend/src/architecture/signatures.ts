import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// What a domain's public file offers, one line per export, for the generated
// Files section of its DOMAIN.md: a function's parameters and return type, a
// type's shape. Agents read DOMAIN.md and then opened the file anyway to see
// how to call it (comic-drafter session a58b69ad), because Files only listed
// export names.

const SIGNATURE_CHARS = 160;
const MAX_SIGNATURES = 20;

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

/** Text on one line, comments dropped, cut at SIGNATURE_CHARS; backticks become quotes so it fits a code span. */
function oneLine(text: string): string {
  const flat = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/`/g, "'")
    .replace(/([{(\[]) /g, '$1')
    .replace(/ ([})\]])/g, '$1')
    .replace(/;([})\]])/g, '$1')
    .replace(/;$/, '')
    .trim();
  return flat.length > SIGNATURE_CHARS ? `${flat.slice(0, SIGNATURE_CHARS)}…` : flat;
}

interface ModuleApi {
  /** Exported name → its signature. */
  exported: Map<string, string>;
  /** Non-exported types, by name, shown when an exported function's parameters use them (a component's props). */
  localTypes: Map<string, string>;
  /** `export { a, b as c } from './x'` and `export * from './x'`. */
  reexports: { from: string; names: { name: string; as: string }[] | '*' }[];
}

function parseModule(source: string, fileName: string): ModuleApi {
  const kind = SCRIPT_KINDS[path.extname(fileName)] ?? ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const api: ModuleApi = { exported: new Map(), localTypes: new Map(), reexports: [] };
  const text = (from: number, to: number) => source.slice(from, to);
  const isExported = (node: ts.Node) =>
    ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (node: ts.Node) =>
    ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  // `name(params): ret`, without `export`, `async` or `function`.
  const callable = (name: string, fn: ts.SignatureDeclaration) => {
    const params = fn.parameters.map((p) => p.getText(sf)).join(', ');
    const generics = fn.typeParameters?.length ? `<${fn.typeParameters.map((t) => t.getText(sf)).join(', ')}>` : '';
    return oneLine(`${name}${generics}(${params})${fn.type ? `: ${fn.type.getText(sf)}` : ''}`);
  };
  const typeText = (node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration) => {
    const start = node.name.getStart(sf);
    const keyword = ts.isInterfaceDeclaration(node) ? 'interface' : ts.isTypeAliasDeclaration(node) ? 'type' : 'enum';
    return oneLine(`${keyword} ${text(start, node.end)}`);
  };

  for (const node of sf.statements) {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      api.reexports.push({
        from: node.moduleSpecifier.text,
        names:
          clause && ts.isNamedExports(clause)
            ? clause.elements.map((e) => ({ name: (e.propertyName ?? e.name).getText(sf), as: e.name.getText(sf) }))
            : '*',
      });
      continue;
    }
    if (ts.isFunctionDeclaration(node)) {
      if (!isExported(node)) continue;
      const name = node.name?.getText(sf) ?? 'default';
      api.exported.set(isDefault(node) ? 'default' : name, callable(name, node));
      continue;
    }
    if (ts.isClassDeclaration(node)) {
      if (!isExported(node)) continue;
      const name = node.name?.getText(sf) ?? 'default';
      const ctor = node.members.find(ts.isConstructorDeclaration);
      const isPublic = (m: ts.ClassElement) =>
        !(ts.canHaveModifiers(m) && ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword || x.kind === ts.SyntaxKind.ProtectedKeyword)) &&
        !(m.name && ts.isPrivateIdentifier(m.name));
      // Fields (an entity's columns) and then methods, by name.
      const members = node.members
        .filter((m) => (ts.isPropertyDeclaration(m) || ts.isMethodDeclaration(m)) && isPublic(m))
        .map((m) => (ts.isMethodDeclaration(m) ? `${m.name.getText(sf)}()` : m.name!.getText(sf)));
      const shown = `class ${ctor ? callable(name, ctor) : name}${members.length ? ` { ${members.join(', ')} }` : ''}`;
      api.exported.set(isDefault(node) ? 'default' : name, oneLine(shown));
      continue;
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      (isExported(node) ? api.exported : api.localTypes).set(node.name.getText(sf), typeText(node));
      continue;
    }
    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.getText(sf);
        const init = decl.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) api.exported.set(name, callable(name, init));
        else if (init && ts.isCallExpression(init) && init.arguments.some((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a))) {
          // A wrapped component, forwardRef<El, Props>(…) or memo(…): the
          // wrapper's type arguments, else the wrapped function's parameters.
          const fn = init.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)) as ts.ArrowFunction | ts.FunctionExpression;
          const callee = init.expression.getText(sf);
          api.exported.set(
            name,
            init.typeArguments?.length
              ? oneLine(`${name} = ${callee}<${init.typeArguments.map((t) => t.getText(sf)).join(', ')}>(…)`)
              : `${name} = ${callee}(${callable('', fn)})`
          );
        } else api.exported.set(name, oneLine(decl.type ? `${name}: ${decl.type.getText(sf)}` : name));
      }
    }
  }
  return api;
}

/** The type names a signature mentions that the module declares without exporting. */
function localTypesUsed(signature: string, localTypes: Map<string, string>): string[] {
  return [...localTypes.keys()].filter((name) => new RegExp(`\\b${name}\\b`).test(signature));
}

/**
 * One line per export of `file` (a domain's public file), following
 * re-exports (`export { a } from './a'`, `export * from './b'`) into the
 * files they name. Non-exported types an exported function's parameters use
 * (a component's props) follow it. `resolve` maps an import specifier to a
 * file; anything it can't resolve is shown by name only.
 */
export function publicSignatures(file: string, resolve: (spec: string, fromFile: string) => string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (line: string) => {
    if (!seen.has(line)) {
      seen.add(line);
      out.push(line);
    }
  };
  const visiting = new Set<string>();
  const walk = (current: string, only: { name: string; as: string }[] | '*') => {
    if (visiting.has(current) || visiting.size > 4) return;
    visiting.add(current);
    let source = '';
    try {
      source = readFileSync(current, 'utf8');
    } catch {
      if (only !== '*') only.forEach((n) => add(n.as));
      return;
    }
    const api = parseModule(source, current);
    const wanted = only === '*' ? [...api.exported.keys()].map((name) => ({ name, as: name })) : only;
    const missing: { name: string; as: string }[] = [];
    for (const { name, as } of wanted) {
      const signature = api.exported.get(name);
      if (!signature) {
        missing.push({ name, as });
        continue;
      }
      add(as === name || name === 'default' ? signature : `${as} (= ${signature})`);
      for (const local of localTypesUsed(signature, api.localTypes)) add(api.localTypes.get(local)!);
    }
    for (const reexport of api.reexports) {
      const target = resolve(reexport.from, current);
      const names =
        reexport.names === '*'
          ? only === '*'
            ? '*'
            : missing
          : reexport.names.filter((n) => only === '*' || missing.some((m) => m.name === n.as)).map((n) => ({
              name: n.name,
              as: only === '*' ? n.as : missing.find((m) => m.name === n.as)!.as,
            }));
      if (names !== '*' && !names.length) continue;
      if (!target) {
        if (names !== '*') names.forEach((n) => add(n.as));
        continue;
      }
      walk(target, names);
    }
    visiting.delete(current);
  };
  walk(file, '*');
  return out.slice(0, MAX_SIGNATURES).concat(out.length > MAX_SIGNATURES ? [`… ${out.length - MAX_SIGNATURES} more`] : []);
}
