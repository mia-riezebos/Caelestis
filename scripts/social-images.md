# Share images

The frontend serves Open Graph and Twitter summary card metadata in the initial HTML.
Home and folder links use `apps/frontend/static/social/site.png`. Template links use the latest
generated GIF, falling back to the site image when there are no snapshots or no generated file.

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

GIFs use the viewer's 16:9 capture bounds, native pixel sampling, at most 32 historical frames,
and a latest-snapshot poster. Blank and unobserved canvas pixels use a neutral background.
There is no template overlay or external basemap. Finished templates end at their archived history.
The renderer reduces the frame count if needed to stay below 4.5 MB. A template failure preserves
its previous image, lets other templates finish, and fails the workflow visibly.

Each season and artwork version has one replaceable R2 object under `social/v1/`. Byte-identical
outputs skip uploading. Metadata uses the object's ETag as its image URL version. The serving route
checks the current manifest, so old links cannot retrieve deleted or unpublished template images.
Already copied images in Discord or other platforms remain subject to those platforms' caching.
Animation and autoplay depend on the receiving platform and the reader's settings.

Validate the deployed template URL in Discord before claiming animated unfurl support. Local HTML
and GIF checks cannot prove what Discord's crawler and client will display. Twitter receives the
same GIF as `twitter:image`; a platform that uses only its first frame gets the latest snapshot.

Regenerate the committed site PNG after editing its SVG:

```sh
node --input-type=module -e 'import sharp from "sharp"; await sharp("apps/frontend/static/social/site.svg").png().toFile("apps/frontend/static/social/site.png")'
```
