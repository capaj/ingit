import { execFile } from 'node:child_process';
export class GitCommandError extends Error {
    code;
    stderr;
    args;
    constructor(args, code, stderr) {
        super(`git ${args.join(' ')} exited with code ${code}: ${stderr.trim()}`);
        this.name = 'GitCommandError';
        this.code = code;
        this.stderr = stderr;
        this.args = args;
    }
}
export function runGit(args, cwd, opts = {}) {
    const { timeout = 30000, signal } = opts;
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
        }
        const child = execFile('git', args, { cwd, timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
            if (signal?.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            if (err) {
                const code = err.code;
                const exitCode = typeof code === 'number' ? code : -1;
                // execFile wraps non-zero exit as an error; extract actual exit code
                const exitSignal = err.signal;
                if (exitSignal === 'SIGTERM') {
                    reject(new DOMException('Aborted', 'AbortError'));
                    return;
                }
                const realCode = err.code === 'ETIMEDOUT'
                    ? -1
                    : (err.status ?? exitCode);
                reject(new GitCommandError(args, realCode, stderr));
                return;
            }
            resolve({ stdout: stdout, stderr: stderr, code: 0 });
        });
        if (signal) {
            const onAbort = () => {
                child.kill('SIGTERM');
                reject(new DOMException('Aborted', 'AbortError'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            child.on('close', () => signal.removeEventListener('abort', onAbort));
        }
    });
}
export async function runGitLines(args, cwd, opts = {}) {
    const { stdout } = await runGit(args, cwd, opts);
    return stdout.split('\n').filter((line) => line.length > 0);
}
//# sourceMappingURL=git-command.js.map