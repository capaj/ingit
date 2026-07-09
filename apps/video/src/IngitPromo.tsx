import type {ReactNode} from 'react'
import {Audio, Video} from '@remotion/media'
import {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion'
import {
  DURATION_IN_FRAMES,
  FEATURE_COUNT,
  FEATURE_FRAMES,
  INTRO_FRAMES,
  OUTRO_FRAMES,
  OUTRO_REVEAL_FRAMES,
  OUTRO_START,
  TRAVEL_FRAMES,
} from './timing'

const palette = {
  base: '#11111b',
  surface: '#1e1e2e',
  text: '#cdd6f4',
  muted: '#7f849c',
  blue: '#89b4fa',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  pink: '#f38ba8',
  mauve: '#cba6f7',
  teal: '#94e2d5',
  peach: '#fab387',
}

type Feature = {
  kicker: string
  title: string
  emphasis: string
  clip: string
  poster: string
  accent: string
  trimSeconds: number
  playbackRate: number
}

const features: Feature[] = [
  {
    kicker: 'SWITCH BRANCHES',
    title: 'Change context.',
    emphasis: 'Keep your bearings.',
    clip: '01-switch-branches.mp4',
    poster: '01-switch-branches.jpg',
    accent: palette.blue,
    trimSeconds: 2.55,
    playbackRate: 1.3,
  },
  {
    kicker: 'MERGE PREVIEW',
    title: 'See the merge',
    emphasis: 'before you make it.',
    clip: '02-merge-preview.mp4',
    poster: '02-merge-preview.jpg',
    accent: palette.green,
    trimSeconds: 2.7,
    playbackRate: 1.5,
  },
  {
    kicker: 'REBASE',
    title: 'Rewrite history.',
    emphasis: 'Without the dread.',
    clip: '03-rebase-branch.mp4',
    poster: '03-rebase-branch.jpg',
    accent: palette.mauve,
    trimSeconds: 2.85,
    playbackRate: 1.4,
  },
  {
    kicker: 'CHERRY-PICK',
    title: 'Pick the right commit.',
    emphasis: 'Visually.',
    clip: '04-cherry-pick.mp4',
    poster: '04-cherry-pick.jpg',
    accent: palette.pink,
    trimSeconds: 2.8,
    playbackRate: 1.55,
  },
  {
    kicker: 'TIME MACHINE',
    title: 'Lost a commit?',
    emphasis: 'Travel back.',
    clip: '05-time-machine-recover.mp4',
    poster: '05-time-machine-recover.jpg',
    accent: palette.yellow,
    trimSeconds: 2.5,
    playbackRate: 3.15,
  },
  {
    kicker: 'CREATE BRANCH',
    title: 'Branch from',
    emphasis: 'any moment.',
    clip: '06-create-branch.mp4',
    poster: '06-create-branch.jpg',
    accent: palette.teal,
    trimSeconds: 2.65,
    playbackRate: 1.65,
  },
  {
    kicker: 'MOVE BRANCH',
    title: 'Move refs.',
    emphasis: 'Watch history respond.',
    clip: '07-move-branch.mp4',
    poster: '07-move-branch.jpg',
    accent: palette.peach,
    trimSeconds: 2.65,
    playbackRate: 1.6,
  },
]

const clamp = {
  extrapolateLeft: 'clamp' as const,
  extrapolateRight: 'clamp' as const,
}

const easeOut = Easing.bezier(0.16, 1, 0.3, 1)
const easeInOut = Easing.bezier(0.65, 0, 0.35, 1)
const NODE_GAP = 1350
const NODE_TOP = 170
const NODE_X = [-105, 92, -74, 110, -92, 78, -42, 0]
const CTA_INDEX = FEATURE_COUNT
const JOURNEY_FRAMES = FEATURE_FRAMES * FEATURE_COUNT + OUTRO_FRAMES

const nodePoint = (index: number) => ({
  x: NODE_X[index],
  y: NODE_TOP + index * NODE_GAP,
})

const LogoMark = ({size = 150}: {size?: number}) => (
  <svg width={size} height={size} viewBox="0 0 128 128" aria-label="ingit">
    <path d="M64 0V128" fill="none" stroke={palette.text} strokeWidth="7" strokeLinecap="round" />
    <circle cx="64" cy="69" r="32" fill={palette.base} opacity=".7" />
    <circle cx="64" cy="69" r="28" fill={palette.surface} stroke={palette.text} strokeWidth="5" />
    <circle cx="64" cy="69" r="17" fill={palette.surface} />
    <path d="M47 69a17 17 0 0 0 17 17V69Z" fill={palette.green} />
    <path d="M64 69v17a17 17 0 0 0 17-17Z" fill="#f5c2e7" />
    <circle cx="64" cy="69" r="17" fill="none" stroke="#45475a" strokeWidth="4" />
    <path d="M47 69h34" fill="none" stroke={palette.surface} strokeWidth="3" strokeLinecap="round" />
    <path d="M64 52V86" fill="none" stroke="#45475a" strokeWidth="4" strokeLinecap="round" />
  </svg>
)

const CommitNode = ({accent, active}: {accent: string; active: boolean}) => (
  <div
    style={{
      width: 74,
      height: 74,
      borderRadius: '50%',
      padding: 8,
      backgroundColor: palette.surface,
      border: `5px solid ${active ? palette.text : accent}`,
      boxShadow: active ? `0 0 0 12px ${accent}1c, 0 0 48px ${accent}88` : `0 0 24px ${accent}33`,
    }}
  >
    <div style={{width: '100%', height: '100%', borderRadius: '50%', overflow: 'hidden', display: 'grid', gridTemplateColumns: '1fr 1fr'}}>
      <div style={{backgroundColor: accent}} />
      <div style={{backgroundColor: active ? palette.green : '#45475a'}} />
    </div>
  </div>
)

const GraphAtmosphere = () => {
  const frame = useCurrentFrame()
  const visualFrame = Math.min(frame, OUTRO_START + OUTRO_REVEAL_FRAMES)
  const drift = interpolate(visualFrame, [0, DURATION_IN_FRAMES], [-70, 100], clamp)

  return (
    <AbsoluteFill style={{overflow: 'hidden', backgroundColor: palette.base}}>
      <div
        style={{
          position: 'absolute',
          width: 900,
          height: 900,
          left: -360,
          top: -220,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${palette.blue}22 0%, ${palette.blue}00 70%)`,
          opacity: 0.65 + Math.sin(visualFrame / 13) * 0.12,
          translate: `${drift}px ${drift * 0.35}px`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 1100,
          height: 1100,
          right: -580,
          bottom: -400,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${palette.mauve}20 0%, ${palette.mauve}00 70%)`,
          translate: `${-drift * 0.4}px ${-drift * 0.2}px`,
        }}
      />
      {[0, 1, 2, 3, 4].map((index) => (
        <div
          key={index}
          style={{
            position: 'absolute',
            width: index % 2 ? 7 : 11,
            height: index % 2 ? 7 : 11,
            borderRadius: '50%',
            backgroundColor: features[index].accent,
            opacity: 0.28,
            left: 100 + index * 220 + Math.sin((visualFrame + index * 30) / 28) * 35,
            top: ((visualFrame * (1.15 + index * 0.08) + index * 370) % 2100) - 90,
          }}
        />
      ))}
    </AbsoluteFill>
  )
}

const SceneShell = ({children, opacity = 1}: {children: ReactNode; opacity?: number}) => (
  <AbsoluteFill style={{padding: '112px 80px 100px', opacity}}>{children}</AbsoluteFill>
)

const Intro = () => {
  const frame = useCurrentFrame()
  const logoIn = interpolate(frame, [0, 18], [0.72, 1], {...clamp, easing: easeOut})
  const textIn = interpolate(frame, [10, 30], [55, 0], {...clamp, easing: easeOut})
  const exit = interpolate(frame, [INTRO_FRAMES - 12, INTRO_FRAMES], [1, 0], {...clamp, easing: easeInOut})

  return (
    <SceneShell opacity={exit}>
      <div style={{display: 'flex', flexDirection: 'column', justifyContent: 'center', height: '100%', gap: 48}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 24, scale: logoIn, transformOrigin: 'left center'}}>
          <LogoMark size={128} />
          <span style={{fontSize: 64, fontWeight: 800, letterSpacing: '-0.045em', color: palette.text}}>ingit</span>
        </div>
        <div style={{translate: `0 ${textIn}px`, opacity: interpolate(frame, [9, 25], [0, 1], clamp)}}>
          <div style={{fontSize: 104, lineHeight: 0.96, letterSpacing: '-0.06em', fontWeight: 850, color: palette.text}}>Your git workflow.</div>
          <div style={{fontSize: 104, lineHeight: 0.96, letterSpacing: '-0.06em', fontWeight: 850, color: palette.blue, marginTop: 12}}>Finally visible.</div>
        </div>
        <div
          style={{
            width: interpolate(frame, [24, 60], [0, 760], {...clamp, easing: easeOut}),
            height: 4,
            borderRadius: 99,
            background: `linear-gradient(90deg, ${palette.blue}, ${palette.mauve}, ${palette.pink})`,
          }}
        />
      </div>
    </SceneShell>
  )
}

const BrowserFrame = ({feature, children, active}: {feature: Feature; children?: ReactNode; active: boolean}) => (
  <div
    style={{
      position: 'absolute',
      width: 880,
      height: 860,
      left: 120,
      top: 228,
      borderRadius: 32,
      overflow: 'hidden',
      backgroundColor: palette.surface,
      border: `1px solid ${feature.accent}${active ? 'aa' : '44'}`,
      boxShadow: active ? `0 45px 110px #00000099, 0 0 90px ${feature.accent}28` : '0 25px 70px #00000066',
    }}
  >
    <div style={{height: 54, display: 'flex', alignItems: 'center', padding: '0 22px', gap: 9, background: '#181825', borderBottom: '1px solid #313244'}}>
      {[palette.pink, palette.yellow, palette.green].map((color) => <div key={color} style={{width: 12, height: 12, borderRadius: '50%', backgroundColor: color, opacity: 0.88}} />)}
      <div style={{height: 24, flex: 1, marginLeft: 15, borderRadius: 8, backgroundColor: '#242437', display: 'flex', alignItems: 'center', justifyContent: 'center', color: palette.muted, fontSize: 13}}>
        localhost:8488 · ingit
      </div>
    </div>
    <div style={{position: 'relative', height: 806, overflow: 'hidden'}}>
      <Img src={staticFile(feature.poster)} style={{position: 'absolute', height: 806, width: 1290, maxWidth: 'none', left: -205, top: 0, objectFit: 'cover'}} />
      {children}
      <div style={{position: 'absolute', inset: 0, boxShadow: 'inset 0 0 90px #11111b66', pointerEvents: 'none'}} />
    </div>
  </div>
)

const ActiveVideo = ({feature}: {feature: Feature}) => {
  const frame = useCurrentFrame()
  return (
    <>
      <Video
        src={staticFile(feature.clip)}
        muted
        trimBefore={Math.round(feature.trimSeconds * 30)}
        playbackRate={feature.playbackRate}
        objectFit="cover"
        style={{position: 'absolute', height: 806, width: 1290, maxWidth: 'none', left: -205, top: 0}}
      />
      <div
        style={{
          position: 'absolute',
          height: 5,
          left: 0,
          bottom: 0,
          width: `${interpolate(frame, [0, FEATURE_FRAMES], [0, 100], clamp)}%`,
          backgroundColor: feature.accent,
          boxShadow: `0 0 22px ${feature.accent}`,
        }}
      />
    </>
  )
}

const FeatureNode = ({feature, index, active}: {feature: Feature; index: number; active: boolean}) => {
  const point = nodePoint(index)
  return (
    <div style={{position: 'absolute', width: 1080, height: 1210, left: point.x, top: point.y}}>
      <div style={{position: 'absolute', left: 67, top: 5}}><CommitNode accent={feature.accent} active={active} /></div>
      <div style={{position: 'absolute', left: 168, right: 76, top: 0, display: 'flex', flexDirection: 'column', gap: 10}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 18}}>
          <span style={{fontSize: 25, fontWeight: 850, letterSpacing: '0.16em', color: feature.accent}}>{feature.kicker}</span>
          <span style={{fontSize: 24, color: '#585b70', fontWeight: 750}}>{String(index + 1).padStart(2, '0')} / {String(FEATURE_COUNT).padStart(2, '0')}</span>
        </div>
        <div style={{fontSize: 70, lineHeight: 0.98, fontWeight: 850, letterSpacing: '-0.055em', color: palette.text}}>
          {feature.title} <span style={{color: feature.accent}}>{feature.emphasis}</span>
        </div>
      </div>
      <BrowserFrame feature={feature} active={active}>
        <Sequence from={index * FEATURE_FRAMES} durationInFrames={FEATURE_FRAMES} layout="none">
          <ActiveVideo feature={feature} />
        </Sequence>
      </BrowserFrame>
      <div style={{position: 'absolute', left: 152, top: 1135, display: 'flex', alignItems: 'center', gap: 18}}>
        <div style={{height: 2, width: 150, backgroundColor: feature.accent}} />
        <div style={{fontSize: 23, color: palette.muted, letterSpacing: '0.04em'}}>REAL GIT · INSTANT FEEDBACK</div>
      </div>
    </div>
  )
}

const connectorPath = (index: number) => {
  const from = nodePoint(index)
  const to = nodePoint(index + 1)
  const x1 = from.x + 104
  const y1 = from.y + 42
  const x2 = to.x + 104
  const y2 = to.y + 42
  const bend = (y2 - y1) * 0.48
  return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`
}

const GraphRail = ({activeIndex, travel}: {activeIndex: number; travel: number}) => (
  <svg
    width="1320"
    height={nodePoint(CTA_INDEX).y + 900}
    viewBox={`-120 0 1320 ${nodePoint(CTA_INDEX).y + 900}`}
    style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}
  >
    {Array.from({length: FEATURE_COUNT}, (_, index) => {
      const color = index + 1 < FEATURE_COUNT ? features[index + 1].accent : palette.blue
      const reveal = index < activeIndex ? 0 : index === activeIndex ? 1 - travel : 1
      return (
        <g key={index}>
          <path d={connectorPath(index)} fill="none" stroke="#313244" strokeWidth="11" strokeLinecap="round" opacity="0.75" />
          <path
            d={connectorPath(index)}
            pathLength={1}
            fill="none"
            stroke={color}
            strokeWidth={index === activeIndex ? 7 : 5}
            strokeLinecap="round"
            strokeDasharray="1"
            strokeDashoffset={reveal}
            opacity={index <= activeIndex ? 0.9 : 0.22}
          />
        </g>
      )
    })}
  </svg>
)

const TypedLine = ({text, from, color = palette.text}: {text: string; from: number; color?: string}) => {
  const frame = useCurrentFrame()
  const count = Math.floor(interpolate(frame, [from, from + text.length * 1.25], [0, text.length], clamp))
  const cursorVisible = frame >= from && Math.floor((frame - from) / 9) % 2 === 0
  return (
    <div style={{fontSize: 37, lineHeight: 1.55, color, fontFamily: '"DejaVu Sans Mono", "Liberation Mono", monospace', whiteSpace: 'pre'}}>
      <span style={{color: palette.green}}>$ </span>{text.slice(0, count)}{cursorVisible && count < text.length ? <span style={{color: palette.blue}}>▌</span> : null}
    </div>
  )
}

const LiveTerminal = () => {
  const frame = useCurrentFrame()
  const sentenceOpacity = interpolate(frame, [150, 165], [0, 1], clamp)
  const emojiProgress = interpolate(frame, [178, 190], [0, 1], {...clamp, easing: easeOut})
  return (
    <>
      <div style={{padding: '36px 40px 40px'}}>
        <TypedLine text="npm install -g @ingit/cli" from={44} />
        <TypedLine text="ingit" from={91} color={palette.blue} />
      </div>
      <div style={{position: 'absolute', top: 620, left: 0, width: 880, textAlign: 'center', fontSize: 31, color: palette.blue, fontWeight: 750, opacity: interpolate(frame, [115, 135], [0, 1], clamp)}}>
        github.com/capaj/ingit
      </div>
      <div style={{position: 'absolute', top: 680, left: -20, width: 920, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontSize: 28, lineHeight: 1.25, color: palette.muted, fontWeight: 650, opacity: sentenceOpacity}}>
        <span>it&apos;s</span>
        <span
          style={{
            display: 'inline-flex',
            width: 42 * emojiProgress,
            marginLeft: 7 * emojiProgress,
            marginRight: 7 * emojiProgress,
            opacity: emojiProgress,
            scale: interpolate(emojiProgress, [0, 0.7, 1], [0.2, 1.25, 1], clamp),
            transformOrigin: 'center',
            overflow: 'visible',
            justifyContent: 'center',
          }}
        >
          💯
        </span>
        <span>vibecoded slop, including this video</span>
      </div>
    </>
  )
}

const CtaNode = ({active}: {active: boolean}) => {
  const point = nodePoint(CTA_INDEX)
  return (
    <div style={{position: 'absolute', width: 1080, height: 1200, left: point.x, top: point.y}}>
      <div style={{position: 'absolute', left: 67, top: 5}}><CommitNode accent={palette.blue} active={active} /></div>
      <div style={{position: 'absolute', left: 168, top: 12, fontSize: 26, fontWeight: 850, letterSpacing: '0.16em', color: palette.blue}}>READY TO SHIP</div>
      <div style={{position: 'absolute', top: 125, left: 0, width: 1080, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center'}}>
        <LogoMark size={150} />
        <div style={{fontSize: 100, lineHeight: 0.96, fontWeight: 850, letterSpacing: '-0.06em', color: palette.text, marginTop: 30}}>Make git click.</div>
        <div style={{fontSize: 39, lineHeight: 1.25, color: palette.muted, marginTop: 22}}>No daemon. No database. Just your repo.</div>
        <div style={{position: 'relative', marginTop: 64, width: 880, height: 260, borderRadius: 28, overflow: 'visible', border: '1px solid #45475a', backgroundColor: '#181825', boxShadow: `0 40px 100px #00000088, 0 0 80px ${palette.blue}20`, textAlign: 'left'}}>
          <div style={{height: 55, padding: '0 22px', display: 'flex', alignItems: 'center', gap: 9, borderBottom: '1px solid #313244'}}>
            {[palette.pink, palette.yellow, palette.green].map((color) => <div key={color} style={{width: 12, height: 12, borderRadius: '50%', backgroundColor: color}} />)}
            <div style={{marginLeft: 'auto', marginRight: 'auto', color: palette.muted, fontSize: 17}}>terminal</div>
          </div>
          <Sequence from={FEATURE_COUNT * FEATURE_FRAMES} durationInFrames={OUTRO_FRAMES} layout="none">
            <LiveTerminal />
          </Sequence>
        </div>
      </div>
    </div>
  )
}

const GraphJourney = () => {
  const frame = useCurrentFrame()
  const activeIndex = Math.min(FEATURE_COUNT, Math.floor(frame / FEATURE_FRAMES))
  const featureIndex = Math.min(FEATURE_COUNT - 1, activeIndex)
  const featureFrame = frame - featureIndex * FEATURE_FRAMES
  const travel = activeIndex === CTA_INDEX
    ? 1
    : interpolate(featureFrame, [FEATURE_FRAMES - TRAVEL_FRAMES, FEATURE_FRAMES - 1], [0, 1], {...clamp, easing: easeInOut})
  const from = nodePoint(featureIndex)
  const to = nodePoint(Math.min(featureIndex + 1, CTA_INDEX))
  const cameraX = interpolate(travel, [0, 1], [from.x, to.x], clamp)
  const cameraY = interpolate(travel, [0, 1], [from.y, to.y], clamp)
  const travelZoom = activeIndex === CTA_INDEX ? 1 : interpolate(travel, [0, 0.5, 1], [1, 0.93, 1], clamp)
  const enter = interpolate(frame, [0, 10], [0, 1], {...clamp, easing: easeOut})

  return (
    <AbsoluteFill style={{overflow: 'hidden', opacity: enter}}>
      <div
        style={{
          position: 'absolute',
          width: 1080,
          height: nodePoint(CTA_INDEX).y + 1350,
          left: 0,
          top: 0,
          translate: `${-cameraX}px ${118 - cameraY}px`,
          scale: travelZoom,
          transformOrigin: `540px ${cameraY + 840}px`,
        }}
      >
        <GraphRail activeIndex={featureIndex} travel={travel} />
        {features.map((feature, index) => <FeatureNode key={feature.clip} feature={feature} index={index} active={activeIndex === index} />)}
        <CtaNode active={activeIndex === CTA_INDEX} />
      </div>
      <div style={{position: 'absolute', inset: 0, pointerEvents: 'none', boxShadow: 'inset 0 160px 160px -150px #11111b, inset 0 -180px 180px -150px #11111b'}} />
    </AbsoluteFill>
  )
}

export const IngitPromo = () => (
  <AbsoluteFill style={{fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'}}>
    <GraphAtmosphere />
    <Audio src={staticFile('ingit-soundtrack.wav')} volume={0.88} />
    <Sequence durationInFrames={INTRO_FRAMES}><Intro /></Sequence>
    <Sequence from={INTRO_FRAMES} durationInFrames={JOURNEY_FRAMES}><GraphJourney /></Sequence>
  </AbsoluteFill>
)
