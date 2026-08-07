/**
 * The overlay's shaders.
 *
 * Two ideas carry the whole thing.
 *
 * **Colour is a lookup, not a bitmap.** A template is uploaded once as one byte per pixel — the
 * palette index wplace itself uses — and the fragment shader reads the colour out of a 64-entry
 * table. Hiding a colour is then a 256-byte table upload rather than rebuilding a million-pixel
 * image, which is what made the CPU version cost a re-bake per toggle.
 *
 * **Shape is computed, not sampled.** The stamp is a rounded box evaluated as a signed distance in
 * cell space, so it is exact at any zoom and anti-aliases itself from the screen-space derivative.
 * The version this replaces expanded every source pixel into a 3x3 block and drew inside it, which
 * fixed the shape's resolution to the pixel grid and made "33% size" one device pixel.
 */

export const VERTEX_SOURCE = `#version 300 es
in vec2 a_pos;
// Mercator extent of the template: x0, y0, x1, y1, all in 0..1 world coordinates.
uniform vec4 u_extent;
// MapLibre's own matrix, mercator to clip space. Using theirs is what puts our pixels exactly on
// theirs instead of near them.
uniform mat4 u_matrix;
out vec2 v_uv;
void main() {
  v_uv = a_pos;
  vec2 mercator = mix(u_extent.xy, u_extent.zw, a_pos);
  gl_Position = u_matrix * vec4(mercator, 0.0, 1.0);
}
`

export const FRAGMENT_SOURCE = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

in vec2 v_uv;

/** One byte per pixel: the wplace palette index. */
uniform usampler2D u_indices;
/** 64x1 RGBA. Alpha 0 means this colour is filtered out. */
uniform sampler2D u_palette;
/** Template size in template pixels, so v_uv can be turned into a cell. */
uniform vec2 u_size;
uniform float u_opacity;

/** Stamp geometry, all in cell fractions except rotation, which is radians. */
uniform float u_stampSize;
uniform float u_stampRadius;
uniform vec2 u_stampOffset;
uniform float u_stampRotation;
/** Set when the stamp is a plain full cell, so the whole distance field can be skipped. */
uniform bool u_plain;

out vec4 fragColor;

/** Signed distance to a rounded box centred on the origin. Negative inside. */
float roundedBox(vec2 point, vec2 half_, float radius) {
  vec2 q = abs(point) - half_ + radius;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;
}

void main() {
  vec2 texel = v_uv * u_size;
  ivec2 cell = ivec2(floor(texel));
  if (cell.x < 0 || cell.y < 0 || cell.x >= int(u_size.x) || cell.y >= int(u_size.y)) discard;

  uint index = texelFetch(u_indices, cell, 0).r;
  vec4 entry = texelFetch(u_palette, ivec2(int(index), 0), 0);
  // Alpha 0 covers both the wildcard index and any colour the filter has switched off.
  if (entry.a < 0.5) discard;

  float coverage = 1.0;
  if (!u_plain) {
    // Position within this cell, centred, so the stamp transform is about the cell's middle.
    vec2 local = fract(texel) - 0.5;
    // Undo the stamp's own transform rather than transforming the stamp: rotate the sample point
    // backwards, then remove the offset, and the box stays axis-aligned at the origin.
    float c = cos(-u_stampRotation);
    float s = sin(-u_stampRotation);
    vec2 rotated = mat2(c, -s, s, c) * local;
    vec2 point = rotated - u_stampOffset;

    float half_ = u_stampSize * 0.5;
    float radius = u_stampRadius * half_;
    float distance = roundedBox(point, vec2(half_), radius);
    // One screen pixel expressed in cell units, so the edge is exactly one pixel wide however far
    // in or out the map is zoomed. This is where the resolution independence comes from.
    float pixel = fwidth(texel.x);
    coverage = 1.0 - smoothstep(-pixel * 0.5, pixel * 0.5, distance);
    if (coverage <= 0.0) discard;
  }

  float alpha = coverage * u_opacity;
  // Premultiplied, to match the blend mode MapLibre leaves set.
  fragColor = vec4(entry.rgb * alpha, alpha);
}
`
