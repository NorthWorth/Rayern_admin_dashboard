/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Calm neutral "operator console" palette.
        ink: {
          50: '#f7f8f9',
          100: '#eef0f2',
          200: '#dee1e6',
          300: '#c4c9d1',
          400: '#9aa2ae',
          500: '#717a89',
          600: '#545c6b',
          700: '#40464f',
          800: '#292e35',
          900: '#1b1f25',
          950: '#111418',
        },
        accent: {
          DEFAULT: '#1f6f54',
          hover: '#185a44',
          soft: '#e3f0ea',
          softborder: '#bcd9cb',
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
      },
    },
  },
  plugins: [],
}
