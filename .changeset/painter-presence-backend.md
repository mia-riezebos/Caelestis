---
'@caelestis/backend': minor
---

Add the live painter presence socket at `/telemetry/presence`, its headcount at `GET /telemetry/presence/online` so clients can pick the least crowded server before opening a socket, and persisted region claims under `/work/regions`.
