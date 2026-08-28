import { css, html, LitElement } from 'lit'

export interface TemplateLifecycleChangeDetail {
  readonly value: boolean
}

export class CaelestisTemplateAdmin extends LitElement {
  static override properties = {
    finished: { type: Boolean, reflect: true },
    frozen: { type: Boolean, reflect: true },
    busy: { type: Boolean, reflect: true },
  }

  static override styles = css`
    :host {
      --_surface: var(--caelestis-surface, oklch(0.97 0.01 264));
      --_text: var(--caelestis-text, oklch(0.26 0.025 264));
      --_border: var(--caelestis-border, oklch(0.78 0.025 264 / 0.7));
      --_focus: var(--caelestis-focus, oklch(0.62 0.17 252));
      display: inline-flex;
      max-inline-size: 100%;
      color: var(--_text);
      font: 600 0.8rem/1.2 ui-sans-serif, system-ui, sans-serif;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    button {
      min-block-size: 2.75rem;
      padding-inline: 0.8rem;
      border: 1px solid var(--_border);
      border-radius: 0.65rem;
      background: var(--_surface);
      color: inherit;
      font: inherit;
      cursor: pointer;
    }

    button:hover:not(:disabled) {
      border-color: color-mix(in oklch, var(--_text) 42%, var(--_border));
      background: color-mix(in oklch, var(--_text) 7%, var(--_surface));
    }

    button:active:not(:disabled) {
      transform: scale(0.97);
    }

    button:focus-visible {
      outline: 3px solid color-mix(in oklch, var(--_focus) 55%, transparent);
      outline-offset: 2px;
    }

    button:disabled {
      cursor: wait;
      opacity: 0.55;
    }

    @media (prefers-color-scheme: dark) {
      :host {
        --_surface: var(--caelestis-surface, oklch(0.27 0.025 264));
        --_text: var(--caelestis-text, oklch(0.91 0.015 264));
        --_border: var(--caelestis-border, oklch(0.5 0.025 264 / 0.55));
        --_focus: var(--caelestis-focus, oklch(0.74 0.14 244));
      }
    }

    @media (prefers-reduced-motion: no-preference) {
      button {
        transition:
          transform 120ms,
          border-color 160ms,
          background-color 160ms;
      }
    }

    @media (prefers-contrast: more) {
      button {
        border-color: currentColor;
      }
    }
  `

  finished = false
  frozen = false
  busy = false

  protected override render() {
    return html`
      <div class="actions" role="group" aria-label="Template lifecycle">
        <button
          type="button"
          ?disabled=${this.busy}
          @click=${() => this.emitChange('caelestis-finished-change', !this.finished)}
        >
          ${this.finished ? 'Reopen template' : 'Mark finished'}
        </button>
        <button
          type="button"
          ?disabled=${this.busy || (this.finished && this.frozen)}
          title=${this.finished && this.frozen ? 'Reopen the template before thawing' : ''}
          @click=${() => this.emitChange('caelestis-frozen-change', !this.frozen)}
        >
          ${this.frozen ? 'Thaw timelapse' : 'Freeze timelapse'}
        </button>
      </div>
    `
  }

  private emitChange(name: string, value: boolean): void {
    this.dispatchEvent(
      new CustomEvent<TemplateLifecycleChangeDetail>(name, {
        detail: { value },
        bubbles: true,
        composed: true,
      }),
    )
  }
}
