<script lang="ts">
  import { onMount } from 'svelte';
  import type { DashboardResponse, UsageQuery } from '../../shared/domain';
  import { groupNames, groups, type Group } from '../../client/usage-workbench';
  import Icon from '../Icon.svelte';
  let {
    data,
    query,
    initialGroup,
    label,
    apply,
    close,
  }: {
    data: DashboardResponse;
    query: UsageQuery;
    initialGroup?: Group;
    label: (g: Group, id: string) => string;
    apply: (updates: Pick<UsageQuery, Group>) => void;
    close: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let search = $state<HTMLInputElement>();
  let tab = $state<Group | 'all'>('all'),
    q = $state(''),
    draft = $state<Pick<UsageQuery, Group>>({});
  // Search every option, but mount a bounded number of native checkboxes per
  // group. A large project history should not stall the palette or its search.
  const batchSize = 40;
  let expanded = $state<Partial<Record<Group, number>>>({});
  const needle = $derived(q.trim().toLowerCase());
  const options = $derived.by(() =>
    groups.map((group) => {
      const names = new Set(data.filters[group]);
      const option = (value: string) => {
        const text = label(group, value);
        return { value, text, search: `${value} ${text}`.toLowerCase() };
      };
      return { group, names, rows: [...names].map(option), option };
    }),
  );
  const matches = $derived.by(() =>
    options
      .filter(({ group }) => tab === 'all' || tab === group)
      .map(({ group, names, rows, option }) => {
        const extras = (draft[group] ?? []).filter((value) => !names.has(value)).map(option);
        const all = extras.length ? [...rows, ...extras] : rows;
        return { group, rows: needle ? all.filter((row) => row.search.includes(needle)) : all };
      }),
  );
  const count = $derived(groups.reduce((n, g) => n + (draft[g]?.length ?? 0), 0));
  function toggle(g: Group, v: string) {
    const old = draft[g] ?? [];
    const next = old.includes(v) ? old.filter((x) => x !== v) : [...old, v];
    draft = { ...draft, [g]: next.length ? next : undefined };
  }
  onMount(() => {
    tab = initialGroup ?? 'all';
    draft = Object.fromEntries(groups.flatMap((g) => (query[g] !== undefined ? [[g, [...query[g]]]] : [])));
    dialog.showModal();
    search?.focus();
  });
</script>

<dialog
  class="wb-dialog"
  bind:this={dialog}
  aria-labelledby="scope-title"
  oncancel={(e) => {
    e.preventDefault();
    close();
  }}
  onclick={(e) => {
    if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
    }
  }}
>
  <div class="wb-section-head">
    <h2 id="scope-title">Filter usage</h2>
    <button class="wb-icon" aria-label="Close" onclick={close}><Icon name="close" size={16} /></button>
  </div>
  <input
    class="wb-search"
    placeholder="Search models, projects, devices…"
    aria-label="Search filters"
    bind:this={search}
    bind:value={q}
    oninput={() => (expanded = {})}
  />
  <div class="wb-tabs filter-tabs">
    {#each ['all', ...groups] as g (g)}<button
        aria-pressed={tab === g}
        onclick={() => {
          tab = groups.find((k) => k === g) ?? 'all';
          expanded = {};
        }}>{groups.find((k) => k === g) ? groupNames[g as Group] : 'All'}</button
      >{/each}
  </div>
  {#if count}<div class="draft-chips">
      {#each groups as g (g)}{#each draft[g] ?? [] as v (v)}<button
            title={`Remove ${label(g, v)}`}
            onclick={() => toggle(g, v)}>{label(g, v)} ×</button
          >{/each}{/each}
    </div>{/if}
  <div class="wb-results">
    {#each matches as { group: g, rows } (g)}
      {@const limit = expanded[g] ?? batchSize}
      {#if rows.length}<div class="group-label">{groupNames[g]}</div>
        {#each rows.slice(0, limit) as { value, text } (value)}<label class="wb-facet-row"
            ><input
              type="checkbox"
              checked={draft[g]?.includes(value) ?? false}
              onchange={() => toggle(g, value)}
            /><span>{text}</span></label
          >{/each}
        {#if rows.length > limit}<button
            class="wb-link more-options"
            aria-label={`Show more ${g}`}
            onclick={() => (expanded[g] = limit + batchSize)}
            >Show {Math.min(batchSize, rows.length - limit)} more · {rows.length - limit} left</button
          >{/if}
      {/if}
    {/each}<span class="no-results">No matching values.</span>
  </div>
  <div class="wb-dialog-foot">
    <button class="wb-link" onclick={() => (draft = {})}>Clear all</button><span>{count} selected</span><button
      class="wb-primary"
      onclick={() => apply(draft)}>Apply filters</button
    >
  </div>
</dialog>
