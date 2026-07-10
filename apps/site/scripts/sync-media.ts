import {cp, mkdir} from 'node:fs/promises'
import {join, resolve} from 'node:path'

const siteRoot = resolve(import.meta.dir, '..')
const repoRoot = resolve(siteRoot, '../..')
const mediaRoot = join(siteRoot, 'public/media')

await mkdir(join(mediaRoot, 'showcase'), {recursive: true})
await mkdir(join(mediaRoot, 'brand'), {recursive: true})

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
])

console.log(`Synced ${showcase.length} showcase videos and the Remotion hero film.`)
