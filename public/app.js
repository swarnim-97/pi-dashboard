'use strict';

/* =========================================================================
 * π dashboard — browser client
 * - Lists sessions from /api/sessions
 * - Renders any session transcript via /api/transcript
 * - Drives a live `pi --mode rpc` process through /api/attach + /api/command
 * - Streams events over Server-Sent Events (/api/events)
 * ========================================================================= */

const $ = (sel) => document.querySelector(sel);

const els = {
  sessionList: $('#session-list'),
  sessionCount: $('#session-count'),
  search: $('#search'),
  newChat: $('#new-chat-btn'),
  workspace: $('#workspace'),
  workspaceList: $('#workspace-list'),
  modelSelect: $('#model-select'),
  thinkingSelect: $('#thinking-select'),
  statusDot: $('#status-dot'),
  statusText: $('#status-text'),
  abortBtn: $('#abort-btn'),
  transcript: $('#transcript'),
  emptyState: $('#empty-state'),
  sessionTitle: $('#session-title'),
  input: $('#input'),
  sendBtn: $('#send-btn'),
  toasts: $('#toasts'),
};

const state = {
  sessions: [],
  workspaces: [],
  currentSessionFile: null, // session being viewed / continued
  currentCwd: null,
  isStreaming: false,
  connected: false,
  models: [],
  thinkingLevels: [],
  liveAssistant: null, // { el, blocks: Map<contentIndex, el> , toolResults: Map<toolCallId, el> }
  pendingUser: [], // optimistic user messages awaiting confirmation
  attachedSessionFile: null, // session the live RPC process is actually on
  attachedCwd: null,
  currentModelId: null,
  currentThinking: null,
};

/* ---------------------------------------------------------------------
 * tiny utilities
 * ------------------------------------------------------------------- */

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const opts = sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  return d.toLocaleString(undefined, opts);
}

function fmtRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  if (!d) return '';
  const diff = Date.now() - d;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return fmtDate(iso);
}

function toast(message, kind = 'info') {
  const node = el('div', 'toast ' + kind, message);
  els.toasts.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

function copyText(text) {
  const done = () => toast('Session ID copied');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch (_) {}
  document.body.removeChild(ta);
}

/* ---------------------------------------------------------------------
 * minimal markdown renderer (block-level, then inline spans)
 * ------------------------------------------------------------------- */

function inlineMarkdown(text) {
  let s = text;
  // inline code
  s = s.replace(/`([^`\n]+)`/g, (_m, c) => `<code>${c}</code>`);
  // bold
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // italic (non-greedy, avoid clobbering **)
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  // links
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isTableSeparator(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function buildTable(headerCells, separatorLine, rows) {
  const align = splitTableRow(separatorLine).map((c) => {
    if (c.startsWith(':') && c.endsWith(':')) return 'center';
    if (c.endsWith(':')) return 'right';
    return 'left';
  });
  const cellStyle = (i) => (align[i] && align[i] !== 'left' ? ` style="text-align:${align[i]}"` : '');

  let html = '<div class="table-wrap"><table><thead><tr>';
  headerCells.forEach((h, i) => {
    html += `<th${cellStyle(i)}>${inlineMarkdown(escapeHtml(h))}</th>`;
  });
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>';
    for (let i = 0; i < headerCells.length; i++) {
      const cell = row[i] != null ? row[i] : '';
      html += `<td${cellStyle(i)}>${inlineMarkdown(escapeHtml(cell))}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  return html;
}

function renderMarkdown(src) {
  if (src == null) return '';
  const source = String(src);

  // Extract fenced code blocks first.
  const codeBlocks = [];
  let text = source.replace(/```([\w+-]*)[ \t]*\n?([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
    const i = codeBlocks.push({ lang, code }) - 1;
    return `\n\u0000CB${i}\u0000\n`;
  });

  const lines = text.split('\n');
  const out = [];
  let para = [];
  let listType = null; // 'ul' | 'ol'
  let quote = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inlineMarkdown(para.join('<br>'))}</p>`);
      para = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${inlineMarkdown(quote.join('<br>'))}</blockquote>`);
      quote = [];
    }
  };
  const flushList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // code-block placeholder lines pass through untouched
    if (/\u0000CB\d+\u0000/.test(line.trim()) && line.trim() === line) {
      flushPara(); flushQuote(); flushList();
      out.push(escapeHtml(line.trim())); // placeholder, replaced later
      continue;
    }

    // markdown table: a header row followed by a |---|---| separator
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headerCells = splitTableRow(line);
      if (headerCells.length >= 2) {
        flushPara(); flushQuote(); flushList();
        const rows = [];
        let j = i + 2;
        while (j < lines.length && lines[j].trim() !== '' && splitTableRow(lines[j]).length >= 2) {
          rows.push(splitTableRow(lines[j]));
          j++;
        }
        out.push(buildTable(headerCells, lines[i + 1], rows));
        i = j - 1;
        continue;
      }
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara(); flushQuote(); flushList();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMarkdown(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }

    if (/^\s*([-*_]\s*){3,}\s*$/.test(line)) {
      flushPara(); flushQuote(); flushList();
      out.push('<hr>');
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushPara(); flushList();
      quote.push(escapeHtml(line.replace(/^\s*>\s?/, '')));
      continue;
    } else {
      flushQuote();
    }

    const ul = line.match(/^(\s*)[-*]\s+(.*)$/);
    const ol = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const isUl = !!ul;
      const content = escapeHtml((ul || ol)[2]);
      if (listType !== (isUl ? 'ul' : 'ol')) {
        flushList();
        listType = isUl ? 'ul' : 'ol';
        out.push(`<${listType}>`);
      }
      out.push(`<li>${inlineMarkdown(content)}</li>`);
      continue;
    } else {
      flushList();
    }

    if (line.trim() === '') {
      flushPara();
      continue;
    }

    para.push(escapeHtml(line));
  }

  flushPara(); flushQuote(); flushList();

  let html = out.join('\n');

  // Reinsert code blocks.
  html = html.replace(/\u0000CB(\d+)\u0000/g, (_m, i) => {
    const cb = codeBlocks[Number(i)];
    const code = escapeHtml(cb.code.replace(/\n$/, ''));
    const lang = cb.lang ? `<div class="code-lang">${escapeHtml(cb.lang)}</div>` : '';
    return `<pre>${lang}<code>${code}</code></pre>`;
  });

  return html;
}

/* ---------------------------------------------------------------------
 * rendering transcript items
 * ------------------------------------------------------------------- */

function renderToolResult(item) {
  const det = el('details', 'block tool-result' + (item.isError ? ' error' : ''));
  det.appendChild(el('summary', null, `↳ ${item.toolName || 'tool'} result`));
  const body = el('div', 'block-body');
  body.appendChild(el('pre', null, item.text || ''));
  det.appendChild(body);
  return det;
}

function renderAssistantContent(content, results = {}) {
  const wrap = el('div', 'assistant-content');
  for (const block of content || []) {
    if (!block) continue;
    if (block.type === 'text') {
      const div = el('div', 'assistant-text md');
      div.innerHTML = renderMarkdown(block.text);
      wrap.appendChild(div);
    } else if (block.type === 'thinking') {
      const det = el('details', 'block thinking');
      det.appendChild(el('summary', null, 'thinking'));
      const body = el('div', 'block-body');
      body.textContent = block.thinking || '';
      det.appendChild(body);
      wrap.appendChild(det);
    } else if (block.type === 'toolCall') {
      const det = el('details', 'block tool');
      const name = block.name || 'tool';
      det.appendChild(el('summary', null, `🛠 ${name}`));
      const body = el('div', 'block-body');
      let argsText;
      try { argsText = JSON.stringify(block.arguments ?? {}, null, 2); } catch (_) { argsText = String(block.arguments); }
      body.appendChild(el('pre', null, argsText));
      det.appendChild(body);
      det.dataset.toolCallId = block.id || '';
      if (block.id && results[block.id]) {
        det.appendChild(renderToolResult(results[block.id]));
      }
      wrap.appendChild(det);
    }
  }
  return wrap;
}

function renderAssistantMessage(item, results = {}) {
  const row = el('div', 'msg msg-assistant');
  const who = el('div', 'who');
  who.appendChild(el('span', 'role-tag', 'assistant'));
  if (item.model) who.appendChild(el('span', 'model-tag', item.model));
  row.appendChild(who);
  row.appendChild(renderAssistantContent(item.content, results));
  return row;
}

function renderItem(item) {
  switch (item.kind) {
    case 'user': {
      const row = el('div', 'msg msg-user');
      const bubble = el('div', 'bubble');
      bubble.textContent = item.text || '';
      row.appendChild(bubble);
      return row;
    }
    case 'assistant':
      return renderAssistantMessage(item);
    case 'toolResult':
      return renderToolResult(item);
    case 'bash': {
      const det = el('details', 'block tool-result');
      det.appendChild(el('summary', null, `$ ${item.command}`));
      const body = el('div', 'block-body');
      body.appendChild(el('pre', null, item.output || ''));
      det.appendChild(body);
      return det;
    }
    case 'custom': {
      const sep = el('div', 'separator');
      sep.appendChild(el('span', null, `extension · ${item.customType || 'message'}`));
      const wrap = el('div');
      wrap.appendChild(sep);
      const body = el('div', 'assistant-text md');
      body.innerHTML = renderMarkdown(item.text);
      wrap.appendChild(body);
      return wrap;
    }
    case 'compaction': {
      const det = el('details', 'block thinking');
      det.appendChild(el('summary', null, 'compacted context'));
      const body = el('div', 'block-body');
      body.textContent = item.summary || '';
      det.appendChild(body);
      return det;
    }
    case 'branchSummary': {
      const det = el('details', 'block thinking');
      det.appendChild(el('summary', null, 'branch summary'));
      const body = el('div', 'block-body');
      body.textContent = item.summary || '';
      det.appendChild(body);
      return det;
    }
    case 'modelChange': {
      const sep = el('div', 'separator');
      sep.appendChild(el('span', null, `model → ${item.provider}/${item.modelId}`));
      return sep;
    }
    case 'thinkingChange': {
      const sep = el('div', 'separator');
      sep.appendChild(el('span', null, `thinking → ${item.level}`));
      return sep;
    }
    default:
      return null;
  }
}

function renderItemList(items) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'assistant') {
      // Nest each tool result inside its matching tool-call block so a single
      // thread reads as one continuous conversation.
      const toolCallIds = new Set((item.content || []).filter((b) => b && b.type === 'toolCall').map((b) => b.id));
      const results = {};
      let j = i + 1;
      while (j < items.length && items[j].kind === 'toolResult' && toolCallIds.has(items[j].toolCallId)) {
        results[items[j].toolCallId] = items[j];
        j++;
      }
      frag.appendChild(renderAssistantMessage(item, results));
      i = j - 1;
    } else {
      const node = renderItem(item);
      if (node) frag.appendChild(node);
    }
  }
  return frag;
}

function clearTranscript() {
  els.transcript.innerHTML = '';
}

function appendToTranscript(node) {
  if (els.emptyState && els.emptyState.parentNode === els.transcript) els.emptyState.remove();
  els.transcript.appendChild(node);
  scrollToBottom();
}

function scrollToBottom() {
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

/* ---------------------------------------------------------------------
 * session list
 * ------------------------------------------------------------------- */

function renderSessionList(filter = '') {
  const q = filter.trim().toLowerCase();
  const list = state.sessions.filter((s) => {
    if (!q) return true;
    const hay = [s.name, s.preview, s.cwd, s.id, s.model && s.model.modelId].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });

  els.sessionList.innerHTML = '';
  if (!list.length) {
    els.sessionList.appendChild(el('div', 'session-empty', 'No sessions found.'));
  }

  for (const s of list) {
    const item = el('div', 'session-item' + (s.file === state.currentSessionFile ? ' active' : ''));

    const title = el('div', 'title', s.name || s.preview || s.id || '(unnamed)');
    item.appendChild(title);

    const meta = el('div', 'meta');
    meta.appendChild(el('span', null, fmtRelative(s.lastActivity)));
    meta.appendChild(el('span', 'badge', `${s.totalMessages} msgs`));
    if (s.model) meta.appendChild(el('span', 'badge', s.model.modelId));
    item.appendChild(meta);

    if (s.id) {
      const sid = el('div', 'sid');
      sid.appendChild(el('span', 'sid-label', 'id'));
      sid.appendChild(el('span', 'sid-value', s.id));
      sid.title = 'Session ID — click to copy';
      sid.addEventListener('click', (e) => {
        e.stopPropagation();
        copyText(s.id);
      });
      item.appendChild(sid);
    }

    if (s.name && s.preview) {
      item.appendChild(el('div', 'preview', s.preview));
    }

    item.addEventListener('click', () => openSession(s.file, s.cwd));
    els.sessionList.appendChild(item);
  }

  els.sessionCount.textContent = `${list.length} session${list.length === 1 ? '' : 's'}`;
}

async function refreshSessions() {
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    state.sessions = data.sessions || [];
    state.workspaces = data.workspaces || [];
    if (data.active) {
      // Track what the RPC process is attached to, but do NOT overwrite the
      // session the user is currently viewing/continuing.
      state.attachedSessionFile = data.active.sessionFile || null;
      if (data.active.cwd) {
        state.attachedCwd = data.active.cwd;
        if (!state.currentCwd) state.currentCwd = data.active.cwd;
      }
    }
    populateWorkspaces();
    renderSessionList(els.search.value);
  } catch (e) {
    console.error('refreshSessions', e);
  }
}

function populateWorkspaces() {
  const set = new Set(state.workspaces);
  if (state.currentCwd) set.add(state.currentCwd);
  if (!els.workspace.value && state.currentCwd) els.workspace.value = state.currentCwd;

  els.workspaceList.innerHTML = '';
  for (const w of set) {
    const opt = document.createElement('option');
    opt.value = w;
    els.workspaceList.appendChild(opt);
  }
}

/* ---------------------------------------------------------------------
 * opening a session (read-only view)
 * ------------------------------------------------------------------- */

async function openSession(file, cwd) {
  state.currentSessionFile = file;
  if (cwd) {
    state.currentCwd = cwd;
    els.workspace.value = cwd;
  }

  renderSessionList(els.search.value);

  try {
    const res = await fetch('/api/transcript?file=' + encodeURIComponent(file));
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    clearTranscript();
    els.sessionTitle.textContent = data.name ? `· ${data.name}` : '';
    if (!cwd && data.cwd) {
      state.currentCwd = data.cwd;
      els.workspace.value = data.cwd;
    }
    els.transcript.appendChild(renderItemList(data.items));
    if (!data.items.length) {
      els.transcript.appendChild(els.emptyState);
    }
    scrollToBottom();
  } catch (e) {
    toast('Failed to load session: ' + e.message, 'error');
  }
}

/* ---------------------------------------------------------------------
 * running pi
 * ------------------------------------------------------------------- */

async function attach(cwd, sessionFile, name) {
  state.attachedCwd = cwd;
  state.attachedSessionFile = sessionFile;
  try {
    await fetch('/api/attach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, sessionFile, name }),
    });
    setStatus('connecting', '');
  } catch (e) {
    state.attachedCwd = null;
    state.attachedSessionFile = null;
    toast('Attach failed: ' + e.message, 'error');
  }
}

function newChat() {
  const cwd = els.workspace.value.trim() || state.currentCwd || '/';
  state.currentCwd = cwd;
  state.currentSessionFile = null;
  clearTranscript();
  els.transcript.appendChild(els.emptyState);
  els.sessionTitle.textContent = '· new session';
  attach(cwd, null, null);
  renderSessionList(els.search.value);
}

async function sendMessage(text) {
  const message = text.trim();
  if (!message) return;

  // Decide where this message should go: continue the viewed session (if any),
  // otherwise a fresh session in the chosen workspace.
  const targetCwd = els.workspace.value.trim() || state.currentCwd || '/';
  const targetSession = state.currentSessionFile || null;
  const onTarget = state.attachedCwd === targetCwd && state.attachedSessionFile === targetSession;
  if (!onTarget) {
    await attach(targetCwd, targetSession, null);
    // Give the subprocess a moment to accept commands before prompting.
    await new Promise((r) => setTimeout(r, 150));
  }

  // Optimistic user bubble.
  const bubble = el('div', 'bubble pending');
  bubble.textContent = message;
  const row = el('div', 'msg msg-user');
  row.appendChild(bubble);
  appendToTranscript(row);
  state.pendingUser.push({ text: message, bubble });
  els.input.value = '';
  autosizeInput();

  try {
    const res = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'prompt', message }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || ('HTTP ' + res.status));
    }
    if (data.disposition === 'handled') {
      toast('Handled by an extension command.');
    }
  } catch (e) {
    bubble.classList.remove('pending');
    toast('Send failed: ' + e.message, 'error');
    state.pendingUser = state.pendingUser.filter((p) => p.bubble !== bubble);
  }
}

function setStatus(mode, text) {
  els.statusDot.className = 'dot';
  if (mode === 'streaming') {
    els.statusDot.classList.add('streaming');
    els.statusText.textContent = text || 'streaming…';
    els.abortBtn.disabled = false;
  } else if (mode === 'connected') {
    els.statusDot.classList.add('connected');
    els.statusText.textContent = text || 'connected';
    els.abortBtn.disabled = true;
  } else if (mode === 'connecting') {
    els.statusDot.classList.add('streaming');
    els.statusText.textContent = text || 'connecting…';
    els.abortBtn.disabled = true;
  } else if (mode === 'error') {
    els.statusDot.classList.add('error');
    els.statusText.textContent = text || 'error';
    els.abortBtn.disabled = true;
  } else {
    els.statusText.textContent = text || 'disconnected';
    els.abortBtn.disabled = true;
  }
}

/* ---------------------------------------------------------------------
 * live streaming (assistant message reconstruction)
 * ------------------------------------------------------------------- */

function beginLiveAssistant() {
  const row = el('div', 'msg msg-assistant');
  const who = el('div', 'who');
  who.appendChild(el('span', 'role-tag', 'assistant'));
  who.appendChild(el('span', 'model-tag live-model', ''));
  row.appendChild(who);
  const content = el('div', 'assistant-content');
  row.appendChild(content);
  appendToTranscript(row);
  state.liveAssistant = { row, content, who, blocks: new Map(), tools: new Map() };
  return state.liveAssistant;
}

function ensureLiveBlock(index, type, data = {}) {
  const live = state.liveAssistant;
  if (!live) return null;
  let entry = live.blocks.get(index);
  if (!entry) {
    const wrap = el('div', 'assistant-content-block');
    if (type === 'text') {
      const div = el('div', 'assistant-text');
      div.textContent = '';
      wrap.appendChild(div);
    } else if (type === 'thinking') {
      const det = el('details', 'block thinking');
      det.appendChild(el('summary', null, 'thinking'));
      const body = el('div', 'block-body');
      det.appendChild(body);
      wrap.appendChild(det);
      entry = { kind: 'thinking', det, body };
    } else if (type === 'tool') {
      const det = el('details', 'block tool');
      det.appendChild(el('summary', null, `🛠 ${data.toolName || 'tool'}`));
      const body = el('div', 'block-body');
      const pre = el('pre');
      body.appendChild(pre);
      det.appendChild(body);
      wrap.appendChild(det);
      entry = { kind: 'tool', det, body, pre, args: '' };
    }
    if (entry) {
      entry.wrap = wrap;
      live.blocks.set(index, entry);
      live.content.appendChild(wrap);
    } else if (type === 'text') {
      entry = { kind: 'text', div: wrap.firstChild };
      entry.wrap = wrap;
      live.blocks.set(index, entry);
      live.content.appendChild(wrap);
    }
  }
  return entry;
}

function applyMessageUpdate(update) {
  const live = state.liveAssistant;
  if (!live) return;
  const ev = update.assistantMessageEvent;
  if (!ev) return;

  switch (ev.type) {
    case 'text_start': {
      const b = ensureLiveBlock(ev.contentIndex, 'text');
      if (b && b.div) b.div.textContent = '';
      break;
    }
    case 'text_delta': {
      const b = ensureLiveBlock(ev.contentIndex, 'text');
      if (b && b.div) b.div.textContent += ev.delta || '';
      break;
    }
    case 'text_end': {
      const b = ensureLiveBlock(ev.contentIndex, 'text');
      if (b && b.div) {
        b.div.className = 'assistant-text md';
        b.div.innerHTML = renderMarkdown(ev.content || '');
      }
      break;
    }
    case 'thinking_delta': {
      const b = ensureLiveBlock(ev.contentIndex, 'thinking');
      if (b && b.body) b.body.textContent += ev.delta || '';
      break;
    }
    case 'thinking_end': {
      const b = ensureLiveBlock(ev.contentIndex, 'thinking');
      if (b && b.body) b.body.textContent = ev.content || '';
      break;
    }
    case 'toolcall_start': {
      ensureLiveBlock(ev.contentIndex, 'tool', { toolName: ev.toolName });
      const b = state.liveAssistant && state.liveAssistant.blocks.get(ev.contentIndex);
      if (b && ev.id) state.liveAssistant.tools.set(ev.id, b);
      break;
    }
    case 'toolcall_delta': {
      const b = ensureLiveBlock(ev.contentIndex, 'tool');
      if (b && b.pre) {
        b.args += ev.delta || '';
        b.pre.textContent = b.args;
      }
      break;
    }
    case 'toolcall_end': {
      const b = ensureLiveBlock(ev.contentIndex, 'tool');
      if (b && b.pre && ev.toolCall) {
        try {
          b.pre.textContent = JSON.stringify(ev.toolCall.arguments ?? {}, null, 2);
        } catch (_) {}
      }
      break;
    }
    case 'error': {
      if (live.who) {
        live.who.appendChild(el('span', 'model-tag', '· ' + (ev.error || ev.reason || 'error')));
      }
      break;
    }
    default:
      break;
  }
}

function finishLiveAssistant(message) {
  const live = state.liveAssistant;
  if (!live) return;
  // Replace with an authoritative render if we got a completed message.
  if (message && message.content) {
    const rendered = renderAssistantContent(message.content);
    live.row.replaceChild(rendered, live.content);
  }
  if (message && message.model && live.who) {
    const tag = live.who.querySelector('.live-model');
    if (tag) tag.textContent = message.model;
  }
  state.liveAssistant = null;
  scrollToBottom();
}

function handleToolEvent(rec) {
  const live = state.liveAssistant;
  if (rec.type === 'tool_execution_start') {
    // ensure tool block exists if toolcall already known
    if (live && live.tools.has(rec.toolCallId)) {
      const b = live.tools.get(rec.toolCallId);
      if (b && b.det && !b.det.querySelector('.tool-running')) {
        const span = el('div', 'tool-running', 'running…');
        b.det.appendChild(span);
        b.running = span;
      }
    }
  } else if (rec.type === 'tool_execution_end') {
    if (live && live.tools.has(rec.toolCallId)) {
      const b = live.tools.get(rec.toolCallId);
      if (b && b.running) b.running.remove();
      if (b && b.det) {
        const resDet = el('details', 'block tool-result' + (rec.isError ? ' error' : ''));
        resDet.appendChild(el('summary', null, `↳ ${rec.toolName || 'tool'} result`));
        const body = el('div', 'block-body');
        let text = '';
        if (rec.result && rec.result.content) {
          text = rec.result.content.map((c) => c.text || '').join('\n');
        } else if (typeof rec.result === 'string') {
          text = rec.result;
        }
        body.appendChild(el('pre', null, text));
        resDet.appendChild(body);
        b.det.appendChild(resDet);
      }
    }
  }
}

/* ---------------------------------------------------------------------
 * SSE event dispatch
 * ------------------------------------------------------------------- */

function handleRecord(rec) {
  if (!rec || !rec.type) return;

  if (rec.type === 'response') {
    const cmd = rec.command;
    if (cmd === 'get_state') {
      if (rec.success && rec.data) {
        state.connected = true;
        state.isStreaming = !!rec.data.isStreaming;
        if (rec.data.sessionFile) {
          state.currentSessionFile = rec.data.sessionFile;
          state.attachedSessionFile = rec.data.sessionFile;
          if (!state.currentCwd && rec.data.cwd) state.currentCwd = rec.data.cwd;
        }
        if (rec.data.sessionName) els.sessionTitle.textContent = '· ' + rec.data.sessionName;
        if (rec.data.model && rec.data.model.id) state.currentModelId = rec.data.model.id;
        if (rec.data.thinkingLevel) state.currentThinking = rec.data.thinkingLevel;
        setStatus(state.isStreaming ? 'streaming' : 'connected');
        els.sendBtn.disabled = false;
      }
    } else if (cmd === 'get_available_models') {
      if (rec.success && rec.data && rec.data.models) {
        state.models = rec.data.models;
        populateModelSelect();
      }
    } else if (cmd === 'get_available_thinking_levels') {
      if (rec.success && rec.data && rec.data.levels) {
        state.thinkingLevels = rec.data.levels;
        populateThinkingSelect();
      }
    } else if (cmd === 'set_model') {
      if (!rec.success) toast('set_model failed: ' + rec.error, 'error');
    } else if (cmd === 'prompt') {
      if (rec.success && rec.data && rec.data.disposition === 'handled') {
        // extension handled it; remove optimistic bubble
        state.pendingUser = [];
      }
    }
    return;
  }

  switch (rec.type) {
    case 'agent_start':
      state.isStreaming = true;
      setStatus('streaming');
      break;

    case 'agent_settled':
      state.isStreaming = false;
      setStatus('connected');
      finishLiveAssistant(null);
      scrollToBottom();
      refreshSessions();
      break;

    case 'message_start': {
      const m = rec.message;
      if (!m) break;
      if (m.role === 'assistant') {
        beginLiveAssistant();
      }
      break;
    }

    case 'message_update':
      applyMessageUpdate(rec);
      scrollToBottom();
      break;

    case 'message_end': {
      const m = rec.message;
      if (!m) break;
      if (m.role === 'assistant') {
        finishLiveAssistant(m);
      } else if (m.role === 'user') {
        confirmUserMessage(m);
      }
      break;
    }

    case 'tool_execution_start':
    case 'tool_execution_end':
    case 'tool_execution_update':
      handleToolEvent(rec);
      break;

    case 'compaction_start':
      appendToTranscript(el('div', 'separator', 'compacting…'));
      break;

    case 'compaction_end':
      if (rec.aborted) appendToTranscript(el('div', 'separator', 'compaction aborted'));
      else appendToTranscript(el('div', 'separator', 'context compacted'));
      break;

    case 'extension_ui_request': {
      if (rec.method === 'notify') {
        toast(rec.message || 'pi notification', rec.notifyType === 'error' ? 'error' : 'info');
      }
      break;
    }

    case 'session_info_changed': {
      if (rec.name != null) els.sessionTitle.textContent = '· ' + rec.name;
      else els.sessionTitle.textContent = '';
      refreshSessions();
      break;
    }

    default:
      break;
  }
}

function confirmUserMessage(m) {
  // The server echoed back our own user message — mark the optimistic bubble delivered.
  const text = typeof m.content === 'string'
    ? m.content
    : (m.content || []).map((c) => (c && c.text) || '').join('');
  const idx = state.pendingUser.findIndex((p) => p.text === text);
  if (idx !== -1) {
    state.pendingUser[idx].bubble.classList.remove('pending');
    state.pendingUser.splice(idx, 1);
  } else {
    const row = el('div', 'msg msg-user');
    const bubble = el('div', 'bubble');
    bubble.textContent = text;
    row.appendChild(bubble);
    appendToTranscript(row);
  }
}

function populateModelSelect() {
  const current = els.modelSelect.value;
  els.modelSelect.innerHTML = '';
  if (!state.models.length) {
    const ph = el('option', null, '—');
    ph.value = '';
    els.modelSelect.appendChild(ph);
    els.modelSelect.disabled = true;
    return;
  }
  els.modelSelect.disabled = false;
  for (const m of state.models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name || m.id;
    els.modelSelect.appendChild(opt);
  }
  const preferred = current || state.currentModelId;
  if (preferred && [...els.modelSelect.options].some((o) => o.value === preferred)) {
    els.modelSelect.value = preferred;
  }
}

function populateThinkingSelect() {
  const current = els.thinkingSelect.value;
  els.thinkingSelect.innerHTML = '';
  if (!state.thinkingLevels.length) {
    const ph = el('option', null, '—');
    ph.value = '';
    els.thinkingSelect.appendChild(ph);
    els.thinkingSelect.disabled = true;
    return;
  }
  els.thinkingSelect.disabled = false;
  for (const l of state.thinkingLevels) {
    const opt = document.createElement('option');
    opt.value = l;
    opt.textContent = l;
    els.thinkingSelect.appendChild(opt);
  }
  const preferred = current || state.currentThinking;
  if (preferred && state.thinkingLevels.includes(preferred)) els.thinkingSelect.value = preferred;
}

async function refreshModelsAndLevels() {
  try {
    const models = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_available_models' }),
    }).then((r) => r.json());
    if (models.success && models.data && models.data.models) {
      state.models = models.data.models;
      populateModelSelect();
    }
  } catch (_) {}
  try {
    const levels = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_available_thinking_levels' }),
    }).then((r) => r.json());
    if (levels.success && levels.data && levels.data.levels) {
      state.thinkingLevels = levels.data.levels;
      populateThinkingSelect();
    }
  } catch (_) {}
}

/* ---------------------------------------------------------------------
 * wiring
 * ------------------------------------------------------------------- */

function autosizeInput() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 220) + 'px';
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.kind === 'record') handleRecord(msg.data);
    else if (msg.kind === 'rpc-status') handleRpcStatus(msg.data);
    else if (msg.kind === 'log') console.log('[pi]', msg.data);
  };
  es.onerror = () => {
    if (state.connected) setStatus('connecting', 'reconnecting…');
  };
}

function handleRpcStatus(status) {
  if (status.status === 'starting') {
    setStatus('connecting');
    state.connected = false;
  } else if (status.status === 'exited') {
    state.connected = false;
    state.isStreaming = false;
    state.attachedSessionFile = null;
    state.attachedCwd = null;
    finishLiveAssistant(null);
    setStatus('error', 'exited');
    els.sendBtn.disabled = true;
  } else if (status.status === 'error') {
    state.connected = false;
    state.isStreaming = false;
    state.attachedSessionFile = null;
    state.attachedCwd = null;
    finishLiveAssistant(null);
    setStatus('error', 'error');
    toast('pi failed to start: ' + (status.message || ''), 'error');
    els.sendBtn.disabled = true;
  }
}

function init() {
  connectSSE();

  els.search.addEventListener('input', () => renderSessionList(els.search.value));
  els.newChat.addEventListener('click', newChat);
  els.abortBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'abort' }),
      });
    } catch (e) {
      toast('Abort failed: ' + e.message, 'error');
    }
  });

  els.input.addEventListener('input', autosizeInput);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(els.input.value);
    }
  });
  els.sendBtn.addEventListener('click', () => sendMessage(els.input.value));

  els.modelSelect.addEventListener('change', async () => {
    const id = els.modelSelect.value;
    if (!id) return;
    const m = state.models.find((x) => x.id === id);
    let provider = m ? m.provider : undefined;
    let modelId = id;
    if (!m && id.includes('/')) [provider, modelId] = id.split('/');
    state.currentModelId = modelId;
    try {
      await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'set_model', provider, modelId }),
      });
    } catch (e) {
      toast('set_model failed: ' + e.message, 'error');
    }
  });

  els.thinkingSelect.addEventListener('change', async () => {
    const level = els.thinkingSelect.value;
    if (!level) return;
    state.currentThinking = level;
    try {
      await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'set_thinking_level', level: els.thinkingSelect.value }),
      });
    } catch (e) {
      toast('set_thinking_level failed: ' + e.message, 'error');
    }
  });

  // Fetch the session list now, and keep it fresh with a light periodic poll
  // so sessions opened in a separate pi terminal appear here too.
  refreshSessions();
  setInterval(refreshSessions, 8000);
  populateModelSelect();
  populateThinkingSelect();
  // Set default workspace to current directory (served by the server).
  fetch('/api/state')
    .then((r) => r.json())
    .then((st) => {
      if (st.connected && st.sessionFile) {
        // Show the active thread's chat in one place on load.
        state.currentSessionFile = st.sessionFile;
        openSession(st.sessionFile, st.cwd);
      }
      if (st.connected) {
        if (st.model && st.model.id) state.currentModelId = st.model.id;
        if (st.thinkingLevel) state.currentThinking = st.thinkingLevel;
        setStatus(st.isStreaming ? 'streaming' : 'connected');
        els.sendBtn.disabled = false;
        refreshModelsAndLevels();
      }
    })
    .catch(() => {});
}

document.addEventListener('DOMContentLoaded', init);
