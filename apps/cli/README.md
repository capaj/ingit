# ingit

Local git history & graph viewer that runs in your browser.

## Install

```sh
npm install -g ingit
```

No runtime dependencies — the binary is self-contained (the Bun runtime is
embedded). Prebuilt binaries are provided for linux (x64/arm64) and macOS
(x64/arm64).

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
