<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  type Theme = 'system' | 'light' | 'dark';
  let theme = $state<Theme>('system');
  const choices = [
    { value: 'system', label: 'System theme', icon: 'monitor' },
    { value: 'light', label: 'Light theme', icon: 'sun' },
    { value: 'dark', label: 'Dark theme', icon: 'moon' },
  ] as const;

  function apply() {
    const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }
  function choose(value: Theme) {
    theme = value;
    try {
      localStorage.setItem('token-tracker-theme', value);
    } catch {
      /* Session preference still works. */
    }
    apply();
  }
  function attachTheme() {
    const media = matchMedia('(prefers-color-scheme: dark)');
    untrack(() => {
      try {
        const stored = localStorage.getItem('token-tracker-theme');
        if (stored === 'light' || stored === 'dark' || stored === 'system') theme = stored;
      } catch {
        /* System theme is the default. */
      }
      apply();
    });
    const changed = () => {
      if (theme === 'system') apply();
    };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }
</script>

<div class="theme-toggle segmented" aria-label="Color theme" {@attach attachTheme}>
  {#each choices as choice (choice.value)}
    <button
      class={theme === choice.value ? 'active' : ''}
      aria-label={choice.label}
      aria-pressed={theme === choice.value}
      title={choice.label}
      onclick={() => choose(choice.value)}><Icon name={choice.icon} size={16} /></button
    >
  {/each}
</div>
