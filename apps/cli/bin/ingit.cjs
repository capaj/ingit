#!/usr/bin/env node
'use strict'

// Launcher for the `ingit` CLI. The actual program is a self-contained,
// prebuilt binary shipped in a per-platform optional dependency. This shim
// resolves the binary that matches the current OS/arch and execs it.

const { spawnSync } = require('node:child_process')

const platform = process.platform
const arch = process.arch
const pkgName = `@ingit/cli-${platform}-${arch}`

let binPath
try {
  binPath = require.resolve(`${pkgName}/ingit`)
} catch {
  console.error(`ingit: no prebuilt binary available for ${platform}-${arch}.`)
  console.error(`Expected the optional dependency "${pkgName}" to be installed.`)
  console.error('Supported: linux-x64, linux-arm64, darwin-x64, darwin-arm64.')
  process.exit(1)
}

const result = spawnSync(binPath, process.argv.slice(2), { stdio: 'inherit' })

if (result.error) {
  console.error(`ingit: failed to launch binary: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status === null ? 1 : result.status)
