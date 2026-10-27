/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /**
         * Ink & Champagne — the dashboard's only neutral scale.
         * Deep Ink (#20201E) anchors text, headings and the featured KPI card;
         * the scale warms upwards into the Warm Ivory background.
         */
        ink: {
          50: '#FAF8F4',
          100: '#F1EDE5',
          200: '#E6E0D6', // Warm Border
          300: '#D3CBBB',
          400: '#A9A294',
          500: '#77756F', // Warm Grey (secondary text)
          600: '#5F5D57',
          700: '#4A4844',
          800: '#33322F',
          900: '#20201E', // Deep Ink
          950: '#141413',
        },
        /** Selective brand accent — small highlights only, never a surface flood. */
        champagne: {
          50: '#F9F5ED',
          100: '#F1E8D6',
          200: '#E3D4B6',
          300: '#D2BC91',
          400: '#C2A875',
          500: '#B69A67', // Champagne
          600: '#A08353',
          700: '#83683F', // accessible on white for links
          800: '#6A5333',
          900: '#564329',
        },
        /** Soft supporting surfaces and restrained active states. */
        sand: {
          100: '#EFE8DA',
          200: '#D9CBB4', // Sand
          300: '#C7B596',
        },
        /** Main application background. */
        ivory: {
          50: '#FDFCF9',
          100: '#F7F4EE', // Warm Ivory
          200: '#F1ECE2',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        /** Editorial numerals for featured metrics. System-resident only. */
        display: ['ui-serif', 'Georgia', 'Cambria', 'Times New Roman', 'serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(32, 32, 30, 0.04)',
        popover: '0 12px 32px rgba(32, 32, 30, 0.12)',
      },
    },
  },
  plugins: [],
}
