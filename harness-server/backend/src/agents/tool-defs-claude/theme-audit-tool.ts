import { tool } from '@anthropic-ai/claude-agent-sdk';
import { auditThemeSchema, auditThemeDescription, createAuditThemeExecute } from '../tool-defs/theme-audit-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

export function createAuditThemeToolClaude(deps: { repoRoot: string }) {
  return tool('audit_theme', auditThemeDescription, auditThemeSchema.shape, wrapForClaudeSdk(createAuditThemeExecute(deps)), {
    annotations: { readOnlyHint: true },
  });
}
