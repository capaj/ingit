import type { ProfilerOnRenderCallback } from 'react'

export interface ClientPerformanceSnapshot {
  storePublications: number
  graphInputPublications: number
  graphCommits: number
  graphRenderMs: number
  graphMaxRenderMs: number
}

const metrics: ClientPerformanceSnapshot = {
  storePublications: 0,
  graphInputPublications: 0,
  graphCommits: 0,
  graphRenderMs: 0,
  graphMaxRenderMs: 0,
}

export function recordStorePublication(graphInputsChanged: boolean): void {
  if (!import.meta.env.DEV) return
  metrics.storePublications++
  if (graphInputsChanged) metrics.graphInputPublications++
}

export const recordGraphRender: ProfilerOnRenderCallback = (
  _id,
  _phase,
  actualDuration,
) => {
  if (!import.meta.env.DEV) return
  metrics.graphCommits++
  metrics.graphRenderMs += actualDuration
  metrics.graphMaxRenderMs = Math.max(metrics.graphMaxRenderMs, actualDuration)
}

export function getClientPerformanceSnapshot(): ClientPerformanceSnapshot {
  return { ...metrics }
}

export function resetClientPerformanceMetrics(): void {
  metrics.storePublications = 0
  metrics.graphInputPublications = 0
  metrics.graphCommits = 0
  metrics.graphRenderMs = 0
  metrics.graphMaxRenderMs = 0
}

declare global {
  interface Window {
    __INGIT_PERFORMANCE__?: {
      snapshot: typeof getClientPerformanceSnapshot
      reset: typeof resetClientPerformanceMetrics
    }
  }
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__INGIT_PERFORMANCE__ = {
    snapshot: getClientPerformanceSnapshot,
    reset: resetClientPerformanceMetrics,
  }
}
