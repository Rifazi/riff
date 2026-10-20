import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.HARNESS_DESIGN_MEMORY_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'design-memory-')), 'memory.json');

let mem: typeof import('../../../harness-server/backend/src/themes/design-memory');

beforeAll(async () => {
  mem = await import('../../../harness-server/backend/src/themes/design-memory');
});

describe('design memory', () => {
  test('adds, ignores exact repeats, replaces and removes', () => {
    const a = mem.changeDesignMemory('app1', 's1', {
      add: [
        { text: 'Sidebar: stays flat, no glow', area: 'Sidebar', source: 'human' },
        { text: '  sidebar: stays flat,  no glow ', source: 'agent' },
      ],
    });
    expect(a).toHaveLength(1);
    const id = a[0].id;
    const b = mem.changeDesignMemory('app1', 's2', { replace: [{ id, text: 'Sidebar: flat, dense' }] });
    expect(b[0].text).toBe('Sidebar: flat, dense');
    expect(b[0].area).toBe('Sidebar');
    expect(mem.changeDesignMemory('app1', null, { remove: [id] })).toHaveLength(0);
  });

  test('apps are separate and the briefing is per role', () => {
    mem.changeDesignMemory('app2', 's1', { add: [{ text: 'Cards keep square corners', source: 'human' }] });
    expect(mem.designMemoryBriefing('app3', 'coding')).toBe('');
    expect(mem.designMemoryBriefing('app2', 'qa')).toContain('Cards keep square corners');
    expect(mem.designMemoryBriefing('app2', 'qa')).toContain('finding');
    expect(mem.designMemoryBriefing('app2', 'uiux')).toContain('remember_design');
  });

  test('fingerprint changes with the list', () => {
    const before = mem.designMemoryFingerprint('app2');
    mem.changeDesignMemory('app2', 's1', { add: [{ text: 'No gradients', source: 'human' }] });
    expect(mem.designMemoryFingerprint('app2')).not.toBe(before);
    expect(mem.designMemoryFingerprint('nobody')).toBe('none');
  });
});
