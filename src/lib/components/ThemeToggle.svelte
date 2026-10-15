<script lang="ts">
  import { theme } from '#lib/client/theme.svelte.ts';
  import Icon from './Icon.svelte';
  let { labeled = false }: { labeled?: boolean } = $props();
  const choices = [
    { value: 'system', label: 'System', icon: 'monitor' },
    { value: 'light', label: 'Light', icon: 'sun' },
    { value: 'dark', label: 'Dark', icon: 'moon' },
  ] as const;
</script>

<div class={['theme-toggle segmented', labeled && 'labeled']} aria-label="Color theme" {@attach theme.attach}>
  {#each choices as choice (choice.value)}
    <button
      class={theme.current === choice.value ? 'active' : ''}
      aria-label={labeled ? undefined : `${choice.label} theme`}
      aria-pressed={theme.current === choice.value}
      title={labeled ? undefined : `${choice.label} theme`}
      onclick={() => theme.choose(choice.value)}
      ><Icon name={choice.icon} size={16} />{#if labeled}<span>{choice.label}</span>{/if}</button
    >
  {/each}
</div>
