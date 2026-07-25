<script lang="ts">
	import '../app.css';
	import { resolve } from '$app/paths';
	import { navigating, page } from '$app/state';
	import { onMount } from 'svelte';

	let { children } = $props();
	let themeLabel = $state('Theme: system');

	const readTheme = () => {
		try {
			return localStorage.getItem('token-tracker-theme');
		} catch {
			return null;
		}
	};

	onMount(() => {
		document.getElementById('initial-loading')?.remove();
		const saved = readTheme();
		applyTheme(saved);
		themeLabel = saved ? `Theme: ${saved}` : 'Theme: system';
	});

	function applyTheme(theme: string | null) {
		const dark =
			theme === 'dark' ||
			(theme === null && matchMedia('(prefers-color-scheme: dark)').matches);
		if (dark) document.documentElement.dataset.theme = 'dark';
		else document.documentElement.removeAttribute('data-theme');
	}

	function cycleTheme() {
		const saved = readTheme();
		const next = saved === null ? 'light' : saved === 'light' ? 'dark' : null;
		try {
			if (next) localStorage.setItem('token-tracker-theme', next);
			else localStorage.removeItem('token-tracker-theme');
		} catch {
			// Persistence is optional; applying the theme still works.
		}
		applyTheme(next);
		themeLabel = next ? `Theme: ${next}` : 'Theme: system';
	}
</script>

<svelte:head>
	<title>Token Tracker</title>
	<meta name="description" content="Local AI agent token usage" />
</svelte:head>

<!-- Mounted unconditionally so the message is announced; see the note on the same
     pattern in the usage page. -->
<div class="sr-only" role="status" aria-live="polite">
	{navigating.to ? 'Loading page…' : ''}
</div>

{#if navigating.to}
	<div class="navigation-progress" aria-hidden="true"></div>
{/if}

<div class="shell" aria-busy={Boolean(navigating.to)}>
	<header class="top-rail">
		<a class="wordmark" href={resolve('/')}>TOKEN/01</a>
		<nav aria-label="Primary">
			<a
				href={resolve('/')}
				aria-current={page.url.pathname === '/' ? 'page' : undefined}>Usage</a
			>
			<a
				href={resolve('/system')}
				aria-current={page.url.pathname === '/system' ? 'page' : undefined}
				>System</a
			>
		</nav>
		<button
			class="theme-toggle"
			type="button"
			onclick={cycleTheme}
			aria-label={themeLabel}>◐</button
		>
	</header>
	{@render children()}
</div>
