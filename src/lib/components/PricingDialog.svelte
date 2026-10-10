<script lang="ts">
  import { untrack } from 'svelte';
  import { createAliasValidation } from '#lib/client/pricing-editor.ts';
  import type { makeDashboardClient } from '#lib/client/rpc.ts';
  import type { UsageQuery } from '#lib/shared/domain.ts';
  import type { PricingInfo, PricingRule } from '#lib/shared/pricing.ts';
  import Icon from './Icon.svelte';

  let {
    client,
    query,
    onchange,
  }: {
    client: ReturnType<typeof makeDashboardClient> | undefined;
    query: UsageQuery;
    onchange: () => Promise<void>;
  } = $props();

  let dialog: HTMLDialogElement;
  let settings = $state.raw<{
    info: PricingInfo;
    unresolved: readonly { model: string; tokens: number; reason: string }[];
    secretRequired: boolean;
  }>();
  let adminSecret = $state('');
  let loading = $state(false);
  let busy = $state('');
  let error = $state('');
  let loadFailed = $state(false);
  let success = $state('');
  let model = $state('');
  let editing = $state(false);
  let kind = $state<PricingRule['kind']>('alias');
  let target = $state('');
  let nickname = $state('');
  let inputRate = $state<number | null | undefined>();
  let outputRate = $state<number | null | undefined>();
  let cacheReadRate = $state<number | null | undefined>();
  let cacheWriteRate = $state<number | null | undefined>();
  let cacheWrite1hRate = $state<number | null | undefined>();
  let request: AbortController | undefined;
  let requestVersion = 0;
  let mutationVersion = 0;
  let editorVersion = 0;

  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
  const validRate = (value: number | null | undefined) => value == null || (Number.isFinite(value) && value >= 0);
  const saved = $derived(settings?.info.rules ?? []);
  const unresolved = $derived(settings?.unresolved ?? []);
  const currentRule = $derived(saved.find((rule) => rule.model === model));
  const currentUnknown = $derived(unresolved.find((entry) => entry.model === model));
  const validateAlias = $derived(settings ? createAliasValidation(settings.info) : undefined);
  const aliasIssue = $derived(validateAlias?.(model, target));
  const catalogEntries = $derived((settings?.info.models ?? []).map((name) => ({ name, search: name.toLowerCase() })));
  const catalogMatches = $derived.by(() => {
    const search = target.trim().toLowerCase();
    const matches: string[] = [];
    for (const entry of catalogEntries) {
      if (entry.search.includes(search) && validateAlias?.(model, entry.name) === undefined) matches.push(entry.name);
      if (matches.length === 60) break;
    }
    return matches;
  });
  const validRates = $derived(
    inputRate != null &&
      outputRate != null &&
      [inputRate, outputRate, cacheReadRate, cacheWriteRate, cacheWrite1hRate].every(validRate),
  );
  const canSave = $derived(
    Boolean(
      model.trim() &&
      model.trim().length <= 200 &&
      settings &&
      !busy &&
      !loadFailed &&
      (kind === 'alias' ? !aliasIssue : kind === 'free' || (validRates && nickname.trim().length <= 200)),
    ),
  );

  const messageFor = (failure: unknown) =>
    failure instanceof Error ? failure.message : 'Could not update pricing. Try again.';

  function editDraft() {
    editorVersion += 1;
    error = '';
    success = '';
  }

  function selectModel(value: string) {
    model = value;
    editing = true;
    editDraft();
    loadFailed = false;
    const rule = saved.find((entry) => entry.model === value);
    kind = rule?.kind ?? 'alias';
    target = rule?.kind === 'alias' ? rule.target : '';
    nickname = rule?.kind === 'rates' ? (rule.nickname ?? '') : '';
    inputRate = rule?.kind === 'rates' ? rule.rates.inputPerMillion : undefined;
    outputRate = rule?.kind === 'rates' ? rule.rates.outputPerMillion : undefined;
    cacheReadRate = rule?.kind === 'rates' ? rule.rates.cacheReadPerMillion : undefined;
    cacheWriteRate = rule?.kind === 'rates' ? rule.rates.cacheWritePerMillion : undefined;
    cacheWrite1hRate = rule?.kind === 'rates' ? rule.rates.cacheWrite1hPerMillion : undefined;
  }

  function cancelLoad() {
    request?.abort();
    request = undefined;
    requestVersion += 1;
    loading = false;
  }

  async function load(background = false, feedbackEditor = editorVersion) {
    if (!client) return;
    cancelLoad();
    const controller = new AbortController();
    request = controller;
    const version = ++requestVersion;
    loading = true;
    error = '';
    loadFailed = false;
    try {
      const next = await client.getPricing({ ...query }, controller.signal);
      if (controller.signal.aborted || version !== requestVersion) return;
      settings = next;
      if (!editing) {
        const first = next.unresolved[0]?.model ?? next.info.rules[0]?.model;
        if (first) selectModel(first);
      }
    } catch (failure) {
      if (!controller.signal.aborted && version === requestVersion) {
        if (feedbackEditor === editorVersion) {
          error = background ? `Changes saved. ${messageFor(failure)}` : messageFor(failure);
          loadFailed = !background;
        }
      }
    } finally {
      if (version === requestVersion) loading = false;
    }
  }

  export function show() {
    if (!dialog.open) dialog.showModal();
    editDraft();
    void load();
  }

  function mountDialog(element: HTMLDialogElement) {
    untrack(() => {
      dialog = element;
    });
    return endEditing;
  }

  function endEditing() {
    cancelLoad();
    editDraft();
  }

  function close() {
    endEditing();
    dialog.close();
  }

  function pricingChanged(info: PricingInfo, message: string, feedbackEditor: number, resetEditor = false) {
    if (settings) settings = { ...settings, info };
    if (feedbackEditor === editorVersion && dialog.open) {
      if (resetEditor) selectModel(model);
      feedbackEditor = editorVersion;
      success = message;
    }
    // The mutation has already persisted. Keep editing responsive while the
    // dashboard and unresolved-model list catch up independently.
    const version = mutationVersion;
    void onchange().catch((failure) => {
      if (version === mutationVersion && feedbackEditor === editorVersion && dialog.open)
        error = `Changes saved. ${messageFor(failure)}`;
    });
    if (dialog.open) void load(true, feedbackEditor);
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!client || !canSave) return;
    const rawModel = model.trim();
    if (rawModel.length > 200 || rawModel === '') {
      error = 'Enter a model name under 200 characters.';
      return;
    }
    let rule: PricingRule;
    if (kind === 'alias') {
      const canonical = target.trim();
      if (aliasIssue) {
        error = aliasIssue;
        return;
      }
      rule = { model: rawModel, kind: 'alias', target: canonical };
    } else if (kind === 'free') {
      rule = { model: rawModel, kind: 'free' };
    } else {
      if (
        inputRate == null ||
        outputRate == null ||
        ![inputRate, outputRate, cacheReadRate, cacheWriteRate, cacheWrite1hRate].every(validRate)
      ) {
        error = 'Enter nonnegative input and output rates. Leave unavailable cache rates blank.';
        return;
      }
      if (nickname.trim().length > 200) {
        error = 'Keep the display name under 200 characters.';
        return;
      }
      rule = {
        model: rawModel,
        kind: 'rates',
        ...(nickname.trim() ? { nickname: nickname.trim() } : {}),
        rates: {
          inputPerMillion: inputRate,
          outputPerMillion: outputRate,
          ...(cacheReadRate == null ? {} : { cacheReadPerMillion: cacheReadRate }),
          ...(cacheWriteRate == null ? {} : { cacheWritePerMillion: cacheWriteRate }),
          ...(cacheWrite1hRate == null ? {} : { cacheWrite1hPerMillion: cacheWrite1hRate }),
        },
      };
    }
    cancelLoad();
    const version = ++mutationVersion;
    const editor = editorVersion;
    busy = 'Saving…';
    error = '';
    loadFailed = false;
    success = '';
    try {
      const info = await client.setPricingRule(rule, adminSecret);
      if (version === mutationVersion) pricingChanged(info, 'Saved', editor);
    } catch (failure) {
      if (version === mutationVersion && editor === editorVersion && dialog.open) error = messageFor(failure);
    } finally {
      if (version === mutationVersion) busy = '';
    }
  }

  async function resetRule() {
    if (!client || !currentRule || busy) return;
    cancelLoad();
    const version = ++mutationVersion;
    const editor = editorVersion;
    busy = 'Resetting…';
    error = '';
    loadFailed = false;
    success = '';
    try {
      const info = await client.deletePricingRule(currentRule.model, adminSecret);
      if (version === mutationVersion) pricingChanged(info, 'Reset to catalog pricing', editor, true);
    } catch (failure) {
      if (version === mutationVersion && editor === editorVersion && dialog.open) error = messageFor(failure);
    } finally {
      if (version === mutationVersion) busy = '';
    }
  }

  async function refreshCatalog() {
    if (!client || busy) return;
    cancelLoad();
    const version = ++mutationVersion;
    const editor = editorVersion;
    busy = 'Updating prices…';
    error = '';
    loadFailed = false;
    success = '';
    try {
      const refreshed = await client.refreshPricing(adminSecret);
      if (version === mutationVersion) {
        pricingChanged(refreshed, 'Catalog updated', editor);
        if (editor === editorVersion && dialog.open && refreshed.refreshError) error = refreshed.refreshError;
      }
    } catch (failure) {
      if (version === mutationVersion && editor === editorVersion && dialog.open) error = messageFor(failure);
    } finally {
      if (version === mutationVersion) busy = '';
    }
  }
</script>

<dialog class="pricing-dialog" aria-labelledby="pricing-title" {@attach mountDialog} onclose={endEditing}>
  <div class="dialog-heading">
    <h2 id="pricing-title">Model pricing</h2>
    <button class="icon-button" aria-label="Close model pricing" onclick={close}><Icon name="close" /></button>
  </div>
  <div class="pricing-catalog-meta">
    <span>{settings ? `Catalog updated ${settings.info.updatedAt}` : 'Loading model prices…'}</span><button
      class="text-button"
      disabled={Boolean(busy) || loading}
      onclick={() => void refreshCatalog()}>Refresh prices</button
    >
  </div>
  <div class="pricing-dialog-body" aria-busy={loading || Boolean(busy)}>
    <div class="pricing-rule-list">
      {#if unresolved.length}<div class="pricing-list-label">Needs pricing <span>{unresolved.length}</span></div>{/if}
      {#each unresolved as entry (entry.model)}<button
          class={['pricing-model-row', model === entry.model && 'selected']}
          disabled={Boolean(busy)}
          onclick={() => selectModel(entry.model)}
          ><strong>{entry.model}</strong><span>{compact.format(entry.tokens)} tokens · {entry.reason}</span></button
        >{/each}
      {#if saved.length}<div class="pricing-list-label">Saved rules <span>{saved.length}</span></div>{/if}
      {#each saved as rule (rule.model)}<button
          class={['pricing-model-row', model === rule.model && 'selected']}
          disabled={Boolean(busy)}
          onclick={() => selectModel(rule.model)}
          ><strong>{rule.model}</strong><span
            >{rule.kind === 'alias'
              ? `→ ${rule.target}`
              : rule.kind === 'free'
                ? 'Free'
                : (rule.nickname ?? 'Custom rates')}</span
          ></button
        >{/each}
      {#if settings && !unresolved.length && !saved.length}<p class="pricing-list-empty">
          All models have catalog prices.
        </p>{/if}
      {#if loading && !settings}<div class="pricing-list-loading">
          <span class="spinner"></span><span>Loading models</span>
        </div>{/if}
      <button class="text-button pricing-add" disabled={!settings || Boolean(busy)} onclick={() => selectModel('')}
        >Add a rule</button
      >
    </div>
    <form class="pricing-editor" onsubmit={save} oninput={editDraft}>
      {#if editing}
        <label class="pricing-field"
          >Model ID<input
            aria-label="Model ID"
            bind:value={model}
            maxlength="200"
            required
            disabled={Boolean(busy)}
            placeholder="ID from your usage logs"
            autocomplete="off"
          /></label
        >
        {#if currentUnknown}<p class="pricing-current-unknown">
            {compact.format(currentUnknown.tokens)} tokens are excluded from estimated cost.
          </p>{/if}
        <div class="pricing-kind segmented" aria-label="Pricing rule type">
          {#each [{ value: 'alias', label: 'Model alias' }, { value: 'rates', label: 'Custom rates' }, { value: 'free', label: 'Free' }] as option (option.value)}<button
              type="button"
              class={kind === option.value ? 'active' : ''}
              disabled={Boolean(busy)}
              aria-pressed={kind === option.value}
              onclick={() => {
                editDraft();
                if (option.value === 'alias' || option.value === 'rates' || option.value === 'free')
                  kind = option.value;
              }}>{option.label}</button
            >{/each}
        </div>
        {#if kind === 'alias'}
          <label class="pricing-field"
            >Actual model<input
              list="pricing-catalog"
              aria-label="Actual model"
              aria-invalid={Boolean(target.trim() && aliasIssue)}
              aria-describedby="pricing-feedback"
              bind:value={target}
              maxlength="200"
              required
              disabled={Boolean(busy)}
              placeholder="Search catalog models"
              autocomplete="off"
            /></label
          >
          <datalist id="pricing-catalog"
            >{#each catalogMatches as name (name)}<option value={name}></option>{/each}</datalist
          >
          <p class="pricing-field-help">Uses this model’s rates and combines its usage in the dashboard.</p>
        {:else if kind === 'rates'}
          <label class="pricing-field"
            >Display name <span class="pricing-optional">optional</span><input
              aria-label="Display name"
              bind:value={nickname}
              maxlength="200"
              disabled={Boolean(busy)}
              placeholder="Name shown in the dashboard"
              autocomplete="off"
            /></label
          >
          <div class="pricing-rates-grid">
            <label class="pricing-field"
              >Input<input
                type="number"
                aria-label="Input price per million tokens"
                bind:value={inputRate}
                min="0"
                step="any"
                required
                disabled={Boolean(busy)}
                placeholder="$/1M"
              /></label
            >
            <label class="pricing-field"
              >Output<input
                type="number"
                aria-label="Output price per million tokens"
                bind:value={outputRate}
                min="0"
                step="any"
                required
                disabled={Boolean(busy)}
                placeholder="$/1M"
              /></label
            >
            <label class="pricing-field"
              >Cache read<input
                type="number"
                aria-label="Cache read price per million tokens"
                bind:value={cacheReadRate}
                min="0"
                step="any"
                disabled={Boolean(busy)}
                placeholder="Unknown"
              /></label
            >
            <label class="pricing-field"
              >Cache write, 5 min<input
                type="number"
                aria-label="Cache write price per million tokens"
                bind:value={cacheWriteRate}
                min="0"
                step="any"
                disabled={Boolean(busy)}
                placeholder="Unknown"
              /></label
            >
            <label class="pricing-field"
              >Cache write, 1 hour<input
                type="number"
                aria-label="One hour cache write price per million tokens"
                bind:value={cacheWrite1hRate}
                min="0"
                step="any"
                disabled={Boolean(busy)}
                placeholder="Unknown"
              /></label
            >
          </div>
          <p class="pricing-field-help">
            USD per 1M tokens, applied to all service tiers. Blank cache rates remain unknown; 0 means free.
          </p>
        {:else}<p class="pricing-field-help">All token types for this model will count at $0.</p>{/if}
        <div class="pricing-editor-actions">
          <button class="button pricing-save" type="submit" disabled={!canSave}>{busy || 'Save rule'}</button
          >{#if currentRule}<button
              class="text-button"
              type="button"
              disabled={Boolean(busy) || loading}
              onclick={() => void resetRule()}>Reset rule</button
            >{/if}
        </div>
      {:else}<div class="pricing-editor-empty">
          <Icon name="check" size={25} /><span>{loading ? 'Reading model prices' : 'Choose a model or add a rule'}</span
          >
        </div>{/if}
    </form>
  </div>
  <div id="pricing-feedback" class="pricing-feedback" aria-live="polite">
    {#if error}<span role="alert">{error}</span
      >{:else if kind === 'alias' && editing && target.trim() && aliasIssue}<span>{aliasIssue}</span
      >{:else if success}<span class="pricing-success"><Icon name="check" size={15} />{success}</span
      >{:else if settings?.info.refreshError}<span>{settings.info.refreshError}</span>{:else if loading || busy}<span
        >{busy || 'Updating…'}</span
      >{/if}
    {#if loadFailed}<button class="text-button" disabled={Boolean(busy)} onclick={() => void load()}>Retry</button>{/if}
  </div>
  <div class="pricing-dialog-footer">
    {#if settings?.secretRequired}<input
        class="pricing-secret"
        type="password"
        aria-label="Pairing secret"
        bind:value={adminSecret}
        disabled={Boolean(busy)}
        placeholder="Pairing secret"
        autocomplete="current-password"
      />{:else}<span>Changes apply across this dashboard.</span>{/if}<button class="button" onclick={close}>Done</button
    >
  </div>
</dialog>
