# OfficeVibe

> Local multi-agent harness for [Claude Code](https://claude.com/claude-code): autonomous agents that message, route, and remember — coordinated by a GOD orchestrator and visualized as avatars at work.

OfficeVibe is a cross-platform **Electron desktop app**. You run a team of Claude Code agents on your own machine; each agent gets a real terminal (PTY), can read/write files and run git, and the whole "office" is rendered as a live pixel-art floor where avatars walk around, sit, think, and hand work to each other. A **GOD orchestrator** (Michael) decomposes work and delegates; a prep assistant (Dwight) keeps state warm. Optional integrations: a **Slack** webhook bridge and an in-app **browser pane** that agents can drive via MCP.

Everything runs locally — there is no OfficeVibe backend. Your code, transcripts, and agent memory stay on your machine.

## Prerequisites

- **Node.js 20+** and npm
- **[Claude Code](https://claude.com/claude-code)** installed and on your `PATH` (`claude --version`) — OfficeVibe spawns it for each agent
- Linux, macOS, or Windows
- Native build toolchain for `node-pty` (e.g. `build-essential`/Xcode CLT/MSVC build tools) — used by the `postinstall` rebuild step

## Quick start (development)

```bash
npm install        # also runs prepare-stt-assets + electron-rebuild
npm run dev        # launch the app with hot reload
```

On Linux you can also use the bundled launcher: `./start-officevibe.sh`.

## Building distributables

```bash
npm run build          # compile main/preload/renderer
npm run dist           # package for the current OS
npm run dist:mac       # or :win / :linux
```

macOS builds are code-signed and notarized when the `APPLE_*` environment variables are set (see `build/notarize.cjs`); without them the build still completes unsigned.

## Project layout

```
src/main/        Electron main process (PTY, git, fs, hooks, Slack, browser MCP, config)
src/preload/     Typed contextBridge API exposed to the renderer
src/renderer/    React + Pixi.js UI (the office floor, panels, terminals)
tools/, scripts/ Map generation + speech-to-text asset prep
build/           App icons, entitlements, notarization
```

Runtime project data (your agents, boards, logs, per-agent settings) is written to a **sibling `OfficeVibe-Projets/` folder outside this repository** and is intentionally never committed.

## Security notes

- **Secrets at rest.** Slack signing secret / bot token are stored in the OS app-data dir (`app.getPath('userData')/config.json`), never in the repo, never logged, and never sent to the renderer.
- **Local servers are loopback-only.** The Slack webhook server and the browser-control MCP server both bind to `127.0.0.1`. Public Slack delivery is reached via an on-demand [localtunnel](https://github.com/localtunnel/localtunnel); the MCP server is gated by a per-run random token.
- **Agents are powerful.** Each agent can run shell commands and edit files within its project directory, just like Claude Code itself. Run OfficeVibe only with projects and tools you trust.

If you find a security issue, please open a GitHub issue (or email the maintainer) rather than disclosing it publicly first.

## Acknowledgements

OfficeVibe is derived from [`shahar061/the-office`](https://github.com/shahar061/the-office)
(ISC) — the pixel-art office-visualization engine it ports lives under
[`src/renderer/src/scene/office/`](src/renderer/src/scene/office/). The office tilesets are by
**LimeZu** (non-commercial license). See [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) and
[ATTRIBUTION.md](src/renderer/src/assets/ATTRIBUTION.md) for full credits.

## License

Original OfficeVibe code is [MIT](./LICENSE) © 2026 William Sorensen. The project
also bundles third-party material under different terms — **ISC** code ported from
`shahar061/the-office`, and **non-commercial-only** pixel art (LimeZu).
Those terms are **not** overridden by the MIT grant; see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md). As a result OfficeVibe as
distributed is **for non-commercial use** unless the encumbered assets are replaced
or separately licensed.
