import { marked } from 'marked';
import DOMPurify from 'dompurify';
import './style.css';
import { streamChat, completeChat, generateImage, type ChatMsg } from './api';
import { IMAGE_MODELS, TEXT_MODELS, modelLabel } from './models';
import { saveTextFile, openTextFile } from './files';
import { load, save, uid, text, type Message, type State } from './store';

marked.setOptions({ breaks: true, gfm: true });

const OOC_RE = /\[OOC:\s*([\s\S]*?)\]/gi;
// Highlights "straight" and “curly” quoted dialogue, and styles [OOC: …] notes.
// Code spans/fences are left untouched; quotes don't span line breaks.
const DIALOGUE_RE = /("[^"\n]+"|“[^“”\n]+”)/g;
function decorate(src: string): string {
  return src.split(/(```[\s\S]*?```|`[^`\n]*`|\[OOC:[\s\S]*?\])/i).map((part, i) => {
    if (i % 2 === 0) return part.replace(DIALOGUE_RE, '<span class="dialogue">$1</span>');
    if (/^\[OOC:/i.test(part)) return `<span class="ooc-inline">OOC · ${part.slice(5, -1).trim()}</span>`;
    return part;
  }).join('');
}
const md = (src: string) => DOMPurify.sanitize(marked.parse(decorate(src)) as string);

let state: State;
let editingId: string | null = null;
let streamingId: string | null = null;
let abort: AbortController | null = null;
// Composer holds two drafts; both are sent together (OOC note first, then the in-character message).
const drafts = { ic: '', ooc: '' };
let oocMode = false;
let banner = '';
let pageIdx: number | null = null; // paged view: null = latest page
let promptFor: string | null = null; // paged view: message whose image-prompt overlay is open
let lastPageKey = '';
const imageBusy = new Map<string, string>(); // message id -> status text

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const persist = () => save(state);

function toChat(upTo: Message[]): ChatMsg[] {
  const out: ChatMsg[] = [];
  const sys = [state.settings.systemPrompt.trim(), state.scene.trim() && `SCENE:\n${state.scene.trim()}`]
    .filter(Boolean).join('\n\n');
  if (sys) out.push({ role: 'system', content: sys });
  for (const m of upTo) {
    const t = text(m);
    out.push({ role: m.role, content: m.ooc ? `[OOC: ${t}]` : t });
  }
  return out;
}

/** Make variant `idx` of an assistant message active, keeping each variant's image with it. */
function switchVariant(m: Message, idx: number) {
  (m.variantImages ??= [])[m.active] = m.image ?? null;
  m.active = idx;
  m.image = m.variantImages[idx] ?? undefined;
}

async function generate(target?: Message) {
  const { apiKey, chatModel } = state.settings;
  if (!apiKey) { banner = 'Add your OpenRouter API key in Settings first.'; return render(); }
  banner = '';
  pageIdx = null;
  let msg: Message;
  let history: Message[];
  let prevActive = 0;
  if (target) {            // regenerate: add a new variant to an assistant message
    msg = target;
    prevActive = target.active;
    history = state.messages.slice(0, state.messages.indexOf(target));
    msg.variants.push('');
    switchVariant(msg, msg.variants.length - 1);
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
  let ok = true;
  try {
    await streamChat(apiKey, chatModel, toChat(history), (_d, full) => {
      msg.variants[variantIdx] = full;
      const el = body();
      if (el) { el.innerHTML = md(full); scrollIfNear(); }
    }, abort.signal);
  } catch (e) {
    ok = false;
    if ((e as Error).name !== 'AbortError') banner = (e as Error).message;
  }
  // Drop an empty result (error or immediate stop) instead of keeping a blank bubble.
  if (!msg.variants[variantIdx]) {
    ok = false;
    msg.variants.splice(variantIdx, 1);
    msg.variantImages?.splice(variantIdx, 1);
    if (msg.variants.length === 0) state.messages.splice(state.messages.indexOf(msg), 1);
    else {
      msg.active = Math.min(prevActive, msg.variants.length - 1);
      msg.image = msg.variantImages?.[msg.active] ?? undefined;
    }
  }
  streamingId = null; abort = null;
  persist(); render();
  if (ok && state.settings.autoImage) void makeImage(msg, 'draft');
}

function fitInput() {
  const el = $<HTMLTextAreaElement>('#input');
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 2 + 'px'; // CSS max-height caps this, then it scrolls
}

function setMode(ooc: boolean) {
  const input = $<HTMLTextAreaElement>('#input');
  drafts[oocMode ? 'ooc' : 'ic'] = input.value;
  oocMode = ooc;
  input.value = drafts[oocMode ? 'ooc' : 'ic'];
  fitInput(); render();
  input.focus();
}

function send() {
  const input = $<HTMLTextAreaElement>('#input');
  drafts[oocMode ? 'ooc' : 'ic'] = input.value;
  const ooc = drafts.ooc.trim(), ic = drafts.ic.trim();
  if (!ooc && !ic) {
    // Empty send: retry a reply to a dangling user message (e.g. after an error).
    if (state.messages.at(-1)?.role === 'user') generate();
    return;
  }
  if (ooc) state.messages.push({ id: uid(), role: 'user', ooc: true, variants: [ooc], active: 0 });
  if (ic) state.messages.push({ id: uid(), role: 'user', variants: [ic], active: 0 });
  drafts.ic = drafts.ooc = '';
  oocMode = false; // always return to in-character after sending
  input.value = '';
  fitInput();
  persist();
  generate();
}

/** mode 'draft': LLM drafts a fresh prompt, then renders it. 'render': render the (possibly edited) prompt as-is. */
async function makeImage(m: Message, mode: 'draft' | 'render') {
  const s = state.settings;
  if (!s.apiKey) { banner = 'Add your OpenRouter API key in Settings first.'; return render(); }
  banner = '';
  const im = (m.image ??= { prompt: '' });
  im.error = undefined;
  try {
    if (mode === 'draft' || !im.prompt.trim()) {
      imageBusy.set(m.id, 'Drafting image prompt…'); render();
      const idx = state.messages.indexOf(m);
      const recent = state.messages.slice(0, idx + 1).filter(x => !x.ooc).slice(-6)
        .map(x => `${x.role === 'user' ? 'USER' : 'NARRATOR'}: ${text(x).replace(OOC_RE, '')}`).join('\n\n');
      im.prompt = await completeChat(s.apiKey, s.promptModel || s.chatModel, [
        { role: 'system', content:
          'You write prompts for a text-to-image model. Given a roleplay setting and the latest part of the story, ' +
          'write ONE vivid, concrete image prompt (max 90 words) depicting the final moment: subjects with physical ' +
          'appearance and clothing, pose, expression, setting, lighting, camera angle, art style. Keep character ' +
          'appearance consistent with the setting notes. No dialogue, no names without visual description, no ' +
          'commentary. Output only the prompt.\n\n' +
          'IMPORTANT: Every character in this story is an adult, always 18 or older, regardless of what the ' +
          'story text implies. Word the prompt so that every person is clearly and unambiguously depicted as an ' +
          'adult: state an adult age (e.g. "a man in his mid-twenties", "a woman in her thirties") for each ' +
          'person and use adult descriptors (man, woman, adult). Never use words like boy, girl, child, kid, ' +
          'teen, schoolboy, schoolgirl, minor, young-looking or childlike, and do not describe youthful or ' +
          'childlike features. If a character\'s age is unclear, depict them as an adult of at least 18. ' +
          'When called for, you can use adult erotic terminology and atmosphere, partial nudity etc. But keep things softporn at most, dont prompt for explicit sex acts or other things that will get moderated. ' 
        },
        { role: 'user', content: `SETTING NOTES:\n${state.scene.slice(0, 3000) || '(none)'}\n\nSTORY SO FAR:\n${recent}` },
      ]);
      persist();
    }
    imageBusy.set(m.id, 'Generating image…'); render();
    im.src = await generateImage(s.apiKey, im.model ?? s.imageModel, im.prompt.trim(), s.aspect);
  } catch (e) { im.error = (e as Error).message; }
  imageBusy.delete(m.id); persist(); render();
}

function scrollIfNear() {
  const c = $(state.settings.view === 'paged' ? '#pagetext' : '#chat');
  if (c.scrollHeight - c.scrollTop - c.clientHeight < 160) c.scrollTop = c.scrollHeight;
}

function msgEl(m: Message, i: number, inPager = false): HTMLElement {
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
    (!inPager ? btn('img', '🖼', 'Generate companion image', busy || imageBusy.has(m.id) || !!m.image) : '') +
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

  if (inPager) return el; // the paged view shows the image in its own pane
  const status = imageBusy.get(m.id);
  if (status) el.insertAdjacentHTML('beforeend', `<div class="imgstatus">${status}</div>`);
  if (m.image) {
    const im = m.image;
    const working = imageBusy.has(m.id);
    const fig = document.createElement('div');
    fig.className = 'imgpanel';
    if (im.src) {
      const img = document.createElement('img');
      img.src = im.src; img.alt = im.prompt;
      fig.append(img);
    }
    if (im.error) {
      const err = document.createElement('div');
      err.className = 'imgerror'; err.textContent = im.error;
      fig.append(err);
    }
    const lbl = document.createElement('label');
    lbl.textContent = 'Image prompt (editable)';
    const ta = document.createElement('textarea');
    ta.className = 'imgprompt'; ta.value = im.prompt; ta.disabled = working;
    ta.placeholder = 'Prompt for the image model…';
    const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
    ta.addEventListener('input', () => { im.prompt = ta.value; fit(); persist(); });
    queueMicrotask(fit);
    const sel = document.createElement('select');
    sel.className = 'imgmodel'; sel.disabled = working;
    const cur = im.model ?? state.settings.imageModel;
    const opts = IMAGE_MODELS.map(x => `<option value="${x.id}">${modelLabel(x)}</option>`);
    if (!IMAGE_MODELS.some(x => x.id === cur)) opts.unshift(`<option value="${cur}">${cur} (custom)</option>`);
    sel.innerHTML = opts.join('');
    sel.value = cur;
    sel.addEventListener('change', () => {
      im.model = sel.value; state.settings.imageModel = sel.value; // remembered as the new default
      pickers.imageModel?.refresh();
      persist();
    });
    const row = document.createElement('div');
    row.className = 'editrow';
    const b = (a: string, label: string, cls = '') =>
      `<button data-a="${a}" class="${cls}"${working ? ' disabled' : ''}>${label}</button>`;
    row.innerHTML =
      b('imgrender', im.error ? 'Retry' : im.src ? 'Regenerate image' : 'Generate image', 'primary') +
      b('imgdraft', 'Redraft prompt') + b('rmimg', 'Remove');
    fig.append(lbl, ta, sel, row);
    el.append(fig);
  }
  return el;
}

function updateComposer() {
  const input = $<HTMLTextAreaElement>('#input');
  drafts[oocMode ? 'ooc' : 'ic'] = input.value;
  $('#composer').classList.toggle('ooc', oocMode);
  $('#tab-ic').classList.toggle('on', !oocMode);
  $('#tab-ooc').classList.toggle('on', oocMode);
  $('#tab-ic').classList.toggle('has', !!drafts.ic.trim());
  $('#tab-ooc').classList.toggle('has', !!drafts.ooc.trim());
  input.placeholder = oocMode ? 'Out-of-character note to the narrator…' : 'Write your message…';
}

interface Page { users: Message[]; reply?: Message }

/** A page is a turn: the user message(s) you sent plus the narrator's reply to them. */
function pages(): Page[] {
  const out: Page[] = [];
  let cur: Page | undefined;
  for (const m of state.messages) {
    if (!cur || cur.reply) { cur = { users: [] }; out.push(cur); }
    if (m.role === 'user') cur.users.push(m); else cur.reply = m;
  }
  return out;
}
const pageIndex = (n: number) => (n === 0 ? 0 : pageIdx === null ? n - 1 : Math.min(pageIdx, n - 1));

function goto(i: number) {
  const n = pages().length;
  i = Math.max(0, Math.min(n - 1, i));
  pageIdx = i === n - 1 ? null : i;
  editingId = null; promptFor = null;
  render();
}

function imagePane(m: Message): HTMLElement {
  const el = document.createElement('div');
  el.className = 'imgpane'; el.dataset.id = m.id;
  const im = m.image;
  const status = imageBusy.get(m.id);
  const working = !!status || streamingId === m.id;

  const stage = document.createElement('div');
  stage.className = 'stage';
  if (im?.src) {
    const img = document.createElement('img');
    img.src = im.src; img.alt = im.prompt;
    stage.append(img);
  } else {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = streamingId === m.id
      ? (state.settings.autoImage ? 'The photo follows the reply…' : '')
      : 'No image yet';
    stage.append(hint);
  }
  if (status) stage.insertAdjacentHTML('beforeend', `<div class="status">${status}</div>`);
  el.append(stage);
  if (im?.error) el.insertAdjacentHTML('beforeend', '<div class="imgerror"></div>');
  if (im?.error) el.querySelector('.imgerror')!.textContent = im.error;

  const sel = document.createElement('select');
  sel.className = 'imgmodel'; sel.disabled = working;
  const cur = im?.model ?? state.settings.imageModel;
  const opts = IMAGE_MODELS.map(x => `<option value="${x.id}">${modelLabel(x)}</option>`);
  if (!IMAGE_MODELS.some(x => x.id === cur)) opts.unshift(`<option value="${cur}">${cur} (custom)</option>`);
  sel.innerHTML = opts.join('');
  sel.value = cur;
  sel.addEventListener('change', () => {
    (m.image ??= { prompt: '' }).model = sel.value;
    state.settings.imageModel = sel.value; // remembered as the new default
    pickers.imageModel?.refresh();
    persist();
  });
  const row = document.createElement('div');
  row.className = 'editrow';
  const hasPrompt = !!im?.prompt.trim();
  const b = (a: string, label: string, cls = '', dis = working) =>
    `<button data-a="${a}" class="${cls}"${dis ? ' disabled' : ''}>${label}</button>`;
  row.innerHTML =
    b(hasPrompt ? 'imgrender' : 'img', im?.src ? 'Regenerate' : im?.error ? 'Retry' : 'Generate image', 'primary') +
    b('prompt', 'Prompt…', '', false) + (im ? b('rmimg', 'Remove') : '');
  el.append(sel, row);
  return el;
}

function promptOverlay(m: Message): HTMLElement {
  const im = (m.image ??= { prompt: '' });
  const working = imageBusy.has(m.id);
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="card" data-id="${m.id}">
    <label>Image prompt</label>
    <textarea></textarea>
    <div class="editrow">
      <button data-a="imgrender" class="primary"${working ? ' disabled' : ''}>Generate image</button>
      <button data-a="imgdraft"${working ? ' disabled' : ''}>Redraft with AI</button>
      <button data-a="closeprompt">Close</button>
    </div>
    ${working ? `<div class="imgstatus">${imageBusy.get(m.id)}</div>` : ''}
  </div>`;
  const ta = ov.querySelector('textarea') as HTMLTextAreaElement;
  ta.value = im.prompt; ta.disabled = working;
  ta.placeholder = 'Prompt for the image model… (or use Redraft)';
  ta.addEventListener('input', () => { im.prompt = ta.value; persist(); });
  ov.addEventListener('click', e => { if (e.target === ov) { promptFor = null; render(); } });
  return ov;
}

function renderPager() {
  const ps = pages();
  const n = ps.length;
  const idx = pageIndex(n);
  const page = ps[idx];
  const text = $('#pagetext');
  const key = page ? (page.users[0] ?? page.reply!).id : '';
  const prevTop = text.scrollTop;
  const sameAsBefore = key === lastPageKey;
  lastPageKey = key;

  $('#pageno').textContent = n ? `${idx + 1} / ${n}` : '–';
  ($('#p-first') as HTMLButtonElement).disabled = ($('#p-prev') as HTMLButtonElement).disabled = idx <= 0;
  ($('#p-next') as HTMLButtonElement).disabled = ($('#p-last') as HTMLButtonElement).disabled = idx >= n - 1;

  const pane = $('#pageimg');
  if (!page) {
    text.innerHTML = '<p class="empty">Set the scene in the sidebar, then write your first message.</p>';
    pane.replaceChildren();
    return;
  }
  const users = document.createElement('div');
  users.className = 'page-users';
  users.append(...page.users.map(m => msgEl(m, state.messages.indexOf(m), true)));
  text.replaceChildren(...(page.users.length ? [users] : []),
    ...(page.reply ? [msgEl(page.reply, state.messages.indexOf(page.reply), true)] : []));
  text.scrollTop = sameAsBefore ? prevTop : 0;

  if (page.reply) {
    pane.replaceChildren(imagePane(page.reply));
    if (promptFor === page.reply.id) pane.append(promptOverlay(page.reply));
  } else {
    pane.innerHTML = '<div class="stage"><div class="hint">The photo appears with the narrator\'s reply</div></div>';
  }
}

function render() {
  const view = state.settings.view;
  const paged = view === 'paged';
  $('#chat').hidden = paged;
  $('#pager').hidden = !paged;
  $('#pagernav').hidden = !paged;
  $('#v-paged').classList.toggle('on', paged);
  $('#v-chat').classList.toggle('on', !paged);
  ($('#autoImage') as HTMLInputElement).checked = state.settings.autoImage;

  if (paged) {
    renderPager();
    // The composer belongs to the latest page; hide it while reading back.
    const n = pages().length;
    $('#composer').hidden = n > 0 && pageIndex(n) < n - 1;
  } else {
    const chat = $('#chat');
    const keep = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160;
    chat.replaceChildren(...state.messages.map((m, i) => msgEl(m, i)));
    if (!state.messages.length) chat.innerHTML = '<p class="empty">Set the scene in the sidebar, then write your first message.</p>';
    if (keep) chat.scrollTop = chat.scrollHeight;
    $('#composer').hidden = false;
  }
  const b = $('#banner');
  b.textContent = banner; b.hidden = !banner;
  $('#send').textContent = streamingId ? 'Stop' : 'Send';
  updateComposer();
}

function onChatClick(e: MouseEvent) {
  const b = (e.target as HTMLElement).closest('button[data-a]') as HTMLElement | null;
  if (!b) return;
  const el = b.closest('[data-id]') as HTMLElement;
  const m = state.messages.find(x => x.id === el.dataset.id)!;
  switch (b.dataset.a) {
    case 'edit': editingId = m.id; break;
    case 'cancel': editingId = null; break;
    case 'save': {
      const v = (el.querySelector('textarea') as HTMLTextAreaElement).value.trim();
      if (v) m.variants[m.active] = v;
      editingId = null; persist(); break;
    }
    case 'prev': switchVariant(m, Math.max(0, m.active - 1)); persist(); break;
    case 'next': switchVariant(m, Math.min(m.variants.length - 1, m.active + 1)); persist(); break;
    case 'del':
      if (!confirm('Delete this message?')) return;
      state.messages.splice(state.messages.indexOf(m), 1); persist(); break;
    case 'regen': return void (m.role === 'assistant' ? generate(m) : generate());
    case 'img': return void makeImage(m, 'draft');
    case 'imgdraft': return void makeImage(m, 'draft'); // overlay stays open to show the new prompt
    case 'imgrender': promptFor = null; return void makeImage(m, 'render');
    case 'rmimg': delete m.image; promptFor = null; persist(); break;
    case 'prompt': m.image ??= { prompt: '' }; promptFor = m.id; break;
    case 'closeprompt': promptFor = null; break;
  }
  render();
}

const pickers: Record<string, { refresh: () => void }> = {};

/** Dropdown of known models plus "Custom…" that reveals a text box for pasting any OpenRouter slug. */
function modelPicker(
  id: string, options: { value: string; label: string }[], get: () => string, set: (v: string) => void,
) {
  const root = $(`#${id}`);
  const sel = document.createElement('select');
  const txt = document.createElement('input');
  txt.placeholder = 'vendor/model-name'; txt.spellcheck = false;
  sel.innerHTML = options.map(o => `<option value="${o.value}">${o.label}</option>`).join('') +
    '<option value="__custom">Custom…</option>';
  root.append(sel, txt);
  const refresh = () => {
    const v = get();
    const known = options.some(o => o.value === v);
    sel.value = known ? v : '__custom';
    txt.hidden = known;
    if (!known) txt.value = v;
  };
  sel.addEventListener('change', () => {
    if (sel.value === '__custom') { txt.hidden = false; txt.value = get() || ''; txt.focus(); return; }
    set(sel.value); persist(); refresh();
  });
  txt.addEventListener('input', () => { set(txt.value.trim()); persist(); });
  refresh();
  return { refresh };
}

function buildUI() {
  $('#app').innerHTML = `
  <aside id="side">
    <h1>WriteTogether</h1>
    <label>Scene <small>(optional, saved with this chat)</small></label>
    <textarea id="scene" placeholder="Describe the setting, characters and situation for this story…"></textarea>
    <details id="settings">
      <summary>Settings</summary>
      <label>System instructions <small>(saved with settings)</small></label>
      <textarea id="systemPrompt" rows="6"></textarea>
      <label>OpenRouter API key</label>
      <input id="apiKey" type="password" autocomplete="off" placeholder="sk-or-…" />
      <label>Chat model</label>
      <div id="chatModel" class="picker"></div>
      <label>Image-prompt model <small>(blank = chat model)</small></label>
      <div id="promptModel" class="picker"></div>
      <label>Image model</label>
      <div id="imageModel" class="picker"></div>
      <label>Image aspect ratio</label>
      <select id="aspect"><option>1:1</option><option>3:4</option><option>4:3</option><option>16:9</option><option>9:16</option></select>
      <p class="hint">Your key is stored only in this browser and sent only to openrouter.ai.</p>
      <div class="side-actions">
        <button id="saveSettings" title="Save API key, models and system instructions to a file">Save settings…</button>
        <button id="loadSettings" title="Load API key, models and system instructions from a file">Load settings…</button>
      </div>
      <p class="hint">Settings files include your API key in plain text. Keep them private.</p>
    </details>
    <div class="side-actions">
      <button id="export">Export chat</button>
      <button id="import">Import chat</button>
      <button id="clear" class="danger">New chat</button>
    </div>
  </aside>
  <main>
    <div id="banner" hidden></div>
    <div id="topbar">
      <div class="seg"><button id="v-paged" title="One turn per page, with a stable photo">Paged</button><button id="v-chat" title="Scrolling conversation">Chat</button></div>
      <div id="pagernav">
        <button id="p-first" title="First page">«</button><button id="p-prev" title="Previous page (←)">‹</button>
        <span id="pageno"></span>
        <button id="p-next" title="Next page (→)">›</button><button id="p-last" title="Latest page">»</button>
      </div>
      <label class="auto" title="Generate a companion image after every reply"><input type="checkbox" id="autoImage" /> Auto photo</label>
    </div>
    <div id="chat"></div>
    <div id="pager"><div id="pagetext"></div><div id="pageimg"></div></div>
    <form id="composer">
      <div class="compose-main">
        <div class="tabs" role="tablist">
          <button type="button" id="tab-ic" role="tab" title="In-character message">In character</button>
          <button type="button" id="tab-ooc" role="tab" title="Out-of-character note, sent as [OOC: …]">OOC</button>
          <span class="tabhint">Both are sent together</span>
        </div>
        <textarea id="input"></textarea>
      </div>
      <button id="send" class="primary" type="submit">Send</button>
    </form>
  </main>`;

  const bind = (id: string, get: () => string, set: (v: string) => void) => {
    const el = $<HTMLInputElement>('#' + id); el.value = get();
    el.addEventListener('input', () => { set(el.value); persist(); });
  };
  const s = state.settings;
  bind('scene', () => state.scene, v => state.scene = v);
  bind('systemPrompt', () => s.systemPrompt, v => s.systemPrompt = v);
  bind('apiKey', () => s.apiKey, v => s.apiKey = v.trim());
  const textOpts = TEXT_MODELS.map(m => ({ value: m.id, label: m.label }));
  pickers.chatModel = modelPicker('chatModel', textOpts, () => s.chatModel, v => s.chatModel = v);
  pickers.promptModel = modelPicker('promptModel', [{ value: '', label: 'Same as chat model' }, ...textOpts],
    () => s.promptModel, v => s.promptModel = v);
  pickers.imageModel = modelPicker('imageModel', IMAGE_MODELS.map(m => ({ value: m.id, label: modelLabel(m) })),
    () => s.imageModel, v => s.imageModel = v);
  bind('aspect', () => s.aspect, v => s.aspect = v);
  if (!s.apiKey) ($('#settings') as HTMLDetailsElement).open = true;

  $('#chat').addEventListener('click', onChatClick);
  $('#pager').addEventListener('click', onChatClick);
  const setView = (v: 'paged' | 'chat') => { state.settings.view = v; persist(); render(); };
  $('#v-paged').addEventListener('click', () => setView('paged'));
  $('#v-chat').addEventListener('click', () => setView('chat'));
  $('#autoImage').addEventListener('change', e => { state.settings.autoImage = (e.target as HTMLInputElement).checked; persist(); });
  const nav = () => pageIndex(pages().length);
  $('#p-first').addEventListener('click', () => goto(0));
  $('#p-prev').addEventListener('click', () => goto(nav() - 1));
  $('#p-next').addEventListener('click', () => goto(nav() + 1));
  $('#p-last').addEventListener('click', () => goto(Infinity));
  document.addEventListener('keydown', e => {
    if (state.settings.view !== 'paged' || e.altKey || e.ctrlKey || e.metaKey) return;
    if ((e.target as HTMLElement).closest('textarea, input, select')) return;
    if (e.key === 'ArrowLeft') goto(nav() - 1);
    if (e.key === 'ArrowRight') goto(nav() + 1);
  });
  $('#tab-ic').addEventListener('click', () => setMode(false));
  $('#tab-ooc').addEventListener('click', () => setMode(true));
  $('#composer').addEventListener('submit', e => {
    e.preventDefault();
    if (streamingId) abort?.abort(); else send();
  });
  $('#input').addEventListener('input', () => { fitInput(); updateComposer(); });
  $('#input').addEventListener('keydown', e => {
    const k = e as KeyboardEvent;
    if (k.key === 'Enter' && !k.shiftKey && !k.isComposing) { k.preventDefault(); if (!streamingId) send(); }
  });
  $('#clear').addEventListener('click', () => {
    if (!confirm('Start a new chat? The current chat will be cleared (the scene is cleared too; settings and system instructions are kept).')) return;
    state.messages = []; state.scene = '';
    $<HTMLTextAreaElement>('#scene').value = '';
    persist(); render();
  });
  const fail = (what: string) => (err: unknown) => { banner = `${what} failed: ${(err as Error).message}`; render(); };
  $('#export').addEventListener('click', () => {
    const data = { app: 'writetogether-chat', version: 2, scene: state.scene, messages: state.messages };
    saveTextFile('writetogether-chat.json', JSON.stringify(data, null, 1)).catch(fail('Export'));
  });
  $('#import').addEventListener('click', async () => {
    try {
      const t = await openTextFile();
      if (t === null) return;
      const j = JSON.parse(t);
      if (!Array.isArray(j.messages)) throw new Error('not a chat export');
      // Older exports stored the scene under "system".
      state.scene = typeof j.scene === 'string' ? j.scene : typeof j.system === 'string' ? j.system : '';
      state.messages = j.messages;
      $<HTMLTextAreaElement>('#scene').value = state.scene;
      persist(); render();
    } catch (err) { fail('Import')(err); }
  });
  $('#saveSettings').addEventListener('click', () => {
    const data = { app: 'writetogether-settings', version: 2, settings: state.settings };
    saveTextFile('writetogether-settings.json', JSON.stringify(data, null, 1)).catch(fail('Save settings'));
  });
  $('#loadSettings').addEventListener('click', async () => {
    try {
      const t = await openTextFile();
      if (t === null) return;
      const j = JSON.parse(t);
      if (j.app !== 'writetogether-settings' || typeof j.settings !== 'object' || !j.settings) {
        throw new Error('not a WriteTogether settings file');
      }
      // Copy only known string fields so a malformed file can't inject anything else.
      for (const k of Object.keys(state.settings) as (keyof typeof state.settings)[]) {
        if (typeof j.settings[k] === typeof state.settings[k]) (state.settings as unknown as Record<string, unknown>)[k] = j.settings[k];
      }
      // Version-1 settings files kept the system prompt at the top level.
      if (typeof j.settings.systemPrompt !== 'string' && typeof j.system === 'string') {
        state.settings.systemPrompt = j.system;
      }
      $<HTMLTextAreaElement>('#systemPrompt').value = state.settings.systemPrompt;
      $<HTMLInputElement>('#apiKey').value = state.settings.apiKey;
      $<HTMLSelectElement>('#aspect').value = state.settings.aspect;
      Object.values(pickers).forEach(p => p.refresh());
      banner = ''; persist(); render();
    } catch (err) { fail('Load settings')(err); }
  });
}

load().then(s => { state = s; buildUI(); render(); });
