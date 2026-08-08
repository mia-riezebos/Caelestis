import { describe, expect, it } from 'vitest'
import { TileDrawState, wplaceRasterRole } from './tile-draw-state.js'

const token = (): object => ({})

describe('TileDrawState', () => {
  it('does not pair a remembered tile texture with another layer’s projection', () => {
    const state = new TileDrawState<object, object, object>()
    const raster = token()
    const vector = token()
    const rasterProjection = token()
    const rasterImage = token()
    const vectorProjection = token()
    const tileTexture = token()
    const rasterMatrix = new Float32Array([11])
    const vectorMatrix = new Float32Array([15])

    state.nameUniform(raster, rasterProjection, 'u_projection_matrix')
    state.nameUniform(raster, rasterImage, 'u_image0')
    state.nameUniform(vector, vectorProjection, 'u_projection_matrix')
    state.setSamplerUnit(rasterImage, 0)
    state.setActiveTextureUnit(0)
    state.bindTexture(tileTexture)
    state.setProjection(rasterProjection, rasterMatrix)

    state.useProgram(vector)
    state.setProjection(vectorProjection, vectorMatrix)
    expect(state.tileDraw()).toBeNull()

    state.useProgram(raster)
    expect(state.tileDraw()).toEqual({ textures: [tileTexture], projection: rasterMatrix })
  })

  it('keeps u_image0 first when another texture unit was bound later', () => {
    const state = new TileDrawState<object, object, object>()
    const raster = token()
    const projection = token()
    const image = token()
    const tileTexture = token()
    const unrelatedTexture = token()
    const matrix = new Float32Array([11])

    state.nameUniform(raster, projection, 'u_projection_matrix')
    state.nameUniform(raster, image, 'u_image0')
    state.setSamplerUnit(image, 0)
    state.setProjection(projection, matrix)
    state.setActiveTextureUnit(0)
    state.bindTexture(tileTexture)
    state.setActiveTextureUnit(1)
    state.bindTexture(unrelatedTexture)
    state.useProgram(raster)

    expect(state.tileDraw()).toEqual({
      textures: [tileTexture, unrelatedTexture],
      projection: matrix,
    })
  })

  it('includes the crossfade texture when the real tile is on u_image1', () => {
    const state = new TileDrawState<object, object, object>()
    const raster = token()
    const projection = token()
    const image0 = token()
    const image1 = token()
    const hoverTexture = token()
    const tileTexture = token()
    const matrix = new Float32Array([11])

    state.nameUniform(raster, projection, 'u_projection_matrix')
    state.nameUniform(raster, image0, 'u_image0')
    state.nameUniform(raster, image1, 'u_image1')
    state.setSamplerUnit(image0, 0)
    state.setSamplerUnit(image1, 1)
    state.setProjection(projection, matrix)
    state.setActiveTextureUnit(0)
    state.bindTexture(hoverTexture)
    state.setActiveTextureUnit(1)
    state.bindTexture(tileTexture)
    state.useProgram(raster)

    expect(state.tileDraw()).toEqual({ textures: [hoverTexture, tileTexture], projection: matrix })
  })
})

describe('wplaceRasterRole', () => {
  it('separates the real pixel tiles from named draft and picker layers', () => {
    expect(wplaceRasterRole('pixel-art-layer')).toBe('tile')
    expect(wplaceRasterRole('paint-preview-0.9268-325,1783')).toBe('draft')
    expect(wplaceRasterRole('pixel-hover')).toBe('other')
    expect(wplaceRasterRole(null)).toBe('other')
  })
})
