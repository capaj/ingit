import type { HistoryWindowResponse } from '@ingit/rpc-contract'

export function shouldRequestMoreHistory(
  scrollTop: number,
  clientHeight: number,
  loadedContentHeight: number,
): boolean {
  return scrollTop + clientHeight >= loadedContentHeight / 2
}

export function shouldApplyCommitScrollRequest(
  lastAppliedKey: number | null,
  requestKey: number,
  targetAvailable: boolean,
): boolean {
  return targetAvailable && lastAppliedKey !== requestKey
}

export function mergeHistory(
  previous: HistoryWindowResponse | null,
  incoming: HistoryWindowResponse,
): HistoryWindowResponse {
  if (!previous) return incoming

  // Pagination requests an expanded prefix from --all. Prefer that complete
  // response so lanes and edges are recalculated consistently across pages.
  const extendsPreviousPrefix = previous.rows.every(
    (row, index) => incoming.rows[index]?.sha === row.sha,
  )
  if (extendsPreviousPrefix) return incoming

  const existingShas = new Set(previous.rows.map((row) => row.sha))
  const newRows = incoming.rows.filter((row) => !existingShas.has(row.sha))
  if (newRows.length === 0) {
    return { ...previous, hasMoreAfter: incoming.hasMoreAfter }
  }

  return {
    ...incoming,
    rows: [...previous.rows, ...newRows],
    edges: [...previous.edges, ...incoming.edges],
    hasMoreBefore: previous.hasMoreBefore,
  }
}
