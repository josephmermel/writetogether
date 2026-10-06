import { marked } from 'marked';
import DOMPurify from 'dompurify';
import './style.css';
import { streamChat, completeChat, generateImage, type ChatMsg } from './api';
import { load, save, uid, text, type Message, type State } from './store';

marked.setOptions({ breaks: true, gfm: true });

const OOC_RE = /\[OOC:\s*([\s\S]*?)\]/gi;
const md = (src: string) =>
  DOMPurify.sanitize(
    marked.parse(src.replace(OOC_RE, (_, t) => `<span class="ooc-inline">OOC · ${t}</span>`)) as string,
    { ADD_ATTR: ['target'] },
  );

let state: State;
let editingId: string | null = null;
let streamingId: string | null = null;
let abort: AbortController | null = null;
let oocMode = false;
let banner = '';
const imageBusy = new Map<string, string>(); // message id -> status text

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const persist = () => save(state);

function toChat(upTo: Message[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  if (state.system.trim()) out.push({ role: 'system', content: state.system.trim() });
  for (const m of upTo) {
    const t = text(m);
    out.push({ role: m.role, content: m.ooc ? `[OOC: ${t}]` : t });
  }
  return out;
}

async function generate(target?: Message) {
  const { apiKey, chatModel } = state.settings;
  if (!apiKey) { banner = 'Add your OpenRouter API key in Settings first.'; return render(); }
  banner = '';
  let msg: Message;
  let history: Message[];
  if (target) {            // regenerate: add a new variant to an assistant message
    msg = target;
    history = state.messages.slice(0, state.messages.indexOf(target));
    msg.variants.push('');
    msg.active = msg.variants.length - 1;
  } else {                 // reply to the last user message
    history = [...state.messages];
    msg = { id: uid(), role: 'assistant', variants: [''], active: 0 };
    state.messages.push(msg);
  }
  const variantIdx = msg.active;
  streamingId = msg.id;
  abort = new AbortController();
  render();
  const body = () => document.querySelector(`[data-id="${msg.id}"] .body`) as HTMLElement | null;
  try {
    await streamChat(apiKey, chatModel, toChat(history), (_d, full) => {
      msg.variants[variantIdx] = full;
      const el = body();
      if (el) { el.innerHTML = md(full); scrollIfNear(); }
    }, abort.signal);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') banner = (e as Error).message;
  }
  // Drop an empty result (error or immediate stop) instead of keeping a blank bubble.
  if (!msg.variants[variantIdx]) {
    msg.variants.splice(variantIdx, 1);
    if (msg.variants.length === 0) state.messages.splice(state.messages.indexOf(msg), 1);
    else msg.active = Math.min(msg.active, msg.variants.length - 1);
  }
  streamingId = null; abort = null;
  persist(); render();
}

function send() {
  const input = $<HTMLTextAreaElement>('#input');
  const t = input.value.trim();
  const last = state.messages.at(-1);
  if (!t) {
    // Empty send: retry a reply to a dangling user message (e.g. after an error).
    if (last?.role === 'user') generate();
    return;
  }
  state.messages.push({ id: uid(), role: 'user', ooc: oocMode || undefined, variants: [t], active: 0 });
  input.value = '';
  persist();
  generate();
}

async function makeImage(m: Message) {
  const s = state.settings;
  if (!s.apiKey) { banner = 'Add your OpenRouter API key in Settings first.'; return render(); }
  banner = '';
  imageBusy.set(m.id, 'Drafting image prompt…'); render();
  try {
    const idx = state.messages.indexOf(m);
    const recent = state.messages.slice(0, idx + 1).filter(x => !x.ooc).slice(-6)
      .map(x => `${x.role === 'user' ? 'USER' : 'NARRATOR'}: ${text(x).replace(OOC_RE, '')}`).join('\n\n');
    const prompt = await completeChat(s.apiKey, s.promptModel || s.chatModel, [
      { role: 'system', content:
        'You write prompts for a text-to-image model. Given a roleplay setting and the latest part of the story, ' +
        'write ONE vivid, concrete image prompt (max 90 words) depicting the final moment: subjects with physical ' +
        'appearance and clothing, pose, expression, setting, lighting, camera angle, art style. Keep character ' +
        'appearance consistent with the setting notes. No dialogue, no names without visual description, no ' +
        'commentary. Output only the prompt.' },
      { role: 'user', content: `SETTING NOTES:\n${state.system.slice(0, 3000) || '(none)'}\n\nSTORY SO FAR:\n${recent}` },
    ]);
    imageBusy.set(m.id, 'Generating image…'); render();
    const src = await generateImage(s.apiKey, s.imageModel, prompt, s.aspect);
    m.image = { src, prompt };
    persist();
  } catch (e) { banner = `Image failed: ${(e as Error).message}`; }
  imageBusy.delete(m.id); render();
}

function scrollIfNear() {
  const c = $('#chat');
  if (c.scrollHeight - c.scrollTop - c.clientHeight < 160) c.scrollTop = c.scrollHeight;
}

function msgEl(m: Message, i: number): HTMLElement {
  const el = document.createElement('div');
  const isLast = i === state.messages.length - 1;
  const t = text(m);
  el.className = `msg ${m.role}${m.ooc ? ' ooc' : ''}`;
  el.dataset.id = m.id;

  const head = document.createElement('div');
  head.className = 'head';
  head.innerHTML = `<span class="who">${m.ooc ? 'OOC' : m.role === 'user' ? 'You' : 'Narrator'}</span>`;
  if (m.role === 'assistant' && m.variants.length > 1) {
    const nav = document.createElement('span');
    nav.className = 'variants';
    nav.innerHTML = `<button data-a="prev" title="Previous answer">‹</button>${m.active + 1}/${m.variants.length}<button data-a="next" title="Next answer">›</button>`;
    head.append(nav);
  }
  const busy = streamingId !== null;
  const actions = document.createElement('span');
  actions.className = 'actions';
  const btn = (a: string, label: string, title: string, dis = false) =>
    `<button data-a="${a}" title="${title}"${dis ? ' disabled' : ''}>${label}</button>`;
  actions.innerHTML =
    btn('edit', '✎', 'Edit', busy) +
    (m.role === 'assistant' || m.role === 'user' ? btn('img', '🖼', 'Generate companion image', busy || imageBusy.has(m.id)) : '') +
    (isLast ? btn('regen', '↻', m.role === 'assistant' ? 'Get an alternative answer' : 'Get a reply', busy) : '') +
    btn('del', '🗑', 'Delete this message', busy);
  head.append(actions);
  el.append(head);

  if (editingId === m.id) {
    const ta = document.createElement('textarea');
    ta.className = 'edit'; ta.value = t;
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
    const row = document.createElement('div');
    row.className = 'editrow';
    row.innerHTML = `<button data-a="save" class="primary">Save</button><button data-a="cancel">Cancel</button>`;
    el.append(ta, row);
    queueMicrotask(() => { ta.focus(); ta.dispatchEvent(new Event('input')); });
  } else {
    const body = document.createElement('div');
    body.className = 'body';
    body.innerHTML = md(t) || (m.id === streamingId ? '<span class="dots">…</span>' : '');
    el.append(body);
  }

  const status = imageBusy.get(m.id);
  if (status) el.insertAdjacentHTML('beforeend', `<div class="imgstatus">${status}</div>`);
  if (m.image) {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = m.image.src; img.alt = m.image.prompt;
    const det = document.createElement('details');
    const sum = document.createElement('summary'); sum.textContent = 'Image prompt';
    const p = document.createElement('p'); p.textContent = m.image.prompt;
    det.append(sum, p);
    const rm = document.createElement('button');
    rm.dataset.a = 'rmimg'; rm.className = 'link'; rm.textContent = 'remove image';
    fig.append(img, det, rm);
    el.append(fig);
  }
  return el;
}

function render() {
  const chat = $('#chat');
  const keep = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160;
  chat.replaceChildren(...state.messages.map(msgEl));
  if (!state.messages.length) chat.innerHTML = '<p class="empty">Set the scene in the sidebar, then write your first message.</p>';
  if (keep) chat.scrollTop = chat.scrollHeight;
  const b = $('#banner');
  b.textContent = banner; b.hidden = !banner;
  $('#send').textContent = streamingId ? 'Stop' : 'Send';
  $('#ooc').classList.toggle('on', oocMode);
  $<HTMLTextAreaElement>('#input').placeholder = oocMode ? 'Out-of-character note to the narrator…' : 'Write your message…';
}

function onChatClick(e: MouseEvent) {
  const b = (e.target as HTMLElement).closest('button[data-a]') as HTMLElement | null;
  if (!b) return;
  const el = b.closest('.msg') as HTMLElement;
  const m = state.messages.find(x => x.id === el.dataset.id)!;
  switch (b.dataset.a) {
    case 'edit': editingId = m.id; break;
    case 'cancel': editingId = null; break;
    case 'save': {
      const v = (el.querySelector('textarea') as HTMLTextAreaElement).value.trim();
      if (v) m.variants[m.active] = v;
      editingId = null; persist(); break;
    }
    case 'prev': m.active = Math.max(0, m.active - 1); persist(); break;
    case 'next': m.active = Math.min(m.variants.length - 1, m.active + 1); persist(); break;
    case 'del':
      if (!confirm('Delete this message?')) return;
      state.messages.splice(state.messages.indexOf(m), 1); persist(); break;
    case 'regen': return void (m.role === 'assistant' ? generate(m) : generate());
    case 'img': return void makeImage(m);
    case 'rmimg': delete m.image; persist(); break;
  }
  render();
}

function buildUI() {
  $('#app').innerHTML = `
  <aside id="side">
    <h1>WriteTogether</h1>
    <label>System instructions / scene</label>
    <textarea id="system" placeholder="Describe the setting, characters, tone, rules of the roleplay…"></textarea>
    <details id="settings">
      <summary>Settings</summary>
      <label>OpenRouter API key</label>
      <input id="apiKey" type="password" autocomplete="off" placeholder="sk-or-…" />
      <label>Chat model</label>
      <input id="chatModel" />
      <label>Image-prompt model <small>(blank = chat model)</small></label>
      <input id="promptModel" />
      <label>Image model</label>
      <input id="imageModel" />
      <label>Image aspect ratio</label>
      <select id="aspect"><option>1:1</option><option>3:4</option><option>4:3</option><option>16:9</option><option>9:16</option></select>
      <p class="hint">Your key is stored only in this browser and sent only to openrouter.ai.</p>
    </details>
    <div class="side-actions">
      <button id="export">Export</button>
      <button id="import">Import</button>
      <button id="clear" class="danger">New chat</button>
    </div>
    <input id="file" type="file" accept="application/json" hidden />
  </aside>
  <main>
    <div id="banner" hidden></div>
    <div id="chat"></div>
    <form id="composer">
      <button type="button" id="ooc" title="Send as an out-of-character message">OOC</button>
      <textarea id="input" rows="2"></textarea>
      <button id="send" class="primary" type="submit">Send</button>
    </form>
  </main>`;

  const bind = (id: string, get: () => string, set: (v: string) => void) => {
    const el = $<HTMLInputElement>('#' + id); el.value = get();
    el.addEventListener('input', () => { set(el.value); persist(); });
  };
  const s = state.settings;
  bind('system', () => state.system, v => state.system = v);
  bind('apiKey', () => s.apiKey, v => s.apiKey = v.trim());
  bind('chatModel', () => s.chatModel, v => s.chatModel = v.trim());
  bind('promptModel', () => s.promptModel, v => s.promptModel = v.trim());
  bind('imageModel', () => s.imageModel, v => s.imageModel = v.trim());
  bind('aspect', () => s.aspect, v => s.aspect = v);
  if (!s.apiKey) ($('#settings') as HTMLDetailsElement).open = true;

  $('#chat').addEventListener('click', onChatClick);
  $('#ooc').addEventListener('click', () => { oocMode = !oocMode; render(); });
  $('#composer').addEventListener('submit', e => {
    e.preventDefault();
    if (streamingId) abort?.abort(); else send();
  });
  $('#input').addEventListener('keydown', e => {
    const k = e as KeyboardEvent;
    if (k.key === 'Enter' && !k.shiftKey && !k.isComposing) { k.preventDefault(); if (!streamingId) send(); }
  });
  $('#clear').addEventListener('click', () => {
    if (!confirm('Start a new chat? The current chat will be cleared (system instructions are kept).')) return;
    state.messages = []; persist(); render();
  });
  $('#export').addEventListener('click', () => {
    const { apiKey: _k, ...settings } = state.settings;
    const blob = new Blob([JSON.stringify({ ...state, settings }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'writetogether-chat.json'; a.click();
  });
  $('#import').addEventListener('click', () => $('#file').click());
  $('#file').addEventListener('change', async e => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!Array.isArray(j.messages)) throw new Error('not a chat export');
      state.system = j.system ?? ''; state.messages = j.messages;
      $<HTMLTextAreaElement>('#system').value = state.system;
      persist(); render();
    } catch (err) { banner = `Import failed: ${(err as Error).message}`; render(); }
  });
}

load().then(s => { state = s; buildUI(); render(); });
