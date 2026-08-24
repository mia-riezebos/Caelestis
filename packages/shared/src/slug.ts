/**
 * How a folder name becomes the segment its path is built from.
 *
 * Shared because it is an agreement, not an implementation detail: the server derives paths with
 * it, and a client that picks names without knowing the rule picks names the server then rejects.
 * `New-folder` and `New folder` are different names and the same segment, so a client checking
 * display names for collisions finds none and gets a path conflict back.
 *
 * Astral characters are replaced rather than kept. SQLite's `length()` counts UTF-16 code units
 * while JavaScript's `[...name].length` counts code points, and paths compared across that gap
 * produced three separate defects. Confined to the BMP the two counts are equal by construction.
 *
 * The name itself keeps every character the caller sent; only the derived segment is narrowed. A
 * name of nothing but astral letters therefore slugs to nothing, which callers must treat as a
 * refusal rather than a segment.
 */
const ASTRAL = /[\u{10000}-\u{10FFFF}]/gu

export const nodeSlug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(ASTRAL, '-')
    .replace(/[^\p{L}\p{N}.]+/gu, '-')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim()
