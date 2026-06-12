import { dlopen, FFIType, ptr, type Pointer } from 'bun:ffi'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

function getLibraryFilename(): string {
  switch (process.platform) {
    case 'darwin':
      return 'libziggit.dylib'
    case 'linux':
      return 'libziggit.so'
    case 'win32':
      return 'ziggit.dll'
    default:
      throw new Error(`Unsupported platform for ziggit native library: ${process.platform}`)
  }
}

const LIB_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', getLibraryFilename())

const BUFFER_SIZE = 1024 * 64 // 64KB for most operations

const symbols = {
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
} as const

type ZiggitLib = ReturnType<typeof dlopen<typeof symbols>>

let lib: ZiggitLib | null | undefined

function getLib(): ZiggitLib | null {
  if (lib !== undefined) return lib
  if (!existsSync(LIB_PATH)) {
    lib = null
    return null
  }

  lib = dlopen(LIB_PATH, symbols)
  return lib
}

export function isZiggitNativeAvailable(): boolean {
  return getLib() !== null
}

export function getZiggitNativeLibraryPath(): string {
  return LIB_PATH
}

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
    const native = getLib()
    if (!native) {
      throw new Error(`ziggit native library not found for ${process.platform}: ${LIB_PATH}`)
    }

    const pathBuf = Buffer.from(repoPath + '\0', 'utf8')
    const handle = native.symbols.ziggit_repo_open(ptr(pathBuf))
    if (!handle) {
      throw new ZiggitError('repo_open', -1)
    }
    this.handle = handle as Pointer
  }

  revParseHead(): string {
    const buf = Buffer.alloc(BUFFER_SIZE)
    const rc = getRequiredLib().symbols.ziggit_rev_parse_head(this.handle, ptr(buf), BUFFER_SIZE) as number
    return readBuffer(buf, rc, 'rev_parse_head')
  }

  revParseHeadFast(): string {
    const buf = Buffer.alloc(BUFFER_SIZE)
    const rc = getRequiredLib().symbols.ziggit_rev_parse_head_fast(this.handle, ptr(buf), BUFFER_SIZE) as number
    return readBuffer(buf, rc, 'rev_parse_head_fast')
  }

  isClean(): boolean {
    const rc = getRequiredLib().symbols.ziggit_is_clean(this.handle) as number
    if (rc < 0) throw new ZiggitError('is_clean', rc)
    return rc === 1
  }

  statusPorcelain(): string {
    const buf = Buffer.alloc(BUFFER_SIZE)
    const rc = getRequiredLib().symbols.ziggit_status_porcelain(this.handle, ptr(buf), BUFFER_SIZE) as number
    return readBuffer(buf, rc, 'status_porcelain')
  }

  checkout(ref: string): void {
    const refBuf = Buffer.from(ref + '\0', 'utf8')
    const rc = getRequiredLib().symbols.ziggit_checkout(this.handle, ptr(refBuf)) as number
    if (rc < 0) throw new ZiggitError('checkout', rc)
  }

  fetch(): void {
    const rc = getRequiredLib().symbols.ziggit_fetch(this.handle) as number
    if (rc < 0) throw new ZiggitError('fetch', rc)
  }

  remoteGetUrl(remoteName: string): string {
    const buf = Buffer.alloc(BUFFER_SIZE)
    const nameBuf = Buffer.from(remoteName + '\0', 'utf8')
    const rc = getRequiredLib().symbols.ziggit_remote_get_url(this.handle, ptr(nameBuf), ptr(buf), BUFFER_SIZE) as number
    return readBuffer(buf, rc, 'remote_get_url')
  }

  findCommit(committish: string): string {
    const buf = Buffer.alloc(BUFFER_SIZE)
    const cBuf = Buffer.from(committish + '\0', 'utf8')
    const rc = getRequiredLib().symbols.ziggit_find_commit(this.handle, ptr(cBuf), ptr(buf), BUFFER_SIZE) as number
    return readBuffer(buf, rc, 'find_commit')
  }

  close(): void {
    if (!this.closed) {
      this.closed = true
      getRequiredLib().symbols.ziggit_repo_close(this.handle)
    }
  }

  static version(): string {
    return String(getRequiredLib().symbols.ziggit_version())
  }
}

function getRequiredLib(): ZiggitLib {
  const native = getLib()
  if (!native) {
    throw new Error(`ziggit native library not found for ${process.platform}: ${LIB_PATH}`)
  }
  return native
}
