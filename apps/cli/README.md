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
| `-p, --port <n>` | Preferred port (default `8449`; next free port if taken). |
| `--host <h>` | Host to bind (default `127.0.0.1`). |
| `--no-open` | Don't open the browser automatically. |
| `--no-auto-update` | Skip the automatic update check for this launch. |
| `-v, --version` | Print version. |
| `-h, --help` | Show help. |

`git` must be installed and on your `PATH`.

## Automatic updates

Global installations check npm's `latest` release when `ingit` starts. When a
newer version is available, the launcher runs the owning package manager's
global install command and starts the updated CLI with the same arguments:

| Package manager | Command (with the detected version) |
| --- | --- |
| npm | `npm install --global @ingit/cli@<version>` |
| pnpm | `pnpm add --global @ingit/cli@<version>` |
| Yarn Classic | `yarn global add @ingit/cli@<version>` |
| Bun | `bun add --global @ingit/cli@<version>` |

Turn off **Settings → Updates → Install updates automatically** to opt out.
The preference is saved on the server machine in
`$XDG_CONFIG_HOME/ingit/settings.json` (default `~/.config/ingit/settings.json`),
or `%APPDATA%\ingit\settings.json` on Windows. It applies across repositories
and browser sessions. `INGIT_AUTO_UPDATE=0` also disables updates, and
`ingit --no-auto-update` skips them for one launch.

Help/version commands and development builds skip checks. Local/temporary
installations are not updated globally, and ambiguous package-manager ownership
is left for manual updating. Registry checks time out after three seconds;
offline checks or failed installs report a warning and continue startup.
Updates never invoke sudo. If an install requires elevated permissions, update
it manually. Close other ingit processes first if Windows reports a locked binary.
