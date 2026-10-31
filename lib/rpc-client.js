'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

/**
 * A minimal, dependency-free client for `pi --mode rpc`.
 *
 * Spawns a long-lived `pi` subprocess, writes JSONL commands to stdin and
 * parses the JSONL records streamed on stdout. Command responses are
 * correlated by request id; everything else is forwarded as an event.
 *
 * Framing note: we split strictly on `\n` (and strip an optional `\r`).
 * Node's `readline` also splits on U+2028 / U+2029, which are legal inside
 * JSON strings, so we deliberately avoid it here.
 */
class RpcClient extends EventEmitter {
  constructor({ cwd, sessionFile, name, model, thinking } = {}) {
    super();
    this.cwd = cwd || process.cwd();
    this.sessionFile = sessionFile || null;
    this.name = name || null;
    this.model = model || null;
    this.thinking = thinking || null;

    this.proc = null;
    this.pending = new Map();
    this.reqCounter = 0;
    this.buffer = '';
    this.exited = false;
    this.exitInfo = null;
  }

  start() {
    const args = ['--mode', 'rpc'];
    if (this.sessionFile) args.push('--session', this.sessionFile);
    if (this.name) args.push('--name', this.name);
    if (this.model) args.push('--model', this.model);
    if (this.thinking) args.push('--thinking', this.thinking);

    this.emit('status', { status: 'starting', cwd: this.cwd, sessionFile: this.sessionFile });

    this.proc = spawn('pi', args, { cwd: this.cwd, env: process.env });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');

    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.on('data', (chunk) => this.emit('stderr', chunk));

    this.proc.on('error', (err) => {
      this.emit('status', { status: 'error', message: String((err && err.message) || err) });
      this._rejectAll(err);
    });

    this.proc.on('exit', (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      this.emit('status', { status: 'exited', code, signal });
      this._rejectAll(new Error(`pi exited (code=${code}, signal=${signal})`));
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line.trim()) continue;

      let record;
      try {
        record = JSON.parse(line);
      } catch (e) {
        this.emit('parse-error', line);
        continue;
      }
      this._onRecord(record);
    }
  }

  _onRecord(record) {
    if (record && record.type === 'response') {
      const pending = this.pending.get(record.id);
      if (pending) {
        this.pending.delete(record.id);
        if (record.success === false && record.error) {
          pending.reject(new Error(record.error));
        } else {
          pending.resolve(record);
        }
      }
    }
    this.emit('record', record);
  }

  /**
   * Send a command and resolve with the matching `response` record.
   * Rejects on a `success:false` response or if the process is gone.
   */
  command(type, payload = {}) {
    if (!this.proc || this.exited) {
      return Promise.reject(new Error('pi is not running'));
    }
    const id = 'req-' + (++this.reqCounter);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const record = { id, type, ...payload };
      try {
        this.proc.stdin.write(JSON.stringify(record) + '\n');
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  _rejectAll(err) {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }

  /** Request an orderly shutdown, escalating to SIGTERM then SIGKILL. */
  stop() {
    if (!this.proc || this.exited) return;
    try {
      this.proc.stdin.end();
    } catch (_) {}
    const proc = this.proc;
    setTimeout(() => {
      if (!this.exited) {
        try { proc.kill('SIGTERM'); } catch (_) {}
      }
    }, 500);
    setTimeout(() => {
      if (!this.exited) {
        try { proc.kill('SIGKILL'); } catch (_) {}
      }
    }, 3000);
  }
}

module.exports = { RpcClient };
