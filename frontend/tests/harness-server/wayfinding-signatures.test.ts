import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { publicSignatures } from '../../../harness-server/backend/src/architecture/signatures';
import { statusPaths } from '../../../harness-server/backend/src/agents/handoff';

// The signatures a DOMAIN.md's Files section shows for the domain's public
// file, so an agent can call it without opening the code.

describe('publicSignatures', () => {
  let dir: string;
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  const resolve = (spec: string, from: string) => {
    const base = path.resolve(path.dirname(from), spec);
    return ['.ts', '.tsx'].map((ext) => base + ext).find((f) => existsSync(f)) ?? null;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'signatures-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('functions, arrow functions, types and classes, without bodies or comments', () => {
    write(
      'service.ts',
      [
        '/** Adds a page. */',
        'export async function addPage(projectId: string, opts?: { at?: number }): Promise<Page> {',
        '  return fetch(projectId) as never;',
        '}',
        'export const listPages = async (projectId: string): Promise<Page[]> => [];',
        'export interface Page {',
        '  id: string; // the id',
        '  /** where it sits */',
        '  position: number;',
        '}',
        'export class ApiError extends Error {',
        '  constructor(public status: number, message: string) { super(message); }',
        '  readonly kind = "api";',
        '  private secret = 1;',
        '  describe() { return ""; }',
        '}',
        'export const LIMIT = 10;',
      ].join('\n')
    );
    expect(publicSignatures(path.join(dir, 'service.ts'), resolve)).toEqual([
      'addPage(projectId: string, opts?: {at?: number}): Promise<Page>',
      'listPages(projectId: string): Promise<Page[]>',
      'interface Page {id: string; position: number}',
      'class ApiError(public status: number, message: string) {kind, describe()}',
      'LIMIT',
    ]);
  });

  test('follows re-exports, renames and export *', () => {
    write('pages.ts', 'export function getPage(id: string): Page | null { return null }\nexport function internal() {}\n');
    write('errors.ts', 'export const isNotFound = (e: unknown): boolean => false\n');
    write('service.ts', "export { getPage as findPage } from './pages'\nexport * from './errors'\nexport { missing } from './nowhere'\n");
    expect(publicSignatures(path.join(dir, 'service.ts'), resolve)).toEqual([
      'findPage (= getPage(id: string): Page | null)',
      'isNotFound(e: unknown): boolean',
      'missing',
    ]);
  });

  test("a wrapped component shows its props, even when they aren't exported", () => {
    write(
      'Button.tsx',
      [
        "import { forwardRef, type ButtonHTMLAttributes } from 'react';",
        'interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {',
        "  variant?: 'primary' | 'danger';",
        '}',
        'interface Unused { a: 1 }',
        'export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant }, ref) {',
        '  return null;',
        '});',
        'type RowProps = { label: string };',
        'export function Row({ label }: RowProps) { return label }',
      ].join('\n')
    );
    expect(publicSignatures(path.join(dir, 'Button.tsx'), resolve)).toEqual([
      'Button = forwardRef<HTMLButtonElement, ButtonProps>(…)',
      "interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {variant?: 'primary' | 'danger'}",
      'Row({label}: RowProps)',
      'type RowProps = {label: string}',
    ]);
  });

  test('long signatures are cut', () => {
    write('service.ts', `export type Big = { ${Array.from({ length: 40 }, (_, i) => `field${i}: string`).join('; ')} }\n`);
    const [line] = publicSignatures(path.join(dir, 'service.ts'), resolve);
    expect(line.endsWith('…')).toBe(true);
    expect(line.length).toBeLessThanOrEqual(161);
  });
});

describe('handoff statusPaths', () => {
  test('each changed or new file, a rename by its new name, deletions left out', () => {
    const status = [
      ' M client/src/App.tsx',
      '?? client/src/components/PagesSidebar/PagesSidebar.tsx',
      '?? client/src/components/PagesSidebar/PagesSidebar.css',
      'R  old.ts -> new.ts',
      ' D gone.ts',
      '?? "with space.ts"',
    ].join('\n');
    expect(statusPaths(status)).toEqual([
      'client/src/App.tsx',
      'client/src/components/PagesSidebar/PagesSidebar.tsx',
      'client/src/components/PagesSidebar/PagesSidebar.css',
      'new.ts',
      'with space.ts',
    ]);
  });
});
