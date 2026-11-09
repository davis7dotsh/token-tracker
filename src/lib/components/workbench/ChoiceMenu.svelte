<script lang="ts">
  import { tick } from 'svelte';
  import Icon from '../Icon.svelte';
  let {
    label,
    prefix = '',
    icon,
    value,
    choices,
    onchange,
  }: {
    label: string;
    prefix?: string;
    icon?: string;
    value: string;
    choices: readonly { value: string; label: string }[];
    onchange: (value: string) => void;
  } = $props();
  const id = $props.id();
  let open = $state(false),
    above = $state(false),
    alignLeft = $state(false),
    active = $state(0);
  let wrap: HTMLDivElement, trigger: HTMLButtonElement;
  let list = $state<HTMLDivElement>();
  function focusOption() {
    list?.querySelectorAll('button')[active]?.focus({ preventScroll: true });
    list?.querySelectorAll('button')[active]?.scrollIntoView({ block: 'nearest' });
  }
  async function show() {
    const r = trigger.getBoundingClientRect();
    above = innerHeight - r.bottom < Math.min(260, choices.length * 36 + 12) && r.top > innerHeight - r.bottom;
    alignLeft = r.right < Math.min(260, innerWidth - 24);
    active = Math.max(
      0,
      choices.findIndex((c) => c.value === value),
    );
    open = true;
    await tick();
    focusOption();
  }
  function close(restore = false) {
    open = false;
    if (restore) trigger.focus({ preventScroll: true });
  }
  function choose(v: string) {
    close(true);
    onchange(v);
  }
  let search = '',
    lastKey = 0;
  function keys(e: KeyboardEvent) {
    if (!open) {
      if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
        e.preventDefault();
        void show();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === 'Tab') {
      close(true);
      return;
    }
    if (e.key === 'ArrowDown') active = (active + 1) % choices.length;
    else if (e.key === 'ArrowUp') active = (active - 1 + choices.length) % choices.length;
    else if (e.key === 'Home') active = 0;
    else if (e.key === 'End') active = choices.length - 1;
    else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey) {
      search = (performance.now() - lastKey < 600 ? search : '') + e.key.toLowerCase();
      lastKey = performance.now();
      const i = choices.findIndex((c) => c.label.toLowerCase().startsWith(search));
      if (i >= 0) active = i;
    } else return;
    e.preventDefault();
    focusOption();
  }
</script>

<svelte:window
  onpointerdown={(e) => {
    if (open && e.target instanceof Node && !wrap.contains(e.target)) close();
  }}
  onresize={() => close()}
/>
<div class="choice" bind:this={wrap}>
  <button
    class="choice-trigger"
    bind:this={trigger}
    aria-label={`${label}: ${choices.find((c) => c.value === value)?.label ?? ''}`}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={open ? id : undefined}
    onclick={() => (open ? close(true) : void show())}
    onkeydown={keys}
  >
    {#if icon}<Icon name={icon} size={15} />{/if}{#if prefix}<span>{prefix}</span>{/if}<strong
      >{choices.find((c) => c.value === value)?.label ?? 'Choose'}</strong
    ><Icon name="chevron" size={13} />
  </button>
  {#if open}<div
      {id}
      class="choice-list"
      class:above
      class:alignLeft
      role="menu"
      tabindex="-1"
      aria-label={label}
      bind:this={list}
      onkeydown={keys}
    >
      {#each choices as c, i (c.value)}<button
          role="menuitemradio"
          aria-checked={value === c.value}
          tabindex={i === active ? 0 : -1}
          onclick={() => choose(c.value)}
          >{c.label}{#if value === c.value}<Icon name="check" size={14} />{/if}</button
        >{/each}
    </div>{/if}
</div>

<style>
  .choice {
    position: relative;
    min-width: 0;
  }
  .choice-trigger {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 36px;
    max-width: 100%;
    font-size: 13px;
    white-space: nowrap;
  }
  .choice-trigger span,
  .choice-trigger :global(svg) {
    color: var(--wb-muted);
  }
  .choice-trigger strong {
    font-weight: 570;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .choice-trigger:hover strong,
  .choice-trigger[aria-expanded='true'] strong {
    color: var(--wb-accent);
  }
  .choice-list {
    position: absolute;
    right: 0;
    top: calc(100% + 2px);
    z-index: 8;
    padding: 4px;
    background: var(--wb-panel);
    border: 1px solid var(--wb-line);
    border-radius: 6px;
    box-shadow: 0 6px 22px #0002;
    min-width: 158px;
    width: max-content;
    max-width: min(280px, 85vw);
    max-height: min(260px, 45dvh);
    overflow: auto;
  }
  .choice-list.above {
    top: auto;
    bottom: 100%;
  }
  .choice-list.alignLeft {
    right: auto;
    left: 0;
  }
  .choice-list button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    width: 100%;
    text-align: left;
    padding: 0 10px;
    min-height: 34px;
    border-radius: 3px;
    font-size: 13px;
  }
  .choice-list button:hover,
  .choice-list button:focus-visible {
    outline: none;
    background: var(--wb-soft);
  }
  .choice-list button[aria-checked='true'] {
    color: var(--wb-accent);
  }
</style>
