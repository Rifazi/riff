import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // `npm run lint` had no working root-level script before the
    // consolidate-ui ticket (see docs/frontend-ui-components.md), so these
    // rules were never actually enforced and the existing codebase carries a
    // large pre-existing backlog of violations unrelated to this ticket's
    // theme/UI-library migration. Downgraded to warnings (still visible,
    // still worth fixing) rather than hard errors so `lint` can be wired up
    // and gate real regressions without blocking on unrelated legacy debt.
    //
    // This relaxation is for that pre-existing backlog only — the override
    // below holds the files this ticket introduced to the original error
    // level, so new code can't quietly add to the backlog it excuses.
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'warn',
      'react/no-unescaped-entities': 'warn',
    },
  },
  {
    // Files added by the consolidate-ui ticket. They start with zero
    // violations, so there's no legacy debt to excuse here and these rules
    // stay hard errors. Add new files to this list as they're created,
    // rather than widening the relaxation above.
    files: [
      'src/components/ui/badge.tsx',
      'src/components/ui/card.tsx',
      'src/components/ui/skeleton.tsx',
      'src/components/ui/spinner.tsx',
      'src/components/AnalyticsDataCategory.tsx',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': 'error',
      'react/no-unescaped-entities': 'error',
    },
  },
];

export default eslintConfig;
