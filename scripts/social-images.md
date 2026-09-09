# Share images

The frontend serves Open Graph and Twitter summary card metadata in the initial HTML.
Home and folder links use `apps/frontend/static/social/site.png`. On first access, a published
template gets an artwork GIF stored in R2. The daily workflow renders its history and replaces that
object. Requests keep serving the stored GIF during refreshes, including across artwork updates.
The site image remains a fallback if the binding or initial generation is unavailable.

`Refresh share images` runs daily at 07:37 UTC and supports manual dispatch. It reads the public
frontend API and uploads GIFs with the existing `CLOUDFLARE_API_TOKEN` secret. That token needs R2
object write access to `caelestis-blobs`. Deploy the frontend with its `SOCIAL_IMAGES` binding before
dispatching the first generation. The workflow runs from the default branch on its daily schedule.

Render locally without uploading:

```sh
pnpm --filter @caelestis/shared build
node scripts/social-images.mjs --site http://localhost:5173 --template TEMPLATE_ID
```

Use an isolated fixture server for development. Reading production or passing `--publish` requires
the operator's explicit authorization. The output defaults to `.scratch/social-images`.

To refresh the running development frontend's local R2 binding:

```sh
node scripts/social-images.mjs --site http://127.0.0.1:5173 --template TEMPLATE_ID --publish --local
```

Full history renders in the workflow, outside Worker request limits. Failed refreshes retain the previous
object. Conditional writes prevent a first-image request from replacing an existing GIF.

GIFs use the viewer's 16:9 capture bounds and native pixel sampling. History plays for ten seconds,
followed by five seconds on the latest state. Up to 300 historical frames keep playback within 30 fps.
Large captures use fewer frames to keep source image reads and decodes within 4,096 per template,
including the final state. Both history endpoints remain present.
GIF timing distributes 10 ms ticks across the history, preserving its duration even if size limits
require fewer frames. Without history, the GIF holds only the latest state.
Real OpenStreetMap tiles remain visible through transparent and
unobserved canvas pixels. Every frame includes map attribution. The Worker caches map tiles in R2;
the CLI uses `.scratch/social-images/.osm`, retained between workflow runs. Both cache for seven days
and identify the renderer in tile requests. Finished templates end at their archived history.
Imported observations join native history, with native buckets taking precedence and missing coverage
revealing the map. Before observations exist, the stored first GIF shows the template artwork.
The renderer reduces the frame count if needed to stay below 4.5 MB. A template failure preserves
its previous image, lets other templates finish, and fails the workflow visibly.

Each season and template has one replaceable R2 object under `social/v2/`. Byte-identical
outputs skip uploading. Metadata uses the object's ETag as its image URL version. The serving route
checks the current manifest, so old links cannot retrieve deleted or unpublished template images.
Already copied images in Discord or other platforms remain subject to those platforms' caching.
Animation and autoplay depend on the receiving platform and the reader's settings.

Validate the deployed template URL in Discord before claiming animated unfurl support. Local HTML
and GIF checks cannot prove what Discord's crawler and client will display. Twitter receives the
same GIF as `twitter:image`; a platform that uses only its first frame gets the earliest sampled state.

Regenerate the committed site PNG after editing its SVG:

```sh
node --input-type=module -e 'import sharp from "sharp"; await sharp("apps/frontend/static/social/site.svg").png().toFile("apps/frontend/static/social/site.png")'
```
