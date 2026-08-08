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

/**
 * Corners arrive already in clip space, projected on the CPU.
 *
 * The obvious version multiplies a Mercator position by MapLibre's matrix here, and it is wrong at
 * high zoom. A world-Mercator coordinate is around 0.16, whose float32 neighbours are about 1.2e-8
 * apart; the matrix scale at zoom 16 is tens of millions, so that gap becomes half a pixel on
 * screen, and worse the further in you go. MapLibre never does this in its own layers for exactly
 * this reason — its tile shaders work in tile-local coordinates precisely to keep the numbers small.
 *
 * Projecting the four corners in JavaScript sidesteps it: doubles carry the Mercator value, and the
 * *result* is clip space in -1..1, where float32 has room to spare. The GPU then only interpolates.
 */
export const VERTEX_SOURCE = `#version 300 es
in vec4 a_clip;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = a_clip;
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
/** Ramps 0 to 1 once the overlay has something to show, so templates arrive instead of appearing. */
uniform float u_fade;

out vec4 fragColor;

/** How many samples a side to take across a fragment when the template is minified. */
const int MINIFY_TAPS = 4;

/** Signed distance to a rounded box centred on the origin. Negative inside. */
float roundedBox(vec2 point, vec2 half_, float radius) {
  vec2 q = abs(point) - half_ + radius;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;
}

/** One cell's colour, with w = 1 when it should be drawn at all and 0 when it is filtered or blank. */
vec4 cellColour(vec2 texel) {
  ivec2 cell = ivec2(floor(texel));
  if (cell.x < 0 || cell.y < 0 || cell.x >= int(u_size.x) || cell.y >= int(u_size.y)) {
    return vec4(0.0);
  }
  uint index = texelFetch(u_indices, cell, 0).r;
  vec4 entry = texelFetch(u_palette, ivec2(int(index), 0), 0);
  // Alpha covers both the wildcard index — always 0 — and how far through the filter's fade the
  // colour is, which is why it is carried through rather than rounded to a yes or a no.
  return vec4(entry.rgb, entry.a);
}

void main() {
  vec2 texel = v_uv * u_size;
  // How much of the template one device pixel covers, per axis.
  vec2 footprint = vec2(fwidth(texel.x), fwidth(texel.y));

  // Below 1:1, one fragment covers several template pixels and a single sample cannot represent
  // them. Point-sampling there is what produced the moire: which of the cells under a fragment got
  // picked depended on where the sample landed, so the pattern beat against the pixel grid and
  // crawled as the map moved.
  //
  // wplace has the same problem and answers it with LINEAR below 1:1 and NEAREST above — measured
  // off their calls, and they never generate a mipmap. LINEAR only averages the nearest four
  // texels, so it is an answer to aliasing rather than a cure. Averaging the fragment's whole
  // footprint is strictly better, and it is only reachable at all because the colour comes from a
  // lookup: indices cannot be averaged, resolved colours can.
  //
  // The stamp is deliberately skipped here. Below 1:1 it is smaller than a pixel, so it has nothing
  // to say about what the fragment should look like.
  if (max(footprint.x, footprint.y) > 1.0) {
    vec3 sum = vec3(0.0);
    float drawn = 0.0;
    for (int j = 0; j < MINIFY_TAPS; j++) {
      for (int i = 0; i < MINIFY_TAPS; i++) {
        vec2 at = (vec2(float(i), float(j)) + 0.5) / float(MINIFY_TAPS) - 0.5;
        vec4 sampled = cellColour(texel + at * footprint);
        sum += sampled.rgb * sampled.w;
        drawn += sampled.w;
      }
    }
    if (drawn <= 0.0) discard;
    float taps = float(MINIFY_TAPS * MINIFY_TAPS);
    // Coverage is the share of the footprint that draws at all, so a template's edge and its holes
    // fade out across the boundary instead of stepping.
    float minifiedAlpha = (drawn / taps) * u_opacity * u_fade;
    fragColor = vec4((sum / drawn) * minifiedAlpha, minifiedAlpha);
    return;
  }

  ivec2 cell = ivec2(floor(texel));
  if (cell.x < 0 || cell.y < 0 || cell.x >= int(u_size.x) || cell.y >= int(u_size.y)) discard;

  uint index = texelFetch(u_indices, cell, 0).r;
  vec4 entry = texelFetch(u_palette, ivec2(int(index), 0), 0);
  // Nothing at all to draw: the wildcard index, or a colour whose fade has finished leaving.
  if (entry.a <= 0.0) discard;

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

    // One screen pixel expressed in cell units, so the edge is exactly one pixel wide however far
    // in or out the map is zoomed. This is where the resolution independence comes from.
    float pixel = fwidth(texel.x);

    // Push the edge out by the anti-aliasing band when the stamp is meant to fill its cell.
    //
    // At exactly 1.0 the box edge lands *on* the cell edge, where the smoothstep is halfway — so
    // every cell drew its border at 50% and two neighbours never summed to a solid one. That is the
    // pale grid between pixels, and it reads as a seam wherever a hidden colour leaves a hole beside
    // a drawn one.
    //
    // Growing it is free: the fragment already belongs to exactly one cell, so a stamp reaching past
    // its own boundary is simply not sampled there. The band moves outside the cell, the edge inside
    // it is solid, and a stamp asked to be smaller than its cell is untouched.
    float outset = u_stampSize >= 1.0 ? pixel : 0.0;
    float half_ = u_stampSize * 0.5 + outset;
    float radius = u_stampRadius * (u_stampSize * 0.5);
    float distance = roundedBox(point, vec2(half_), radius);
    coverage = 1.0 - smoothstep(-pixel * 0.5, pixel * 0.5, distance);
    if (coverage <= 0.0) discard;
  }

  float alpha = coverage * u_opacity * u_fade * entry.a;
  // Premultiplied, to match the blend mode MapLibre leaves set.
  fragColor = vec4(entry.rgb * alpha, alpha);
}
`
