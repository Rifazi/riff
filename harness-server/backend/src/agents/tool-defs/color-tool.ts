import { tool } from 'ai';
import { z } from 'zod';
import { readAppTheme } from '../../themes/apply-theme.js';
import { analyzePairs, analyzePalette, analyzeThemeColors } from '../../themes/color-science.js';

export const analyzeColorsSchema = z.object({
  pairs: z
    .array(z.object({ fg: z.string(), bg: z.string(), label: z.string().optional(), large: z.boolean().optional() }))
    .max(40)
    .optional()
    .describe('Foreground/background pairs to check against WCAG, as #hex or rgb(). large = 24px+ text or a UI component (needs 3:1 instead of 4.5:1).'),
  palette: z.array(z.string()).max(40).optional().describe('Colors to read as a palette: lightness, chroma and hue of each (OKLCH), the harmony they form, and the usual faults.'),
});

export const analyzeColorsDescription =
  "Measure color instead of guessing. With no arguments it checks the app's own theme (theme/theme.json) in light and dark: " +
  'WCAG contrast for every pair a UI relies on (text, muted text, primary button label, links, borders, status colors), ' +
  'the harmony its brand and status colors form, and faults like glare, vibrating chroma or a page indistinguishable from its cards. ' +
  'Pass `pairs` to check specific colors you found in code or a screenshot, and `palette` to read any set of colors. Read-only.';

export function createAnalyzeColorsExecute(deps: { repoRoot: string }) {
  return async ({ pairs, palette }: z.infer<typeof analyzeColorsSchema>): Promise<string> => {
    const parts: string[] = [];
    if (pairs?.length) parts.push(analyzePairs(pairs));
    if (palette?.length) parts.push(analyzePalette(palette));
    if (parts.length === 0) {
      const theme = readAppTheme(deps.repoRoot);
      if (!theme) return "This app has no Riff theme (theme/theme.json), so there's nothing to analyze by default. Pass `pairs` or `palette` with the colors you found in its styles.";
      parts.push(analyzeThemeColors(theme.theme));
    }
    return parts.join('\n\n');
  };
}

export function createAnalyzeColorsTool(deps: { repoRoot: string }) {
  return tool({ description: analyzeColorsDescription, inputSchema: analyzeColorsSchema, execute: createAnalyzeColorsExecute(deps) });
}
