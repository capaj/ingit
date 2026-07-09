import {copyFile, mkdir, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {DURATION_IN_FRAMES, FEATURE_COUNT, FEATURE_FRAMES, FPS, INTRO_FRAMES, OUTRO_START, TRAVEL_FRAMES, featureStart} from '../src/timing'

const appDir = resolve(import.meta.dir, '..')
const repoDir = resolve(appDir, '../..')
const publicDir = join(appDir, 'public')

await mkdir(publicDir, {recursive: true})

for (let index = 1; index <= FEATURE_COUNT; index += 1) {
  const prefix = String(index).padStart(2, '0')
  const names = [
    'switch-branches',
    'merge-preview',
    'rebase-branch',
    'cherry-pick',
    'time-machine-recover',
    'create-branch',
    'move-branch',
  ]
  const base = `${prefix}-${names[index - 1]}`
  for (const extension of ['mp4', 'jpg']) {
    const file = `${base}.${extension}`
    await copyFile(join(repoDir, 'video-showcase', file), join(publicDir, file))
  }
}

const sampleRate = 48_000
const durationSeconds = DURATION_IN_FRAMES / FPS
const sampleCount = Math.ceil(durationSeconds * sampleRate)
const left = new Float64Array(sampleCount)
const right = new Float64Array(sampleCount)

let noiseState = 0x1a2b3c4d
const noise = () => {
  noiseState ^= noiseState << 13
  noiseState ^= noiseState >>> 17
  noiseState ^= noiseState << 5
  return ((noiseState >>> 0) / 0xffffffff) * 2 - 1
}

const addStereo = (time: number, duration: number, synth: (t: number, progress: number) => [number, number]) => {
  const start = Math.max(0, Math.floor(time * sampleRate))
  const end = Math.min(sampleCount, Math.ceil((time + duration) * sampleRate))
  for (let i = start; i < end; i += 1) {
    const t = (i - start) / sampleRate
    const progress = t / duration
    const [l, r] = synth(t, progress)
    left[i] += l
    right[i] += r
  }
}

const pan = (value: number, position: number): [number, number] => [value * (1 - position * 0.35), value * (1 + position * 0.35)]

// Warm pad: slow, restrained chord changes underneath the UI sounds.
const notes = [55, 65.41, 73.42, 49]
const chordSeconds = 4
for (let bar = 0; bar < Math.ceil(durationSeconds / chordSeconds); bar += 1) {
  const frequency = notes[bar % notes.length]
  addStereo(bar * chordSeconds, chordSeconds + 0.4, (t, progress) => {
    const attack = Math.min(1, progress * 7)
    const release = Math.min(1, (1 - progress) * 5)
    const envelope = attack * release * 0.024
    const value = (Math.sin(Math.PI * 2 * frequency * t) + Math.sin(Math.PI * 2 * frequency * 2.01 * t) * 0.32) * envelope
    return [value * 0.96, value * 1.04]
  })
}

// A quieter 84 BPM electronic heartbeat: soft kick and sparse alternating hat.
const bpm = 84
const beatSeconds = 60 / bpm
for (let beat = 0; beat < Math.ceil(durationSeconds / beatSeconds); beat += 1) {
  const time = beat * beatSeconds
  addStereo(time, 0.22, (t) => {
    const frequency = 78 * Math.exp(-t * 12) + 43
    const value = Math.sin(Math.PI * 2 * frequency * t) * Math.exp(-t * 18) * 0.16
    return pan(value, beat % 2 === 0 ? -0.08 : 0.08)
  })
  addStereo(time + beatSeconds / 2, 0.055, (_t, progress) => {
    const value = noise() * Math.exp(-progress * 7) * 0.022
    return pan(value, beat % 2 === 0 ? 0.5 : -0.5)
  })
}

// Logo ignition.
addStereo(0.08, 0.9, (t, progress) => {
  const envelope = Math.sin(Math.PI * progress) ** 1.5
  const value = (Math.sin(Math.PI * 2 * (150 + t * 280) * t) * 0.08 + noise() * 0.012) * envelope
  return [value * (0.7 + progress * 0.3), value * (1 - progress * 0.3)]
})

const transitionFrames = [INTRO_FRAMES, ...Array.from({length: FEATURE_COUNT - 1}, (_, i) => featureStart(i + 1)), OUTRO_START]

for (const [index, frame] of transitionFrames.entries()) {
  const travelDuration = frame === INTRO_FRAMES ? 0.48 : TRAVEL_FRAMES / FPS
  const time = frame / FPS - travelDuration
  // Wide whoosh follows the camera down the connector and opens in stereo.
  addStereo(time, travelDuration + 0.08, (_t, progress) => {
    const sweep = noise() * Math.sin(Math.PI * progress) ** 1.8 * 0.095
    const tone = Math.sin(Math.PI * 2 * (170 + index * 18) * progress) * Math.sin(Math.PI * progress) * 0.032
    return [sweep * (1 - progress * 0.5) + tone, sweep * (0.5 + progress * 0.5) - tone]
  })
  // Tactile landing click when the camera locks onto the next commit-card.
  addStereo(frame / FPS, 0.11, (t) => {
    const value = (noise() * 0.16 + Math.sin(Math.PI * 2 * 1450 * t) * 0.08) * Math.exp(-t * 42)
    return pan(value, index % 2 ? 0.4 : -0.4)
  })
  if (frame !== INTRO_FRAMES) {
    for (let railPing = 0; railPing < 3; railPing += 1) {
      addStereo(time + travelDuration * (0.28 + railPing * 0.22), 0.16, (t) => {
        const value = Math.sin(Math.PI * 2 * (680 + railPing * 190) * t) * Math.exp(-t * 24) * 0.052
        return pan(value, -0.55 + railPing * 0.55)
      })
    }
  }
}

// Graph action pings: click, branch split, and reconciliation sparkle in every feature.
for (let index = 0; index < FEATURE_COUNT; index += 1) {
  const scene = featureStart(index) / FPS
  const action = scene + (index === 4 ? 1.35 : 1.05)
  addStereo(action, 0.09, (t) => {
    const value = Math.sin(Math.PI * 2 * 1850 * t) * Math.exp(-t * 48) * 0.15
    return pan(value, index % 2 ? 0.35 : -0.35)
  })
  for (let ping = 0; ping < 3; ping += 1) {
    addStereo(action + 0.12 + ping * 0.085, 0.32, (t) => {
      const frequency = 520 + index * 34 + ping * 170
      const value = Math.sin(Math.PI * 2 * frequency * t) * Math.exp(-t * 12) * (0.075 - ping * 0.012)
      return pan(value, -0.55 + ping * 0.55)
    })
  }
}

// Terminal keystrokes and final confirmation bloom.
const typingStart = OUTRO_START / FPS + 44 / FPS
const command = 'npm install -g @ingit/cli'
for (let index = 0; index < command.length; index += 1) {
  addStereo(typingStart + index * (1.25 / FPS), 0.025, () => {
    const value = noise() * 0.055
    return pan(value, index % 3 === 0 ? -0.25 : 0.2)
  })
}
const runStart = OUTRO_START / FPS + 91 / FPS
for (let index = 0; index < 5; index += 1) {
  addStereo(runStart + index * (1.25 / FPS), 0.025, () => pan(noise() * 0.055, index % 2 ? 0.2 : -0.2))
}
addStereo(OUTRO_START / FPS + 4.1, 1.45, (t, progress) => {
  const envelope = Math.sin(Math.PI * progress) ** 0.7
  const value = [261.63, 329.63, 392].reduce((sum, frequency) => sum + Math.sin(Math.PI * 2 * frequency * t), 0) * envelope * 0.035
  return [value, value]
})

let peak = 0
for (let i = 0; i < sampleCount; i += 1) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
const gain = peak > 0.92 ? 0.92 / peak : 1

const dataBytes = sampleCount * 2 * 2
const wav = Buffer.alloc(44 + dataBytes)
wav.write('RIFF', 0)
wav.writeUInt32LE(36 + dataBytes, 4)
wav.write('WAVE', 8)
wav.write('fmt ', 12)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(2, 22)
wav.writeUInt32LE(sampleRate, 24)
wav.writeUInt32LE(sampleRate * 4, 28)
wav.writeUInt16LE(4, 32)
wav.writeUInt16LE(16, 34)
wav.write('data', 36)
wav.writeUInt32LE(dataBytes, 40)

for (let i = 0; i < sampleCount; i += 1) {
  // Musical soft limiter: lifts the subtle bed and keeps UI transients crisp
  // without allowing the clicks or kick drum to clip.
  const fadeOut = Math.min(1, (sampleCount - i) / (sampleRate * 1.25))
  const l = Math.tanh(left[i] * gain * 2.8) / Math.tanh(2.8) * 0.92 * fadeOut
  const r = Math.tanh(right[i] * gain * 2.8) / Math.tanh(2.8) * 0.92 * fadeOut
  wav.writeInt16LE(Math.round(l * 32767), 44 + i * 4)
  wav.writeInt16LE(Math.round(r * 32767), 46 + i * 4)
}

const wavBytes = new Uint8Array(wav.buffer as ArrayBuffer, wav.byteOffset, wav.byteLength)
await writeFile(join(publicDir, 'ingit-soundtrack.wav'), wavBytes)

console.log(`Prepared ${FEATURE_COUNT} showcase clips and a ${durationSeconds.toFixed(1)}s procedural soundtrack.`)
