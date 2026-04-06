import { dlopen, FFIType, ptr, type Pointer } from 'bun:ffi'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'libziggit.so')

const BUFFER_SIZE = 1024 * 64 // 64KB for most operations

const lib = dlopen(LIB_PATH, {
  ziggit_repo_open: {
    args: [FFIType.cstring],
    returns: FFIType.ptr,
  },
  ziggit_repo_close: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  ziggit_rev_parse_head: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ziggit_rev_parse_head_fast: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ziggit_is_clean: {
    args: [FFIType.ptr],
    returns: FFIType.i32,
  },
  ziggit_status_porcelain: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ziggit_checkout: {
    args: [FFIType.ptr, FFIType.cstring],
    returns: FFIType.i32,
  },
  ziggit_fetch: {
    args: [FFIType.ptr],
    returns: FFIType.i32,
  },
  ziggit_remote_get_url: {
    args: [FFIType.ptr, FFIType.cstring, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ziggit_find_commit: {
    args: [FFIType.ptr, FFIType.cstring, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  ziggit_version: {
    args: [],
    returns: FFIType.cstring,
  },
})

export class ZiggitError extends Error {
  readonly code: number
  constructor(fn: string, code: number) {
    super(`ziggit ${fn} failed with code ${code}`)
    this.name = 'ZiggitError'
    this.code = code
  }
}

function readBuffer(buf: Buffer, rc: number, fn: string): string {
  if (rc < 0) throw new ZiggitError(fn, rc)
  const end = buf.indexOf(0)
  return buf.subarray(0, end === -1 ? undefined : end).toString('utf8')
}

export class ZiggitRepo {
  private handle: Pointer
  private closed = false

  constructor(repoPath: string) {
    const pathBuf = Buffer.from(repoPath + '\0', 'utf8')
    const handle = lib.symbols.ziggit_repo_open(ptr(pathBuf))
    if (!handle) {
      throw new ZiggitError('repo_open', -1)
    }
    this.handle = handle as Pointer
  }

  revParseHead(): string {
    const buf = Buffer.alloc(BUFFER_SIZE)
    const rc = lib.symbols.ziggit_rev_parse_head(this.handle, ptr(buf), BUFFER_SIZE) as number
    return readBuffer(buf, rc, 'rev_parse_head')
  }

  revParseHeadFast(): string {
    const buf = Buffer.alloc(BUFFER_SIZE)
    const rc = lib.symbols.ziggit_rev_parse_head_fast(this.handle, ptr(buf), BUFFER_SIZE) as number
    return readBuffer(buf, rc, 'rev_parse_head_fast')
  }

  isClean(): boolean {
    const rc = lib.symbols.ziggit_is_clean(this.handle) as number
    if (rc < 0) throw new ZiggitError('is_clean', rc)
    return rc === 1
  }

  statusPorcelain(): string {
    const buf = Buffer.alloc(BUFFER_SIZE)
    const rc = lib.symbols.ziggit_status_porcelain(this.handle, ptr(buf), BUFFER_SIZE) as number
    return readBuffer(buf, rc, 'status_porcelain')
  }

  checkout(ref: string): void {
    const refBuf = Buffer.from(ref + '\0', 'utf8')
    const rc = lib.symbols.ziggit_checkout(this.handle, ptr(refBuf)) as number
    if (rc < 0) throw new ZiggitError('checkout', rc)
  }

  fetch(): void {
    const rc = lib.symbols.ziggit_fetch(this.handle) as number
    if (rc < 0) throw new ZiggitError('fetch', rc)
  }

  remoteGetUrl(remoteName: string): string {
    const buf = Buffer.alloc(BUFFER_SIZE)
    const nameBuf = Buffer.from(remoteName + '\0', 'utf8')
    const rc = lib.symbols.ziggit_remote_get_url(this.handle, ptr(nameBuf), ptr(buf), BUFFER_SIZE) as number
    return readBuffer(buf, rc, 'remote_get_url')
  }

  findCommit(committish: string): string {
    const buf = Buffer.alloc(BUFFER_SIZE)
    const cBuf = Buffer.from(committish + '\0', 'utf8')
    const rc = lib.symbols.ziggit_find_commit(this.handle, ptr(cBuf), ptr(buf), BUFFER_SIZE) as number
    return readBuffer(buf, rc, 'find_commit')
  }

  close(): void {
    if (!this.closed) {
      this.closed = true
      lib.symbols.ziggit_repo_close(this.handle)
    }
  }

  static version(): string {
    return String(lib.symbols.ziggit_version())
  }
}
