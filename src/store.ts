import { DEFAULT_CHAT_MODEL, DEFAULT_IMAGE_MODEL, DEFAULT_PROMPT_MODEL } from './models';

export type Who = 'you' | 'them'; // you = the user's character, them = the narrator's character
export interface Character { name: string; description: string; image?: string; avatar?: string }

export interface MsgImage { src?: string; prompt: string; error?: string; model?: string; refs?: Who[]; note?: string }

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  ooc?: boolean;            // user message sent as [OOC: ...]
  variants: string[];       // alternative answers (regenerate keeps the old ones)
  active: number;
  image?: MsgImage;                    // image for the active variant
  variantImages?: (MsgImage | null)[]; // images of the other variants, indexed like `variants`
}

export interface Settings {
  apiKey: string;
  chatModel: string;
  promptModel: string;      // drafts image prompts; defaults to chat model if empty
  imageModel: string;
  aspect: string;
  systemPrompt: string;     // part of settings (saved with the settings file)
  useRefs: boolean;         // send character portraits to the image model as reference images
  autoImage: boolean;       // generate a companion image automatically after each reply
  view: 'paged' | 'chat' | 'builder';
  memories: string;         // short background facts, sent to the model with the system instructions
  builderModel: string;     // model for the Builder page ('' = chat model)
  sidebar: boolean;         // setup sidebar (scene, characters, settings) shown
}

export interface BuilderMsg { role: 'user' | 'assistant'; content: string }
/** Builder page working state (kept in the browser so a reload doesn't lose the thread). */
export interface BuilderState {
  thread: BuilderMsg[];
  selected: string[];                       // source ids ('current' or library ids)
  detail: Record<string, 'cast' | 'full'>;  // how much of each source to include
}

export interface State {
  scene: string; // saved with the chat
  cast: Record<Who, Character>;
  messages: Message[];
  settings: Settings;
  builder: BuilderState;
}

export const DEFAULT_SYSTEM_PROMPT =
  'You are the narrator and game master of an interactive, turn-based roleplay with the user. Stay in the ' +
  'story, write vivid prose, and let the user decide what their character does and says. Messages in the form ' +
  '[OOC: ...] are out-of-character instructions from the user to you: follow them, and if you need to answer ' +
  'them directly, do so briefly in the same [OOC: ...] format, separate from the story.';

export const defaults: State = {
  scene: '',
  cast: { you: { name: '', description: '' }, them: { name: '', description: '' } },
  messages: [],
  builder: { thread: [], selected: [], detail: {} },
  settings: {
    apiKey: '',
    chatModel: DEFAULT_CHAT_MODEL,
    promptModel: DEFAULT_PROMPT_MODEL,
    imageModel: DEFAULT_IMAGE_MODEL,
    aspect: '3:4',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    useRefs: true,
    autoImage: false,
    view: 'paged',
    sidebar: true,
    memories: '',
    builderModel: '',
  },
};

// IndexedDB: localStorage's ~5MB cap is quickly hit by base64 images.
const open = () => new Promise<IDBDatabase>((res, rej) => {
  const r = indexedDB.open('writetogether', 2);
  r.onupgradeneeded = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    if (!db.objectStoreNames.contains('library')) db.createObjectStore('library', { keyPath: 'id' });
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

export async function load(): Promise<State> {
  try {
    const db = await open();
    const v = await new Promise<State | undefined>((res, rej) => {
      const q = db.transaction('kv').objectStore('kv').get('state');
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
    if (v) {
      // Migrate: the old single "system instructions / scene" box becomes the chat's scene.
      const old = v as State & { system?: string };
      const scene = old.scene ?? old.system ?? '';
      delete old.system;
      const cast = { you: { ...defaults.cast.you, ...old.cast?.you }, them: { ...defaults.cast.them, ...old.cast?.them } };
      const builder = { ...defaults.builder, ...old.builder };
      return { ...defaults, ...old, scene, cast, builder, settings: { ...defaults.settings, ...old.settings } };
    }
  } catch { /* fall through */ }
  return structuredClone(defaults);
}

let timer: number | undefined;
export function save(s: State) {
  clearTimeout(timer);
  timer = window.setTimeout(async () => {
    try {
      const db = await open();
      db.transaction('kv', 'readwrite').objectStore('kv').put(structuredClone(s), 'state');
    } catch (e) { console.warn('save failed', e); }
  }, 300);
}

export const uid = () => crypto.randomUUID();
export const text = (m: Message) => m.variants[m.active] ?? '';

// ---- Library: past chats kept in the browser (text only, no images) so the Builder page can learn from them.

export interface LibraryChat {
  id: string;
  title: string;
  savedAt: number;
  scene: string;
  cast: Record<Who, { name: string; description: string }>;
  messages: { role: 'user' | 'assistant'; ooc?: boolean; text: string }[];
}

const slim = (c: Character) => ({ name: c.name ?? '', description: c.description ?? '' });

export function toLibrary(scene: string, cast: Record<Who, Character>, messages: Message[], title: string): LibraryChat {
  return {
    id: uid(), title, savedAt: Date.now(), scene,
    cast: { you: slim(cast.you), them: slim(cast.them) },
    messages: messages.map(m => ({ role: m.role, ooc: m.ooc || undefined, text: text(m) })),
  };
}

/** Accepts any chat export this app has produced (v1 `system`, v2 `scene`, v3 with `cast`). */
export function parseChatFile(j: unknown, title: string): LibraryChat {
  const o = j as { scene?: unknown; system?: unknown; cast?: Record<string, Partial<Character>>; messages?: unknown };
  if (!o || !Array.isArray(o.messages)) throw new Error('not a chat export');
  const msgs = (o.messages as Partial<Message>[]).map(m => ({
    role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
    ooc: m.ooc || undefined,
    text: String(m.variants?.[m.active ?? 0] ?? ''),
  })).filter(m => m.text);
  return {
    id: uid(), title, savedAt: Date.now(),
    scene: typeof o.scene === 'string' ? o.scene : typeof o.system === 'string' ? o.system : '',
    cast: { you: slim({ name: '', description: '', ...o.cast?.you }), them: slim({ name: '', description: '', ...o.cast?.them }) },
    messages: msgs,
  };
}

const tx = async <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await open();
  return new Promise((res, rej) => {
    const r = f(db.transaction('library', mode).objectStore('library'));
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
};
export const libList = async () => ((await tx<LibraryChat[]>('readonly', s => s.getAll())) ?? []).sort((a, b) => b.savedAt - a.savedAt);
export const libPut = (c: LibraryChat) => tx('readwrite', s => s.put(c));
export const libDelete = (id: string) => tx('readwrite', s => s.delete(id));
