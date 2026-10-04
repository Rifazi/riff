/**
 * Makes a CSS-variable-backed color usable with Tailwind's opacity
 * modifiers (`bg-primary/10`, `hover:bg-primary/90`, `border-warning/50`).
 *
 * Tailwind 3 can only inject an alpha channel into a color it can parse.
 * A plain `"var(--primary)"` string is unparseable, so every utility with
 * an opacity modifier is silently dropped — no background, no border.
 * Returning a function instead lets Tailwind hand us the alpha it wants,
 * and we blend it with `color-mix()`, which works for any color format
 * the theme happens to emit (hex, rgb(), oklch(), ...).
 *
 * `opacityValue` is undefined for the plain utility, a number for a
 * modifier, and `var(--tw-bg-opacity)` for the legacy `bg-opacity-*`
 * utilities — all three are handled.
 */
const themeColor =
  (variable) =>
  ({ opacityValue }) => {
    if (opacityValue === undefined || opacityValue === '<alpha-value>') {
      return `var(${variable})`;
    }
    return `color-mix(in srgb, var(${variable}) calc(${opacityValue} * 100%), transparent)`;
  };

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-source-sans-3)'],
      },
      colors: {
        // These read the shadcn-style CSS variables defined in
        // globals.css, which themselves alias onto Riff's generated
        // theme tokens (--color-*). The theme's tokens are plain color
        // values, not HSL triplets, so there's no HSL-function wrapping
        // here — `themeColor` keeps them alpha-modifier-capable instead.
        background: themeColor('--background'),
        foreground: themeColor('--foreground'),
        border: themeColor('--border'),
        input: themeColor('--input'),
        ring: themeColor('--ring'),
        primary: {
          DEFAULT: themeColor('--primary'),
          foreground: themeColor('--primary-foreground'),
        },
        secondary: {
          DEFAULT: themeColor('--secondary'),
          foreground: themeColor('--secondary-foreground'),
        },
        card: {
          DEFAULT: themeColor('--card'),
          foreground: themeColor('--card-foreground'),
        },
        popover: {
          DEFAULT: themeColor('--popover'),
          foreground: themeColor('--popover-foreground'),
        },
        muted: {
          DEFAULT: themeColor('--muted'),
          foreground: themeColor('--muted-foreground'),
        },
        accent: {
          DEFAULT: themeColor('--accent'),
          foreground: themeColor('--accent-foreground'),
        },
        destructive: {
          DEFAULT: themeColor('--destructive'),
          foreground: themeColor('--destructive-foreground'),
        },
        success: {
          DEFAULT: themeColor('--color-success'),
          foreground: themeColor('--color-on-success'),
        },
        warning: {
          DEFAULT: themeColor('--color-warning'),
          foreground: themeColor('--color-on-warning'),
        },
        info: {
          DEFAULT: themeColor('--color-info'),
          foreground: themeColor('--color-on-info'),
        },
        chart: {
          1: themeColor('--chart-1'),
          2: themeColor('--chart-2'),
          3: themeColor('--chart-3'),
          4: themeColor('--chart-4'),
          5: themeColor('--chart-5'),
        },
      },
      // Tailwind's own defaults for the color-less forms of these
      // utilities are literal palette values (`border` alone → gray-200,
      // `ring` alone → blue-500, ring offsets → plain white), which would
      // put off-theme colors back on screen wherever a class omits the
      // color.
      // Point the defaults at the theme instead.
      borderColor: {
        DEFAULT: themeColor('--border'),
      },
      ringColor: {
        DEFAULT: themeColor('--ring'),
      },
      ringOffsetColor: {
        DEFAULT: themeColor('--background'),
      },
      borderRadius: {
        lg: 'var(--radius-lg, var(--radius))',
        md: 'var(--radius-md, var(--radius))',
        sm: 'var(--radius-sm, calc(var(--radius) - 4px))',
      },
      keyframes: {
        'accordion-down': {
          from: {
            height: '0',
          },
          to: {
            height: 'var(--radix-accordion-content-height)',
          },
        },
        'accordion-up': {
          from: {
            height: 'var(--radix-accordion-content-height)',
          },
          to: {
            height: '0',
          },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [
    require('tailwindcss-animate'),
    require('@tailwindcss/typography'),
    require('@tailwindcss/container-queries'),
  ],
};
