import { warn } from '../debug.js'
import { VERTEX_SOURCE } from './shaders.js'

const compile = (gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null => {
  const shader = gl.createShader(type)
  if (shader === null) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    warn('install', 'overlay shader failed to compile', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

/** Link the shader program shared by the MapLibre and alliance-artboard hosts. */
export const linkTemplateProgram = (
  gl: WebGL2RenderingContext,
  fragmentSource: string,
): WebGLProgram | null => {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource)
  if (vertex === null || fragment === null) {
    if (vertex !== null) gl.deleteShader(vertex)
    if (fragment !== null) gl.deleteShader(fragment)
    return null
  }
  const program = gl.createProgram()
  if (program === null) {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    return null
  }
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    warn('install', 'overlay program failed to link', gl.getProgramInfoLog(program))
    gl.deleteProgram(program)
    return null
  }
  return program
}

/** Convert one device-pixel corner to the clip coordinates consumed by the shared vertex shader. */
export const writeClipCorner = (
  deviceX: number,
  deviceY: number,
  bufferWidth: number,
  bufferHeight: number,
  u: number,
  v: number,
  into: Float32Array,
  offset: number,
): void => {
  into[offset] = (2 * deviceX) / bufferWidth - 1
  into[offset + 1] = 1 - (2 * deviceY) / bufferHeight
  into[offset + 2] = 0
  into[offset + 3] = 1
  into[offset + 4] = u
  into[offset + 5] = v
}
