export interface CaelestisThemeTokens {
  readonly surface: string
  readonly raisedSurface: string
  readonly text: string
  readonly mutedText: string
  readonly border: string
  readonly focus: string
  readonly primary: string
  readonly warning: string
  readonly success: string
  readonly danger: string
  readonly finished: string
  readonly frozen: string
  readonly fieldRadius: string
  readonly cardRadius: string
  readonly panelRadius: string
  readonly compactTarget: string
  readonly touchTarget: string
  readonly shadow: string
  readonly motionDuration: string
}

export type CaelestisThemeToken = keyof CaelestisThemeTokens

const PROPERTIES: Record<CaelestisThemeToken, `--caelestis-${string}`> = {
  surface: '--caelestis-surface',
  raisedSurface: '--caelestis-raised-surface',
  text: '--caelestis-text',
  mutedText: '--caelestis-muted-text',
  border: '--caelestis-border',
  focus: '--caelestis-focus',
  primary: '--caelestis-primary',
  warning: '--caelestis-warning',
  success: '--caelestis-success',
  danger: '--caelestis-danger',
  finished: '--caelestis-finished',
  frozen: '--caelestis-frozen',
  fieldRadius: '--caelestis-field-radius',
  cardRadius: '--caelestis-card-radius',
  panelRadius: '--caelestis-panel-radius',
  compactTarget: '--caelestis-compact-target',
  touchTarget: '--caelestis-touch-target',
  shadow: '--caelestis-shadow',
  motionDuration: '--caelestis-motion-duration',
}

export const themeProperty = (token: CaelestisThemeToken): `--caelestis-${string}` =>
  PROPERTIES[token]

export const applyThemeTokens = (
  target: HTMLElement,
  tokens: Partial<CaelestisThemeTokens>,
): void => {
  for (const [token, value] of Object.entries(tokens) as Array<
    [CaelestisThemeToken, string | undefined]
  >) {
    if (value !== undefined) target.style.setProperty(PROPERTIES[token], value)
  }
}
