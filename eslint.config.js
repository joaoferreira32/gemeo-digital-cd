import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Node scripts (benchmarks, mutation check).
    files: ['bench/**/*.{ts,mjs}', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The simulation must stay deterministic and renderer-agnostic.
    files: ['src/sim/**/*.ts', 'src/ai/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['three', 'three/*', '../render/*', '../ui/*'] },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded Rng from sim/rng.ts.' },
        { object: 'Date', property: 'now', message: 'Simulation time comes from the fixed step.' },
        {
          object: 'performance',
          property: 'now',
          message: 'Simulation time comes from the fixed step.',
        },
      ],
    },
  },
  prettier,
);
