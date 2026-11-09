<script lang="ts">
  import { onMount } from 'svelte';
  import type { DashboardResponse, UsageQuery } from '../../shared/domain';
  import {
    groupNames,
    groups,
    periodOf,
    timeBuckets,
    valueOf,
    type Picked,
    type Group,
    type Metric,
  } from '../../client/usage-workbench';
  import Icon from '../Icon.svelte';
  let {
    data,
    query,
    picked,
    initialGroup,
    metric,
    readContext,
    label,
    apply,
    close,
  }: {
    data: DashboardResponse;
    query: UsageQuery;
    picked?: Picked;
    initialGroup?: Group;
    metric: Metric;
    readContext: (q: UsageQuery, signal: AbortSignal) => Promise<DashboardResponse>;
    label: (g: Group, id: string) => string;
    apply: (updates: Pick<UsageQuery, Group>, drill?: Group) => void;
    close: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let search = $state<HTMLInputElement>();
  let tab = $state<Group | 'all'>('all'),
    q = $state(''),
    draft = $state<Pick<UsageQuery, Group>>({});
  let context = $state.raw<DashboardResponse>(),
    failed = $state(false),
    target = $state.raw<Picked>();
  let targetOpen = $state(false),
    targetSearch = $state('');
  const pickedValue = $derived.by(() => {
    if (!picked) return;
    const row =
      picked.bucket === undefined
        ? data[picked.group].find((r) => r.name === picked.name)
        : timeBuckets(data, picked.group)[picked.bucket]?.rows.get(picked.name);
    return row ? valueOf(row, metric) : valueOf({ tokens: 0, costUSD: 0 }, metric);
  });
  const bucketText = $derived(
    picked?.bucket !== undefined ? timeBuckets(data, picked.group)[picked.bucket]?.label : periodOf(data),
  );
  const contributors = $derived.by(() => {
    const scoped = context;
    if (!scoped || !picked) return [];
    const at = picked.bucket;
    return groups
      .filter((g) => g !== picked.group)
      .flatMap((g) => {
        const rows =
          at === undefined
            ? scoped[g]
            : [...(timeBuckets(scoped, g).find((b) => b.label === bucketText)?.rows ?? [])].map(([name, row]) => ({
                name,
                ...row,
              }));
        return [...rows].sort((a, b) => b[metric] - a[metric]).map((r) => ({ group: g, name: r.name }));
      });
  });
  const selected = $derived(target ? (query[target.group] ?? []) : []);
  const count = $derived(groups.reduce((n, g) => n + (draft[g]?.length ?? 0), 0));
  function toggle(g: Group, v: string) {
    const old = draft[g] ?? [];
    const next = old.includes(v) ? old.filter((x) => x !== v) : [...old, v];
    draft = { ...draft, [g]: next.length ? next : undefined };
  }
  function act(only: boolean) {
    if (!target) return;
    const names = only
      ? [target.name]
      : selected.includes(target.name)
        ? selected.filter((v) => v !== target?.name)
        : [...selected, target.name];
    const next = only
      ? groups.find((g) => g !== target?.group && query[g]?.length !== 1 && (context?.[g].length ?? data[g].length) > 1)
      : undefined;
    apply({ ...query, [target.group]: names.length ? names : undefined }, only ? (next ?? target.group) : undefined);
  }
  onMount(() => {
    tab = initialGroup ?? 'all';
    draft = Object.fromEntries(groups.flatMap((g) => (query[g] !== undefined ? [[g, [...query[g]]]] : [])));
    target = picked;
    dialog.showModal();
    if (!picked) search?.focus();
    const c = new AbortController();
    if (picked) {
      if (query[picked.group]?.length === 1 && query[picked.group]?.[0] === picked.name) context = data;
      else
        void readContext({ ...query, [picked.group]: [picked.name] }, c.signal)
          .then((r) => {
            if (!c.signal.aborted) context = r;
          })
          .catch(() => {
            if (!c.signal.aborted) failed = true;
          });
    }
    return () => c.abort();
  });
</script>

<dialog
  class="wb-dialog"
  class:inspector={picked}
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
    <h2 id="scope-title">{picked ? label(picked.group, picked.name) : 'Filter usage'}</h2>
    <button class="wb-icon" aria-label="Close" onclick={close}><Icon name="close" size={16} /></button>
  </div>
  {#if picked}
    <div class="inspect-value">
      <strong>{pickedValue}{metric === 'tokens' ? ' tokens' : ''}</strong><span>{bucketText} · {data.timezone}</span>
    </div>
    <span class="field-label">Filter across {periodOf(data)}</span><button
      class="target-button"
      aria-expanded={targetOpen}
      onclick={() => {
        targetOpen = !targetOpen;
        targetSearch = '';
      }}
      >{target ? `${groupNames[target.group]}: ${label(target.group, target.name)}` : 'Choose'}
      <Icon name="chevron" size={14} /></button
    >
    {#if targetOpen}<input
        class="wb-search"
        aria-label="Search contributing values"
        placeholder="Find a model, project, device…"
        bind:value={targetSearch}
      />
      <div class="target-options">
        {#each [picked, ...contributors].filter((t) => `${groupNames[t.group]} ${label(t.group, t.name)}`
            .toLowerCase()
            .includes(targetSearch.toLowerCase())) as t (JSON.stringify([t.group, t.name]))}<button
            aria-pressed={target?.group === t.group && target?.name === t.name}
            onclick={() => {
              target = t;
              targetOpen = false;
            }}><span>{groupNames[t.group]}</span> {label(t.group, t.name)}</button
          >{/each}{#if !context}<small>{failed ? 'Related values unavailable.' : 'Loading related values…'}</small>{/if}
      </div>{/if}
    {#if selected.length > 1}<p class="wb-note">“Only” replaces {selected.length} selected {target?.group}.</p>{/if}
    <div class="wb-dialog-foot">
      <button class="wb-link" onclick={() => act(false)}
        >{selected.includes(target?.name ?? '') ? 'Remove from filter' : 'Include in filter'}</button
      ><button class="wb-primary" onclick={() => act(true)}
        >Only this {target ? groupNames[target.group].toLowerCase() : 'series'} →</button
      >
    </div>
  {:else}
    <input
      class="wb-search"
      placeholder="Search models, projects, devices…"
      aria-label="Search filters"
      bind:this={search}
      bind:value={q}
    />
    <div class="wb-tabs filter-tabs">
      {#each ['all', ...groups] as g (g)}<button
          aria-pressed={tab === g}
          onclick={() => {
            tab = groups.find((k) => k === g) ?? 'all';
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
      {#each groups.filter((g) => tab === 'all' || tab === g) as g (g)}
        {@const values = [...new Set([...data.filters[g], ...(draft[g] ?? [])])].filter((v) =>
          `${v} ${label(g, v)}`.toLowerCase().includes(q.trim().toLowerCase()),
        )}
        {#if values.length}<div class="group-label">{groupNames[g]}</div>
          {#each values as v (v)}<label class="wb-facet-row"
              ><input type="checkbox" checked={draft[g]?.includes(v) ?? false} onchange={() => toggle(g, v)} /><span
                >{label(g, v)}</span
              ></label
            >{/each}{/if}
      {/each}<span class="no-results">No matching values.</span>
    </div>
    <div class="wb-dialog-foot">
      <button class="wb-link" onclick={() => (draft = {})}>Clear all</button><span>{count} selected</span><button
        class="wb-primary"
        onclick={() => apply(draft)}>Apply filters</button
      >
    </div>
  {/if}
</dialog>
