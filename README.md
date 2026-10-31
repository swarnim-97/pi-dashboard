# π dashboard

A local web GUI for [pi](https://github.com/earendil-works/pi) — the coding agent.

- **Browse every session** you've ever run with pi, grouped by workspace, with search.
- **Read any transcript** rendered nicely (markdown, thinking, tool calls, tool results).
- **Run pi from the browser** — start a new chat or continue an existing session, with live-streamed responses.

No dependencies and no build step. It's a plain Node.js server that talks to pi over its [RPC mode](https://herdr.dev) (JSON lines over stdin/stdout) and reads pi's session files directly from disk.

## Requirements

- Node.js ≥ 18
- `pi` on your `PATH`

## Run

```bash
cd pi-dashboard
npm start          # or: node server.js
```

Then open **http://127.0.0.1:4319**.

Change the port/host with env vars:

```bash
PORT=9000 HOST=127.0.0.1 npm start
```

## How to use it

1. **Sidebar** — all your pi sessions, newest first. Click one to read it. Use the search box to filter.
2. **Workspace** — the working directory for new chats. Defaults to where the server was launched.
3. **New chat** — starts a fresh session in the selected workspace.
4. **Continue** — click a session in the sidebar, then type a message: pi resumes that exact session.
5. **Model / Thinking** — pick from the dropdowns once a session is attached; they map to `set_model` and `set_thinking_level`.
6. **Stop** — aborts the current run.

## How it works

| Piece | What it does |
|---|---|
| `server.js` | Zero-dependency HTTP + SSE server; owns the single shared `pi --mode rpc` child process |
| `lib/rpc-client.js` | Spawns `pi --mode rpc` and speaks JSONL to it (LF framing, request-id correlation) |
| `lib/sessions.js` | Scans `~/.pi/agent/sessions/` and parses session JSONL into listings + transcripts |
| `public/` | The web UI (vanilla JS, no framework) |

Messages are streamed to the browser over Server-Sent Events. The server reconstructs assistant streaming from `message_update` deltas and renders tool calls/results inline.

## Notes & limits

- Sessions are read from `~/.pi/agent/sessions` by default. Set `PI_CODING_AGENT_SESSION_DIR` to override (the server inherits your environment).
- Transcripts are shown in file (append) order, which is the natural "what happened" view. The active-branch tree view is not reconstructed here.
- One `pi` process runs at a time. Switching sessions or starting a new chat stops the previous one.
- This is a local personal tool — it binds to `127.0.0.1` and has no authentication. Don't expose it to a network.
