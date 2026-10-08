import { describe, expect, test } from 'bun:test';

import { stripCodeFence } from '../../../harness-server/backend/src/agents/helpers/compress';

describe('stripCodeFence', () => {
  test('unwraps a fenced reply', () => {
    expect(stripCodeFence('```typescript\n// a.ts\nexport const a = 1;\n```')).toBe('// a.ts\nexport const a = 1;');
  });

  test('leaves unfenced text alone', () => {
    expect(stripCodeFence('export const a = 1;')).toBe('export const a = 1;');
  });
});
