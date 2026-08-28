import { applyThemeTokens } from '@caelestis/ui/theme'

/** Bridge Wplace's DaisyUI variables into the package's stable theme contract. */
export const applyWplaceTheme = (target: HTMLElement): void => {
  applyThemeTokens(target, {
    surface: 'var(--color-base-100, oklch(0.27 0.025 264))',
    raisedSurface: 'var(--color-base-200, oklch(0.32 0.025 264))',
    text: 'var(--color-base-content, oklch(0.91 0.015 264))',
    mutedText: 'color-mix(in oklch, var(--color-base-content, currentColor) 62%, transparent)',
    border: 'var(--color-base-300, rgb(255 255 255 / 0.14))',
    focus: 'var(--color-primary, oklch(0.74 0.14 244))',
    primary: 'var(--color-primary, oklch(0.68 0.15 244))',
    warning: 'var(--color-warning, oklch(0.76 0.15 75))',
    success: 'var(--color-success, oklch(0.75 0.14 154))',
    danger: 'var(--color-error, oklch(0.72 0.18 27))',
    finished: 'var(--color-success, oklch(0.75 0.14 154))',
    frozen: 'var(--color-primary, oklch(0.76 0.12 238))',
    fieldRadius: '0.65rem',
    cardRadius: '0.75rem',
    panelRadius: '1rem',
    compactTarget: '2rem',
    touchTarget: '2.75rem',
    shadow: '0 24px 80px rgb(0 0 0 / 0.35)',
    motionDuration: '160ms',
  })
}
