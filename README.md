# Caelestis

[![Install userscript](https://img.shields.io/badge/Install-userscript-6d28d9)](https://github.com/mia-cx/Caelestis/releases/latest/download/caelestis.user.js)
[![Userscript downloads](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/mia-cx/Caelestis/main/badges/userscript-downloads.json)](https://github.com/mia-cx/Caelestis/releases)
[![Discord server](https://img.shields.io/discord/1157300973618872411?label=Discord&logo=discord&logoColor=white)](https://discord.gg/thequilt)
[![Latest release](https://img.shields.io/github/v/release/mia-cx/Caelestis?label=latest%20release)](https://github.com/mia-cx/Caelestis/releases/latest)
[![Userscript CI](https://github.com/mia-cx/Caelestis/actions/workflows/userscript-ci.yml/badge.svg)](https://github.com/mia-cx/Caelestis/actions/workflows/userscript-ci.yml)

https://github.com/user-attachments/assets/3cf4473d-d0cc-4b05-a60d-8f0f7f8d8ab1

Caelestis adds image templates and painting tools to [Wplace](https://wplace.live).
Place your artwork on the map, adjust how the overlay looks, and find the pixels that still need painting.

Local templates work without a server. Connect to a server to share artwork and progress with a group.
Its web dashboard shows templates, contributions, and timelapses outside Wplace.

## Install

1. Install [Violentmonkey](https://violentmonkey.github.io/get-it/) or [Tampermonkey](https://www.tampermonkey.net/).
2. Open [the Caelestis installer](https://github.com/mia-cx/Caelestis/releases/latest/download/caelestis.user.js) and confirm **Install** in your userscript manager.
3. Open or reload [Wplace](https://wplace.live). Click the Caelestis map button to open the template panel.

The [installation guide](https://github.com/mia-cx/Caelestis/wiki/Install-the-userscript) includes browser settings and screenshots.
Then follow [Getting started](https://github.com/mia-cx/Caelestis/wiki/Getting-started) to import and place your first template.

## Templates

Import PNG images, Blue Marble exports, or native `.wplace` files. Organise them with folders,
tags, search, and filters. Caelestis also reads Wplace's personal and alliance templates.

Local artwork stays in this browser. Export a copy before clearing browser storage.

![The Caelestis template tree beside a placed Wplace overlay.](docs/assets/readme/templates-and-overlay.png)

## Painting

Choose full, corner, or small overlay pixels, then adjust their size, rounding, opacity, and outlines.
These controls change how the overlay looks, not the stored artwork.

Mark mismatches or work for the selected colour, and navigate to unfinished pixels.
Press `Shift+/` for your current keyboard shortcuts.

![The Wplace colour palette with Caelestis remaining-work markers.](docs/assets/readme/colour-work.png)

## Paint with a group

Connect to a group's server to use its shared templates and per-colour progress.
Painters can share their viewports and drafts, and draw claims around areas they plan to paint.
Activity reports, tile sharing, and presence have separate settings.

The dashboard shows recorded progress, painting pace, contributions, and timelapses.

![A server template with timelapse and progress controls.](docs/assets/readme/dashboard-timelapse.png)

## Run your own server

The backend stores shared artwork and progress. The frontend serves the dashboard.
Run both with [Docker](https://github.com/mia-cx/Caelestis/wiki/Run-with-Docker)
or [Cloudflare](https://github.com/mia-cx/Caelestis/wiki/Deploy-on-Cloudflare).

Docker uses SQLite and filesystem storage by default. The [self-hosting guides](https://github.com/mia-cx/Caelestis/wiki/Self-hosting)
also cover PostgreSQL, MariaDB, CNPG, S3, and Kubernetes.

## Guides

| Task | Guide |
| --- | --- |
| Import and organise artwork | [Templates](https://github.com/mia-cx/Caelestis/wiki/Templates) |
| Adjust pixels, outlines, and markers | [Overlay and painting](https://github.com/mia-cx/Caelestis/wiki/Overlay-and-painting) |
| Join a group's server | [Connect to a server](https://github.com/mia-cx/Caelestis/wiki/Connect-to-a-server) |
| Change sharing or keyboard bindings | [Settings and shortcuts](https://github.com/mia-cx/Caelestis/wiki/Settings-and-shortcuts) |
| Fix a problem | [Troubleshooting](https://github.com/mia-cx/Caelestis/wiki/Troubleshooting) |

## Project links

- [Wiki](https://github.com/mia-cx/Caelestis/wiki)
- [Dashboard](https://caelestis.mia.cx)
- [Releases](https://github.com/mia-cx/Caelestis/releases)
- [The Quilt Discord](https://discord.gg/thequilt)
- [Issue tracker](https://github.com/mia-cx/Caelestis/issues)

## Contribute

Read the [contribution guide](CONTRIBUTING.md) before opening a pull request. Use the
[issue forms](https://github.com/mia-cx/Caelestis/issues/new/choose) for bugs and feature
ideas. Report vulnerabilities through the [security process](SECURITY.md), not a public issue.
