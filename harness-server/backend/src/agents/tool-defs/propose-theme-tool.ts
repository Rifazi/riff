import { tool } from 'ai';
import { z } from 'zod';
import { getSession, updateSession } from '../../sessions/session-store.js';
import { findThemePreset, presetDefinition, THEME_PRESETS } from '../../themes/presets.js';
import { startingTheme } from '../../themes/apply-theme.js';
import { mergeThemeChanges, themeChangesSchema } from '../../themes/theme-schema.js';
import { THEME_DEFINITION_PATH } from '../../themes/theme-docs.js';

const PRESET_IDS = THEME_PRESETS.map((p) => p.id) as [string, ...string[]];

export const proposeThemeSchema = z.object({
  summary: z.string().describe('One or two sentences for the human: what you changed and why, in plain words.'),
  basedOn: z
    .enum(PRESET_IDS)
    .optional()
    .describe(
      `Start from this preset: ${THEME_PRESETS.map((p) => `"${p.id}" (${p.description})`).join('; ')}. ` +
        "Omit to start from the app's current theme (or the first preset if it has none)."
    ),
  changes: themeChangesSchema
    .optional()
    .describe(
      'Only the values to change on top of the starting theme. Colors are 6-digit hex (#rrggbb) per mode ("light" and ' +
        '"dark": bg, surface, surfaceMuted, border, text, textMuted, primary, onPrimary, success, warning, danger, info). ' +
        'Change a color in both modes, keeping text readable on its background. fonts: CSS font stacks (sans, heading, mono). ' +
        'radius (sm, md, lg, full) and borderWidth in px, headingWeight 100-900, density compact|comfortable|spacious, ' +
        'shadow (sm, md) as CSS box-shadow values or "none". Rename the theme (name) when it no longer matches its preset.'
    ),
});

// The when-to-use rules live here rather than only in the system prompt:
// tool descriptions reach every turn, including a resumed Claude session
// (which never re-reads a system prompt) and apps whose prompt override
// replaces the base prompt.
export const proposeThemeDescription =
  "Open Riff's theme picker for the human with a suggested UI theme for this app. The picker is part of Riff (this " +
  "harness), not of the app: it rewrites the app's " + THEME_DEFINITION_PATH + ', which every view is styled from. ' +
  "Call this RIGHT AWAY whenever the human asks to update, change or pick the app's theme, look, colors, branding, fonts, " +
  'roundness or density, even when the request is vague. Do not ask what kind of theme change they mean, do not use ' +
  'ask_multiple_choice for it, and do not scope it as a feature: pick a sensible starting preset and let them adjust it ' +
  'in the picker. Building a theme switcher that the app\'s own end users can use is a real feature for a requirements ' +
  'document ONLY when the human explicitly asks for that in-app capability. Also offer a theme when a feature needs UI and ' +
  'the app has no theme yet. You never write the theme file. This only records a suggestion: the human reviews it, can ' +
  'edit it, and applies or dismisses it. Once they apply it, the theme change is complete: no requirements document and ' +
  'no follow-up questions for it. Different case: moving the app\'s existing code onto the theme (wiring it in, replacing ' +
  'its own tokens and hard-coded colors) is code work, so scope it with audit_theme and write a requirements document. ' +
  "After calling this, end your turn with one short sentence.";

export function createProposeThemeExecute(deps: { sessionId: string; repoRoot: string }) {
  return async ({ summary, basedOn, changes }: z.infer<typeof proposeThemeSchema>): Promise<string> => {
    const session = await getSession(deps.sessionId);
    if (!session) throw new Error('Session not found.');

    const preset = basedOn ? findThemePreset(basedOn) : undefined;
    const start = preset ? { theme: presetDefinition(preset), basedOn: preset.id } : startingTheme(deps.repoRoot);
    // Throws on invalid values, which the model sees as a tool error to fix.
    const theme = mergeThemeChanges(start.theme, changes);

    await updateSession(deps.sessionId, {
      themeProposal: { theme, basedOn: start.basedOn, summary: summary.trim(), proposedAt: new Date().toISOString() },
    });
    return `The theme picker is now open for the human with "${theme.name}". They'll apply, edit or dismiss it. End your turn now.`;
  };
}

export function createProposeThemeTool(deps: { sessionId: string; repoRoot: string }) {
  return tool({ description: proposeThemeDescription, inputSchema: proposeThemeSchema, execute: createProposeThemeExecute(deps) });
}
