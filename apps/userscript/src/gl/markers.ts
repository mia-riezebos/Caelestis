import { TILE_SIZE } from '@wts/shared'
import { warn } from '../debug.js'
import type { TileQuad } from '../tile-transform.js'

/**
 * Mismatch markers, drawn one point per marked pixel.
 *
 * The first version asked this question in the fragment shader: for every fragment, walk outwards
 * looking for a marked cell whose arms reach it. That is O(fragments on screen) with a texture fetch
 * per step, and a marker sized in device pixels means the walk gets *longer* the further out you
 * zoom. It killed the GPU — not the tab, the whole compositor.
 *
 * The shape of the problem is the fix. There are a handful of mismatched pixels and millions of
 * fragments, so the work belongs where the handful is: find them once on the CPU, per tile, and draw
 * one point each. Cost becomes O(mismatches), which is what it always should have been.
 *
 * Points rather than quads because `gl_PointSize` is specified in device pixels, which is exactly
 * the property being asked for — a marker the same size at every zoom — with no per-instance
 * geometry to build and no matrix to get wrong.
 */

const VERTEX = `#version 300 es
/** A marked pixel, in wplace canvas pixels. */
in vec2 a_pixel;

/** The tile's top-left in canvas pixels, and where it landed on screen this frame. */
uniform vec2 u_tileOrigin;
uniform vec2 u_tileScreen;
/** Device pixels per canvas pixel, from the tile's own on-screen size. */
uniform vec2 u_tileScale;
uniform vec2 u_buffer;
uniform float u_size;

void main() {
  // The centre of the pixel, not its corner, so the crosshair sits on the thing it marks.
  vec2 device = u_tileScreen + (a_pixel - u_tileOrigin + 0.5) * u_tileScale;
  gl_Position = vec4((2.0 * device.x) / u_buffer.x - 1.0, 1.0 - (2.0 * device.y) / u_buffer.y, 0.0, 1.0);
  gl_PointSize = u_size;
}
`

const FRAGMENT = `#version 300 es
precision highp float;

uniform float u_size;
uniform float u_thickness;
uniform vec3 u_colour;
uniform float u_fade;

out vec4 fragColor;

void main() {
  // Device pixels from the centre of the point, which is where the marked pixel is.
  vec2 offset = (gl_PointCoord - 0.5) * u_size;
  float half_ = u_thickness * 0.5;
  // A cross, not a box: it has to be findable against dense art without hiding the pixel it marks.
  if (abs(offset.x) > half_ && abs(offset.y) > half_) discard;
  float alpha = u_fade;
  fragColor = vec4(u_colour * alpha, alpha);
}
`

let program: WebGLProgram | null = null
let buffer: WebGLBuffer | null = null
let vao: WebGLVertexArrayObject | null = null
const uniforms = new Map<string, WebGLUniformLocation | null>()

const compile = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null => {
  const shader = gl.createShader(type)
  if (shader === null) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    warn('install', 'marker shader failed to compile', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

const uniform = (gl: WebGL2RenderingContext, name: string): WebGLUniformLocation | null => {
  if (!uniforms.has(name)) {
    uniforms.set(name, program === null ? null : gl.getUniformLocation(program, name))
  }
  return uniforms.get(name) ?? null
}

export const initMarkers = (gl: WebGL2RenderingContext): void => {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
  if (vertex === null || fragment === null) return
  const created = gl.createProgram()
  if (created === null) return
  gl.attachShader(created, vertex)
  gl.attachShader(created, fragment)
  gl.linkProgram(created)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(created, gl.LINK_STATUS)) {
    warn('install', 'marker program failed to link', gl.getProgramInfoLog(created))
    return
  }
  program = created
  uniforms.clear()
  buffer = gl.createBuffer()
  vao = gl.createVertexArray()
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  const pixel = gl.getAttribLocation(program, 'a_pixel')
  gl.enableVertexAttribArray(pixel)
  gl.vertexAttribPointer(pixel, 2, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)
}

export const releaseMarkers = (gl: WebGL2RenderingContext): void => {
  if (buffer !== null) gl.deleteBuffer(buffer)
  if (vao !== null) gl.deleteVertexArray(vao)
  if (program !== null) gl.deleteProgram(program)
  buffer = null
  vao = null
  program = null
  uniforms.clear()
}

export interface MarkerStyle {
  readonly size: number
  readonly thickness: number
  readonly colour: readonly [number, number, number]
}

/**
 * Draw one crosshair per marked pixel of one tile.
 *
 * `pixels` is x,y pairs in canvas coordinates. Placement comes from the tile's own on-screen rect,
 * the same rect the overlay itself is drawn on, so markers inherit whatever MapLibre did to place
 * that tile rather than being projected separately.
 */
export const drawMarkers = (
  gl: WebGL2RenderingContext,
  tile: TileQuad,
  pixels: Float32Array,
  style: MarkerStyle,
  fade: number,
): void => {
  if (program === null || vao === null || pixels.length === 0) return

  gl.useProgram(program)
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, pixels, gl.DYNAMIC_DRAW)

  gl.uniform2f(uniform(gl, 'u_tileOrigin'), tile.tile.x * TILE_SIZE, tile.tile.y * TILE_SIZE)
  gl.uniform2f(uniform(gl, 'u_tileScreen'), tile.x, tile.y)
  gl.uniform2f(uniform(gl, 'u_tileScale'), tile.width / TILE_SIZE, tile.height / TILE_SIZE)
  gl.uniform2f(uniform(gl, 'u_buffer'), gl.drawingBufferWidth, gl.drawingBufferHeight)
  gl.uniform1f(uniform(gl, 'u_size'), style.size)
  gl.uniform1f(uniform(gl, 'u_thickness'), style.thickness)
  gl.uniform3f(uniform(gl, 'u_colour'), ...style.colour)
  gl.uniform1f(uniform(gl, 'u_fade'), fade)

  gl.drawArrays(gl.POINTS, 0, pixels.length / 2)
  gl.bindVertexArray(null)
}
