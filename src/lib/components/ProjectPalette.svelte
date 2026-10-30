<script lang="ts">
  import { tick } from 'svelte';
  import { buildProjectIndex, searchProjects, type ProjectEntry } from '#lib/client/project-search.ts';
  import { projectLabel } from '#lib/client/session-links.ts';
  import { relativeTime } from '#lib/client/format.ts';
  import Icon from './Icon.svelte';
  import type { DashboardResponse } from '#lib/shared/domain.ts';

  let {
    data,
    value,
    hidden,
    colors,
    loading = false,
    error = '',
    context,
    onopen,
    onapply,
  }: {
    data: DashboardResponse | undefined;
    value: readonly string[] | undefined;
    hidden: readonly string[];
    colors: ReadonlyMap<string, string>;
    loading?: boolean;
    error?: string;
    context: string;
    onopen: () => void;
    onapply: (projects: readonly string[] | undefined, excluded: readonly string[]) => void;
  } = $props();

  const id = $props.id();
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  let dialog: HTMLDialogElement;
  let input = $state<HTMLInputElement>();
  let trigger: HTMLButtonElement;
  let returnFocus: HTMLElement | undefined;
  let open = $state(false);
  let search = $state('');
  let sort = $state<'tokens' | 'cost' | 'recent' | 'name'>('tokens');
  let scope = $state<'all' | 'selected' | 'hidden'>('all');
  let draft = $state<readonly string[] | undefined>();
  let draftHidden = $state<readonly string[]>([]);
  let activeKey = $state<string>();
  let limit = $state(60);
  let shortcut = $state('Ctrl K');
  const selected = $derived(new Set(draft ?? []));
  const hiddenSet = $derived(new Set(draftHidden));
  const entries = $derived(open ? buildProjectIndex(data, [...(value ?? []), ...hidden]) : []);
  const labels = $derived(new Map(entries.map((entry) => [entry.key, entry.label])));
  const scoped = $derived(
    entries.filter(
      (entry) => scope === 'all' || (scope === 'selected' ? selected.has(entry.key) : hiddenSet.has(entry.key)),
    ),
  );
  const matches = $derived(searchProjects(scoped, search, sort));
  const visible = $derived(matches.slice(0, limit));
  const activeIndex = $derived(
    Math.max(
      0,
      visible.findIndex((entry) => entry.key === activeKey),
    ),
  );
  const total = $derived(entries.reduce((sum, entry) => sum + (entry.metrics?.tokens ?? 0), 0));
  const chosen = $derived(entries.filter((entry) => selected.has(entry.key)));
  const selectionTokens = $derived(chosen.reduce((sum, entry) => sum + (entry.metrics?.tokens ?? 0), 0));

  $effect(() => {
    if (!open) return;
    const previous = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = previous;
    };
  });

  function mount() {
    shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
  }
  async function show() {
    if (open) return;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    draft = value === undefined ? undefined : [...value];
    draftHidden = [...hidden];
    search = '';
    scope = 'all';
    activeKey = undefined;
    limit = 60;
    open = true;
    dialog.showModal();
    onopen();
    await tick();
    input?.focus();
  }
  function close() {
    dialog.close();
    open = false;
    (returnFocus?.isConnected ? returnFocus : trigger).focus({ preventScroll: true });
  }
  function apply() {
    onapply(draft, draftHidden);
    close();
  }
  function toggle(entry: ProjectEntry) {
    const next = selected.has(entry.key)
      ? (draft ?? []).filter((key) => key !== entry.key)
      : [...(draft ?? []), entry.key];
    draft = next.length ? next : undefined;
    if (next.includes(entry.key)) draftHidden = draftHidden.filter((key) => key !== entry.key);
  }
  async function toggleHidden(key: string) {
    if (hiddenSet.has(key)) draftHidden = draftHidden.filter((entry) => entry !== key);
    else {
      draftHidden = [...draftHidden, key];
      const next = draft?.filter((entry) => entry !== key);
      draft = next?.length ? next : undefined;
    }
    await tick();
    input?.focus();
  }
  function only(key: string) {
    onapply(
      [key],
      hidden.filter((entry) => entry !== key),
    );
    close();
  }
  async function removeSelection(key?: string) {
    const next = key === undefined ? undefined : draft?.filter((entry) => entry !== key);
    draft = next?.length ? next : undefined;
    await tick();
    input?.focus();
  }
  function resetSearch() {
    activeKey = undefined;
    limit = 60;
    document.getElementById(`${id}-list`)?.parentElement?.scrollTo({ top: 0 });
  }
  function globalKeyboard(event: KeyboardEvent) {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === 'k' &&
      !event.altKey &&
      !event.shiftKey &&
      !event.isComposing
    ) {
      event.preventDefault();
      if (open) close();
      else void show();
    }
  }
  async function searchKeyboard(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) apply();
      else if (visible[activeIndex]) toggle(visible[activeIndex]);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (event.key === 'ArrowDown') {
        const next = Math.min(activeIndex + 1, matches.length - 1);
        if (next >= limit) limit += 60;
        activeKey = matches[next]?.key;
      } else activeKey = visible[Math.max(0, activeIndex - 1)]?.key;
      await tick();
      document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
    }
  }
  function modalKeyboard(event: KeyboardEvent) {
    if (!event.defaultPrevented && (event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      apply();
    }
  }
</script>

<svelte:window onkeydown={globalKeyboard} />

<button
  class={['project-trigger', value !== undefined && 'filtered']}
  bind:this={trigger}
  onclick={() => void show()}
  aria-label="Find and filter projects"
  aria-haspopup="dialog"
  aria-expanded={open}
  {@attach mount}
>
  <Icon name="search" size={16} /><span>Projects</span><span class="filter-count"
    >{value === undefined ? 'All' : value.length}</span
  ><kbd>{shortcut}</kbd>
</button>

<dialog
  bind:this={dialog}
  class="project-palette"
  aria-labelledby={`${id}-title`}
  oncancel={(event) => {
    event.preventDefault();
    close();
  }}
  onkeydown={modalKeyboard}
  onclose={() => {
    if (!dialog.open) open = false;
  }}
>
  {#if open}
    <div class="palette-heading">
      <h2 id={`${id}-title`}>Find projects</h2>
      <button class="dismiss" onclick={close} aria-label="Close project search"><Icon name="close" size={18} /></button>
    </div>
    <div class="palette-search">
      <Icon name="search" size={21} />
      <input
        bind:this={input}
        bind:value={search}
        oninput={resetSearch}
        onkeydown={searchKeyboard}
        type="text"
        role="combobox"
        aria-haspopup="grid"
        aria-label="Search projects"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls={`${id}-list`}
        aria-activedescendant={visible.length ? `${id}-option-${activeIndex}` : undefined}
        placeholder="Search projects, repositories or paths…"
        autocomplete="off"
        spellcheck="false"
      />
      {#if search}<button
          onclick={() => {
            search = '';
            resetSearch();
            input?.focus();
          }}
          aria-label="Clear project search"><Icon name="close" size={16} /></button
        >{/if}
    </div>
    <div class="palette-toolbar">
      <div class="palette-tabs" role="group" aria-label="Project list">
        <button
          class:current={scope === 'all'}
          aria-pressed={scope === 'all'}
          onclick={() => {
            scope = 'all';
            resetSearch();
          }}>All <span>{entries.length}</span></button
        >
        <button
          class:current={scope === 'selected'}
          aria-pressed={scope === 'selected'}
          onclick={() => {
            scope = 'selected';
            resetSearch();
          }}>Selected <span>{draft?.length ?? 0}</span></button
        >
        <button
          class:current={scope === 'hidden'}
          aria-pressed={scope === 'hidden'}
          onclick={() => {
            scope = 'hidden';
            resetSearch();
          }}>Hidden <span>{draftHidden.length}</span></button
        >
      </div>
      <select aria-label="Sort projects" bind:value={sort} onchange={resetSearch}>
        <option value="tokens">Most tokens</option><option value="cost">Highest cost</option><option value="recent"
          >Recently active</option
        ><option value="name">Name A–Z</option>
      </select>
    </div>
    <div class="palette-context">
      <span title={`${context} · Shares include all projects, including hidden projects`}
        >{context}{hidden.length || draftHidden.length ? ' · Includes hidden projects' : ''}</span
      ><span role="status"
        >{loading
          ? 'Updating insights…'
          : error
            ? 'Insights unavailable'
            : `${matches.length} ${matches.length === 1 ? 'project' : 'projects'}`}</span
      >
    </div>
    {#if error}<p class="palette-error" role="alert">{error} <button onclick={onopen}>Retry</button></p>{/if}
    <div class="palette-results" aria-busy={loading}>
      <div
        id={`${id}-list`}
        role="grid"
        aria-label="Projects"
        aria-multiselectable="true"
        aria-colcount="2"
        aria-rowcount={matches.length}
      >
        {#each visible as entry, index (entry.key)}
          {@const isSelected = selected.has(entry.key)}
          {@const isHidden = hiddenSet.has(entry.key)}
          <div
            id={`${id}-option-${index}`}
            role="row"
            aria-selected={isSelected}
            aria-rowindex={index + 1}
            aria-label={`${entry.label}, ${entry.key}${isHidden ? ', hidden' : ''}`}
            class={[
              'project-row',
              index === activeIndex && 'highlighted',
              isSelected && 'selected',
              isHidden && 'is-hidden',
            ]}
          >
            <div role="gridcell" class="project-cell">
              <button
                class="project-option"
                aria-pressed={isSelected}
                tabindex="-1"
                onclick={() => {
                  activeKey = entry.key;
                  toggle(entry);
                  input?.focus();
                }}
              >
                <span class="project-check" aria-hidden="true"
                  >{#if isSelected}<Icon name="check" size={13} />{/if}</span
                >
                <div class="project-info">
                  <span class="project-title"
                    ><i style:background={colors.get(entry.key) ?? 'var(--accent)'}></i><strong>{entry.label}</strong
                    >{#if isHidden}<span class="hidden-label">Hidden</span>{/if}</span
                  ><span class="project-path" title={[entry.key, ...entry.paths].join('\n')}>{entry.key}</span>
                  <span class="project-detail"
                    >{#if loading}Loading insights…{:else if error}Insights unavailable{:else if entry.metrics}{entry
                        .metrics.sessions}
                      {entry.metrics.sessions === 1 ? 'session' : 'sessions'}<span>·</span>{total
                        ? ((entry.metrics.tokens / total) * 100).toFixed(1)
                        : '0'}% of all tokens{#if entry.lastActiveAt}<span>·</span><time
                          datetime={entry.lastActiveAt}
                          title={new Date(entry.lastActiveAt).toLocaleString()}>{relativeTime(entry.lastActiveAt)}</time
                        >{/if}{:else}No usage in this view{/if}</span
                  >
                </div>
                <div
                  class="project-numbers"
                  title={entry.metrics?.unpricedTokens
                    ? `${compact.format(entry.metrics.unpricedTokens)} unpriced tokens excluded from estimated cost`
                    : 'Estimated API cost'}
                >
                  {#if entry.metrics && !loading && !error}<strong
                      >{compact.format(entry.metrics.tokens)}<small> tokens</small></strong
                    ><span
                      >{entry.metrics.tokens > 0 && entry.metrics.unpricedTokens >= entry.metrics.tokens
                        ? 'Unpriced'
                        : `${money.format(entry.metrics.costUSD)}${entry.metrics.unpricedTokens ? '*' : ''}`}</span
                    >{:else}<span>—</span>{/if}
                </div>
              </button>
            </div>
            <div class="project-row-actions" role="gridcell">
              <button
                class="only-project"
                tabindex={index === activeIndex ? 0 : -1}
                aria-label={`Focus only ${entry.label}`}
                title="Apply this project immediately"
                onclick={() => only(entry.key)}>Only</button
              ><button
                class="hide-project"
                tabindex={index === activeIndex ? 0 : -1}
                aria-label={`${isHidden ? 'Unhide' : 'Hide'} ${entry.label}`}
                title={isHidden ? 'Unhide project' : 'Hide project'}
                onclick={() => toggleHidden(entry.key)}><Icon name={isHidden ? 'eye' : 'eye-off'} size={15} /></button
              >
            </div>
          </div>
        {/each}
      </div>
      {#if visible.length === 0}
        <div class="palette-empty">
          <Icon name="search" size={27} /><strong
            >{search
              ? 'No matching projects'
              : scope === 'selected'
                ? 'No projects selected'
                : scope === 'hidden'
                  ? 'No hidden projects'
                  : loading
                    ? 'Loading projects…'
                    : 'No projects yet'}</strong
          ><span
            >{search
              ? 'Try a project name or part of its full path.'
              : scope === 'selected'
                ? 'Select projects from All to compare their usage.'
                : scope === 'hidden'
                  ? 'Hidden projects can be restored here.'
                  : 'Projects appear when usage is collected.'}</span
          >{#if search}<button
              onclick={() => {
                search = '';
                resetSearch();
                input?.focus();
              }}>Clear search</button
            >{/if}
        </div>
      {/if}
      {#if matches.length > visible.length}<button class="load-more" onclick={() => (limit += 60)}
          >Show more · {visible.length} of {matches.length}</button
        >{/if}
    </div>
    <div class="palette-selection">
      <div class="selection-chips">
        {#if draft === undefined}<span class="all-projects">All visible projects</span>{:else if !draft.length}<span
            class="all-projects">No projects selected</span
          >{:else}{#each draft as key (key)}<button
              class="selection-chip"
              onclick={() => void removeSelection(key)}
              aria-label={`Deselect ${labels.get(key) ?? projectLabel(key)}`}
              ><span>{labels.get(key) ?? projectLabel(key)}</span><Icon name="close" size={11} /></button
            >{/each}{/if}
      </div>
      {#if draft !== undefined}<button class="reset-projects" onclick={() => void removeSelection()}>Reset</button>{/if}
    </div>
    <footer class="palette-footer">
      <div class="keyboard-hints">
        <span><kbd>↑↓</kbd> navigate</span><span><kbd>Enter</kbd> select</span><span><kbd>Esc</kbd> cancel</span>
      </div>
      <div class="apply-area">
        <button class="cancel-projects" onclick={close}>Cancel</button>
        <span
          >{draft?.length
            ? `${draft.length} selected${loading || error ? '' : ` · ${compact.format(selectionTokens)} tokens`}`
            : ''}</span
        ><button class="apply-projects" onclick={apply}
          >{draft && draft.length > 1 ? 'Compare projects' : 'Apply filters'}
          <kbd>{shortcut.startsWith('⌘') ? '⌘' : 'Ctrl'} Enter</kbd></button
        >
      </div>
    </footer>
  {/if}
</dialog>

<style>
  .project-trigger {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 34px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    font-size: 12px;
    white-space: nowrap;
  }
  .project-trigger > :global(svg) {
    color: var(--accent);
  }
  .project-trigger:hover,
  .project-trigger.filtered {
    border-color: var(--accent);
  }
  kbd {
    font-size: 10px;
    color: var(--muted);
    white-space: nowrap;
  }
  .project-trigger kbd {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 4px;
    margin-left: 10px;
  }
  .project-palette {
    width: min(800px, calc(100vw - 32px));
    max-width: none;
    max-height: calc(100dvh - 40px);
    margin: max(20px, calc((100dvh - 720px) / 3)) auto auto;
    padding: 0;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 15px;
    box-shadow: 0 24px 100px #0006;
    overflow: hidden;
  }
  .project-palette[open] {
    display: flex;
    flex-direction: column;
  }
  .project-palette::backdrop {
    background: #0008;
    backdrop-filter: blur(5px);
  }
  .palette-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 17px 20px 0;
  }
  .palette-heading h2 {
    margin: 0;
    font-size: 16px;
    letter-spacing: -0.3px;
  }
  .dismiss {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 5px;
    color: var(--muted);
  }
  .dismiss:hover {
    background: var(--soft);
    color: var(--ink);
  }
  .palette-search {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 10px 20px 14px;
  }
  .palette-search > :global(svg) {
    color: var(--accent);
  }
  .palette-search input {
    min-width: 0;
    width: 100%;
    height: 37px;
    padding: 0;
    border: 0;
    outline: none;
    background: transparent;
    color: var(--ink);
    font-size: 17px;
  }
  .palette-search input::placeholder {
    color: var(--muted);
  }
  .palette-search input:focus-visible {
    outline: none;
  }
  .palette-search:focus-within {
    box-shadow: 0 2px 0 var(--accent);
  }
  .palette-search > button {
    color: var(--muted);
    padding: 5px;
  }
  .palette-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 0 20px 12px;
    border-bottom: 1px solid var(--border);
  }
  .palette-tabs {
    display: flex;
    gap: 4px;
  }
  .palette-tabs button {
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 6px 9px;
    border-radius: 5px;
    color: var(--muted);
    font-size: 12px;
  }
  .palette-tabs button.current {
    color: var(--ink);
    background: var(--soft);
  }
  .palette-tabs span {
    font-size: 10px;
    opacity: 0.8;
    font-variant-numeric: tabular-nums;
  }
  select {
    max-width: 150px;
    padding: 5px 6px;
    color: var(--muted);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 5px;
    font: inherit;
    font-size: 11px;
  }
  select:focus-visible {
    outline: 2px solid var(--accent);
  }
  .palette-context {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: center;
    min-height: 34px;
    padding: 5px 22px;
    color: var(--muted);
    background: var(--soft);
    font-size: 10px;
  }
  .palette-context > span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .palette-context > span:last-child {
    flex-shrink: 0;
  }
  .palette-error {
    margin: 0;
    padding: 7px 20px;
    font-size: 11px;
    color: var(--series-claude);
  }
  .palette-error button {
    text-decoration: underline;
  }
  .palette-results {
    height: 350px;
    min-height: 120px;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
    padding: 5px 8px;
  }
  .project-row {
    display: flex;
    align-items: center;
    gap: 5px;
    border: 1px solid transparent;
    border-radius: 7px;
  }
  .project-row.highlighted {
    background: var(--soft);
  }
  .project-row.selected {
    background: color-mix(in srgb, var(--accent) 7%, var(--surface));
  }
  .project-row.highlighted.selected {
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  }
  .project-row:hover {
    background: var(--soft);
  }
  .project-option {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    min-width: 0;
    text-align: left;
    padding: 11px 6px 11px 12px;
    width: 100%;
  }
  .project-cell {
    flex: 1;
    min-width: 0;
  }
  .project-check {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 17px;
    height: 17px;
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .selected .project-check {
    background: var(--accent);
    color: #09131c;
    border-color: var(--accent);
  }
  .project-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    flex: 1;
  }
  .project-title {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }
  .project-title i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .project-title strong {
    font-size: 12px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hidden-label {
    color: var(--muted);
    font-size: 9px;
    border: 1px solid var(--border);
    padding: 1px 4px;
    border-radius: 3px;
  }
  .project-path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10px;
    color: var(--table-secondary);
  }
  .project-detail {
    display: flex;
    gap: 6px;
    font-size: 10px;
    color: var(--muted);
  }
  .project-numbers {
    min-width: 88px;
    display: flex;
    align-items: flex-end;
    flex-direction: column;
    gap: 6px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .project-numbers strong {
    font-weight: 600;
  }
  .project-numbers small {
    color: var(--muted);
    font-size: 9px;
    font-weight: 400;
    margin-left: 3px;
  }
  .project-numbers > span {
    color: var(--muted);
    font-size: 10px;
  }
  .project-row-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    padding-right: 7px;
  }
  .only-project {
    padding: 5px 7px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 10px;
    color: var(--muted);
  }
  .only-project:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
  .hide-project {
    display: grid;
    place-items: center;
    width: 27px;
    height: 27px;
    color: var(--muted);
  }
  .hide-project:hover {
    color: var(--ink);
  }
  .is-hidden .project-title strong {
    color: var(--muted);
  }
  .palette-empty {
    height: 320px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--muted);
    text-align: center;
    padding: 20px;
  }
  .palette-empty strong {
    font-size: 14px;
    color: var(--ink);
  }
  .palette-empty span {
    font-size: 12px;
  }
  .palette-empty button {
    color: var(--accent);
    font-size: 12px;
  }
  .load-more {
    width: 100%;
    padding: 12px;
    color: var(--accent);
    font-size: 11px;
  }
  .palette-selection {
    height: 46px;
    min-height: 46px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 20px;
    border-top: 1px solid var(--border);
  }
  .selection-chips {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    overflow-x: auto;
    flex: 1;
    scrollbar-width: thin;
  }
  .all-projects {
    color: var(--muted);
    font-size: 11px;
  }
  .selection-chip {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 4px 6px;
    border: 1px solid var(--border);
    background: var(--soft);
    border-radius: 5px;
    white-space: nowrap;
    font-size: 10px;
  }
  .selection-chip span {
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .selection-chip :global(svg) {
    color: var(--muted);
  }
  .reset-projects {
    font-size: 11px;
    color: var(--muted);
  }
  .palette-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 13px 20px;
    border-top: 1px solid var(--border);
  }
  .keyboard-hints {
    display: flex;
    gap: 10px;
    color: var(--muted);
    font-size: 10px;
  }
  .keyboard-hints kbd {
    margin-right: 3px;
  }
  .apply-area {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .cancel-projects {
    color: var(--muted);
    font-size: 11px;
    padding: 8px 0;
  }
  .apply-area > span {
    color: var(--muted);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }
  .apply-projects {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 9px 12px;
    background: var(--accent);
    color: #081520;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
  }
  .apply-projects kbd {
    color: #173850;
  }
  @media (max-width: 600px) {
    .project-trigger kbd,
    .apply-projects kbd {
      display: none;
    }
    .project-palette {
      width: calc(100vw - 16px);
      max-height: calc(100dvh - 24px);
      margin: 12px auto auto;
      border-radius: 11px;
    }
    .palette-heading {
      padding: 13px 14px 0;
    }
    .palette-search {
      margin: 10px 14px 14px;
    }
    .palette-search input {
      font-size: 16px;
    }
    .palette-toolbar {
      padding: 0 10px 10px;
      gap: 4px;
    }
    .palette-tabs {
      gap: 0;
    }
    .palette-tabs button {
      padding: 6px;
      font-size: 11px;
      gap: 4px;
    }
    select {
      max-width: 115px;
      font-size: 10px;
      padding: 5px 2px;
    }
    .palette-context {
      padding: 7px 14px;
    }
    .palette-results {
      height: min(350px, calc(100dvh - 300px));
      padding: 4px;
    }
    .project-option {
      gap: 8px;
      padding: 10px 4px 10px 7px;
    }
    .project-numbers {
      min-width: 60px;
    }
    .project-numbers small {
      display: none;
    }
    .project-row-actions {
      flex-direction: column;
      gap: 1px;
      padding-right: 3px;
    }
    .project-row-actions button {
      min-height: 36px;
      min-width: 36px;
    }
    .project-detail {
      font-size: 9px;
    }
    .palette-selection {
      padding: 6px 12px;
    }
    .palette-footer {
      padding: 11px 12px;
    }
    .keyboard-hints {
      display: none;
    }
    .apply-area {
      width: 100%;
      justify-content: space-between;
    }
    .apply-projects {
      min-height: 38px;
    }
  }
</style>
