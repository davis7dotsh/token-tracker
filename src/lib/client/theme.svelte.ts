import { untrack } from 'svelte';

export const themes = ['system', 'light', 'dark'] as const;
export type Theme = (typeof themes)[number];
const storageKey = 'token-tracker-theme';
const isTheme = (value: unknown): value is Theme => themes.some((theme) => theme === value);

// One preference per browser. Every theme control reads and writes this state,
// so the top bar and Settings stay in step. app.html applies it before paint.
let current = $state<Theme>('system');

const apply = () => {
  const dark = current === 'dark' || (current === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
};

export const theme = {
  get current() {
    return current;
  },
  choose: (value: Theme) => {
    current = value;
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      /* Session preference still works. */
    }
    apply();
  },
  // Attach to each theme control: reads the saved preference and follows the system.
  attach: () => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    untrack(() => {
      try {
        const stored = localStorage.getItem(storageKey);
        if (isTheme(stored)) current = stored;
      } catch {
        /* System theme is the default. */
      }
      apply();
    });
    const changed = () => {
      if (current === 'system') apply();
    };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  },
};
