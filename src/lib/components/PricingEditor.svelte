<script lang="ts">
  import { tick, untrack } from 'svelte';
  import {
    createAliasValidation,
    draftFromRule,
    draftIssue,
    rankCatalogMatches,
    ruleFromDraft,
  } from '#lib/client/pricing-editor.ts';
  import {
    catalogKey,
    intendedRule,
    isIdle,
    pendingWrite,
    type PricingSaves,
    type PricingWrite,
    type PricingWriteResult,
  } from '#lib/client/pricing-saves.ts';
  import type { makeDashboardClient } from '#lib/client/dashboard-rpc.ts';
  import type { UsageQuery } from '#lib/shared/domain.ts';
  import type { PricingInfo, PricingRule } from '#lib/shared/pricing.ts';
  import Icon from './Icon.svelte';

  let {
    client,
    saves,
    query,
    adminSecret = $bindable(''),
  }: {
    client: ReturnType<typeof makeDashboardClient> | undefined;
    saves: PricingSaves | undefined;
    query: UsageQuery;
    adminSecret?: string;
  } = $props();

  let settings = $state.raw<{
    info: PricingInfo;
    unresolved: readonly { model: string; tokens: number; reason: string }[];
    secretRequired: boolean;
  }>();
  let saveState = $state.raw(untrack(() => saves?.state()));
  let loading = $state(false);
  let error = $state('');
  let loadFailed = $state(false);
  let success = $state('');
  let editing = $state(false);
  let draft = $state(draftFromRule('', undefined));
  let targetOpen = $state(false);
  let targetHighlight = $state(0);
  let targetWrapper = $state.raw<HTMLElement>();
  let request: AbortController | undefined;
  let requestVersion = 0;
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  // Edited since it was last submitted or selected. Blur only saves real edits,
  // so focus leaving a control that a reset just disabled cannot undo the reset.
  let dirty = false;
  // The model this draft was opened for or last submitted under. Locking
  // follows it rather than the typed ID, so typing cannot lock the field.
  let identity = $state('');

  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
  const saved = $derived(settings?.info.rules ?? []);
  const unresolved = $derived(settings?.unresolved ?? []);
  const pending = $derived(saveState ? pendingWrite(saveState, draft.model) : undefined);
  const resetting = $derived(pending?.type === 'delete');
  const hasRule = $derived(resetting || pending?.type === 'set' || saved.some((rule) => rule.model === draft.model));
  const refreshing = $derived(
    Boolean(saveState && [saveState.inFlight, ...saveState.queued].some((write) => write?.type === 'refresh')),
  );
  const saving = $derived(Boolean(saveState && !isIdle(saveState)));
  const currentFailure = $derived(saveState?.failures.get(draft.model));
  const refreshFailure = $derived(saveState?.failures.get(catalogKey));
  // A failed save for a model that is not open stays visible until it is retried.
  const otherFailure = $derived(
    [...(saveState?.failures ?? [])].find(([key]) => key !== draft.model && key !== catalogKey),
  );
  // The failed save the feedback row is showing, if any.
  const shownFailure = $derived(
    editing && currentFailure ? currentFailure : !error && !refreshFailure ? otherFailure?.[1] : undefined,
  );
  const listed = $derived(new Set([...unresolved.map((entry) => entry.model), ...saved.map((rule) => rule.model)]));
  // A new model is in neither list until the hub stores its rule, so its
  // failed or pending save is listed here to be reopened, retried or discarded.
  const failedNew = $derived(
    [...(saveState?.failures.keys() ?? [])].filter((key): key is string => typeof key === 'string' && !listed.has(key)),
  );
  const savingNew = $derived([
    ...new Map(
      (saveState ? [saveState.inFlight, ...saveState.queued] : []).flatMap((write) =>
        write?.type === 'set' && !listed.has(write.rule.model) ? [[write.rule.model, write.rule] as const] : [],
      ),
    ).values(),
  ]);
  const currentUnknown = $derived(unresolved.find((entry) => entry.model === draft.model));
  // The model ID names an existing rule or usage, so an edit would save a
  // second rule rather than rename this one.
  const modelLocked = $derived(draft.model === identity && (hasRule || Boolean(currentUnknown)));
  const validateAlias = $derived(settings ? createAliasValidation(settings.info) : undefined);
  const issue = $derived(validateAlias ? draftIssue(draft, validateAlias) : undefined);
  const draftRule = $derived(validateAlias && !loadFailed ? ruleFromDraft(draft, validateAlias) : undefined);
  // Hint only once the user has entered something the rule needs.
  const touched = $derived(
    draft.kind === 'alias'
      ? Boolean(draft.target.trim())
      : draft.kind === 'rates' && (Object.values(draft.rates).some((rate) => rate != null) || Boolean(draft.nickname)),
  );
  const catalogMatches = $derived(
    rankCatalogMatches(
      settings?.info.models ?? [],
      draft.target,
      8,
      (name) => validateAlias?.(draft.model, name) === undefined,
    ),
  );
  const highlightedIndex = $derived(Math.min(targetHighlight, Math.max(catalogMatches.length - 1, 0)));

  const messageFor = (failure: unknown) =>
    failure instanceof Error ? failure.message : 'Could not update pricing. Try again.';

  function editDraft() {
    dirty = true;
    success = '';
  }

  const summary = (rule: PricingRule) =>
    rule.kind === 'alias' ? `→ ${rule.target}` : rule.kind === 'free' ? 'Free' : (rule.nickname ?? 'Custom rates');

  function cancelAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
  }

  // Typing in rates or the display name saves after a pause; blur, Enter,
  // picks, kind changes and switching models save immediately.
  function scheduleAutosave() {
    cancelAutosave();
    autosaveTimer = setTimeout(flushAutosave, 600);
  }

  function flushAutosave() {
    cancelAutosave();
    if (!dirty || !saves || !draftRule) return;
    dirty = false;
    const rule = draftRule;
    draft.model = identity = rule.model;
    if (saves.submit({ type: 'set', rule }, adminSecret)) success = '';
  }

  function editorFocusOut(event: FocusEvent) {
    // Discard must clear the draft before a blur can submit it.
    if (event.relatedTarget instanceof Element && event.relatedTarget.closest('[data-discard]')) return;
    flushAutosave();
  }

  function saveOnEnter(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.defaultPrevented) return;
    event.preventDefault();
    flushAutosave();
  }

  function openTarget() {
    targetOpen = true;
    targetHighlight = 0;
  }

  function pickTarget(name: string) {
    // mousedown and click both pick; the first pick closes the list, so the
    // repeat call lands here with it closed and must not save a second time.
    if (resetting || !targetOpen) return;
    draft.target = name;
    targetOpen = false;
    targetHighlight = 0;
    editDraft();
    flushAutosave();
  }

  function chooseKind(kind: PricingRule['kind']) {
    editDraft();
    draft.kind = kind;
    flushAutosave();
  }

  function targetOutside(event: PointerEvent) {
    if (targetOpen && targetWrapper && !event.composedPath().includes(targetWrapper)) targetOpen = false;
  }

  function targetFocusOut(event: FocusEvent) {
    if (targetWrapper && event.relatedTarget instanceof Node && targetWrapper.contains(event.relatedTarget)) return;
    targetOpen = false;
  }

  function scrollHighlightedTarget() {
    void tick().then(() => {
      targetWrapper
        ?.querySelector<HTMLElement>(`#pricing-catalog-option-${highlightedIndex}`)
        ?.scrollIntoView({ block: 'nearest' });
    });
  }

  function targetKeyboard(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!catalogMatches.length) return;
      event.preventDefault();
      if (!targetOpen) {
        targetOpen = true;
        targetHighlight = event.key === 'ArrowDown' ? 0 : catalogMatches.length - 1;
      } else {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        targetHighlight = (highlightedIndex + step + catalogMatches.length) % catalogMatches.length;
      }
      scrollHighlightedTarget();
    } else if (event.key === 'Enter' && targetOpen && catalogMatches[highlightedIndex]) {
      event.preventDefault();
      pickTarget(catalogMatches[highlightedIndex]);
    } else if (event.key === 'Escape' && targetOpen) {
      event.preventDefault();
      event.stopPropagation();
      targetOpen = false;
    } else saveOnEnter(event);
  }

  // Pending and failed edits are restored, so returning to a model shows what
  // will be saved rather than what the hub last acknowledged.
  function selectModel(value: string) {
    cancelAutosave();
    targetOpen = false;
    targetHighlight = 0;
    editing = true;
    success = '';
    loadFailed = false;
    identity = value;
    draft = draftFromRule(
      value,
      saveState ? intendedRule(saveState, value) : saved.find((entry) => entry.model === value),
    );
    // A failed edit is still unsaved, so leaving it again retries.
    dirty = Boolean(saveState?.failures.has(value));
  }

  // Entering the ID of a model with a saved, pending or failed rule into a
  // blank draft opens that rule rather than starting over. On change, not
  // input, so a shorter ID passed while typing cannot lend its rule.
  function typeModel(value: string) {
    if (draft.kind === 'alias' && !draft.target && saveState && intendedRule(saveState, value)) selectModel(value);
  }

  // Keep a pending edit for the previous model before replacing the draft.
  function switchModel(value: string) {
    flushAutosave();
    selectModel(value);
  }

  function cancelLoad() {
    request?.abort();
    request = undefined;
    requestVersion += 1;
    loading = false;
  }

  // A background load follows writes settling; `persisted` is whether the last one did.
  async function load(persisted?: boolean) {
    if (!client) return;
    cancelLoad();
    const controller = new AbortController();
    request = controller;
    const version = ++requestVersion;
    const since = saves?.state().generation ?? 0;
    loading = true;
    error = '';
    loadFailed = false;
    try {
      const next = await client.getPricing({ ...query }, controller.signal);
      if (controller.signal.aborted || version !== requestVersion) return;
      // A write that settled during this read reloads once the queue is idle.
      if (saves && !saves.acknowledge(next.info.rules, since)) return;
      settings = next;
      if (!editing) {
        const first = next.unresolved[0]?.model ?? next.info.rules[0]?.model;
        if (first) selectModel(first);
      }
    } catch (failure) {
      if (!controller.signal.aborted && version === requestVersion) {
        // The failed write's own message stays visible over a stale list.
        if (persisted === false && settings) return;
        error = persisted ? `Changes saved. ${messageFor(failure)}` : messageFor(failure);
        // Without settings there is nothing to edit, so any failed load offers Retry.
        loadFailed = persisted === undefined || !settings;
      }
    } finally {
      if (version === requestVersion) loading = false;
    }
  }

  function written(result: PricingWriteResult) {
    if (!result.ok) {
      // A kept failure of the open draft is unsaved again, so blur, Enter or
      // switching retries it. Discarded or superseded writes keep no failure.
      const write = result.write;
      if (editing && write.type === 'set' && saveState?.failures.get(draft.model)?.write === write) dirty = true;
      return;
    }
    if (settings) settings = { ...settings, info: result.info };
    const write = result.write;
    if (write.type === 'refresh') {
      if (!result.info.refreshError) success = 'Catalog updated';
    } else if ((write.type === 'set' ? write.rule.model : write.model) === draft.model && saveState) {
      if (write.type === 'delete' && !pendingWrite(saveState, draft.model)) selectModel(draft.model);
      success = write.type === 'set' ? 'Saved' : 'Reset to catalog pricing';
    }
  }

  function mountEditor() {
    const unsubscribe = saves?.subscribe((state, result) => {
      saveState = state;
      if (result) written(result);
      // The writes have settled. Keep editing responsive while the
      // unresolved-model list catches up; the dashboard rereads usage when opened.
      if (result && isIdle(state)) void load(result.ok);
    });
    untrack(() => void load());
    return () => {
      // Leaving settings still persists the last complete edit; the shared
      // queue keeps sending after this editor is gone.
      flushAutosave();
      unsubscribe?.();
      cancelLoad();
    };
  }

  // Reset and refresh queue behind any save started by the blur of their
  // click, so a reset always lands after (and supersedes) that edit.
  // A failed new model has nothing to reset, so its draft is discarded instead.
  function resetRule() {
    cancelAutosave();
    dirty = false;
    if (!hasRule) {
      saves?.discard(draft.model);
      selectModel(draft.model);
    } else if (saves && saves.submit({ type: 'delete', model: draft.model.trim() }, adminSecret)) success = '';
  }

  // Retry sends with the pairing secret as entered now. The open model's
  // draft goes when complete, since it may have been edited since it failed.
  function retry(write: PricingWrite) {
    if (write.type === 'set' && write.rule.model === draft.model && draftRule) {
      dirty = true;
      flushAutosave();
    } else if (saves && saves.submit(write, adminSecret)) success = '';
  }

  function refreshCatalog() {
    if (saves && saves.submit({ type: 'refresh' }, adminSecret)) success = '';
  }
</script>

<svelte:window onpointerdown={targetOutside} />
<div class="pricing-settings" {@attach mountEditor}>
  <div class="pricing-catalog-meta">
    <span>{settings ? `Catalog updated ${settings.info.updatedAt}` : 'Loading model prices…'}</span><button
      class="text-button"
      disabled={!saves || refreshing}
      onclick={refreshCatalog}>Refresh prices</button
    >
  </div>
  <div class="pricing-body" aria-busy={loading || resetting || refreshing}>
    <div class="pricing-rule-list">
      {#if failedNew.length}<div class="pricing-list-label">Not saved <span>{failedNew.length}</span></div>{/if}
      {#each failedNew as model (model)}<button
          class={['pricing-model-row', draft.model === model && 'selected']}
          onclick={() => switchModel(model)}><strong>{model}</strong><span>Save failed</span></button
        >{/each}
      {#if unresolved.length}<div class="pricing-list-label">Needs pricing <span>{unresolved.length}</span></div>{/if}
      {#each unresolved as entry (entry.model)}<button
          class={['pricing-model-row', draft.model === entry.model && 'selected']}
          onclick={() => switchModel(entry.model)}
          ><strong>{entry.model}</strong><span
            >{saveState?.failures.has(entry.model)
              ? 'Save failed'
              : `${compact.format(entry.tokens)} tokens · ${entry.reason}`}</span
          ></button
        >{/each}
      {#if saved.length || savingNew.length}<div class="pricing-list-label">
          Saved rules <span>{saved.length + savingNew.length}</span>
        </div>{/if}
      {#each saved as rule (rule.model)}<button
          class={['pricing-model-row', draft.model === rule.model && 'selected']}
          onclick={() => switchModel(rule.model)}
          ><strong>{rule.model}</strong><span
            >{saveState?.failures.has(rule.model) ? 'Save failed' : summary(rule)}</span
          ></button
        >{/each}
      {#each savingNew as rule (rule.model)}<button
          class={['pricing-model-row', draft.model === rule.model && 'selected']}
          onclick={() => switchModel(rule.model)}><strong>{rule.model}</strong><span>Saving…</span></button
        >{/each}
      {#if settings && !failedNew.length && !unresolved.length && !saved.length && !savingNew.length}<p
          class="pricing-list-empty"
        >
          All models have catalog prices.
        </p>{/if}
      {#if loading && !settings}<div class="pricing-list-loading">
          <span class="spinner"></span><span>Loading models</span>
        </div>{/if}
      <button class="text-button pricing-add" disabled={!settings} onclick={() => switchModel('')}>Add a rule</button>
    </div>
    <form
      class="pricing-editor"
      onsubmit={(event) => event.preventDefault()}
      oninput={editDraft}
      onfocusout={editorFocusOut}
    >
      {#if editing}
        <label class="pricing-field"
          >Model ID<input
            aria-label="Model ID"
            bind:value={draft.model}
            maxlength="200"
            required
            readonly={modelLocked}
            disabled={resetting}
            placeholder="ID from your usage logs"
            oninput={cancelAutosave}
            onchange={(event) => typeModel(event.currentTarget.value)}
            onkeydown={saveOnEnter}
            autocomplete="off"
          /></label
        >
        {#if currentUnknown}<p class="pricing-current-unknown">
            {compact.format(currentUnknown.tokens)} tokens are excluded from estimated cost.
          </p>{/if}
        <div class="pricing-kind segmented" aria-label="Pricing rule type">
          {#each [{ value: 'alias', label: 'Model alias' }, { value: 'rates', label: 'Custom rates' }, { value: 'free', label: 'Free' }] as option (option.value)}<button
              type="button"
              class={draft.kind === option.value ? 'active' : ''}
              disabled={resetting}
              aria-pressed={draft.kind === option.value}
              onclick={() => {
                if (option.value === 'alias' || option.value === 'rates' || option.value === 'free')
                  chooseKind(option.value);
              }}>{option.label}</button
            >{/each}
        </div>
        {#if draft.kind === 'alias'}
          <div class="pricing-field">
            <label for="pricing-target-model">Actual model</label>
            <span class="pricing-target" bind:this={targetWrapper} onfocusout={targetFocusOut}
              ><input
                id="pricing-target-model"
                role="combobox"
                aria-label="Actual model"
                aria-autocomplete="list"
                aria-expanded={targetOpen && !resetting && catalogMatches.length > 0}
                aria-controls={targetOpen && !resetting && catalogMatches.length ? 'pricing-catalog' : undefined}
                aria-activedescendant={targetOpen && !resetting && catalogMatches.length
                  ? `pricing-catalog-option-${highlightedIndex}`
                  : undefined}
                aria-invalid={Boolean(touched && issue)}
                aria-describedby="pricing-feedback"
                bind:value={draft.target}
                maxlength="200"
                required
                disabled={resetting}
                placeholder="Search catalog models"
                autocomplete="off"
                onfocus={openTarget}
                onclick={openTarget}
                oninput={() => {
                  cancelAutosave();
                  openTarget();
                }}
                onkeydown={targetKeyboard}
              />{#if targetOpen && !resetting && catalogMatches.length}<span
                  class="pricing-target-list"
                  id="pricing-catalog"
                  role="listbox"
                  aria-label="Catalog models"
                  >{#each catalogMatches as name, index (name)}<button
                      id={`pricing-catalog-option-${index}`}
                      type="button"
                      role="option"
                      tabindex="-1"
                      aria-selected={index === highlightedIndex}
                      class={['pricing-target-option', index === highlightedIndex && 'highlighted']}
                      onmouseenter={() => (targetHighlight = index)}
                      onmousedown={(event) => {
                        event.preventDefault();
                        pickTarget(name);
                      }}
                      onclick={() => pickTarget(name)}>{name}</button
                    >{/each}</span
                >{/if}</span
            >
          </div>
          <p class="pricing-field-help">Uses this model’s rates and combines its usage in the dashboard.</p>
        {:else if draft.kind === 'rates'}
          <label class="pricing-field"
            >Display name <span class="pricing-optional">optional</span><input
              aria-label="Display name"
              bind:value={draft.nickname}
              maxlength="200"
              disabled={resetting}
              oninput={scheduleAutosave}
              onkeydown={saveOnEnter}
              placeholder="Name shown in the dashboard"
              autocomplete="off"
            /></label
          >
          <div class="pricing-rates-grid">
            <label class="pricing-field"
              >Input<input
                type="number"
                aria-label="Input price per million tokens"
                bind:value={draft.rates.input}
                oninput={scheduleAutosave}
                onkeydown={saveOnEnter}
                min="0"
                step="any"
                required
                disabled={resetting}
                placeholder="$/1M"
              /></label
            >
            <label class="pricing-field"
              >Output<input
                type="number"
                aria-label="Output price per million tokens"
                bind:value={draft.rates.output}
                oninput={scheduleAutosave}
                onkeydown={saveOnEnter}
                min="0"
                step="any"
                required
                disabled={resetting}
                placeholder="$/1M"
              /></label
            >
            <label class="pricing-field"
              >Cache read<input
                type="number"
                aria-label="Cache read price per million tokens"
                bind:value={draft.rates.cacheRead}
                oninput={scheduleAutosave}
                onkeydown={saveOnEnter}
                min="0"
                step="any"
                disabled={resetting}
                placeholder="Unknown"
              /></label
            >
            <label class="pricing-field"
              >Cache write, 5 min<input
                type="number"
                aria-label="Cache write price per million tokens"
                bind:value={draft.rates.cacheWrite}
                oninput={scheduleAutosave}
                onkeydown={saveOnEnter}
                min="0"
                step="any"
                disabled={resetting}
                placeholder="Unknown"
              /></label
            >
            <label class="pricing-field"
              >Cache write, 1 hour<input
                type="number"
                aria-label="One hour cache write price per million tokens"
                bind:value={draft.rates.cacheWrite1h}
                oninput={scheduleAutosave}
                onkeydown={saveOnEnter}
                min="0"
                step="any"
                disabled={resetting}
                placeholder="Unknown"
              /></label
            >
          </div>
          <p class="pricing-field-help">
            USD per 1M tokens, applied to all service tiers. Blank cache rates remain unknown; 0 means free.
          </p>
        {:else}<p class="pricing-field-help">All token types for this model will count at $0.</p>{/if}
        <div class="pricing-editor-actions">
          {#if hasRule || currentFailure}<button
              class="text-button"
              type="button"
              data-discard={!hasRule ? '' : undefined}
              disabled={resetting}
              onclick={resetRule}>{hasRule ? 'Reset rule' : 'Discard'}</button
            >{/if}
        </div>
      {:else}<div class="pricing-editor-empty">
          <Icon name="check" size={25} /><span>{loading ? 'Reading model prices' : 'Choose a model or add a rule'}</span
          >
        </div>{/if}
    </form>
  </div>
  <div id="pricing-feedback" class="pricing-feedback" aria-live="polite">
    {#if editing && currentFailure}<span role="alert">{currentFailure.message}</span>{:else if error}<span role="alert"
        >{error}</span
      >{:else if refreshFailure}<span role="alert">{refreshFailure.message}</span>{:else if otherFailure}<span
        role="alert">Could not update {String(otherFailure[0])}. {otherFailure[1].message}</span
      >{:else if editing && touched && issue}<span>{issue}</span>{:else if success}<span class="pricing-success"
        ><Icon name="check" size={15} />{success}</span
      >{:else if settings?.info.refreshError}<span>{settings.info.refreshError}</span>{:else if loading || saving}<span
        >{resetting ? 'Resetting…' : refreshing ? 'Updating prices…' : saving ? 'Saving…' : 'Updating…'}</span
      >{/if}
    {#if loadFailed}<button class="text-button" onclick={() => void load()}>Retry</button>{:else if shownFailure}<button
        class="text-button"
        onclick={() => shownFailure && retry(shownFailure.write)}>Retry</button
      >{/if}
  </div>
  <div class="pricing-footer">
    {#if settings?.secretRequired}<input
        class="pricing-secret"
        type="password"
        aria-label="Pairing secret"
        bind:value={adminSecret}
        placeholder="Pairing secret"
        autocomplete="current-password"
      />{:else}<span>Changes apply across this dashboard.</span>{/if}
  </div>
</div>
