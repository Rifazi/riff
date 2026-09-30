import { z } from 'zod';
import { DENSITIES, type ThemeDefinition } from './presets.js';

// Validates a theme definition from the Theme page, a propose_theme call or
// a hand-edited theme/theme.json. Strings are interpolated straight into
// CSS, so they're limited to characters that can't close a declaration or
// a rule (no ; { } or quotes other than font-name quoting).

const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a 6-digit hex color like #2563eb')
  .transform((v) => v.toLowerCase());
const fontStack = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[\w\s"',.-]+$/, 'may only contain font names, quotes, commas and hyphens');
const shadow = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[\w\s#().,/%-]+$/, 'must be a CSS box-shadow value, or "none"');
const px = (max: number) => z.number().min(0).max(max);

const colorsShape = {
  bg: hex,
  surface: hex,
  surfaceMuted: hex,
  border: hex,
  text: hex,
  textMuted: hex,
  primary: hex,
  onPrimary: hex,
  success: hex,
  warning: hex,
  danger: hex,
  info: hex,
};
const colors = z.object(colorsShape);
const fonts = z.object({ sans: fontStack, heading: fontStack, mono: fontStack });
const radius = z.object({ sm: px(48), md: px(48), lg: px(64), full: px(9999) });
const shadows = z.object({ sm: shadow, md: shadow });

export const themeDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300),
  fonts,
  headingWeight: z.number().int().min(100).max(900),
  radius,
  borderWidth: px(6),
  shadow: shadows,
  density: z.enum(DENSITIES),
  light: colors,
  dark: colors,
});

// What propose_theme may change on top of its starting theme — every field
// optional, at every level.
export const themeChangesSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  fonts: fonts.partial().optional(),
  headingWeight: z.number().optional(),
  radius: radius.partial().optional(),
  borderWidth: z.number().optional(),
  shadow: shadows.partial().optional(),
  density: z.enum(DENSITIES).optional(),
  light: colors.partial().optional(),
  dark: colors.partial().optional(),
});
export type ThemeChanges = z.infer<typeof themeChangesSchema>;

export class InvalidThemeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidThemeError';
  }
}

export function parseThemeDefinition(input: unknown): ThemeDefinition {
  const result = themeDefinitionSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || 'theme'}: ${i.message}`);
    throw new InvalidThemeError(`Invalid theme — ${issues.join('; ')}`);
  }
  return result.data;
}

export function mergeThemeChanges(base: ThemeDefinition, changes: ThemeChanges = {}): ThemeDefinition {
  return parseThemeDefinition({
    ...base,
    ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined && typeof v !== 'object')),
    fonts: { ...base.fonts, ...changes.fonts },
    radius: { ...base.radius, ...changes.radius },
    shadow: { ...base.shadow, ...changes.shadow },
    light: { ...base.light, ...changes.light },
    dark: { ...base.dark, ...changes.dark },
  });
}

// Key-order-independent equality, so a hand-edited theme.json that only
// reordered keys still counts as its preset.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}

export function sameTheme(a: ThemeDefinition, b: ThemeDefinition): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
