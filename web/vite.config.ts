import { defineConfig } from 'vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: { runes: true },
			adapter: adapter({ fallback: 'index.html', pages: '../priv/static' })
		})
	],
	server: {
		proxy: {
			'/api': 'http://127.0.0.1:4000'
		}
	}
});
