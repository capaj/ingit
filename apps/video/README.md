# ingit social promo

A deterministic 48-second vertical Remotion promo built from the recordings in `video-showcase/`, with an extra second on every feature and a 13-second fully static final CTA hold after all copy has appeared.

```sh
# Interactive timeline and live editing
bun run --filter @ingit/video studio

# Representative PNG frame
bun run --filter @ingit/video still

# Final 1080x1920 H.264 + AAC render
bun run --filter @ingit/video render
```

The asset step runs automatically before previewing or rendering. It copies the latest showcase clips into Remotion's local `public/` directory and regenerates the soundtrack, including the beat, transitions, UI clicks, graph pings, typing, and CTA resolve. Generated assets and renders are ignored by git.

The main creative controls are:

- `src/timing.ts` — duration and scene boundaries
- `src/IngitPromo.tsx` — copy, colors, crop, speed, graph-node positions, and camera motion
- `scripts/prepare-assets.ts` — soundtrack and sound-effect synthesis
