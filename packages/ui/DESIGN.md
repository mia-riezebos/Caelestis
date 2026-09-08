# Shared shape

Every rectangular Caelestis surface and control uses `--caelestis-radius`, including menus, popovers, panels, cards, fields, and buttons. Its default `calc(0.7rem + 1px)` preserves the template context menu's established radius. The userscript theme and frontend DaisyUI/Tailwind tokens use the same value.

Circular buttons stay circular. Dots and circular colour markers retain their shape. Flush edges in joined regions remain square. Do not introduce separate radius scales or derive a different radius for inset controls.

# Icons

Glyphs are Material Symbols, the family wplace renders, taken from Iconify's per-icon modules in `@iconify-icons/material-symbols`. `foundations/icons.ts` names each glyph once and `Icon.svelte` is the only place icon SVG is rendered. Filled variants are the default, matching wplace's rail; `-outline` variants are reserved for glyphs that lose their meaning filled at 16px, such as edit, delete, upload file, and the sidebar. Do not paste path data into components.
