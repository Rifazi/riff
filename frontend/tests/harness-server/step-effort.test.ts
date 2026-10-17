import { describe, expect, test } from 'bun:test';

import { docsOnlyStepIdsOf } from '../../../harness-server/backend/src/agents/step-effort';

const steps = [
  { id: 'parser', title: 'Parser' },
  { id: 'docs', title: 'Docs: docs/edi-viewer.md' },
  { id: 'page', title: 'Page wiring' },
];

const body = `## Approach
x

## Steps

### Parser
Adds \`lib/parser844.ts\`, mirrors \`lib/parser843.ts\`.

### Docs: docs/edi-viewer.md
Update \`docs/edi-viewer.md\` and \`README.md\`.

### Page wiring
Edit \`EdiViewerPage.tsx\` and \`docs/edi-viewer.md\`.
`;

describe('docsOnlyStepIdsOf', () => {
  test('a step naming only documentation files is docs-only', () => {
    expect([...docsOnlyStepIdsOf(body, steps)]).toEqual(['docs']);
  });

  test('a step that also names code is not, and one naming no files is not', () => {
    const none = `## Steps\n\n### Parser\nDo it.\n\n### Docs: docs/edi-viewer.md\nWrite.\n\n### Page wiring\nWire it.\n`;
    expect([...docsOnlyStepIdsOf(none, steps)]).toEqual([]);
  });
});
