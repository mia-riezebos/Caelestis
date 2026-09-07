<!-- Shared by native selects and custom menus, including inside userscript shadow roots. -->
<style>
  :global(.caelestis-select), :global(.caelestis-menu) {
    --menu-radius: 0.5rem;
    --menu-item-radius: 0.25rem;
    --menu-padding: 0.25rem;
    --menu-surface: var(--caelestis-surface, var(--color-base-100, white));
    --menu-text: var(--caelestis-text, var(--color-base-content, #202c40));
    --menu-border: var(--caelestis-border, var(--color-base-300, #d4dbe5));
    --menu-hover: color-mix(in oklab, var(--menu-text) 10%, transparent);
    box-sizing: border-box;
    color: var(--menu-text);
    font: 400 0.875rem/1.35 ui-sans-serif, system-ui, sans-serif;
  }
  :global(select.caelestis-select) {
    appearance: none;
    min-inline-size: 0;
    max-inline-size: 100%;
    block-size: 2rem;
    padding-inline: 0.75rem 1.75rem;
    border: 1px solid var(--menu-border);
    border-radius: var(--menu-radius);
    background-color: var(--menu-surface);
    background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%);
    background-position: calc(100% - 20px) calc(1px + 50%), calc(100% - 16.1px) calc(1px + 50%);
    background-repeat: no-repeat;
    background-size: 4px 4px;
    box-shadow: 0 1px color-mix(in oklab, var(--menu-text) 10%, transparent) inset;
    cursor: pointer;
    touch-action: manipulation;
  }
  @supports (appearance: base-select) {
    :global(select.caelestis-select), :global(select.caelestis-select::picker(select)) { appearance: base-select; }
  }
  :global(select.caelestis-select::picker-icon) { display: none; }
  :global(.caelestis-menu), :global(select.caelestis-select::picker(select)) {
    box-sizing: border-box;
    padding: var(--menu-padding);
    border: 1px solid var(--menu-border);
    border-radius: var(--menu-radius);
    background: var(--menu-surface);
    color: var(--menu-text);
    box-shadow: 0 8px 24px #0002;
  }
  :global(select.caelestis-select::picker(select)) { margin-block: 0.5rem; max-block-size: min(24rem, 70dvh); }
  :global(.caelestis-menu-item), :global(select.caelestis-select option) {
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-block-size: 2rem;
    padding: 0.375rem 0.625rem;
    border: 0;
    border-radius: var(--menu-item-radius);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: start;
    white-space: normal;
    cursor: pointer;
  }
  :global(.caelestis-menu-item:is(:hover, :focus-visible, [data-selected])),
  :global(select.caelestis-select option:is(:hover, :focus-visible)) { background: var(--menu-hover); }
  :global(.caelestis-menu-item:focus-visible) { outline: 2px solid var(--caelestis-focus, var(--color-primary, currentColor)); outline-offset: -2px; }
  :global(select.caelestis-select:focus-visible) { outline: 2px solid var(--caelestis-focus, var(--color-primary, currentColor)); outline-offset: 2px; }
  :global(select.caelestis-select:disabled), :global(.caelestis-menu-item:is(:disabled, [data-disabled])) { opacity: 0.5; cursor: not-allowed; }
</style>
