export interface Message {
  id: string;
  role: 'user' | 'assistant';
  ooc?: boolean;            // user message sent as [OOC: ...]
  variants: string[];       // alternative answers (regenerate keeps the old ones)
  active: number;
  image?: { src?: string; prompt: string; error?: string };
}

export interface Settings {
  apiKey: string;
  chatModel: string;
  promptModel: string;      // drafts image prompts; defaults to chat model if empty
  imageModel: string;
  aspect: string;
}

export interface State { system: string; messages: Message[]; settings: Settings }

export const defaults: State = {
  system: '',
  messages: [],
  settings: {
    apiKey: '',
    chatModel: 'anthropic/claude-sonnet-4.5',
    promptModel: '',
    imageModel: 'black-forest-labs/flux.2-klein-4b',
    aspect: '3:4',
  },
};

// IndexedDB: localStorage's ~5MB cap is quickly hit by base64 images.
const open = () => new Promise<IDBDatabase>((res, rej) => {
  const r = indexedDB.open('writetogether', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
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
    if (v) return { ...defaults, ...v, settings: { ...defaults.settings, ...v.settings } };
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
