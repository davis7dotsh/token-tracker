<script lang="ts">
  let { name, size = 18 }: { name: string; size?: number } = $props();
  const paths: Record<string, string> = {
    refresh: 'M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7',
    download: 'M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5',
    sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    moon: 'M20.5 14a9 9 0 0 1-10.5-10.5A9 9 0 1 0 20.5 14Z',
    monitor: 'M4 4h16v12H4ZM8 21h8m-4-5v5',
    chevron: 'm7 10 5 5 5-5',
    close: 'm6 6 12 12M18 6 6 18',
    search: 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0m-1.5 4.5L21 21',
    bars: 'M5 19V11m7 8V5m7 14V8',
    line: 'm3 17 6-8 5 4 7-10',
    arrow: 'm9 5 7 7-7 7',
    check: 'm5 12 4 4L19 6',
    warning: 'm12 3 10 18H2L12 3Zm0 6v5m0 3v.2',
    info: 'M12 11v6m0-10v.2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
    terminal: 'm5 7 5 5-5 5m8 0h6',
    network: 'M8 3h8v6H8ZM2 16h8v5H2Zm12 0h8v5h-8ZM12 9v4M6 16v-3h12v3',
    external: 'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
    repository: 'M6 3h14v18H6a3 3 0 0 1 0-6h14M6 3a3 3 0 0 0-3 3v12m5 0h8M8 7h8',
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.6"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"><path d={paths[name] ?? paths.info} /></svg
>
