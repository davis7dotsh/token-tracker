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
  plugins: [sveltekit({ adapter: adapter(), compilerOptions: { experimental: { async: true } } })],
  ssr: { external: ['bun:sqlite'] },
  // localhost and IP addresses are always allowed. Tailnet MagicDNS names are too.
  // Add any other hostname here; `true` would disable the DNS-rebinding check.
  server: { port: 5173, strictPort: true, allowedHosts: ['.ts.net'] },
  preview: { allowedHosts: ['.ts.net'] },
});
