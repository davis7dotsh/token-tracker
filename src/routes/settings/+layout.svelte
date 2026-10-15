<script lang="ts">
  import { browser } from '$app/env';
  import { page } from '$app/state';
  import { makeDashboardClient } from '#lib/client/dashboard-rpc.ts';
  import { SettingsState, setSettings } from '#lib/client/settings.svelte.ts';
  import Icon from '#lib/components/Icon.svelte';
  import ThemeToggle from '#lib/components/ThemeToggle.svelte';

  let { children } = $props();
  const sections = [
    { href: '/settings', label: 'General' },
    { href: '/settings/pricing', label: 'Pricing' },
    { href: '/settings/devices', label: 'Devices' },
    { href: '/settings/data', label: 'Data' },
    { href: '/settings/about', label: 'About' },
  ];
  const settings = setSettings(new SettingsState(browser ? makeDashboardClient() : undefined));
  const current = $derived(page.url.pathname.replace(/\/$/, '') || '/');
  const title = $derived(sections.find((section) => section.href === current)?.label ?? 'Settings');

  function disposeClient() {
    return () => void settings.client?.dispose();
  }
</script>

<svelte:head><title>{title} · Settings · Token tracker</title></svelte:head>

<div class="workspace" {@attach disposeClient}>
  <header class="topbar">
    <a class="wordmark" href="/"
      ><svg class="brand-mark" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"
        ><rect x="5" y="18" width="5" height="9" rx="1.5" /><rect x="13.5" y="11" width="5" height="16" rx="1.5" /><rect
          x="22"
          y="5"
          width="5"
          height="22"
          rx="1.5"
        /></svg
      >Token tracker<span class="brand-dot">.</span></a
    >
    <div class="topbar-right">
      <a class="icon-button active" href="/settings" aria-label="Settings" aria-current="page" title="Settings"
        ><Icon name="settings" /></a
      >
      <ThemeToggle />
    </div>
  </header>

  <main class="settings">
    <nav class="settings-nav" aria-label="Settings">
      {#each sections as section (section.href)}<a
          href={section.href}
          aria-current={current === section.href ? 'page' : undefined}>{section.label}</a
        >{/each}
    </nav>
    <div class="settings-content">
      {@render children()}
    </div>
  </main>
</div>
