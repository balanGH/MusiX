/**
 * Every colour resolves to a CSS custom property so that theme switching
 * (dark / amoled / light / system) and the dynamic artwork accent (spec §38)
 * are a single attribute change on <html> with no React re-render.
 */
const rgb = (name) => `rgb(var(${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: rgb('--mx-bg'),
        'bg-elevated': rgb('--mx-bg-elevated'),
        surface: rgb('--mx-surface'),
        'surface-hover': rgb('--mx-surface-hover'),
        'surface-active': rgb('--mx-surface-active'),
        line: rgb('--mx-line'),
        'line-strong': rgb('--mx-line-strong'),
        text: rgb('--mx-text'),
        muted: rgb('--mx-text-muted'),
        subtle: rgb('--mx-text-subtle'),
        accent: rgb('--mx-accent'),
        'accent-hover': rgb('--mx-accent-hover'),
        'accent-fg': rgb('--mx-accent-fg'),
        danger: rgb('--mx-danger'),
        warn: rgb('--mx-warn'),
        ok: rgb('--mx-ok'),
      },
      fontFamily: {
        sans: ['InterVariable', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        xs: '0.25rem',
        card: '0.75rem',
        panel: '1rem',
      },
      boxShadow: {
        card: '0 1px 2px rgb(0 0 0 / 0.28), 0 8px 24px -12px rgb(0 0 0 / 0.45)',
        pop: '0 12px 40px -8px rgb(0 0 0 / 0.55)',
      },
      transitionDuration: {
        DEFAULT: '150ms',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'bar-dance': {
          '0%, 100%': { transform: 'scaleY(0.35)' },
          '50%': { transform: 'scaleY(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'slide-up': 'slide-up 200ms ease-out',
      },
    },
  },
  plugins: [],
};
