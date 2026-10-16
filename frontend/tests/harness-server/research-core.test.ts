import { describe, expect, test } from 'bun:test';

import {
  cleanAnswer,
  delegateSchema,
  excerptFile,
  formatResults,
  isDescribeFilesTask,
  isFullContentsTask,
  isListFilesTask,
  listingPaths,
  NOTHING_FOUND,
  RedoLedger,
  runDelegation,
  runLimited,
  savedTokens,
  searchTerms,
  wantsCheckRun,
  type DelegateTaskResult,
  type HelperRun,
} from '../../../harness-server/backend/src/agents/helpers/research/core';

// The research helper (the delegate tool) exists to save the paid coding agent's context, so these
// pin down that it hands back as little as possible: only the answer, and
// next to nothing when a helper found nothing.

const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 };
const run = (text: string, readChars = 8000, error: string | null = null): HelperRun => ({ text, error, usage, readChars });
const result = (answer: string | null, error: string | null = null, readChars = 4000): DelegateTaskResult => ({
  answer,
  error,
  readChars,
  localTokens: 0,
});

describe('cleanAnswer', () => {
  test('the NOTHING_FOUND reply, alone or explained, is nothing', () => {
    expect(cleanAnswer(NOTHING_FOUND)).toBeNull();
    expect(cleanAnswer(`  \`${NOTHING_FOUND}\`. `)).toBeNull();
    expect(cleanAnswer(`${NOTHING_FOUND}\nI searched src/ and docs/ but could not find it.`)).toBeNull();
    expect(cleanAnswer('   ')).toBeNull();
  });

  test('a sentinel tacked onto a real answer is dropped, the answer kept', () => {
    expect(cleanAnswer('src/wrap.ts:11\n```ts\nexport function wrap() {\n```\n NOTHING_FOUND')).toBe(
      'src/wrap.ts:11\n```ts\nexport function wrap() {\n```',
    );
  });

  test('reasoning blocks are dropped, closed or not', () => {
    expect(cleanAnswer('<think>let me look</think>\nsrc/a.ts:12 sets it')).toBe('src/a.ts:12 sets it');
    expect(cleanAnswer('src/a.ts:12\n<think>still going')).toBe('src/a.ts:12');
    expect(cleanAnswer('<think>only thinking</think>')).toBeNull();
  });

  test('preamble and sign-off lines are dropped, the answer kept', () => {
    const raw = "Sure! Here's what I found:\nsrc/retry.ts:40 RETRY_DELAY_MS = 5000\n\nLet me know if you need more.";
    expect(cleanAnswer(raw)).toBe('src/retry.ts:40 RETRY_DELAY_MS = 5000');
  });

  test('a long answer is cut at a line break and marked', () => {
    const raw = Array.from({ length: 100 }, (_, i) => `src/file${i}.ts:${i} something`).join('\n');
    const cleaned = cleanAnswer(raw, 300)!;
    expect(cleaned.length).toBeLessThanOrEqual(306);
    expect(cleaned.endsWith('\n[cut]')).toBe(true);
    expect(cleaned.split('\n').slice(0, -1).every((l) => /^src\/file\d+\.ts:\d+ something$/.test(l))).toBe(true);
  });
});

describe('formatResults', () => {
  test('a single answer comes back bare', () => {
    expect(formatResults([result('src/a.ts:3')])).toBe('src/a.ts:3');
  });

  test('nothing found anywhere is one short line', () => {
    const text = formatResults([result(null), result(null), result(null)]);
    expect(text).toStartWith('Nothing found.');
    expect(text.length).toBeLessThan(70);
  });

  test('empty and failed tasks share a line each, after the answers', () => {
    const text = formatResults([
      result('src/a.ts:3'),
      result(null),
      result(null, 'timed out'),
      result(null, 'timed out'),
    ]);
    expect(text).toBe('[1] src/a.ts:3\n\nNothing found: 2.\n\nFailed, do yourself: 3, 4 (timed out).');
  });

  test('a single failure says to do it yourself', () => {
    expect(formatResults([result(null, 'Ollama not reachable')])).toBe(
      'Helper failed (Ollama not reachable). Do this one yourself.',
    );
  });
});

describe('savedTokens', () => {
  test('is what the helpers read minus what came back, in tokens', () => {
    expect(savedTokens([result('x', null, 6000), result(null, null, 2000)], 'x'.repeat(400))).toBe(1900);
  });

  test('never goes below zero', () => {
    expect(savedTokens([result('x', null, 10)], 'x'.repeat(400))).toBe(0);
  });
});

describe('runLimited', () => {
  test('keeps order and never runs more than the limit at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await runLimited([30, 5, 20, 1, 10], 2, async (ms, i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight -= 1;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });
});

describe('runDelegation', () => {
  test('returns only the answers and reports local usage and savings', async () => {
    const prompts: string[] = [];
    const { text, report } = await runDelegation(
      { tasks: [{ task: ' Where is X? ', paths: ['src/'] }, { task: 'Who calls Y?' }] },
      async (prompt) => {
        prompts.push(prompt);
        return prompt.startsWith('Where') ? run('Sure, here it is:\nsrc/x.ts:4') : run(NOTHING_FOUND);
      },
    );
    expect(prompts).toEqual(['Where is X?\n\nStart from: src/', 'Who calls Y?']);
    expect(text).toBe('[1] src/x.ts:4\n\nNothing found: 2.');
    expect(report.tasks).toBe(2);
    expect(report.useful).toBe(1);
    expect(report.usage.input).toBe(2000);
    // 16k characters read, ~30 returned.
    expect(report.savedTokens).toBe(Math.round((16000 - text.length) / 4));
  });

  test('a helper that throws becomes a short failure, not a crash', async () => {
    const { text, report } = await runDelegation({ tasks: [{ task: 'Q' }] }, async () => {
      throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:11434');
    });
    expect(text).toBe('Helper failed (Ollama not reachable). Do this one yourself.');
    expect(report.useful).toBe(0);
  });

  test('an empty task is refused', async () => {
    await expect(runDelegation({ tasks: [{ task: '  ' }] }, async () => run('x'))).rejects.toThrow('Task 1 is empty.');
  });
});

describe('delegate schema', () => {
  test('paths is optional, and stays undefined when omitted (MCP needs optional, not default)', () => {
    const parsed = delegateSchema.safeParse({ tasks: [{ task: 'Where is X?' }] });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.tasks[0].paths).toBeUndefined();
  });

  test('takes 1 to 4 tasks', () => {
    expect(delegateSchema.safeParse({ tasks: [] }).success).toBe(false);
    expect(delegateSchema.safeParse({ tasks: Array(5).fill({ task: 'q' }) }).success).toBe(false);
  });
});

// The exact questions that came back as "read_file: path" and false "N/A"s
// from the built-in helper.
const SETTINGS_Q =
  "In backend/src/routes/settings.test.ts, does it mock '../secure-store/store' with vi.mock, and does the string " +
  'MOBILINK_DATA_DIR appear anywhere in the file? Quote the first 40 lines verbatim.';
const HISTORY_Q =
  "In backend/src/entry-files/history/history.test.ts, find the test named 'returns 404 when the handler reports an error' " +
  'and quote the getRunDetailHandler mock value used in it verbatim, with line numbers. Does it include a `status` field?';
const STACK_Q =
  'In infra/lib/stateless-stack.ts: (a) is the UserPoolClient variable `appClient` referenced anywhere after creation, ' +
  "e.g. in a CfnOutput? (b) quote the line(s) using Fn.importValue verbatim with line numbers. (c) Do any comments " +
  "containing 'Placeholder' or 'pending confirmation' still exist?";

describe('cleanAnswer drops non-answers', () => {
  test('a written-out tool call is nothing', () => {
    expect(cleanAnswer('read_file: backend/src/routes/settings.test.ts')).toBeNull();
    expect(cleanAnswer('`search_code`: appClient')).toBeNull();
  });

  test('N/A lines are nothing; real lines next to them stay', () => {
    expect(cleanAnswer('N/A: No `appClient` variable found.\nN/A: No comments found.')).toBeNull();
    expect(cleanAnswer('infra/lib/stateless-stack.ts:88\nN/A: no comments')).toBe('infra/lib/stateless-stack.ts:88');
  });

  test("a file header copied into a quote is dropped", () => {
    expect(cleanAnswer('```\n=== a.ts (382 lines) [complete] ===\n1| import x\n```')).toBe('```\n1| import x\n```');
  });
});

describe('wantsCheckRun', () => {
  test('test file names and quoted test names are not a status question', () => {
    expect(wantsCheckRun(SETTINGS_Q)).toBe(false);
    expect(wantsCheckRun(HISTORY_Q)).toBe(false);
    expect(wantsCheckRun(`${HISTORY_Q}\n\nStart from: backend/src/entry-files/history/history.test.ts`)).toBe(false);
  });

  test('asking whether tests or lint pass is', () => {
    expect(wantsCheckRun('Do the tests pass?')).toBe(true);
    expect(wantsCheckRun('Which tests are failing in backend?')).toBe(true);
    expect(wantsCheckRun('Run lint and list the errors.')).toBe(true);
  });
});

describe('searchTerms', () => {
  test('quoted strings and code-shaped names, not file paths or plain words', () => {
    expect(searchTerms(SETTINGS_Q)).toEqual(['../secure-store/store', 'vi.mock', 'MOBILINK_DATA_DIR']);
    expect(searchTerms(HISTORY_Q)).toEqual(['returns 404 when the handler reports an error', 'status', 'getRunDetailHandler']);
    expect(searchTerms(STACK_Q)).toEqual(
      expect.arrayContaining(['appClient', 'Placeholder', 'pending confirmation', 'UserPoolClient', 'CfnOutput', 'Fn.importValue']),
    );
  });
});

describe('excerptFile', () => {
  const big = Array.from({ length: 600 }, (_, i) => `const line${i + 1} = ${i + 1};`);
  big[449] = 'new CfnOutput(this, "ClientId", { value: appClient.userPoolClientId });';
  const text = big.join('\n');

  test('a small file is shown whole, numbered and marked complete', () => {
    const out = excerptFile('a.ts', 'one\ntwo\n', [], 1_000);
    expect(out).toBe('=== a.ts (2 lines) [complete] ===\n1| one\n2| two');
  });

  test('a big file keeps its head and a window around each term, and marks every gap', () => {
    const out = excerptFile('stack.ts', text, ['appClient'], 3_000);
    expect(out).not.toContain('[complete]');
    expect(out).toContain('1| const line1');
    expect(out).toContain('450| new CfnOutput');
    expect(out).toContain('… lines 41-443 not shown …');
    expect(out).toContain('… lines 457-600 not shown …');
  });

  test('a budget too small for every window says where it stopped', () => {
    const out = excerptFile('stack.ts', text, ['appClient'], 600);
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out).toMatch(/… lines \d+-600 not shown …$/);
  });
});

describe('RedoLedger', () => {
  test('hands a delegation back once, when the agent reads one of its files', () => {
    const ledger = new RedoLedger();
    ledger.record(['src/a.ts', './src/b.ts'], 2, 1500);
    expect(ledger.noteRead('src/other.ts')).toEqual([]);
    expect(ledger.noteRead('src/b.ts')).toEqual([{ useful: 2, savedTokens: 1500 }]);
    expect(ledger.noteRead('src/a.ts')).toEqual([]);
  });

  test('ignores delegations that answered nothing or read nothing', () => {
    const ledger = new RedoLedger();
    ledger.record(['src/a.ts'], 0, 0);
    ledger.record([], 1, 300);
    expect(ledger.noteRead('src/a.ts')).toEqual([]);
  });

  // A recall returns line ranges; reading another part of the same file isn't redoing it.
  test('with ranges, only a read that overlaps one is a redo', () => {
    const ledger = new RedoLedger();
    ledger.record(['src/a.ts'], 1, 400, [{ path: 'src/a.ts', start: 429, end: 457 }]);
    expect(ledger.noteRead('src/a.ts', { start: 753, end: 843 })).toEqual([]);
    expect(ledger.noteRead('src/a.ts', { start: 440, end: 470 })).toEqual([{ useful: 1, savedTokens: 400 }]);
  });

  test('runDelegation reports the files every successful task read', async () => {
    const runs: HelperRun[] = [
      { text: 'src/a.ts:3 does it', error: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, readChars: 900, paths: ['src/a.ts'] },
      { text: '', error: 'timed out', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, readChars: 0, paths: ['src/c.ts'] },
    ];
    let i = 0;
    const { report } = await runDelegation({ tasks: [{ task: 'one' }, { task: 'two' }] }, async () => runs[i++], 1);
    expect(report.paths).toEqual(['src/a.ts']);
  });
});

// Tasks agents actually sent (comic-drafter): listing is answered from the
// repo, a file's full contents is turned away.
describe('tasks that are not a helper\'s job', () => {
  const LIST = 'List all files under client/src/ (recursively, every file path).';
  const FULL = 'Show me the full contents of client/src/api/pages.ts and client/src/types.ts (the merged client-api work).';
  const MIXED =
    'Show me the full contents of client/src/components/service.ts, client/src/components/DOMAIN.md, and list the component folders under client/src/components with the exported component name of each.';

  test('classifies listing and full-contents tasks', () => {
    expect(isListFilesTask(LIST)).toBe(true);
    expect(isListFilesTask('List the component folders under client/src/components')).toBe(true);
    expect(isListFilesTask('List every file under server/src/ and confirm whether service.ts exists.')).toBe(true);
    expect(isListFilesTask('list every file that imports getPool')).toBe(false);
    expect(isListFilesTask('List the CSS custom property names defined in client/src/styles/tokens.css')).toBe(false);
    expect(isListFilesTask('Where is retryDelay set?')).toBe(false);
    expect(isFullContentsTask(FULL)).toBe(true);
    expect(isFullContentsTask(MIXED)).toBe(true);
    expect(isListFilesTask(MIXED)).toBe(false);
    expect(isFullContentsTask('Show the exact Page type definition in client/src/types.ts')).toBe(false);
  });

  test('listing paths: given, else named in the task', () => {
    expect(listingPaths({ task: LIST, paths: ['client/src/'] })).toEqual(['client/src']);
    expect(listingPaths({ task: 'List all files under ./client/src/pages/ and client/src/api/.' })).toEqual([
      'client/src/pages',
      'client/src/api',
    ]);
    expect(listingPaths({ task: 'List all files in the repo' })).toEqual([]);
  });

  test('a listing never reaches a helper; full contents is turned away', async () => {
    const asked: string[] = [];
    const listed: string[][] = [];
    const { text, report } = await runDelegation(
      { tasks: [{ task: LIST, paths: ['client/src'] }, { task: FULL }, { task: 'Who calls createPage?' }] },
      async (prompt) => {
        asked.push(prompt);
        return { text: 'client/src/pages/x.tsx:12', error: null, usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }, readChars: 400 };
      },
      2,
      async (paths) => {
        listed.push(paths);
        return 'client/src/DOMAIN.md\n- `main.tsx`';
      },
    );
    expect(asked).toEqual(['Who calls createPage?']);
    expect(listed).toEqual([['client/src']]);
    expect(text).toContain('[1] client/src/DOMAIN.md');
    expect(text).toContain('[3] client/src/pages/x.tsx:12');
    expect(text).toContain('Not delegated: 2 (a file\'s full contents');
    expect(report.useful).toBe(2);
    // The turned-away task never reached a helper, so it isn't counted against them.
    expect(report.tasks).toBe(2);
  });

  test('a single full-contents task costs one line', async () => {
    const { text } = await runDelegation({ tasks: [{ task: FULL }] }, async () => {
      throw new Error('should not run');
    });
    expect(text).toStartWith('Not delegated (a file\'s full contents');
  });

  test('without a lister, a listing goes to a helper as before', async () => {
    const asked: string[] = [];
    await runDelegation({ tasks: [{ task: LIST }] }, async (p) => {
      asked.push(p);
      return { text: 'a', error: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, readChars: 0 };
    });
    expect(asked).toHaveLength(1);
  });
});

// Tasks the EDI Viewer sessions (2ec615c4, 7bdd0d9e) sent: the plan agent asked
// three times for "every file with a one-line description" and got bare names
// back each time; the coding agent asked for whole files four times.
describe('describing files and turning away full contents', () => {
  const DESCRIBE =
    'List all files under client/src/features/edi-viewer/lib/ and client/src/features/edi-viewer/lib/dictionary/ with a one-line description of what each file does.';
  const DESCRIBE_EXPORTS =
    'List all files under client/src/features/edi-viewer/lib/dictionary/ with a one-line description of what each exports';
  const FULL = 'Show the full contents of client/src/features/edi-viewer/lib/parser852.ts (the parse852Segments function).';

  test('a listing that asks what each file is', () => {
    expect(isDescribeFilesTask(DESCRIBE)).toBe(true);
    expect(isDescribeFilesTask(DESCRIBE_EXPORTS)).toBe(true);
    expect(isDescribeFilesTask('List all files under client/src/ (recursively, every file path).')).toBe(false);
    expect(isDescribeFilesTask('Describe how the validator dispatches per transaction set')).toBe(false);
  });

  test('the lister is told to describe', async () => {
    const calls: [string[], boolean][] = [];
    const { text } = await runDelegation(
      { tasks: [{ task: DESCRIBE, paths: ['client/src/features/edi-viewer/lib'] }, { task: 'List all files under client/src/' }] },
      async () => {
        throw new Error('should not run');
      },
      2,
      async (paths, describe) => {
        calls.push([paths, describe]);
        return describe ? '- client/src/a.ts (12 lines): parseA' : '- client/src/a.ts';
      },
    );
    expect(calls).toEqual([
      [['client/src/features/edi-viewer/lib'], true],
      [['client/src'], false],
    ]);
    expect(text).toContain('[1] - client/src/a.ts (12 lines): parseA');
  });

  test('a full-contents task gets the outline of the file it names', async () => {
    const outlined: string[][] = [];
    const { text, report } = await runDelegation(
      { tasks: [{ task: FULL }] },
      async () => {
        throw new Error('should not run');
      },
      2,
      async () => '',
      async (paths) => {
        outlined.push(paths);
        return 'client/src/features/edi-viewer/lib/parser852.ts: 310 lines\nfunction parse852Segments 12-180';
      },
    );
    expect(outlined).toEqual([['client/src/features/edi-viewer/lib/parser852.ts']]);
    expect(text).toStartWith("Not delegated (a file's full contents");
    expect(text).toContain('function parse852Segments 12-180');
    expect(report.tasks).toBe(0);
    expect(report.useful).toBe(0);
  });

  test('among several tasks, the outline is numbered', async () => {
    const { text } = await runDelegation(
      { tasks: [{ task: FULL }, { task: 'Who calls parse852Segments?' }] },
      async () => ({ text: 'lib/explainedEnvelope.ts:40', error: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, readChars: 100 }),
      2,
      async () => '',
      async () => 'parser852.ts: 310 lines',
    );
    expect(text).toContain('Not delegated: 1');
    expect(text).toContain('[1] parser852.ts: 310 lines');
    expect(text).toContain('[2] lib/explainedEnvelope.ts:40');
  });
});
