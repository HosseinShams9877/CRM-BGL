// Flat ESLint config (ESLint v9 / Next 16) — enables `next lint` gate.
// Tuned to surface real defects without overwhelming the existing codebase.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // Error-only: things that genuinely cause bugs / security holes.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Stay friendly with existing React 19 patterns.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react/no-unescaped-entities': 'off',
      '@next/next/no-img-element': 'off',
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
  {
    // v2.14.0 — plain Node ESM build scripts (postbuild.mjs): give them the
    // Node globals so `no-undef` stays active without false positives.
    // v2.30.0 — Buffer added (reset-admin-password.mjs uses
    // crypto.timingSafeEqual over Buffers).
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        // v2.57.1 (r84) — QA E2E scripts embed browser code inside
        // page.evaluate() callbacks; those run in Chromium, not Node, so
        // no-undef needs the browser globals here (r74–r80 hit 50 false
        // positives otherwise).
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        getComputedStyle: 'readonly',
        requestAnimationFrame: 'readonly',
      },
    },
  },
  {
    // v2.29.0 — PM2 process file (deploy/pm2.config.cjs) is CommonJS by
    // design (PM2 requires module.exports). Node globals only for that file.
    files: ['deploy/**/*.cjs'],
    languageOptions: {
      globals: {
        module: 'readonly',
        require: 'readonly',
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    ignores: ['node_modules/**', '.next/**', 'node_modules', '.next', 'public/**', 'scripts/.v260-build/**', 'scripts/dump-*'],
  },
);
