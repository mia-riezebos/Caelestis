# Import evidence

`apps/userscript/test/import-contract.test.ts` imports the real Blue Marble
`fixtures/berrycamp/wplace-templates/quantized/rooms/prologue/a/__prologue-a.json` fixture.

The test decodes each embedded PNG through the shared codec, reads Blue Marble's centre pixels,
and quantises those pixels independently. It checks the imported placement extent, palette-index
buffer, transparent-pixel count, quantisation report, and a fresh IndexedDB restore.

Run it with:

```sh
pnpm --filter @caelestis/userscript test test/import-contract.test.ts
```
