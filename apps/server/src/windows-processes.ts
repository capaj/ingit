import { dlopen, FFIType, ptr, type Pointer } from 'bun:ffi'
import type { ProcessInfo } from './darwin-processes.js'

const PROCESS_QUERY_INFORMATION = 0x0400
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const PROCESS_VM_READ = 0x0010
const TH32CS_SNAPPROCESS = 0x00000002
const PROCESS_BASIC_INFORMATION = 0
const PROCESS_WOW64_INFORMATION = 26

// PROCESSENTRY32W is 568 bytes for a 64-bit caller. szExeFile starts at byte
// 44 and contains MAX_PATH (260) UTF-16 code units.
const PROCESS_ENTRY_SIZE = 568
const PROCESS_ENTRY_EXE_OFFSET = 44

const kernel32Symbols = {
  CreateToolhelp32Snapshot: {
    args: [FFIType.u32, FFIType.u32],
    returns: FFIType.ptr,
  },
  Process32FirstW: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  Process32NextW: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  OpenProcess: {
    args: [FFIType.u32, FFIType.u32, FFIType.u32],
    returns: FFIType.ptr,
  },
  ReadProcessMemory: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr],
    returns: FFIType.i32,
  },
  QueryFullProcessImageNameW: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  GetProcessTimes: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
  CloseHandle: {
    args: [FFIType.ptr],
    returns: FFIType.i32,
  },
} as const

const ntdllSymbols = {
  NtQueryInformationProcess: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr],
    returns: FFIType.i32,
  },
} as const

type Kernel32 = ReturnType<typeof dlopen<typeof kernel32Symbols>>
type Ntdll = ReturnType<typeof dlopen<typeof ntdllSymbols>>
interface WindowsLibraries {
  kernel32: Kernel32
  ntdll: Ntdll
}

let libraries: WindowsLibraries | null | undefined

function getLibraries(): WindowsLibraries | null {
  if (libraries !== undefined) return libraries
  if (process.platform !== 'win32') {
    libraries = null
    return null
  }
  try {
    libraries = {
      kernel32: dlopen('kernel32.dll', kernel32Symbols),
      ntdll: dlopen('ntdll.dll', ntdllSymbols),
    }
  } catch {
    libraries = null
  }
  return libraries
}

function utf16String(buffer: Buffer): string {
  let end = 0
  while (end + 1 < buffer.length && buffer.readUInt16LE(end) !== 0) end += 2
  return buffer.subarray(0, end).toString('utf16le')
}

/** Parse a Windows command line using the CommandLineToArgvW quote rules. */
export function splitWindowsCommandLine(commandLine: string): string[] {
  const argv: string[] = []
  let index = 0

  while (index < commandLine.length) {
    while (index < commandLine.length && /\s/.test(commandLine[index]!)) index += 1
    if (index >= commandLine.length) break

    let value = ''
    let quoted = false
    while (index < commandLine.length) {
      const char = commandLine[index]!
      if (!quoted && /\s/.test(char)) break

      if (char === '\\') {
        let slashCount = 0
        while (commandLine[index + slashCount] === '\\') slashCount += 1
        const next = commandLine[index + slashCount]
        if (next === '"') {
          value += '\\'.repeat(Math.floor(slashCount / 2))
          if (slashCount % 2 === 1) {
            value += '"'
          } else if (quoted && commandLine[index + slashCount + 1] === '"') {
            value += '"'
            index += 1
          } else {
            quoted = !quoted
          }
          index += slashCount + 1
          continue
        }
        value += '\\'.repeat(slashCount)
        index += slashCount
        continue
      }

      if (char === '"') {
        if (quoted && commandLine[index + 1] === '"') {
          value += '"'
          index += 2
        } else {
          quoted = !quoted
          index += 1
        }
        continue
      }

      value += char
      index += 1
    }

    argv.push(value)
    while (index < commandLine.length && /\s/.test(commandLine[index]!)) index += 1
  }

  return argv
}

export function normalizeWindowsPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`
  if (path.startsWith('\\\\?\\')) return path.slice(4)
  return path
}

function readRemoteMemory(
  kernel32: Kernel32,
  handle: Pointer,
  address: number,
  length: number,
): Buffer | null {
  if (!Number.isSafeInteger(address) || address <= 0 || length <= 0) return null
  const output = Buffer.alloc(length)
  const bytesRead = Buffer.alloc(8)
  const ok = kernel32.symbols.ReadProcessMemory(
    handle,
    address as Pointer,
    ptr(output),
    length,
    ptr(bytesRead),
  )
  if (!ok || Number(bytesRead.readBigUInt64LE(0)) < length) return null
  return output
}

function readRemotePointer(
  kernel32: Kernel32,
  handle: Pointer,
  address: number,
  pointerSize: 4 | 8,
): number | null {
  const data = readRemoteMemory(kernel32, handle, address, pointerSize)
  if (!data) return null
  const value = pointerSize === 8 ? Number(data.readBigUInt64LE(0)) : data.readUInt32LE(0)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function queryPeb(
  libs: WindowsLibraries,
  handle: Pointer,
): { address: number; pointerSize: 4 | 8 } | null {
  // A 64-bit process can inspect a 32-bit target through its WOW64 PEB.
  const wow64 = Buffer.alloc(8)
  const returnLength = Buffer.alloc(4)
  const wow64Status = libs.ntdll.symbols.NtQueryInformationProcess(
    handle,
    PROCESS_WOW64_INFORMATION,
    ptr(wow64),
    wow64.length,
    ptr(returnLength),
  )
  const wow64Peb = wow64Status === 0 ? Number(wow64.readBigUInt64LE(0)) : 0
  if (Number.isSafeInteger(wow64Peb) && wow64Peb > 0) {
    return { address: wow64Peb, pointerSize: 4 }
  }

  // PROCESS_BASIC_INFORMATION is 48 bytes for this 64-bit ingit binary; its
  // PebBaseAddress pointer is the second pointer-sized field.
  const basic = Buffer.alloc(48)
  const basicStatus = libs.ntdll.symbols.NtQueryInformationProcess(
    handle,
    PROCESS_BASIC_INFORMATION,
    ptr(basic),
    basic.length,
    ptr(returnLength),
  )
  if (basicStatus !== 0) return null
  const address = Number(basic.readBigUInt64LE(8))
  return Number.isSafeInteger(address) && address > 0
    ? { address, pointerSize: 8 }
    : null
}

interface ProcessParameters {
  commandLine: string
  cwd: string
}

function readUnicodeString(
  kernel32: Kernel32,
  handle: Pointer,
  address: number,
  pointerSize: 4 | 8,
): string {
  const structureSize = pointerSize === 8 ? 16 : 8
  const structure = readRemoteMemory(kernel32, handle, address, structureSize)
  if (!structure) return ''
  const length = structure.readUInt16LE(0)
  if (length === 0) return ''
  if (length > 65_534 || length % 2 !== 0) return ''
  const bufferAddress = pointerSize === 8
    ? Number(structure.readBigUInt64LE(8))
    : structure.readUInt32LE(4)
  const content = readRemoteMemory(kernel32, handle, bufferAddress, length)
  return content?.toString('utf16le') ?? ''
}

function readProcessParameters(libs: WindowsLibraries, handle: Pointer): ProcessParameters | null {
  const peb = queryPeb(libs, handle)
  if (!peb) return null
  const parametersOffset = peb.pointerSize === 8 ? 0x20 : 0x10
  const parameters = readRemotePointer(
    libs.kernel32,
    handle,
    peb.address + parametersOffset,
    peb.pointerSize,
  )
  if (!parameters) return null

  const currentDirectoryOffset = peb.pointerSize === 8 ? 0x38 : 0x24
  const commandLineOffset = peb.pointerSize === 8 ? 0x70 : 0x40
  return {
    cwd: normalizeWindowsPath(readUnicodeString(
      libs.kernel32, handle, parameters + currentDirectoryOffset, peb.pointerSize)),
    commandLine: readUnicodeString(
      libs.kernel32, handle, parameters + commandLineOffset, peb.pointerSize),
  }
}

function queryImagePath(kernel32: Kernel32, handle: Pointer): string {
  const maxChars = 32_768
  const output = Buffer.alloc(maxChars * 2)
  const size = Buffer.alloc(4)
  size.writeUInt32LE(maxChars)
  const ok = kernel32.symbols.QueryFullProcessImageNameW(handle, 0, ptr(output), ptr(size))
  if (!ok) return ''
  return normalizeWindowsPath(output.subarray(0, size.readUInt32LE(0) * 2).toString('utf16le'))
}

const WINDOWS_EPOCH_OFFSET_MS = 11_644_473_600_000n

function queryProcessTimes(
  kernel32: Kernel32,
  handle: Pointer,
): { cpuTicks: number; startEpochMs?: number } {
  const creation = Buffer.alloc(8)
  const exit = Buffer.alloc(8)
  const kernel = Buffer.alloc(8)
  const user = Buffer.alloc(8)
  const ok = kernel32.symbols.GetProcessTimes(
    handle, ptr(creation), ptr(exit), ptr(kernel), ptr(user))
  if (!ok) return { cpuTicks: 0 }

  const cpu100ns = kernel.readBigUInt64LE(0) + user.readBigUInt64LE(0)
  const startEpochMs = Number(creation.readBigUInt64LE(0) / 10_000n - WINDOWS_EPOCH_OFFSET_MS)
  return {
    cpuTicks: Number(cpu100ns / 100_000n),
    ...(Number.isFinite(startEpochMs) && startEpochMs > 0 ? { startEpochMs } : {}),
  }
}

interface ProcessEntry {
  pid: number
  ppid: number
  name: string
}

function enumerateProcesses(kernel32: Kernel32): ProcessEntry[] {
  const snapshot = kernel32.symbols.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
  if (!snapshot) return []

  const entries: ProcessEntry[] = []
  const data = Buffer.alloc(PROCESS_ENTRY_SIZE)
  try {
    data.writeUInt32LE(PROCESS_ENTRY_SIZE, 0)
    let available = kernel32.symbols.Process32FirstW(snapshot, ptr(data))
    while (available) {
      entries.push({
        pid: data.readUInt32LE(8),
        ppid: data.readUInt32LE(32),
        name: utf16String(data.subarray(PROCESS_ENTRY_EXE_OFFSET)),
      })
      data.fill(0)
      data.writeUInt32LE(PROCESS_ENTRY_SIZE, 0)
      available = kernel32.symbols.Process32NextW(snapshot, ptr(data))
    }
  } finally {
    kernel32.symbols.CloseHandle(snapshot)
  }
  return entries
}

function potentialAgentProcess(name: string): boolean {
  const normalized = name.toLowerCase().replace(/\.exe$/, '')
  return normalized.includes('claude')
    || normalized.includes('codex')
    || normalized === 'node'
    || normalized === 'bun'
    || /^\d+\.\d+\.\d+(?:[-.].*)?$/.test(normalized)
}

function readProcessInfo(
  libs: WindowsLibraries,
  entry: ProcessEntry,
): ProcessInfo | null {
  let canReadMemory = true
  let handle = libs.kernel32.symbols.OpenProcess(
    PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
    0,
    entry.pid,
  )
  if (!handle) {
    canReadMemory = false
    handle = libs.kernel32.symbols.OpenProcess(
      PROCESS_QUERY_LIMITED_INFORMATION,
      0,
      entry.pid,
    )
  }
  if (!handle) return null

  try {
    const parameters = canReadMemory ? readProcessParameters(libs, handle) : null
    const exe = queryImagePath(libs.kernel32, handle) || entry.name
    const command = parameters?.commandLine || exe
    const argv = splitWindowsCommandLine(command)
    const times = queryProcessTimes(libs.kernel32, handle)
    return {
      pid: entry.pid,
      ppid: entry.ppid,
      comm: entry.name,
      state: '',
      ttyNr: 0,
      tty: null,
      cpuTicks: times.cpuTicks,
      argv: argv.length > 0 ? argv : [exe],
      command,
      exe,
      cwd: parameters?.cwd ?? '',
      ...(times.startEpochMs !== undefined ? { startEpochMs: times.startEpochMs } : {}),
    }
  } finally {
    libs.kernel32.symbols.CloseHandle(handle)
  }
}

/** Read Windows process metadata, restricting expensive PEB reads to candidates. */
export async function readWindowsProcesses(pids?: number[]): Promise<ProcessInfo[]> {
  if (pids?.length === 0) return []
  const libs = getLibraries()
  if (!libs) return []

  const requested = pids ? new Set(pids) : null
  let entries: ProcessEntry[]
  try {
    entries = enumerateProcesses(libs.kernel32)
      .filter((entry) => requested ? requested.has(entry.pid) : potentialAgentProcess(entry.name))
  } catch {
    return []
  }
  return entries
    .map((entry) => {
      try {
        return readProcessInfo(libs, entry)
      } catch {
        // Processes routinely exit or change state between snapshot and read.
        return null
      }
    })
    .filter((info): info is ProcessInfo => info !== null)
}

/** Exposed for the Windows-only integration test and targeted fallbacks. */
export async function readWindowsProcessCwd(pid: number): Promise<string | null> {
  return (await readWindowsProcesses([pid]))[0]?.cwd || null
}
