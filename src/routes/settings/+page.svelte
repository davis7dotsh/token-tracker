<script lang="ts">
  import { untrack } from 'svelte';
  import { page } from '$app/state';
  import {
    dashboardRanges,
    readDefaultRange,
    readHiddenProjects,
    saveDefaultRange,
    saveHiddenProjects,
    type DashboardRange,
  } from '#lib/client/dashboard-url.ts';
  import ThemeToggle from '#lib/components/ThemeToggle.svelte';

  let range = $state<DashboardRange>('30d');

  let hidden = $state.raw<readonly string[]>([]);

  function loadPreferences() {
    untrack(() => {
      range = readDefaultRange();
      hidden = readHiddenProjects();
    });
  }
  function chooseRange(value: DashboardRange) {
    range = value;
    saveDefaultRange(value);
  }
</script>

<h1 class="settings-title">General</h1>
<div class="settings-rows" {@attach loadPreferences}>
  <div class="settings-row">
    <span class="settings-label">Theme</span>
    <ThemeToggle labeled />
  </div>
  <div class="settings-row">
    <span class="settings-label" id="default-range-label">Default date range</span>
    <div class="segmented" role="group" aria-labelledby="default-range-label">
      {#each dashboardRanges as option (option.value)}<button
          class={range === option.value ? 'active' : ''}
          aria-pressed={range === option.value}
          onclick={() => chooseRange(option.value)}>{option.label}</button
        >{/each}
    </div>
  </div>
  {#if hidden.length}<div class="settings-row">
      <span class="settings-label">Hidden projects · {hidden.length}</span>
      <button
        class="button"
        onclick={() => {
          saveHiddenProjects([]);
          hidden = [];
        }}>Unhide all</button
      >
    </div>{/if}
  {#if page.data.passcodeEnabled}<div class="settings-row">
      <span class="settings-label">Dashboard session</span>
      <form method="POST" action="/logout"><button class="button" type="submit">Sign out</button></form>
    </div>{/if}
</div>
