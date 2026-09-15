# Userscript live lifecycle

`apps/userscript/test/live-lifecycle.test.ts` drives the installed sync coordinator with the real
userscript state and a typed WebSocket fake. The fake is the network boundary. Vitest's fake clock
controls reconnect and heartbeat timers.

The case proves a server can negotiate v2, send its initial state vector, close, reconnect as v1,
and refresh the divergent world manifest. It also sends a manifest frame from the retired socket.
The coordinator ignores it, so only the current socket's correction starts the refresh.

Run it with:

```sh
pnpm --dir apps/userscript exec vitest run test/live-lifecycle.test.ts
```
