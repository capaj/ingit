import { runGit } from './git-command.js';
const CONCURRENCY = {
    interactive: 4,
    normal: 2,
    background: 1,
};
export class GitCommandScheduler {
    cwd;
    queues = {
        interactive: [],
        normal: [],
        background: [],
    };
    running = {
        interactive: 0,
        normal: 0,
        background: 0,
    };
    constructor(cwd) {
        this.cwd = cwd;
    }
    enqueue(job) {
        return new Promise((resolve, reject) => {
            if (job.signal?.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            const entry = { ...job, resolve, reject };
            this.queues[job.priority].push(entry);
            if (job.signal) {
                job.signal.addEventListener('abort', () => {
                    const queue = this.queues[job.priority];
                    const idx = queue.indexOf(entry);
                    if (idx !== -1) {
                        queue.splice(idx, 1);
                        reject(new DOMException('Aborted', 'AbortError'));
                    }
                }, { once: true });
            }
            this.drain();
        });
    }
    drain() {
        const priorities = ['interactive', 'normal', 'background'];
        for (const priority of priorities) {
            while (this.queues[priority].length > 0 &&
                this.running[priority] < CONCURRENCY[priority]) {
                const job = this.queues[priority].shift();
                this.running[priority]++;
                this.runJob(job, priority);
            }
        }
    }
    runJob(job, priority) {
        if (job.signal?.aborted) {
            this.running[priority]--;
            job.reject(new DOMException('Aborted', 'AbortError'));
            this.drain();
            return;
        }
        runGit(job.args, this.cwd, { signal: job.signal })
            .then((result) => {
            job.resolve(result);
        })
            .catch((err) => {
            job.reject(err);
        })
            .finally(() => {
            this.running[priority]--;
            this.drain();
        });
    }
}
//# sourceMappingURL=scheduler.js.map