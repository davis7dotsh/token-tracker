<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
</script>

<svelte:head><title>{page.status} · Token Tracker</title></svelte:head>

<main class="error-state">
	<p class="eyebrow">REQUEST / {page.status}</p>
	<h1>Dashboard unavailable</h1>
	<p class="lede">The local Token Tracker API did not return this surface.</p>
	<p><a href={resolve('/')}>Try usage again</a></p>
</main>
