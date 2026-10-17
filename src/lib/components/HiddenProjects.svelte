<script lang="ts">
  import Icon from './Icon.svelte';
  let {
    projects,
    name,
    color,
    onunhide,
    onunhideall,
  }: {
    projects: readonly string[];
    name: (project: string) => string;
    color: (project: string) => string;
    onunhide: (project: string) => void;
    onunhideall: () => void;
  } = $props();
  let open = $state(false);
  let wrapper: HTMLDivElement;
  let trigger: HTMLButtonElement;
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
    class="filter-trigger filtered"
    bind:this={trigger}
    aria-label="Hidden projects"
    aria-haspopup="dialog"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <Icon name="eye-off" size={14} />Hidden<span class="filter-count">{projects.length}</span><Icon
      name="chevron"
      size={14}
    />
  </button>
  {#if open}
    <div class="filter-popover" role="dialog" aria-label="Hidden projects">
      <div class="popover-actions">
        <span>{projects.length} hidden</span><button onclick={onunhideall}>Unhide all</button>
      </div>
      <div class="filter-options">
        {#each projects as project (project)}
          {@const label = name(project)}
          <div class="filter-option-row">
            <span class="filter-option"
              ><i class="category-swatch" style:background={color(project)} aria-hidden="true"></i><span title={label}
                >{label}</span
              ></span
            ><button
              class="visibility-toggle"
              aria-label={`Unhide ${label}`}
              title={`Unhide ${label}`}
              onclick={() => onunhide(project)}><Icon name="eye" size={14} /></button
            >
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>
