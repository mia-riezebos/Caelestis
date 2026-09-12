# @caelestis/backend

## 0.4.3

### Patch Changes

- 6021b80: Add caelest.is and backend.caelest.is alongside the existing Caelestis domains.

## 0.4.2

### Patch Changes

- af91052: Stop Eralyon backfill at the first native observation and give native history precedence in charts and timelapses.

## 0.4.1

### Patch Changes

- 5140200: Keep historical progress tied to saved canvas observations instead of recalculating it from current totals and placement reports.

## 0.4.0

### Minor Changes

- 0e5d506: Backfill sparse template timelapse and progress history from Eralyon archives through a userscript admin form.

### Patch Changes

- d6a978d: Attribute backfill D1 queries to their originating requests, including failed operations.
- 10ae980: Keep backfill starts retryable after alarm scheduling failures.

## 0.3.0

### Minor Changes

- e1dd180: Keep each painter's share of every folded telemetry bucket and serve it from `GET /telemetry/painter-history`, so dashboards can draw a painter's pace at the template's precision.
- 51ad3ba: Create, manage, and search tags on local and server folders.
- 1e0b8cb: Create, manage, and search reusable tags for local and server templates.
- 526dda5: Plan and claim shared work under folders and templates, with painter assignments, tags, blockers, live updates, and activity history.

### Patch Changes

- 9d87af0: Claim templates from their context menu and browse active work below the template list.
- 2c54c30: Let multiple painters claim a template independently, with admin assignment and personal release.

## 0.2.0

### Minor Changes

- d277ef2: Accept paint reports and tile uploads over authenticated WebSockets while preserving protocol v1 compatibility.

### Patch Changes

- 836886e: Schedule alarm follow-ups and refresh live alerts after WebSocket tile uploads.

## 0.1.0

### Minor Changes

- c1ac9b5: Establish backend release versioning.
