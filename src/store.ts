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
  autoImage: boolean;       // generate a companion image automatically after each reply
  view: 'paged' | 'chat';
  sidebar: boolean;         // setup sidebar (scene, characters, settings) shown
}

export interface State { scene: string; cast: Record<Who, Character>; messages: Message[]; settings: Settings }  // scene is saved with the chat

export const DEFAULT_SYSTEM_PROMPT =
  'You are the narrator and game master of an interactive, turn-based roleplay with the user. Stay in the ' +
  'story, write vivid prose, and let the user decide what their character does and says. Messages in the form ' +
  '[OOC: ...] are out-of-character instructions from the user to you: follow them, and if you need to answer ' +
  'them directly, do so briefly in the same [OOC: ...] format, separate from the story.';

export const defaults: State = {
  scene: '',
  cast: { you: { name: '', description: '' }, them: { name: '', description: '' } },
  messages: [],
  settings: {
    apiKey: '',
    chatModel: DEFAULT_CHAT_MODEL,
    promptModel: DEFAULT_PROMPT_MODEL,
    imageModel: DEFAULT_IMAGE_MODEL,
    aspect: '3:4',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    autoImage: false,
    view: 'paged',
    sidebar: true,
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
    if (v) {
      // Migrate: the old single "system instructions / scene" box becomes the chat's scene.
      const old = v as State & { system?: string };
      const scene = old.scene ?? old.system ?? '';
      delete old.system;
      const cast = { you: { ...defaults.cast.you, ...old.cast?.you }, them: { ...defaults.cast.them, ...old.cast?.them } };
      return { ...defaults, ...old, scene, cast, settings: { ...defaults.settings, ...old.settings } };
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
