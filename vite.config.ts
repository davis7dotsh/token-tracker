import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-node';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  lint: {
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ['.svelte-kit/**', 'build/**', 'dist/**', 'artifacts/**', 'bin/**'],
    categories: { correctness: 'error' },
  },
  fmt: {
    svelte: true,
    singleQuote: true,
    printWidth: 120,
    ignorePatterns: [
      '.svelte-kit/**',
      'build/**',
      'dist/**',
      'artifacts/**',
      'bin/**',
      'src/lib/server/usage/pricing.json',
      'static/*-license.txt',
    ],
  },
  plugins: [
    // Kit also starts config-less Vite servers while syncing env types. Their
    // default optimizer cache must never evict a running dashboard's modules.
    { name: 'dashboard-dev-cache', apply: 'serve', config: () => ({ cacheDir: 'node_modules/.vite-dashboard-dev' }) },
    sveltekit({ adapter: adapter(), compilerOptions: { experimental: { async: true } } }),
  ],
  ssr: { external: ['bun:sqlite'] },
  server: { port: 5173, allowedHosts: ['.ts.net'] },
});
