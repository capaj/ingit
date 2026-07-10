# ingit website

Astro landing page for ingit. Media is sourced from `video-showcase/`, the Remotion render in `apps/video/out/`, and the client press kit; `sync-media` copies it into the static build automatically.

```sh
# From the repository root
bun run --filter @ingit/site dev
bun run --filter @ingit/site build
```

## Cloudflare Pages

The site is fully static and does not need the Cloudflare Astro adapter.

- Root directory: `apps/site`
- Build command: `bun run build`
- Build output directory: `dist`

For a direct Wrangler upload, authenticate with Cloudflare and run:

```sh
bun run --filter @ingit/site deploy
```
