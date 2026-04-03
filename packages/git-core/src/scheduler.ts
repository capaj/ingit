import { runGit, GitRunResult } from './git-command.js'

export type Priority = 'interactive' | 'normal' | 'background'

interface Job {
  args: string[]
  priority: Priority
  signal?: AbortSignal
  resolve: (result: GitRunResult) => void
  reject: (err: unknown) => void
}

const CONCURRENCY: Record<Priority, number> = {
  interactive: 4,
  normal: 2,
  background: 1,
}

export class GitCommandScheduler {
  private readonly cwd: string
  private queues: Record<Priority, Job[]> = {
    interactive: [],
    normal: [],
    background: [],
  }
  private running: Record<Priority, number> = {
    interactive: 0,
    normal: 0,
    background: 0,
  }

  constructor(cwd: string) {
    this.cwd = cwd
  }

  enqueue(job: { args: string[]; priority: Priority; signal?: AbortSignal }): Promise<GitRunResult> {
    return new Promise<GitRunResult>((resolve, reject) => {
      if (job.signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }

      const entry: Job = { ...job, resolve, reject }
      this.queues[job.priority].push(entry)

      if (job.signal) {
        job.signal.addEventListener(
          'abort',
          () => {
            const queue = this.queues[job.priority]
            const idx = queue.indexOf(entry)
            if (idx !== -1) {
              queue.splice(idx, 1)
              reject(new DOMException('Aborted', 'AbortError'))
            }
          },
          { once: true },
        )
      }

      this.drain()
    })
  }

  private drain(): void {
    const priorities: Priority[] = ['interactive', 'normal', 'background']
    for (const priority of priorities) {
      while (
        this.queues[priority].length > 0 &&
        this.running[priority] < CONCURRENCY[priority]
      ) {
        const job = this.queues[priority].shift()!
        this.running[priority]++
        this.runJob(job, priority)
      }
    }
  }

  private runJob(job: Job, priority: Priority): void {
    if (job.signal?.aborted) {
      this.running[priority]--
      job.reject(new DOMException('Aborted', 'AbortError'))
      this.drain()
      return
    }

    runGit(job.args, this.cwd, { signal: job.signal })
      .then((result) => {
        job.resolve(result)
      })
      .catch((err) => {
        job.reject(err)
      })
      .finally(() => {
        this.running[priority]--
        this.drain()
      })
  }
}
