export type WplaceRasterRole = 'tile' | 'draft' | 'other'

/** Wplace names the raster layers; use that identity instead of reverse-engineering their quads. */
export const wplaceRasterRole = (layerId: string | null): WplaceRasterRole => {
  if (layerId === 'pixel-art-layer') return 'tile'
  if (layerId?.startsWith('paint-preview-')) return 'draft'
  return 'other'
}

/**
 * The small piece of WebGL state needed to recognise a MapLibre raster draw.
 *
 * WebGL bindings are global to the context, but they do not all describe the same draw: a vector
 * program can upload its own projection while a raster texture remains bound, and texture unit 1
 * can be changed after the tile on unit 0. Keeping those as two anonymous "last seen" values pairs
 * unrelated state and produces a perfectly square, completely wrong tile quad.
 *
 * Program and uniform tokens stay generic so this state machine can be tested without a browser.
 */
export class TileDrawState<
  Program extends object,
  Location extends object,
  Texture extends object,
> {
  private readonly uniforms = new Map<Location, { program: Program; name: string }>()
  private readonly rasterPrograms = new WeakSet<Program>()
  private readonly projections = new WeakMap<Program, ArrayLike<number>>()
  private readonly imageUnits = new WeakMap<Program, Map<string, number>>()
  private readonly textures = new Map<number, Texture | null>()
  private program: Program | null = null
  private textureUnit = 0

  nameUniform(program: Program, location: Location, name: string): void {
    this.uniforms.set(location, { program, name })
    // MapLibre's raster program calls its primary sampler u_image0. Its vector, background and
    // clipping programs all use u_projection_matrix too, which is why the matrix name alone is not
    // an identity.
    if (name === 'u_image0' || name === 'u_image1') this.rasterPrograms.add(program)
  }

  useProgram(program: Program | null): void {
    this.program = program
  }

  setActiveTextureUnit(unit: number): void {
    this.textureUnit = unit
  }

  bindTexture(texture: Texture | null): void {
    this.textures.set(this.textureUnit, texture)
  }

  textureOnActiveUnit(): Texture | null {
    return this.textures.get(this.textureUnit) ?? null
  }

  setSamplerUnit(location: Location, unit: number): void {
    const uniform = this.uniforms.get(location)
    if (uniform?.name !== 'u_image0' && uniform?.name !== 'u_image1') return
    let units = this.imageUnits.get(uniform.program)
    if (units === undefined) {
      units = new Map()
      this.imageUnits.set(uniform.program, units)
    }
    units.set(uniform.name, unit)
  }

  setProjection(location: Location, value: ArrayLike<number>): void {
    const uniform = this.uniforms.get(location)
    if (uniform?.name === 'u_projection_matrix') {
      this.projections.set(uniform.program, value)
    }
  }

  tileDraw(): { textures: readonly Texture[]; projection: ArrayLike<number> } | null {
    const program = this.program
    if (program === null || !this.rasterPrograms.has(program)) return null
    const projection = this.projections.get(program)
    if (projection === undefined) return null
    const units = this.imageUnits.get(program)
    // u_image0 and u_image1 are the current tile and its crossfade partner. Which one is populated
    // changes as MapLibre moves between zoom levels, so hand both to the attribution layer and let
    // the texture that came from a wplace tile URL identify itself.
    const sampled = [units?.get('u_image0') ?? 0, units?.get('u_image1') ?? 1]
    const textures: Texture[] = []
    for (const unit of sampled) {
      const texture = this.textures.get(unit)
      if (texture != null && !textures.includes(texture)) textures.push(texture)
    }
    if (textures.length === 0) return null
    return { textures, projection }
  }
}
