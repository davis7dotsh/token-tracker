<script lang="ts">
  import Icon from './Icon.svelte';
  let {
    label,
    options,
    value,
    onchange,
    names = {},
  }: {
    label: string;
    options: readonly string[];
    value: readonly string[] | undefined;
    onchange: (next: readonly string[] | undefined) => void;
    names?: Record<string, string>;
  } = $props();
  let open = $state(false);
  let search = $state('');
  let wrapper: HTMLDivElement;
  let trigger: HTMLButtonElement;
  const selected = $derived(value ?? options);
  const visible = $derived(
    options.filter((item) => (names[item] ?? item).toLowerCase().includes(search.toLowerCase())),
  );
  function toggle(item: string) {
    const next = selected.includes(item) ? selected.filter((entry) => entry !== item) : [...selected, item];
    onchange(next.length === options.length ? undefined : next);
  }
  function outside(event: PointerEvent) {
    if (open && !event.composedPath().includes(wrapper)) open = false;
  }
  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape' && open) {
      open = false;
      trigger.focus();
    }
  }
</script>

<svelte:window onpointerdown={outside} onkeydown={keyboard} />
<div class="filter-control" bind:this={wrapper}>
  <button
    class={['filter-trigger', value !== undefined && 'filtered']}
    bind:this={trigger}
    aria-label={`Filter by ${label.toLowerCase()}`}
    aria-haspopup="dialog"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    {label}<span class="filter-count">{value === undefined ? 'All' : value.length}</span><Icon
      name="chevron"
      size={14}
    />
  </button>
  {#if open}
    <div class="filter-popover" role="dialog" aria-label={`Choose ${label.toLowerCase()}`}>
      <div class="popover-actions">
        <button onclick={() => onchange(undefined)}>Select all</button><span>{selected.length} selected</span><button
          onclick={() => onchange([])}>Clear</button
        >
      </div>
      {#if options.length > 6}<label class="popover-search"
          ><Icon name="search" size={15} /><input
            type="search"
            bind:value={search}
            placeholder={`Search ${label.toLowerCase()}`}
            aria-label={`Search ${label.toLowerCase()}`}
          /></label
        >{/if}
      <div class="filter-options">
        {#each visible as item (item)}
          <label class="filter-option"
            ><input type="checkbox" checked={selected.includes(item)} onchange={() => toggle(item)} /><span
              >{names[item] ?? item}</span
            ></label
          >
        {:else}<p class="popover-empty">No matches</p>{/each}
      </div>
    </div>
  {/if}
</div>
