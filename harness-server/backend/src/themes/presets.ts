// The default themes an app can start from. An app's own theme lives in its
// repo's theme/theme.json (see apply-theme.ts), which is where it's edited;
// these are only starting points. theme-css.ts renders any definition to
// the CSS written to the repo and to the token maps the Apps page previews
// with, so the preview and the real app can't drift apart.

export interface ThemeColors {
  bg: string;
  surface: string;
  surfaceMuted: string;
  border: string;
  text: string;
  textMuted: string;
  primary: string;
  onPrimary: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
}

export const DENSITIES = ['compact', 'comfortable', 'spacious'] as const;
export type Density = (typeof DENSITIES)[number];

export interface ThemeDefinition {
  name: string;
  description: string;
  fonts: { sans: string; heading: string; mono: string };
  headingWeight: number;
  radius: { sm: number; md: number; lg: number; full: number };
  borderWidth: number;
  shadow: { sm: string; md: string };
  density: Density;
  light: ThemeColors;
  dark: ThemeColors;
}

export interface ThemePreset extends ThemeDefinition {
  id: string;
}

const SYSTEM_SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SYSTEM_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const SOFT_SHADOW = {
  sm: '0 1px 2px rgb(15 23 42 / 0.06), 0 1px 3px rgb(15 23 42 / 0.08)',
  md: '0 4px 12px rgb(15 23 42 / 0.10), 0 2px 4px rgb(15 23 42 / 0.06)',
};

// Every palette is built in OKLCH (perceptually even lightness) from a named
// color harmony, then each color's lightness is tuned until it passes WCAG
// AA where it's used: text and muted text on every surface, onPrimary on
// primary, primary as link text on surfaces, and white text on danger
// buttons, in both modes. Status colors keep their meaning (green success,
// amber warning, red danger) but take hues that fit each harmony.
export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'blueberry-fizz',
    name: 'Blueberry Fizz',
    description: 'Crisp and clear, like a blueberry soda. Complementary: a blueberry blue against its opposite, apricot. Suits dashboards, admin screens and internal tools.',
    fonts: { sans: `Inter, ${SYSTEM_SANS}`, heading: `Inter, ${SYSTEM_SANS}`, mono: SYSTEM_MONO },
    headingWeight: 650,
    radius: { sm: 4, md: 6, lg: 10, full: 9999 },
    borderWidth: 1,
    shadow: SOFT_SHADOW,
    density: 'comfortable',
    light: {
      bg: '#f4f8ff', surface: '#fefeff', surfaceMuted: '#ecf0f8', border: '#dae0eb',
      text: '#171d28', textMuted: '#646c7a', primary: '#2766e2', onPrimary: '#ffffff',
      success: '#1a9951', warning: '#b37903', danger: '#d02b34', info: '#028fc0',
    },
    dark: {
      bg: '#0a0e16', surface: '#131720', surfaceMuted: '#1d222a', border: '#30363f',
      text: '#e9edf3', textMuted: '#838b9a', primary: '#679cff', onPrimary: '#0c121c',
      success: '#36ac62', warning: '#c38406', danger: '#d9353c', info: '#2f9ecf',
    },
  },
  {
    id: 'grape-soda',
    name: 'Grape Soda',
    description: 'Bubbly and friendly. Split-complementary: grape violet with the gold and green on either side of its opposite. Suits consumer apps and SaaS products.',
    fonts: { sans: `"Plus Jakarta Sans", Inter, ${SYSTEM_SANS}`, heading: `"Plus Jakarta Sans", Inter, ${SYSTEM_SANS}`, mono: SYSTEM_MONO },
    headingWeight: 700,
    radius: { sm: 6, md: 10, lg: 16, full: 9999 },
    borderWidth: 1,
    shadow: {
      sm: '0 1px 2px rgb(76 29 149 / 0.06), 0 2px 6px rgb(76 29 149 / 0.06)',
      md: '0 8px 24px rgb(76 29 149 / 0.12), 0 2px 6px rgb(76 29 149 / 0.06)',
    },
    density: 'spacious',
    light: {
      bg: '#f9f6ff', surface: '#fefefe', surfaceMuted: '#f1eefa', border: '#e2dded',
      text: '#1f192a', textMuted: '#6e687c', primary: '#8b46df', onPrimary: '#ffffff',
      success: '#1a9951', warning: '#a28007', danger: '#d21d53', info: '#3e85dc',
    },
    dark: {
      bg: '#100c17', surface: '#191521', surfaceMuted: '#231f2c', border: '#373340',
      text: '#eeebf4', textMuted: '#8d879c', primary: '#b17ffe', onPrimary: '#140e1e',
      success: '#36ac62', warning: '#b28d04', danger: '#d7325b', info: '#5894e0',
    },
  },
  {
    id: 'matcha-latte',
    name: 'Matcha Latte',
    description: 'Calm and grounded. Analogous: matcha green between teal and honey, over warm latte neutrals. Suits finance, health and operations apps.',
    fonts: { sans: SYSTEM_SANS, heading: SYSTEM_SANS, mono: SYSTEM_MONO },
    headingWeight: 650,
    radius: { sm: 4, md: 8, lg: 12, full: 9999 },
    borderWidth: 1,
    shadow: SOFT_SHADOW,
    density: 'comfortable',
    light: {
      bg: '#fef7eb', surface: '#fefefd', surfaceMuted: '#f7efe3', border: '#e9decd',
      text: '#261b08', textMuted: '#776a54', primary: '#3b7a2c', onPrimary: '#ffffff',
      success: '#19966e', warning: '#ac7d08', danger: '#c2402a', info: '#119399',
    },
    dark: {
      bg: '#140d02', surface: '#1e1608', surfaceMuted: '#282012', border: '#3d3426',
      text: '#f2ece2', textMuted: '#968972', primary: '#6cb35d', onPrimary: '#1a0f00',
      success: '#36a980', warning: '#b98918', danger: '#cb4832', info: '#42a3a8',
    },
  },
  {
    id: 'peach-cobbler',
    name: 'Peach Cobbler',
    description: 'Warm and editorial, with serif headings. Analogous warms (peach, caramel, olive) plus one complementary accent, a blueberry blue for info. Suits content-heavy and marketing apps.',
    fonts: {
      sans: SYSTEM_SANS,
      heading: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
      mono: SYSTEM_MONO,
    },
    headingWeight: 600,
    radius: { sm: 3, md: 6, lg: 10, full: 9999 },
    borderWidth: 1,
    shadow: {
      sm: '0 1px 2px rgb(68 42 20 / 0.06), 0 1px 3px rgb(68 42 20 / 0.08)',
      md: '0 6px 16px rgb(68 42 20 / 0.10), 0 2px 4px rgb(68 42 20 / 0.06)',
    },
    density: 'comfortable',
    light: {
      bg: '#fef6ee', surface: '#fffefd', surfaceMuted: '#f9eee2', border: '#ecddcc',
      text: '#291906', textMuted: '#7b6853', primary: '#b84b03', onPrimary: '#ffffff',
      success: '#6e903c', warning: '#ae7c02', danger: '#c63740', info: '#268fb8',
    },
    dark: {
      bg: '#160c02', surface: '#201507', surfaceMuted: '#2b1f11', border: '#3f3324',
      text: '#f4ebe2', textMuted: '#9b8771', primary: '#ea7d2e', onPrimary: '#1c0e00',
      success: '#7da04b', warning: '#bb881a', danger: '#d14148', info: '#479dc4',
    },
  },
  {
    id: 'midnight-arcade',
    name: 'Midnight Arcade',
    description: 'Neon on deep navy, compact and high-contrast. Triadic: cyan, magenta and amber spaced evenly around the wheel. Suits developer tools and data-dense screens.',
    fonts: { sans: SYSTEM_SANS, heading: SYSTEM_SANS, mono: `"JetBrains Mono", ${SYSTEM_MONO}` },
    headingWeight: 600,
    radius: { sm: 4, md: 6, lg: 8, full: 9999 },
    borderWidth: 1,
    shadow: {
      sm: '0 1px 2px rgb(0 0 0 / 0.12)',
      md: '0 8px 24px rgb(0 0 0 / 0.20)',
    },
    density: 'compact',
    light: {
      bg: '#f4f8ff', surface: '#fefeff', surfaceMuted: '#eaf0fe', border: '#d3e0fb',
      text: '#101b37', textMuted: '#5c6c8d', primary: '#087982', onPrimary: '#ffffff',
      success: '#059a46', warning: '#a97f05', danger: '#d40c5b', info: '#c35bca',
    },
    dark: {
      bg: '#060d20', surface: '#0e162a', surfaceMuted: '#182136', border: '#2b354b',
      text: '#e5edfc', textMuted: '#7a8bad', primary: '#0db3c1', onPrimary: '#06102a',
      success: '#09af51', warning: '#b88a06', danger: '#df2264', info: '#ca61d1',
    },
  },
  {
    id: 'zine-machine',
    name: 'Zine Machine',
    description: 'Photocopied punk: square corners, heavy borders and a typewriter heading. Achromatic ink and paper, with Bauhaus red, yellow and blue as spot colors.',
    fonts: { sans: SYSTEM_SANS, heading: `"JetBrains Mono", ${SYSTEM_MONO}`, mono: `"JetBrains Mono", ${SYSTEM_MONO}` },
    headingWeight: 700,
    radius: { sm: 0, md: 0, lg: 0, full: 0 },
    borderWidth: 2,
    shadow: { sm: 'none', md: '4px 4px 0 currentColor' },
    density: 'comfortable',
    light: {
      bg: '#ffffff', surface: '#ffffff', surfaceMuted: '#f0f0f0', border: '#111111',
      text: '#111111', textMuted: '#6c6c6c', primary: '#161616', onPrimary: '#ffffff',
      success: '#029b29', warning: '#a68003', danger: '#db0310', info: '#3f80fe',
    },
    dark: {
      bg: '#0b0b0b', surface: '#0b0b0b', surfaceMuted: '#222222', border: '#f2f2f2',
      text: '#f2f2f2', textMuted: '#8a8a8a', primary: '#e8e8e8', onPrimary: '#0b0b0b',
      success: '#19b036', warning: '#b48c05', danger: '#e61b1d', info: '#528dff',
    },
  },
];

export function findThemePreset(id: string): ThemePreset | undefined {
  return THEME_PRESETS.find((t) => t.id === id);
}

export function presetDefinition(preset: ThemePreset): ThemeDefinition {
  const { id: _id, ...definition } = preset;
  return definition;
}
