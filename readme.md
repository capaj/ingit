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

Prebuilt standalone binary (embeds the bun runtime — no node/bun needed):

```sh
ingit                 # open the repo in the current directory
ingit ~/code/my-repo  # open a specific repo
ingit --port 9000 --no-open
```

From source (needs [bun](https://bun.sh)):

```sh
git clone https://github.com/capaj/ingit-vibe
cd ingit-vibe
bun install
bun dev               # server on http://127.0.0.1:8488 + vite dev client
```

Linux is the primary target today (agent detection reads `/proc`). The git UI itself is platform-agnostic; macOS/Windows agent detection is a welcome contribution.

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

- macOS agent detection + window focusing (AppleScript can target Terminal/iTerm tabs by tty — cleaner than what Wayland allows).
- KDE Wayland focusing backend (`kdotool`).
- More agents (Gemini CLI, Amp, opencode…) — detection lives in `apps/server/src/agent-sessions.ts` and is ~20 lines per agent.
- Diff view polish, partial-file staging.

## Why not just use ungit?

Use ungit! It's great. ingit exists because I wanted: a faster graph on huge repos, a reflog UI, CI status inline, and a control tower for the half-dozen AI agents working across local checkouts. None of that fit ungit's architecture cleanly, and rewriting from scratch with agents doing the typing took just a few sessions, not months.

Models used: mostly codex with GPT-5.5, some with opus 4.8 

## License

MIT
