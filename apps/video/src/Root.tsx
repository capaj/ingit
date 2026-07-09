import {Composition} from 'remotion'
import {IngitPromo} from './IngitPromo'
import {DURATION_IN_FRAMES, FPS} from './timing'

export const RemotionRoot = () => (
  <Composition
    id="IngitPromo"
    component={IngitPromo}
    durationInFrames={DURATION_IN_FRAMES}
    fps={FPS}
    width={1080}
    height={1920}
  />
)
