# wplace-template-server

A self-hostable server that hosts wplace.live templates for an alliance, plus a userscript that
overlays them on the canvas. A userscript can connect to several servers at once; each server
exposes its own tree of groups and templates, individually toggleable.

## Layout

```
apps/
  backend/       Hono API — manifest, chunks, telemetry, auth
  userscript/    Violentmonkey userscript — tile interception, rendering, UI
  frontend/      SvelteKit dashboard — stub, deferred (see the map)
packages/
  shared/        wire contract: manifest, chunk, and telemetry types
  ui/            web components shared by userscript and frontend — stub
```

## Planning

This project is planned as a Wayfinder map. The map and its tickets live in `.scratch/v1/` and are
mirrored to GitHub issues.

- Map: [#1](https://github.com/mia-riezebos/wplace-template-server/issues/1)
- Working copy: [`.scratch/v1/map.md`](.scratch/v1/map.md)

Decisions belong in their ticket, not in this README.

## Getting started

```sh
pnpm install
pnpm build
```

Userscript releases use Changesets. See [Userscript releases](docs/userscript-releases.md).

## Status

Scaffold only. The backend runtime is undecided — see
[Runtime & storage platform #12](https://github.com/mia-riezebos/wplace-template-server/issues/12).
