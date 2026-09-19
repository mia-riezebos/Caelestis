---
'@caelestis/backend': patch
---

Durable jobs now claim a fenced, renewable lease before they run, so several processes sharing one database run each job once. Existing coordinator databases migrate in place on startup.
