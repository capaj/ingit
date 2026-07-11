



# ingit

A fast, animated git GUI that runs in your browser — a **vibecoded alternative to [ungit](https://github.com/FredrikNoren/ungit)**.

Yes, vibecoded: this codebase is written entirely by AI coding agents, steered by a human with strong opinions about how a git client should feel. If that offends you, ungit is lovely and hand-crafted. If you're curious what an agent-built tool looks like when it's used daily by its author, read on.

## What it does

- **Commit graph** — smooth, virtualized history graph with lanes, edges, and ref labels. Loads thousand-commit windows and paginates on scroll.
- **Optimistic mutations** — checkout, merge, rebase, cherry-pick, revert, uncommit, branch move/reset animate *immediately* with a predicted graph layout, then reconcile against the real result. Failures roll back.
- **Time Machine** — a reflog view that shows where HEAD has been and lets you recover "lost" commits and deleted branches with one click.
- **Working tree** — stage/unstage files (or everything), see staged vs unstaged at a glance.
- **Push / fetch / force-push** — non-fast-forward pushes surface a typed error with a one-click `--force-with-lease` escape hatch.
- **GitHub integration** — PRs linked to commits, live CI status dots that poll until check-runs settle (set `GITHUB_TOKEN` for private repos / rate limits).
- **Agent sessions** — detects running **Claude Code** and **Codex** sessions on your machine (terminal, VS Code, cursor…), shows which repo each one works in, its live conversation title, and whether it's busy doing inference right now. Click to focus the exact terminal window or IDE workspace where the agent lives. On GNOME Wayland this uses the [Window Calls](https://extensions.gnome.org/extension/4724/window-calls/) shell extension — ingit offers a one-click install via GNOME's native consent dialog.
- **Repo browser** — folder tree with git-repo detection, recent repos, and path autocomplete.

## Install & run

Requires [Node.js](https://nodejs.org/) 18+ and `git`. Install the CLI from npm:

```sh
npm install --global @ingit/cli
```

The npm package installs a small launcher and a prebuilt, self-contained ingit
binary for Linux or macOS (x64/arm64), or Windows (x64). Bun is embedded in the
binary and does not need to be installed separately.

```sh
ingit                 # open the repo in the current directory
ingit ~/code/my-repo  # open a specific repo
ingit --port 9000 --no-open
```

From source (needs [bun](https://bun.sh)):

```sh
git clone https://github.com/capaj/ingit
cd ingit-vibe
bun install
bun dev               # server on http://127.0.0.1:8488 + vite dev client
```

Linux, macOS, and Windows are supported. Agent detection reads `/proc` on Linux
and uses the system `ps` and `lsof` tools on macOS; agent detection and window
focusing are not yet available on Windows. The git UI itself is platform-agnostic.

## See it in action

Click any preview to watch the full recording.

### Switch branches

https://github.com/user-attachments/assets/7e8f8f2f-057f-4eca-ab80-68c7a9f8a1a9

### Preview and merge

https://github.com/user-attachments/assets/7da64406-1dc7-4178-b9f3-e3589a4f9891

### Rebase onto main

https://github.com/user-attachments/assets/633d5fb2-60ac-49a2-93cc-623d40167725

### Cherry-pick a commit

https://github.com/user-attachments/assets/3eb48f31-b8d2-4494-bcb5-087a217d9948

### Recover with Time Machine

https://github.com/user-attachments/assets/74ce82e9-0963-423e-a962-3ebf7eae248c

### Create a branch

https://github.com/user-attachments/assets/0ec99170-801c-4a65-9878-ec7ee49993ba

### Move a branch

https://github.com/user-attachments/assets/2a869a8f-63a9-4555-b518-10b537e29e52


## How it's built

Bun workspaces monorepo:

```
apps/
  client/       React + Vite + Zustand UI — graph canvas, optimistic layout prediction
  server/       node:http + WebSocket server, serves the built client and the RPC API
  cli/          standalone executable via `bun build --compile`, bundles client + server
packages/
  git-core/     spawns real git (rev-list/cat-file batch processes), parsers, repo sessions
  graph-core/   lane allocation + edge building for the commit graph
  rpc-contract/ zod-typed oRPC contract shared by client and server — single source of truth
```

Client and server talk over a WebSocket using [oRPC](https://orpc.unnoq.com/) with zod schemas — add an endpoint to `packages/rpc-contract`, implement it in `apps/server/src/rpc-router.ts`, call it type-safe from the client.

No database. No daemon. Plain git under the hood — everything ingit shows you is derivable from your repo, and everything it does is a git command you could have typed.

## Contributing

PRs welcome. Ground rules:

- **bun, not npm** — package management and scripts all run through bun.
- `bun run typecheck` must pass (project references, `tsc --build`).
- Tests live next to code (`*.test.ts`, `bun test`).
- The workflow here is agent-first: it's perfectly acceptable (encouraged, even) to develop your contribution with Claude Code, Codex, or whatever you drive — you'll fit right in, and ingit will happily show your agent in its own sidebar while it works on itself. Review what you ship; you own the diff.

Good first areas:

- macOS window focusing (AppleScript can target Terminal/iTerm tabs by tty — cleaner than what Wayland allows).
- KDE Wayland focusing backend (`kdotool`).
- More agents (Gemini CLI, Amp, opencode…) — detection lives in `apps/server/src/agent-sessions.ts` and is ~20 lines per agent.
- Diff view polish, partial-file staging.

## Why not just use ungit?

Use ungit! It's great. ingit exists because I wanted: a faster graph on huge repos, a reflog UI, CI status inline, and a control tower for the half-dozen AI agents working across local checkouts. None of that fit ungit's architecture cleanly, and rewriting from scratch with agents doing the typing took just a few sessions, not months.

Models used: mostly codex with GPT-5.5, some with opus 4.8 

## Supported Platforms

- Linux (`/proc` agent detection and GNOME/X11 window focusing)
- macOS (`ps`/`lsof` agent detection; window focusing is not yet implemented)
- Windows x64 (git UI; agent detection and window focusing are not yet implemented)

## License

MIT
