# Shared shape

Every rectangular Caelestis surface and control uses `--caelestis-radius`, including menus, popovers, panels, cards, fields, and buttons. Its default `calc(0.7rem + 1px)` preserves the template context menu's established radius. The userscript theme and frontend DaisyUI/Tailwind tokens use the same value.

Circular buttons stay circular. Dots and circular colour markers retain their shape. Flush edges in joined regions remain square. Do not introduce separate radius scales or derive a different radius for inset controls.
