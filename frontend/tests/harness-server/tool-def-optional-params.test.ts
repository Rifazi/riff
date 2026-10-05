import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, test } from 'bun:test';

// Guards a defect that shipped once: classify_text declared
// `mode: z.enum([...]).default('single')`, and a zod default makes the
// argument *required* on the Claude-Agent-SDK/MCP path — calling the tool
// without `mode` failed with "expected nonoptional, received undefined",
// contradicting the tool's own description and docs. Optional tool parameters
// must be `.optional()`, with the default applied in the execute path.
//
// Source-scanned rather than imported because the tool defs pull in `ai` and
// `zod`, which live in the agent server's node_modules, not the frontend's.
const TOOL_DEFS_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'harness-server',
  'backend',
  'src',
  'agents',
  'tool-defs',
);

/** Comments discuss `.default()` on purpose; only real code should be matched. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const toolDefSources = readdirSync(TOOL_DEFS_DIR)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({ name, source: stripComments(readFileSync(join(TOOL_DEFS_DIR, name), 'utf8')) }));

describe('tool-defs zod schemas', () => {
  test('there are tool defs to check', () => {
    expect(toolDefSources.length).toBeGreaterThan(0);
  });

  test('no tool parameter uses .default() — it makes the parameter required', () => {
    const offenders = toolDefSources.filter(({ source }) => /\.default\(/.test(source)).map(({ name }) => name);

    expect(offenders).toEqual([]);
  });
});

describe('classify_text schema', () => {
  const source = toolDefSources.find(({ name }) => name === 'classify-text-tool.ts')?.source ?? '';

  test('the tool def exists', () => {
    expect(source).not.toBe('');
  });

  test('mode is optional, so a call that omits it defaults to single', () => {
    const mode = source.slice(source.indexOf('mode: z'), source.indexOf('threshold: z'));

    expect(mode).toContain(".enum(['single', 'multi'])");
    expect(mode).toContain('.optional()');
    expect(mode).not.toContain('.default(');
  });

  test('threshold is optional', () => {
    const threshold = source.slice(source.indexOf('threshold: z'));

    expect(threshold).toContain('.optional()');
  });
});
