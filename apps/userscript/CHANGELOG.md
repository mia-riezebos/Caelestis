# @caelestis/userscript

## 0.2.7

### Patch Changes

- c5756b2: Mark only unpainted or mismatched pixels for the selected colour.

## 0.2.6

### Patch Changes

- 4fb0313: Load mismatch markers from server telemetry while keeping local paint updates immediate.

## 0.2.5

### Patch Changes

- 2c63f93: Keep every visible mismatch and selected-colour marker while culling cached marker data outside the viewport.

## 0.2.4

### Patch Changes

- f9f1b9e: Render all server templates that fit the aggregate pixel budget instead of dropping overlays after legacy template and bitmap caps.

## 0.2.3

### Patch Changes

- ea5bbc3: Import templates directly into servers, add configurable selected-colour markers, keep server progress stable while tiles load, and hide local controls with their parent folders.

## 0.2.2

### Patch Changes

- b1a6639: Resize template menus when appearance groups expand and keep pixel-style sliders live while tweening.

## 0.2.1

### Patch Changes

- a922236: Exclude unpublished templates from folder and server progress totals while keeping their individual progress visible.

## 0.2.0

### Minor Changes

- 9a74581: Release the current Caelestis userscript as version 0.2.0.

## 0.1.1

### Patch Changes

- 7da8563: Default origin-only template servers to the `/backend` base path while preserving explicitly configured base paths.

## 0.1.0

### Minor Changes

- 8ae1ce7: Publish the first versioned Caelestis userscript with automatic updates from GitHub Releases.
