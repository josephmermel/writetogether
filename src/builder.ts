// Builder page: study saved/imported chats, then ask a model for new situations, character descriptions
// and short "memories" that can be dropped into the scene, the system instructions or the memories box.
import { streamChat } from './api';
import { openTextFile } from './files';
import { libDelete, libList, libPut, parseChatFile, toLibrary, type LibraryChat, type State } from './store';

export interface BuilderCtx {
  state: () => State;
  persist: () => void;
  md: (src: string) => string;
  banner: (msg: string) => void;
  toast: (msg: string) => void;
  openSidebar: () => void;
}

const MAX_FULL_CHARS = 30000; // per source when "full story" is chosen (about 7.5K tokens)
const CAST_KEYS = ['you', 'them'] as const;

const BUILDER_SYSTEM =
  'You are a creative collaborator helping an author plan interactive, turn-based roleplay fiction for adults. ' +
  'You are given SOURCE MATERIAL from earlier sessions (scenes, characters and story excerpts). Learn what the ' +
  'author enjoys: the dynamics, tone, pacing, kinds of situations and how characters speak and behave. ' +
  'Then do what the author asks, concretely and in the same spirit and tone as the sources, without moralizing or ' +
  'adding disclaimers. Every character is an adult (18 or older). Be specific: names, settings, physical ' +
  'descriptions and hooks beat generalities. When asked for memories, write short, durable, neutral facts ' +
  '(one or two sentences each) that a narrator should remember, one per line.';

const PRESETS: { label: string; prompt: string }[] = [
  { label: 'New situations', prompt:
    'Based on the sources, propose 6 new situations for a fresh scene. They can reuse the characters or introduce new ones in a similar spirit. For each: a short title, a 2–3 sentence setup, the dynamic or tension between the characters, and a suggested opening line. Vary setting and tone.' },
  { label: 'Character descriptions', prompt:
    'Create two new protagonists for a new scene inspired by the sources. For each give: name, age (adult), appearance (build, hair, face, clothing — concrete physical details, 60–100 words, written so an image model could use it), and personality and speech style (2–3 sentences).' },
  { label: 'Draft memories', prompt:
    'Distill 8 short memories (one or two sentences each, one per line) from the sources: durable facts, preferences, boundaries, running jokes and relationship dynamics that a narrator should remember in future scenes. Write them as neutral statements.' },
  { label: 'Themes I like', prompt:
    'Analyse the sources: what recurring themes, dynamics, tones and kinds of moments appear, and which seem to work best? Then list 6 theme ideas worth exploring next, each in one line.' },
  { label: 'Scene text', prompt:
    'Write a scene setup I can paste into the Scene box (about 200 words): the setting, the situation, who the characters are, the tone, and any ground rules for the narrator. Base it on the sources and on this idea: ' },
];

let ctx: BuilderCtx;
let library: LibraryChat[] = [];
let abort: AbortController | null = null;
let busy = false;

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

interface Source { id: string; title: string; sub: string; chat: LibraryChat; deletable: boolean }

function sources(): Source[] {
  const st = ctx.state();
  const out: Source[] = [];
  if (st.messages.length || st.scene.trim()) {
    out.push({
      id: 'current', title: 'Current chat', sub: `${st.messages.length} messages`, deletable: false,
      chat: toLibrary(st.scene, st.cast, st.messages, 'Current chat'),
    });
  }
  for (const c of library) {
    out.push({ id: c.id, title: c.title, sub: `${fmtDate(c.savedAt)} · ${c.messages.length} messages`, chat: c, deletable: true });
  }
  return out;
}

function sourceText(s: Source, detail: 'cast' | 'full'): string {
  const c = s.chat;
  const names = (k: typeof CAST_KEYS[number]) => c.cast[k].name.trim() || (k === 'you' ? 'Character A' : 'Character B');
  const parts = [`=== SOURCE: ${s.title} ===`];
  if (c.scene.trim()) parts.push(`SCENE:\n${c.scene.trim()}`);
  const chars = CAST_KEYS.filter(k => c.cast[k].name.trim() || c.cast[k].description.trim())
    .map(k => `- ${names(k)}${c.cast[k].description.trim() ? `: ${c.cast[k].description.trim()}` : ''}`);
  if (chars.length) parts.push(`CHARACTERS:\n${chars.join('\n')}`);
  if (detail === 'full' && c.messages.length) {
    const lines = c.messages.filter(m => !m.ooc).map(m => `${m.role === 'user' ? names('you') : names('them')}: ${m.text.trim()}`);
    let story = lines.join('\n\n');
    if (story.length > MAX_FULL_CHARS) {
      // Keep the opening (sets the tone) and the most recent part (where the story ended up).
      const head = Math.floor(MAX_FULL_CHARS * 0.3);
      story = story.slice(0, head) + '\n\n[… middle of the story omitted …]\n\n' + story.slice(-(MAX_FULL_CHARS - head));
    }
    parts.push(`STORY:\n${story}`);
  }
  return parts.join('\n\n');
}

function selectedSources() {
  const b = ctx.state().builder;
  return sources().filter(s => b.selected.includes(s.id)).map(s => ({ s, detail: b.detail[s.id] ?? 'cast' as const }));
}

function systemMessage(): string {
  const st = ctx.state();
  const chosen = selectedSources().map(({ s, detail }) => sourceText(s, detail));
  const parts = [BUILDER_SYSTEM];
  parts.push(chosen.length ? `SOURCE MATERIAL:\n\n${chosen.join('\n\n')}` : 'SOURCE MATERIAL: (none selected — work from the author\'s request alone)');
  if (st.settings.memories.trim()) parts.push(`EXISTING MEMORIES (do not repeat these):\n${st.settings.memories.trim()}`);
  return parts.join('\n\n');
}

function renderSources() {
  const st = ctx.state(), b = st.builder;
  const list = $('#b-list');
  const srcs = sources();
  list.replaceChildren();
  if (!srcs.length) list.innerHTML = '<p class="hint">No chats yet. Import a chat file, or save the current chat to the library.</p>';
  for (const s of srcs) {
    const row = document.createElement('div');
    row.className = 'b-src';
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = b.selected.includes(s.id);
    cb.addEventListener('change', () => {
      b.selected = cb.checked ? [...new Set([...b.selected, s.id])] : b.selected.filter(x => x !== s.id);
      ctx.persist(); renderSources();
    });
    const t = document.createElement('span');
    t.className = 'b-title'; t.textContent = s.title;
    const sub = document.createElement('small');
    sub.textContent = s.sub;
    lab.append(cb, t, sub);
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="cast">Scene + characters</option><option value="full">Full story</option>';
    sel.value = b.detail[s.id] ?? 'cast';
    sel.addEventListener('change', () => { b.detail[s.id] = sel.value as 'cast' | 'full'; ctx.persist(); renderSources(); });
    row.append(lab, sel);
    if (s.deletable) {
      const del = document.createElement('button');
      del.className = 'link'; del.textContent = '✕'; del.title = 'Remove from library';
      del.addEventListener('click', async () => {
        if (!confirm(`Remove "${s.title}" from the library?`)) return;
        await libDelete(s.id);
        b.selected = b.selected.filter(x => x !== s.id);
        ctx.persist(); await refreshLibrary();
      });
      row.append(del);
    }
    list.append(row);
  }
  const chars = selectedSources().reduce((n, { s, detail }) => n + sourceText(s, detail).length, 0);
  $('#b-tokens').textContent = `Selected sources ≈ ${Math.round(chars / 4 / 100) / 10}K tokens sent with every request.`;
}

function bmsgEl(i: number): HTMLElement {
  const m = ctx.state().builder.thread[i];
  const el = document.createElement('div');
  el.className = `bmsg ${m.role}`;
  el.dataset.i = String(i);
  const body = document.createElement('div');
  body.className = 'body';
  if (m.role === 'user') body.textContent = m.content;
  else body.innerHTML = ctx.md(m.content) || '<span class="dots">…</span>';
  el.append(body);
  if (m.role === 'assistant' && m.content && !(busy && i === ctx.state().builder.thread.length - 1)) {
    const row = document.createElement('div');
    row.className = 'b-actions2';
    row.innerHTML = `<button data-a="copy">Copy</button>
      <span class="b-add">Add selection (or whole reply) to
        <select data-t>
          <option value="memories">Memories</option><option value="scene">Scene</option><option value="system">System instructions</option>
          <option value="you">Your character</option><option value="them">Narrator's character</option>
        </select>
        <button data-a="add" class="primary">Add</button></span>
      ${i === ctx.state().builder.thread.length - 1 ? '<button data-a="regen">Regenerate</button>' : ''}`;
    el.append(row);
  }
  return el;
}

function renderThread() {
  const th = ctx.state().builder.thread;
  const box = $('#b-thread');
  box.replaceChildren(...th.map((_, i) => bmsgEl(i)));
  if (!th.length) box.innerHTML = '<p class="empty">Pick some sources, then choose a starting prompt below or write your own.</p>';
  box.scrollTop = box.scrollHeight;
  ($('#b-send') as HTMLButtonElement).textContent = busy ? 'Stop' : 'Generate';
}

async function refreshLibrary() {
  try { library = await libList(); } catch { library = []; }
  renderSources();
}

/** Text the user wants to move: their selection inside this reply, else the whole reply. */
function pickText(el: HTMLElement, whole: string): string {
  const sel = window.getSelection();
  const s = sel?.toString().trim();
  return s && sel!.anchorNode && el.contains(sel!.anchorNode) ? s : whole.trim();
}

function addTo(target: string, t: string) {
  const st = ctx.state();
  const join = (a: string, b: string) => (a.trim() ? a.trimEnd() + '\n\n' : '') + b;
  const setVal = (sel: string, v: string) => { const e = document.querySelector(sel) as HTMLTextAreaElement | null; if (e) e.value = v; };
  if (target === 'memories') {
    st.settings.memories = (st.settings.memories.trim() ? st.settings.memories.trimEnd() + '\n' : '') + t;
    setVal('#memories', st.settings.memories);
  } else if (target === 'scene') { st.scene = join(st.scene, t); setVal('#scene', st.scene); }
  else if (target === 'system') { st.settings.systemPrompt = join(st.settings.systemPrompt, t); setVal('#systemPrompt', st.settings.systemPrompt); }
  else if (target === 'you' || target === 'them') {
    const c = st.cast[target];
    c.description = join(c.description, t);
    setVal(`#cast-${target} .cdesc`, c.description);
  }
  ctx.persist();
  const names: Record<string, string> = { memories: 'memories', scene: 'the scene', system: 'the system instructions', you: 'your character', them: "the narrator's character" };
  ctx.toast(`Added to ${names[target]}. Review it in the sidebar.`);
}

async function run() {
  const st = ctx.state();
  if (!st.settings.apiKey) { ctx.banner('Add your OpenRouter API key in Settings first.'); ctx.openSidebar(); return; }
  const th = st.builder.thread;
  busy = true;
  abort = new AbortController();
  th.push({ role: 'assistant', content: '' });
  renderThread();
  const idx = th.length - 1;
  try {
    const msgs = [{ role: 'system' as const, content: systemMessage() }, ...th.slice(0, idx).map(m => ({ role: m.role, content: m.content }))];
    await streamChat(st.settings.apiKey, st.settings.builderModel || st.settings.chatModel, msgs, (_d, full) => {
      th[idx].content = full;
      const el = document.querySelector(`#b-thread .bmsg[data-i="${idx}"] .body`);
      if (el) { el.innerHTML = ctx.md(full); const box = $('#b-thread'); box.scrollTop = box.scrollHeight; }
    }, abort.signal);
  } catch (e) { if ((e as Error).name !== 'AbortError') ctx.banner((e as Error).message); }
  if (!th[idx].content) th.splice(idx, 1);
  busy = false; abort = null;
  ctx.persist(); renderThread();
}

function send() {
  if (busy) { abort?.abort(); return; }
  const ta = $<HTMLTextAreaElement>('#b-prompt');
  const t = ta.value.trim();
  if (!t) return;
  ctx.state().builder.thread.push({ role: 'user', content: t });
  ta.value = '';
  void run();
}

const defaultTitle = (c: { scene: string; cast: LibraryChat['cast'] }) => {
  const names = [c.cast.you.name, c.cast.them.name].map(n => n.trim()).filter(Boolean).join(' & ');
  return names || c.scene.trim().slice(0, 40) || `Chat ${new Date().toLocaleDateString()}`;
};

export async function archiveCurrent(title?: string): Promise<void> {
  const st = ctx.state();
  if (!st.messages.length) return;
  await libPut(toLibrary(st.scene, st.cast, st.messages, title ?? defaultTitle(st)));
  await refreshLibrary();
}

export function initBuilder(c: BuilderCtx) {
  ctx = c;
  const root = $('#builder');
  root.innerHTML = `
    <section id="b-sources">
      <h3>Sources</h3>
      <div class="b-btns">
        <button id="b-import">Import chat file…</button>
        <button id="b-save">Save current chat to library</button>
      </div>
      <div id="b-list"></div>
      <p class="hint" id="b-tokens"></p>
      <p class="hint">Imported and saved chats are kept in this browser (text only). Choose "Full story" to include the conversation itself; long stories are trimmed to the opening and the latest part.</p>
    </section>
    <section id="b-work">
      <div id="b-thread"></div>
      <div class="b-presets"></div>
      <div class="b-compose">
        <textarea id="b-prompt" rows="3" placeholder="Ask for new situations, character descriptions, memories… (Ctrl/Cmd+Enter to send)"></textarea>
        <div class="b-side">
          <div id="b-model" class="picker"></div>
          <button id="b-send" class="primary">Generate</button>
          <button id="b-clear">Clear thread</button>
        </div>
      </div>
    </section>`;

  const presets = root.querySelector('.b-presets')!;
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.textContent = p.label;
    b.addEventListener('click', () => { const ta = $<HTMLTextAreaElement>('#b-prompt'); ta.value = p.prompt; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
    presets.append(b);
  }
  $('#b-send').addEventListener('click', send);
  $('#b-clear').addEventListener('click', () => {
    if (busy) abort?.abort();
    ctx.state().builder.thread = []; ctx.persist(); renderThread();
  });
  $('#b-prompt').addEventListener('keydown', e => {
    const k = e as KeyboardEvent;
    if (k.key === 'Enter' && (k.ctrlKey || k.metaKey)) { k.preventDefault(); send(); }
  });
  $('#b-import').addEventListener('click', async () => {
    try {
      const t = await openTextFile();
      if (t === null) return;
      const draft = parseChatFile(JSON.parse(t), '');
      draft.title = prompt('Name for this chat in the library?', defaultTitle(draft)) ?? '';
      if (!draft.title.trim()) return;
      await libPut(draft);
      const b = ctx.state().builder;
      b.selected = [...new Set([...b.selected, draft.id])]; ctx.persist();
      await refreshLibrary();
    } catch (e) { ctx.banner(`Import failed: ${(e as Error).message}`); }
  });
  $('#b-save').addEventListener('click', async () => {
    const st = ctx.state();
    if (!st.messages.length) { ctx.toast('The current chat is empty.'); return; }
    const title = prompt('Name for this chat in the library?', defaultTitle(st));
    if (!title?.trim()) return;
    await archiveCurrent(title.trim());
    ctx.toast('Saved to the library.');
  });
  $('#b-thread').addEventListener('mousedown', e => { if ((e.target as HTMLElement).closest('button')) e.preventDefault(); }); // keep text selection
  $('#b-thread').addEventListener('click', e => {
    const btn = (e.target as HTMLElement).closest('button[data-a]') as HTMLElement | null;
    if (!btn) return;
    const el = btn.closest('.bmsg') as HTMLElement;
    const i = Number(el.dataset.i);
    const th = ctx.state().builder.thread;
    const body = el.querySelector('.body') as HTMLElement;
    if (btn.dataset.a === 'copy') { void navigator.clipboard?.writeText(pickText(body, th[i].content)); ctx.toast('Copied.'); }
    else if (btn.dataset.a === 'add') addTo((el.querySelector('select[data-t]') as HTMLSelectElement).value, pickText(body, th[i].content));
    else if (btn.dataset.a === 'regen' && !busy) { th.splice(i, 1); ctx.persist(); void run(); }
  });
  void refreshLibrary();
  renderThread();
}

/** Called when the Builder page is shown (and whenever the app re-renders while it is open). */
export function renderBuilder() {
  const b = ctx.state().builder;
  // Keep selection valid: drop ids that no longer exist; default to the current chat the first time.
  const ids = new Set(sources().map(s => s.id));
  b.selected = b.selected.filter(id => ids.has(id));
  renderSources();
}

export const builderBusy = () => busy;
