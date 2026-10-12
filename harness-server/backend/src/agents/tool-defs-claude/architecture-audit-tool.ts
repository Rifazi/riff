import { tool } from '@anthropic-ai/claude-agent-sdk';
import {
  auditArchitectureDescription,
  auditArchitectureReadOnlySchema,
  auditArchitectureSchema,
  createAuditArchitectureExecute,
  type AuditArchitectureDeps,
} from '../tool-defs/architecture-audit-tool.js';
import { wrapForClaudeSdk } from './wrap.js';

/** [] for an app without an architecture, so the tool isn't offered (or listed) at all. */
export function architectureToolsClaude(deps: AuditArchitectureDeps) {
  if (!deps.app.architecture) return [];
  const schema = deps.allowRegenerate ? auditArchitectureSchema : auditArchitectureReadOnlySchema;
  return [
    tool('audit_architecture', auditArchitectureDescription(deps), schema.shape, wrapForClaudeSdk(createAuditArchitectureExecute(deps)), {
      annotations: { readOnlyHint: !deps.allowRegenerate },
    }),
  ];
}

/** Tool names to allow on the Claude engine, matching architectureToolsClaude. */
export function architectureToolNames(deps: Pick<AuditArchitectureDeps, 'app'>): string[] {
  return deps.app.architecture ? ['audit_architecture'] : [];
}
