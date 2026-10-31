'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Read-only access to pi's on-disk session history.
 *
 * Sessions are JSONL files under `~/.pi/agent/sessions/<encoded-cwd>/`.
 * Each line is a JSON record with a `type` field. See pi's
 * "Session File Format" documentation for the full contract.
 */

function sessionsRoot() {
  return (
    process.env.PI_CODING_AGENT_SESSION_DIR ||
    path.join(os.homedir(), '.pi', 'agent', 'sessions')
  );
}

/** Recursively find *.jsonl session files under the sessions root. */
function findSessionFiles(root) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...findSessionFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Stream a JSONL file, invoking `onRecord(record)` for each parsed line.
 * Splits only on LF; malformed lines are skipped.
 */
function forEachRecord(file, onRecord) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    stream.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.trim()) continue;
        try {
          onRecord(JSON.parse(line));
        } catch (_) {
          // tolerate a malformed trailing/partial line
        }
      }
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

/** Flatten message content blocks into a single text string. */
function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (!b || typeof b !== 'object') return '';
        if (b.type === 'text') return b.text || '';
        if (b.type === 'thinking') return b.thinking || '';
        if (b.type === 'image') return '[image]';
        if (b.type === 'toolCall') return '';
        return '';
      })
      .join('');
  }
  return '';
}

function truncate(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + '…';
}

/** Build a lightweight summary for one session file. */
async function summarizeSession(file) {
  const summary = {
    file,
    id: null,
    cwd: null,
    name: null,
    preview: null,
    startedAt: null,
    lastActivity: null,
    userMessages: 0,
    assistantMessages: 0,
    totalMessages: 0,
    model: null,
    thinkingLevel: null,
  };

  await forEachRecord(file, (rec) => {
    switch (rec.type) {
      case 'session':
        summary.id = rec.id || summary.id;
        summary.cwd = rec.cwd || summary.cwd;
        summary.startedAt = rec.timestamp || summary.startedAt;
        break;
      case 'session_info':
        if (rec.name != null) summary.name = rec.name;
        break;
      case 'model_change':
        summary.model = { provider: rec.provider, modelId: rec.modelId };
        break;
      case 'thinking_level_change':
        summary.thinkingLevel = rec.thinkingLevel;
        break;
      case 'message': {
        const m = rec.message;
        if (!m) break;
        if (m.role === 'user') {
          summary.userMessages += 1;
          summary.totalMessages += 1;
          if (!summary.preview) summary.preview = truncate(contentToText(m.content), 140);
        } else if (m.role === 'assistant') {
          summary.assistantMessages += 1;
          summary.totalMessages += 1;
        }
        break;
      }
      default:
        break;
    }
    if (rec.timestamp) summary.lastActivity = rec.timestamp;
  });

  return summary;
}

/** List every session, newest first, plus the distinct workspaces they live in. */
async function listSessions() {
  const files = findSessionFiles(sessionsRoot()).sort();
  const sessions = [];
  for (const file of files) {
    try {
      sessions.push(await summarizeSession(file));
    } catch (_) {
      // skip unreadable files
    }
  }
  sessions.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));

  const workspaces = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
  return { sessions, workspaces };
}

/**
 * Parse one session file into a display transcript.
 * Entries are returned in append (file) order, which is the natural
 * "what happened" view of a session.
 */
async function transcript(file) {
  const out = {
    file,
    id: null,
    cwd: null,
    name: null,
    startedAt: null,
    model: null,
    thinkingLevel: null,
    items: [],
  };

  await forEachRecord(file, (rec) => {
    switch (rec.type) {
      case 'session':
        out.id = rec.id || out.id;
        out.cwd = rec.cwd || out.cwd;
        out.startedAt = rec.timestamp || out.startedAt;
        break;
      case 'session_info':
        if (rec.name != null) out.name = rec.name;
        break;
      case 'model_change':
        out.model = { provider: rec.provider, modelId: rec.modelId };
        out.items.push({
          kind: 'modelChange',
          entryId: rec.id,
          timestamp: rec.timestamp,
          provider: rec.provider,
          modelId: rec.modelId,
        });
        break;
      case 'thinking_level_change':
        out.thinkingLevel = rec.thinkingLevel;
        out.items.push({
          kind: 'thinkingChange',
          entryId: rec.id,
          timestamp: rec.timestamp,
          level: rec.thinkingLevel,
        });
        break;
      case 'message': {
        const m = rec.message;
        if (!m) break;
        if (m.role === 'system') break; // huge prompt/tool payloads, not useful in a chat view
        if (m.role === 'user') {
          out.items.push({
            kind: 'user',
            entryId: rec.id,
            timestamp: rec.timestamp,
            text: contentToText(m.content),
          });
        } else if (m.role === 'assistant') {
          out.items.push({
            kind: 'assistant',
            entryId: rec.id,
            timestamp: rec.timestamp,
            model: m.model,
            provider: m.provider,
            content: m.content || [],
            stopReason: m.stopReason,
          });
        } else if (m.role === 'toolResult') {
          out.items.push({
            kind: 'toolResult',
            entryId: rec.id,
            timestamp: rec.timestamp,
            toolCallId: m.toolCallId,
            toolName: m.toolName,
            text: contentToText(m.content),
            isError: !!m.isError,
          });
        } else if (m.role === 'bashExecution') {
          out.items.push({
            kind: 'bash',
            entryId: rec.id,
            timestamp: rec.timestamp,
            command: m.command,
            output: m.output,
            exitCode: m.exitCode,
            truncated: !!m.truncated,
          });
        } else if (m.role === 'custom') {
          if (m.display === false) break;
          out.items.push({
            kind: 'custom',
            entryId: rec.id,
            timestamp: rec.timestamp,
            customType: m.customType,
            text: contentToText(m.content),
          });
        }
        break;
      }
      case 'compaction':
        out.items.push({
          kind: 'compaction',
          entryId: rec.id,
          timestamp: rec.timestamp,
          summary: rec.summary || '',
        });
        break;
      case 'branch_summary':
        out.items.push({
          kind: 'branchSummary',
          entryId: rec.id,
          timestamp: rec.timestamp,
          summary: rec.summary || '',
          fromId: rec.fromId,
        });
        break;
      case 'custom_message':
        if (rec.display === false) break;
        out.items.push({
          kind: 'custom',
          entryId: rec.id,
          timestamp: rec.timestamp,
          customType: rec.customType,
          text: contentToText(rec.content),
        });
        break;
      default:
        break;
    }
  });

  return out;
}

module.exports = { sessionsRoot, listSessions, transcript };
