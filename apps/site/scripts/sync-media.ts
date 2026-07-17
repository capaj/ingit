import {cp, mkdir} from 'node:fs/promises'
import {join, resolve} from 'node:path'

const siteRoot = resolve(import.meta.dir, '..')
const repoRoot = resolve(siteRoot, '../..')
const mediaRoot = join(siteRoot, 'public/media')

await mkdir(join(mediaRoot, 'showcase'), {recursive: true})
await mkdir(join(mediaRoot, 'brand'), {recursive: true})
await mkdir(join(mediaRoot, 'product'), {recursive: true})

const showcase = [
  '01-switch-branches',
  '02-merge-preview',
  '03-rebase-branch',
  '04-cherry-pick',
  '05-time-machine-recover',
  '06-create-branch',
  '07-move-branch',
]

await Promise.all([
  ...showcase.flatMap((name) => [
    cp(join(repoRoot, `video-showcase/${name}.mp4`), join(mediaRoot, `showcase/${name}.mp4`)),
    cp(join(repoRoot, `video-showcase/${name}.jpg`), join(mediaRoot, `showcase/${name}.jpg`)),
  ]),
  cp(
    join(repoRoot, 'apps/video/out/ingit-promo-vertical.mp4'),
    join(mediaRoot, 'ingit-promo-vertical.mp4'),
  ),
  cp(
    join(repoRoot, 'apps/video/out/ingit-promo-preview.png'),
    join(mediaRoot, 'ingit-promo-preview.png'),
  ),
  cp(
    join(repoRoot, 'apps/client/public/press-kit/ingit-icon-transparent.svg'),
    join(mediaRoot, 'brand/ingit-icon.svg'),
  ),
  cp(
    join(repoRoot, 'apps/client/public/press-kit/favicon/favicon.svg'),
    join(siteRoot, 'public/favicon.svg'),
  ),
  cp(
    join(repoRoot, 'apps/client/public/press-kit/png/dark/ingit-icon-180.png'),
    join(siteRoot, 'public/apple-touch-icon.png'),
  ),
  cp(
    join(repoRoot, 'apps/client/public/press-kit/png/dark/ingit-icon-192.png'),
    join(siteRoot, 'public/icon-192.png'),
  ),
  cp(
    join(repoRoot, 'apps/client/public/press-kit/png/dark/ingit-icon-512.png'),
    join(siteRoot, 'public/icon-512.png'),
  ),
  cp(
    join(siteRoot, 'assets/product-screenshots/linked-worktrees.png'),
    join(mediaRoot, 'product/linked-worktrees.png'),
  ),
  cp(
    join(siteRoot, 'assets/product-screenshots/stash-detail.png'),
    join(mediaRoot, 'product/stash-detail.png'),
  ),
  cp(
    join(siteRoot, 'assets/product-screenshots/finishing-flow.png'),
    join(mediaRoot, 'product/finishing-flow.png'),
  ),
])

console.log(`Synced ${showcase.length} showcase videos, 3 product screenshots, and the Remotion hero film.`)
