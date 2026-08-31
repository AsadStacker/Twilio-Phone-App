import next from 'eslint-config-next/core-web-vitals';

/** Next 16 ships a native flat config that already includes its TypeScript rules. */
const eslintConfig = [
  ...next,
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'],
  },
];

export default eslintConfig;
