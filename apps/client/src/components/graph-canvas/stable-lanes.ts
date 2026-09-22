import type { CommitRow } from '@ingit/rpc-contract'

/** Lane ownership lasts for the open repository, independently of RPC windows. */
export class StableLaneLayout {
  private lanes = new Map<string, number>()
  private continuations = new Map<string, number>()
  private cache = new WeakMap<CommitRow[], CommitRow[]>()

  stabilize(rows: CommitRow[]): CommitRow[] {
    const cached = this.cache.get(rows)
    if (cached) return cached
    if (rows.length === 0) return rows
    const initial = this.lanes.size === 0
    const indices = new Map(rows.map((row, index) => [row.sha, index]))
    const bySha = new Map(rows.map((row) => [row.sha, row]))
    const children = new Map<string, string[]>()
    const mergeStarts = new Map<string, number>()
    for (const [index, row] of rows.entries()) {
      for (const parent of row.parentShas.slice(1)) {
        mergeStarts.set(parent, Math.min(index, mergeStarts.get(parent) ?? index))
      }
      const parent = row.parentShas[0]
      if (!parent) continue
      const siblings = children.get(parent) ?? []
      siblings.push(row.sha)
      children.set(parent, siblings)
    }
    const assigned = new Map<string, number>()
    const remember = (sha: string, lane: number) => {
      assigned.set(sha, lane)
      this.lanes.set(sha, lane)
    }
    for (const row of rows) {
      // Seed the main line, then place side branches by actual occupancy.
      // Server lane numbers are ordering hints, not a minimum gutter distance.
      const lane = initial ? (row.lane === 0 ? 0 : undefined)
        : this.lanes.get(row.sha) ?? this.continuations.get(row.sha)
      if (lane !== undefined) remember(row.sha, lane)
    }

    for (const tip of rows) {
      if (assigned.has(tip.sha)) continue
      const chain: CommitRow[] = []
      const visited = new Set<string>()
      let current: CommitRow | undefined = tip
      while (current && !assigned.has(current.sha) && !visited.has(current.sha)) {
        visited.add(current.sha)
        chain.push(current)
        current = bySha.get(current.parentShas[0])
      }
      const ancestor = current
      const childLanes = (children.get(tip.sha) ?? [])
        .flatMap((sha) => assigned.has(sha) ? [assigned.get(sha)!] : [])
      const continuation = childLanes.includes(0) ? 0 : childLanes[0]
      const preferred = continuation ?? (ancestor ? assigned.get(ancestor.sha) : undefined)
      const start = Math.min(indices.get(tip.sha)!, ...chain.map((row) => mergeStarts.get(row.sha) ?? Infinity))
      const last = chain[chain.length - 1]
      const end = ancestor ? indices.get(ancestor.sha)!
        : last.parentShas.length > 0 ? rows.length : indices.get(last.sha)!

      const overlaps = (from: number, to: number) => (
        Math.max(start, Math.min(from, to)) < Math.min(end, Math.max(from, to))
        || (start === end && Math.min(from, to) < start && Math.max(from, to) > start)
      )
      // A gutter is free only if the entire branch span is clear, including
      // rails between commits and continuations below the loaded page.
      const isClear = (candidate: number) => rows.every((row, index) => {
        if (assigned.get(row.sha) === candidate && row.sha !== ancestor?.sha) {
          if (index >= start && index <= end) return false
          const parentIndex = indices.get(row.parentShas[0])
            ?? (row.parentShas.length > 0 ? rows.length : index)
          if (overlaps(index, parentIndex)) return false
        }
        // Merge edges use the merged parent's rail, even when its next node
        // lies below this candidate branch.
        return row.parentShas.slice(1).every((sha) => {
          const parentIndex = indices.get(sha)
          return assigned.get(sha) !== candidate || parentIndex === undefined || !overlaps(index, parentIndex)
        })
      })
      const side = preferred || tip.lane
      let lane = preferred !== undefined && isClear(preferred) ? preferred : undefined
      // Preserve an available continuation; otherwise take the nearest free
      // gutter on either side. Side preference only breaks equal-distance ties.
      for (let distance = 1; lane === undefined; distance++) {
        const near = side < 0 ? -distance : distance
        if (isClear(near)) lane = near
        else if (isClear(-near)) lane = -near
      }
      for (const row of chain) remember(row.sha, lane)
    }

    // A page boundary is not a branch boundary. Reserve the next first parent
    // even before its metadata is loaded, and keep it across shorter refreshes.
    for (const row of rows) {
      const parent = row.parentShas[0]
      if (parent && !this.lanes.has(parent) && !this.continuations.has(parent)) {
        this.continuations.set(parent, assigned.get(row.sha)!)
      }
    }
    let changed = false
    const result = rows.map((row) => {
      const lane = assigned.get(row.sha)!
      if (lane === row.lane) return row
      changed = true
      return { ...row, lane }
    })
    const stable = changed ? result : rows
    this.cache.set(rows, stable)
    return stable
  }
}
