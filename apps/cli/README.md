# ingit

Local git history & graph viewer that runs in your browser.

## Install

```sh
npm install -g @ingit/cli
```

No runtime dependencies — the binary is self-contained (the Bun runtime is
embedded). Prebuilt binaries are provided for Linux (x64/arm64), macOS
(x64/arm64), and Windows (x64).

## Local testing from this repo

Build the host binary and register the CLI package with Bun:

```sh
bun run --filter '@ingit/cli' release linux-x64
cd apps/cli
bun link
```

After that, `ingit` should resolve from `~/.bun/bin`:

```sh
command -v ingit
ingit --version
ingit --help
```

When CLI code changes, rebuild the binary from the repo root:

```sh
bun run --filter '@ingit/cli' release linux-x64
```

You only need to run `bun link` again if the package/link setup changes.

On Windows, use `win32-x64` as the release target. The generated executable is
`apps/cli/release/cli-win32-x64/ingit.exe`.

## Usage

```sh
ingit                 # scan the current folder for repos, open the UI
ingit ~/code          # scan a specific folder
ingit -p 9000         # use a specific preferred port
ingit --no-open       # don't open the browser automatically
```

| Option | Description |
| --- | --- |
| `[path]` | Folder to open (defaults to the current directory). Its child folders are scanned for git repositories. |
| `-p, --port <n>` | Preferred port (default `8488`; next free port if taken). |
| `--host <h>` | Host to bind (default `127.0.0.1`). |
| `--no-open` | Don't open the browser automatically. |
| `-v, --version` | Print version. |
| `-h, --help` | Show help. |

`git` must be installed and on your `PATH`.
