import { describe, expect, test } from 'bun:test';

import tailwindConfig from '../../tailwind.config.js';

/**
 * Every color in the Tailwind config aliases onto a CSS variable that
 * globals.css points at Riff's generated theme tokens. Tailwind 3 can only
 * attach an alpha channel to a color it is able to parse, so a color
 * declared as the plain string `"var(--primary)"` makes it silently drop
 * every utility that carries an opacity modifier — `bg-primary/10`,
 * `hover:bg-primary/90`, `border-warning/50` and friends all compile to
 * nothing. Declaring them as functions is what keeps those working, so
 * these tests guard the shape rather than any particular palette.
 */

type ColorFn = (options: { opacityValue?: string }) => string;

const colors = (
  tailwindConfig as unknown as {
    theme: { extend: { colors: Record<string, unknown> } };
  }
).theme.extend.colors;

/** Flattens `{ primary: { DEFAULT, foreground } }` into dotted keys. */
function flatten(value: Record<string, unknown>, prefix = ''): Array<[string, unknown]> {
  return Object.entries(value).flatMap(([key, entry]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    return entry !== null && typeof entry === 'object'
      ? flatten(entry as Record<string, unknown>, name)
      : [[name, entry] as [string, unknown]];
  });
}

const allColors = flatten(colors);

describe('tailwind theme colors', () => {
  test('every color is alpha-modifier-capable', () => {
    const plainStrings = allColors.filter(([, value]) => typeof value !== 'function').map(([name]) => name);

    expect(plainStrings).toEqual([]);
  });

  test('the plain utility resolves to the bare CSS variable', () => {
    const primary = colors.primary as { DEFAULT: ColorFn };

    expect(primary.DEFAULT({})).toBe('var(--primary)');
    expect(primary.DEFAULT({ opacityValue: '<alpha-value>' })).toBe('var(--primary)');
  });

  test('an opacity modifier blends the variable instead of being dropped', () => {
    const primary = colors.primary as { DEFAULT: ColorFn };

    expect(primary.DEFAULT({ opacityValue: '0.1' })).toBe(
      'color-mix(in srgb, var(--primary) calc(0.1 * 100%), transparent)',
    );
  });

  test('the legacy bg-opacity-* variable form is still valid CSS', () => {
    const destructive = colors.destructive as { DEFAULT: ColorFn };

    expect(destructive.DEFAULT({ opacityValue: 'var(--tw-bg-opacity)' })).toBe(
      'color-mix(in srgb, var(--destructive) calc(var(--tw-bg-opacity) * 100%), transparent)',
    );
  });

  test('no color is a hard-coded value', () => {
    const hardCoded = allColors.filter(([, value]) => {
      const resolved = (value as ColorFn)({});
      return !/^var\(--[a-z0-9-]+\)$/.test(resolved);
    });

    expect(hardCoded).toEqual([]);
  });

  test('the color-less border/ring utilities default to theme tokens', () => {
    const { borderColor, ringColor, ringOffsetColor } = tailwindConfig.theme.extend;

    expect((borderColor.DEFAULT as ColorFn)({})).toBe('var(--border)');
    expect((ringColor.DEFAULT as ColorFn)({})).toBe('var(--ring)');
    expect((ringOffsetColor.DEFAULT as ColorFn)({})).toBe('var(--background)');
  });
});
