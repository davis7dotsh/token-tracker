<script lang="ts">
  import '@fontsource-variable/geist';
  import geistFont from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url';
  import '../app.css';
  let { children } = $props();
</script>

<svelte:head>
  <link rel="preload" href={geistFont} as="font" type="font/woff2" crossorigin="anonymous" />
</svelte:head>

{@render children()}
