import type { Template } from '@caelestis/shared'
import { css, html, LitElement, nothing } from 'lit'

export type TemplateLifecycleState = Pick<
  Template,
  'finished' | 'finishedAt' | 'timelapseFrozen'
> & {
  readonly griefed: boolean
}

export class CaelestisTemplateState extends LitElement {
  static override properties = {
    finished: { type: Boolean, reflect: true },
    frozen: { type: Boolean, reflect: true },
    griefed: { type: Boolean, reflect: true },
    compact: { type: Boolean, reflect: true },
  }

  static override styles = css`
    :host {
      --_text: var(--caelestis-text, oklch(0.26 0.025 264));
      --_border: var(--caelestis-border, oklch(0.78 0.025 264 / 0.7));
      --_finished: var(--caelestis-finished, oklch(0.63 0.14 154));
      --_frozen: var(--caelestis-frozen, oklch(0.64 0.13 238));
      --_danger: var(--caelestis-danger, oklch(0.59 0.2 27));
      display: inline-flex;
      max-inline-size: 100%;
      color: var(--_text);
      font: 600 0.75rem/1.15 ui-sans-serif, system-ui, sans-serif;
    }

    .states {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 0.3rem;
      align-items: center;
    }

    .state {
      display: inline-flex;
      align-items: center;
      min-block-size: 1.45rem;
      padding-inline: 0.5rem;
      border: 1px solid color-mix(in oklch, currentColor 35%, var(--_border));
      border-radius: 999px;
      background: color-mix(in oklch, currentColor 10%, transparent);
      white-space: nowrap;
    }

    .finished {
      color: var(--_finished);
    }

    .frozen {
      color: var(--_frozen);
    }

    .griefed {
      color: var(--_danger);
      font-weight: 750;
    }

    :host([compact]) .state {
      min-block-size: 1.15rem;
      padding-inline: 0.35rem;
      font-size: 0.66rem;
    }

    @media (prefers-color-scheme: dark) {
      :host {
        --_text: var(--caelestis-text, oklch(0.91 0.015 264));
        --_border: var(--caelestis-border, oklch(0.5 0.025 264 / 0.55));
        --_finished: var(--caelestis-finished, oklch(0.75 0.14 154));
        --_frozen: var(--caelestis-frozen, oklch(0.76 0.12 238));
        --_danger: var(--caelestis-danger, oklch(0.72 0.18 27));
      }
    }

    @media (prefers-contrast: more) {
      .state {
        border-color: currentColor;
        background: transparent;
      }
    }

    @media (forced-colors: active) {
      .state {
        border-color: CanvasText;
      }
    }
  `

  finished = false
  frozen = false
  griefed = false
  compact = false

  protected override render() {
    if (!this.finished && !this.frozen) return nothing
    return html`
      <span class="states" aria-label="Template state">
        ${this.finished ? html`<span class="state finished">Finished</span>` : nothing}
        ${this.frozen ? html`<span class="state frozen">Timelapse frozen</span>` : nothing}
        ${
          this.finished && this.griefed
            ? html`<span class="state griefed" role="status">Grief detected</span>`
            : nothing
        }
      </span>
    `
  }
}
