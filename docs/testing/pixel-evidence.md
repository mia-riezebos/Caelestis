# Pixel accounting evidence

`apps/userscript/test/pixel-contracts.test.ts` protects the outcomes a painter sees when template,
committed, draft, and display-filter pixels meet.

| Contract | Evidence |
| --- | --- |
| Transparent template pixels assert nothing. | They produce no marker or progress entry. |
| Hidden colours stay in progress. | Their markers are omitted while their completed, wrong, and unpainted counts remain. |
| Drafts override committed pixels. | A drafted Transparent pixel is wrong even over a matching committed colour. |
| Draft removal is observed. | A dirty crosshair patch is rescanned and no longer reports its removed offset. |
| Artwork capture retains template data below transparent committed art. | Known committed colours replace it; committed transparency does not. |
| Per-template colour ownership reaches rendering. | The palette alpha hides its selected index and leaves another index visible. |

Run the focused contract with `pnpm --filter @caelestis/userscript test test/pixel-contracts.test.ts`.
The browser-only production-boundary check separately exercises the real Worker transfer, cache, and
forget lifecycle; this suite does not duplicate that infrastructure.
