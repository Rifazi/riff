import { describe, expect, test } from 'bun:test';

import {
  analyzePairs,
  analyzePalette,
  analyzeThemeColors,
  contrastRatio,
  parseColor,
  readPalette,
  toOklch,
} from '../../../harness-server/backend/src/themes/color-science';
import { THEME_PRESETS } from '../../../harness-server/backend/src/themes/presets';
import { historyWithoutImages, withoutImages } from '../../../harness-server/backend/src/agents/tool-defs/screenshot-tool';

const rgb = (hex: string) => parseColor(hex)!;

describe('color science', () => {
  test('parses hex and rgb()', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor('#336699cc')).toEqual({ r: 51, g: 102, b: 153 });
    expect(parseColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30 });
    expect(parseColor('papayawhip')).toBeNull();
  });

  test('WCAG contrast matches known values', () => {
    const near = (actual: number, expected: number) => expect(Math.abs(actual - expected) < 0.05).toBe(true);
    near(contrastRatio(rgb('#000'), rgb('#fff')), 21);
    near(contrastRatio(rgb('#777'), rgb('#fff')), 4.48);
    near(contrastRatio(rgb('#fff'), rgb('#fff')), 1);
  });

  test('OKLCH: white is light and colorless, red has a warm hue', () => {
    expect(Math.abs(toOklch(rgb('#fff')).l - 1) < 0.01).toBe(true);
    expect(toOklch(rgb('#fff')).c).toBeLessThan(0.01);
    const red = toOklch(rgb('#ff0000'));
    expect(red.h).toBeGreaterThan(20);
    expect(red.h).toBeLessThan(40);
  });

  test('names harmonies', () => {
    expect(readPalette(['#2563eb', '#f59e0b'].map(rgb)).harmony).toBe('complementary');
    expect(readPalette(['#2563eb', '#3b82f6', '#1d4ed8'].map(rgb)).harmony).toBe('monochromatic');
    expect(readPalette(['#808080', '#ffffff'].map(rgb)).harmony).toBe('neutral');
  });

  test('flags a palette with too many unrelated hues', () => {
    const reading = readPalette(['#ff0000', '#ffaa00', '#00cc44', '#0088ff', '#aa00ff', '#ff00aa'].map(rgb));
    expect(reading.notes.some((n) => n.includes('too many'))).toBe(true);
  });

  test('reports failing pairs', () => {
    const text = analyzePairs([
      { fg: '#999999', bg: '#ffffff', label: 'muted' },
      { fg: '#999999', bg: '#ffffff', label: 'icon', large: true },
    ]);
    expect(text).toContain('muted: 2.85:1');
    expect(text).toContain('FAILS');
    expect(text).toContain('icon: 2.85:1 (fail), FAILS, needs 3:1');
  });

  test('every shipped preset passes the contrast checks it was tuned for', () => {
    for (const preset of THEME_PRESETS) {
      const report = analyzeThemeColors(preset);
      const failing = report.split('\n').filter((l) => l.includes('| FAIL') && /text|button|link/.test(l) && !l.includes('non-text'));
      expect({ preset: preset.id, failing }).toEqual({ preset: preset.id, failing: [] });
    }
  });

  test('palette report lists each color', () => {
    expect(analyzePalette(['#2563eb', 'nope'])).toContain('Could not read: nope');
  });
});

describe('screenshot results', () => {
  test('the transcript keeps the text, never the pixels', () => {
    expect(withoutImages({ text: 'x', image: { data: 'AAAA', mediaType: 'image/png' }, file: 'f.png' })).toEqual({ text: 'x', file: 'f.png' });
    expect(withoutImages([{ type: 'text', text: 'x' }, { type: 'image', data: 'AAAA' }])).toEqual([
      { type: 'text', text: 'x' },
      { type: 'text', text: '[screenshot]' },
    ]);
    expect(withoutImages('plain')).toBe('plain');
  });

  test('stored history loses the pixels but keeps the tool result text', () => {
    const history = [
      { role: 'assistant', content: 'hi' },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: '1', toolName: 'screenshot_app', output: { type: 'json', value: { text: 'shot', image: { data: 'AAAA' }, file: 'f.png' } } }],
      },
    ] as never;
    const out = historyWithoutImages(history) as unknown as { content: { output: { value: unknown } }[] }[];
    expect(out[1].content[0].output.value).toEqual({ text: 'shot', file: 'f.png' });
  });
});
