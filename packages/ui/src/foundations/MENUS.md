# Menus

Render MenuStyles in components that own a select or menu. Svelte installs its CSS once per
document or shadow root. Use `caelestis-select` on native selects, `caelestis-menu` on custom
menu containers, and `caelestis-menu-item` on their choices.

MenuStyles owns borders, 0.5rem outer corners, 0.25rem option corners, padding, typography,
hover/focus states, and shadows. Component styles own placement and width. Menu corners remain
compact regardless of Wplace's field and card radius settings.

Keep native select, popover, and existing keyboard behavior. Selected marks and action icons
occupy the leading icon column; searchable multi-select lists may retain their trailing checks.

Filter choices, tag suggestions, and claim actions use these same classes. Two-line tag rows
keep their name and owner layout. Forms keep their field layout inside the shared menu container.
