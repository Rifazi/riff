import { tool } from 'ai';
import { z } from 'zod';
import { auditThemeUsage, formatThemeAudit } from '../../themes/theme-audit.js';

export const auditThemeSchema = z.object({});

export const auditThemeDescription =
  "Report how far this app's code has adopted its Riff UI theme (theme/theme.json): whether theme/index.css is imported " +
  'and from where, hard-coded colors outside theme/ (file, count, sample lines), the app\'s own CSS token definitions ' +
  'that should be aliased onto the theme, Tailwind configs and whether they use the theme tokens, and component ' +
  'libraries in package.json. Read-only. Run it before planning or doing UI work or a migration onto the theme, and ' +
  'again afterwards to check nothing hard-coded is left.';

export function createAuditThemeExecute(deps: { repoRoot: string }) {
  return async (): Promise<string> => formatThemeAudit(await auditThemeUsage(deps.repoRoot));
}

export function createAuditThemeTool(deps: { repoRoot: string }) {
  return tool({ description: auditThemeDescription, inputSchema: auditThemeSchema, execute: createAuditThemeExecute(deps) });
}
