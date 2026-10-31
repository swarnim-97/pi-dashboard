'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { RpcClient } = require('./lib/rpc-client');
const sessions = require('./lib/sessions');

const PORT = parseInt(process.env.PORT || '4319', 10);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------------------
// RPC process management (a single shared pi --mode rpc subprocess)
// ---------------------------------------------------------------------------

let rpc = null;
let isStreaming = false;
let activeCwd = process.cwd();
let activeSessionFile = null;

const sseClients = new Set();

function broadcast(kind, data) {
  const frame = `data: ${JSON.stringify({ kind, data })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch (_) {}
  }
}

function attachRpc({ cwd, sessionFile, name, model, thinking }) {
  if (rpc) {
    rpc.removeAllListeners();
    rpc.stop();
    rpc = null;
  }

  activeCwd = cwd || process.cwd();
  activeSessionFile = sessionFile || null;
  isStreaming = false;

  rpc = new RpcClient({ cwd: activeCwd, sessionFile, name, model, thinking });

  rpc.on('record', (record) => {
    if (record.type === 'agent_start') isStreaming = true;
    else if (record.type === 'agent_settled') isStreaming = false;
    broadcast('record', record);
  });
  rpc.on('status', (status) => {
    if (status.status === 'exited' || status.status === 'error') isStreaming = false;
    broadcast('rpc-status', status);
  });
  rpc.on('stderr', (text) => broadcast('log', text));
  rpc.on('parse-error', (line) => broadcast('log', 'parse error: ' + line));

  rpc.start();

  // Announce state + models shortly after launch. The `record` listener above
  // already broadcasts these responses; here we only read side effects.
  setTimeout(async () => {
    try {
      const state = await rpc.command('get_state');
      if (state && state.data && state.data.sessionFile) {
        activeSessionFile = state.data.sessionFile;
      }
    } catch (_) {}
    try {
      await rpc.command('get_available_models');
    } catch (_) {}
    try {
      await rpc.command('get_available_thinking_levels');
    } catch (_) {}
  }, 400);

  return rpc;
}

function detachRpc() {
  if (rpc) {
    rpc.removeAllListeners();
    rpc.stop();
    rpc = null;
  }
  isStreaming = false;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5e6) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = url.pathname;

  try {
    // ---- static ----
    if (req.method === 'GET' && !route.startsWith('/api/')) {
      return serveStatic(req, res);
    }

    // ---- SSE ----
    if (req.method === 'GET' && route === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // ---- session listing ----
    if (req.method === 'GET' && route === '/api/sessions') {
      const { sessions: list, workspaces } = await sessions.listSessions();
      return sendJson(res, 200, {
        sessions: list,
        workspaces,
        active: { cwd: activeCwd, sessionFile: activeSessionFile, isStreaming },
      });
    }

    // ---- transcript ----
    if (req.method === 'GET' && route === '/api/transcript') {
      const file = url.searchParams.get('file');
      if (!file) return sendJson(res, 400, { error: 'missing ?file=' });
      const t = await sessions.transcript(file);
      return sendJson(res, 200, t);
    }

    // ---- attach / detach ----
    if (req.method === 'POST' && route === '/api/attach') {
      const body = JSON.parse((await readBody(req)) || '{}');
      attachRpc({
        cwd: body.cwd,
        sessionFile: body.sessionFile,
        name: body.name,
        model: body.model,
        thinking: body.thinking,
      });
      return sendJson(res, 200, { ok: true, active: { cwd: activeCwd, sessionFile: activeSessionFile } });
    }

    if (req.method === 'POST' && route === '/api/detach') {
      detachRpc();
      return sendJson(res, 200, { ok: true });
    }

    // ---- state ----
    if (req.method === 'GET' && route === '/api/state') {
      if (!rpc || rpc.exited) {
        return sendJson(res, 200, { connected: false, isStreaming: false });
      }
      try {
        const resp = await rpc.command('get_state');
        return sendJson(res, 200, { connected: true, ...resp.data });
      } catch (e) {
        return sendJson(res, 200, { connected: false, error: e.message });
      }
    }

    // ---- generic RPC command ----
    if (req.method === 'POST' && route === '/api/command') {
      if (!rpc || rpc.exited) {
        return sendJson(res, 409, { error: 'pi is not connected. Attach a workspace first.' });
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      const { type, ...payload } = body;
      if (!type) return sendJson(res, 400, { error: 'missing command "type"' });

      // A prompt sent mid-run must declare how it should behave.
      if (type === 'prompt' && isStreaming && !payload.streamingBehavior) {
        payload.streamingBehavior = 'steer';
      }

      const resp = await rpc.command(type, payload);
      return sendJson(res, 200, {
        command: type,
        success: resp.success,
        data: resp.data,
        error: resp.error,
      });
    }

    sendJson(res, 404, { error: 'unknown route: ' + route });
  } catch (e) {
    sendJson(res, 500, { error: e.message || String(e) });
  }
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`\n  π dashboard → http://${HOST}:${PORT}\n`);
});

// Clean up the child process on shutdown.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    detachRpc();
    process.exit(0);
  });
}
