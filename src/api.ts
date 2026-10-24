import { modelInfo } from './models';

const BASE = 'https://openrouter.ai/api/v1';

export interface ChatMsg { role: 'system' | 'user' | 'assistant'; content: string }

function headers(key: string) {
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': location.origin,
    'X-Title': 'WriteTogether',
  };
}

async function fail(res: Response): Promise<never> {
  let detail = '';
  try { detail = (await res.json())?.error?.message ?? ''; } catch { /* ignore */ }
  throw new Error(`OpenRouter ${res.status}${detail ? `: ${detail}` : ''}`);
}

/** Streams a chat completion, calling onToken with each text delta. Returns full text. */
export async function streamChat(
  key: string, model: string, messages: ChatMsg[],
  onToken: (delta: string, full: string) => void, signal: AbortSignal,
  reasoning?: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers: headers(key), signal,
    body: JSON.stringify({ model, messages, stream: true, ...(reasoning && { reasoning }) }),
  });
  if (!res.ok) return fail(res);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // also skips ": OPENROUTER PROCESSING" comments
      const data = line.slice(5).trim();
      if (data === '[DONE]') return full;
      try {
        const j = JSON.parse(data);
        if (j.error) throw new Error(j.error.message ?? 'Stream error');
        const delta: string | undefined = j.choices?.[0]?.delta?.content;
        if (delta) { full += delta; onToken(delta, full); }
      } catch (e) { if (e instanceof SyntaxError) continue; throw e; }
    }
  }
  return full;
}

export async function completeChat(key: string, model: string, messages: ChatMsg[]): Promise<string> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers: headers(key),
    body: JSON.stringify({ model, messages }),
  });
  if (!res.ok) return fail(res);
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content;
  if (!text) throw new Error('Model returned no content');
  return String(text).trim();
}

/** Text-to-image via OpenRouter's /images endpoint. Returns a data: or http URL. */
export async function generateImage(
  key: string, model: string, prompt: string, aspect: string, refs: string[] = [],
): Promise<string> {
  const prov = modelInfo(model)?.prov;
  const res = await fetch(`${BASE}/images`, {
    method: 'POST', headers: headers(key),
    body: JSON.stringify({
      model, prompt, n: 1, aspect_ratio: aspect,
      ...(prov && { provider: { options: { [prov[0]]: prov[1] } } }),
      ...(refs.length && { input_references: refs.map(url => ({ type: 'image_url', image_url: { url } })) }),
    }),
  });
  if (!res.ok) return fail(res);
  const item = (await res.json()).data?.[0];
  if (item?.b64_json) return `data:${item.media_type ?? 'image/png'};base64,${item.b64_json}`;
  if (item?.url) return item.url;
  throw new Error('No image returned (the model may have refused the prompt)');
}

// ---- Thinking (reasoning) control -------------------------------------------------------------
// OpenRouter takes a unified `reasoning` parameter, but what a model allows differs: some can't turn
// thinking off ("mandatory") and each supports a different set of effort levels. /models tells us which.

export type Thinking = 'default' | 'off' | 'low' | 'high' | 'max';
interface ReasoningInfo { mandatory?: boolean; default_enabled?: boolean; default_effort?: string; supported_efforts?: string[] }
let reasoningInfo: Map<string, ReasoningInfo> | null = null;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Fetches model capabilities once (public endpoint). Failure is harmless: requests then use best-effort values. */
export async function loadReasoningInfo(): Promise<void> {
  if (reasoningInfo) return;
  try {
    const res = await fetch(`${BASE}/models`);
    if (!res.ok) return;
    const data = (await res.json()).data as { id: string; reasoning?: ReasoningInfo }[];
    reasoningInfo = new Map(data.filter(m => m.reasoning).map(m => [m.id, m.reasoning!]));
  } catch { /* offline or blocked: ignore */ }
}

/** The `reasoning` request value for the user's setting on this model, plus a plain-language note. */
export function reasoningFor(model: string, setting: Thinking): { param?: Record<string, unknown>; note: string } {
  if (setting === 'default') return { note: describeDefault(model) };
  const info = reasoningInfo?.get(model);
  const want = setting === 'off' ? 'none' : setting;
  if (!info) return { param: want === 'none' ? { enabled: false } : { effort: want }, note: 'Model capabilities unknown; sending the setting as-is.' };
  const sup = (info.supported_efforts ?? []).filter(e => e !== 'none');
  const nearest = (target: string) => sup.length
    ? sup.reduce((a, b) => (Math.abs(EFFORTS.indexOf(b) - EFFORTS.indexOf(target)) < Math.abs(EFFORTS.indexOf(a) - EFFORTS.indexOf(target)) ? b : a))
    : target;
  if (want === 'none') {
    if (!info.mandatory) return { param: { effort: 'none' }, note: 'Thinking off.' };
    const low = nearest('low');
    return { param: { effort: low }, note: `This model always thinks and cannot be switched off, so "Off" uses its lowest level (${low}).` };
  }
  const use = nearest(want);
  return { param: { effort: use }, note: use === want ? `Thinking ${use}.` : `This model has no "${want}" level; using "${use}".` };
}

function describeDefault(model: string): string {
  const i = reasoningInfo?.get(model);
  if (!i) return 'Uses the model\'s own default.';
  const on = i.default_enabled ? `thinks by default${i.default_effort ? ` (${i.default_effort})` : ''}` : 'does not think by default';
  return `Model default: ${on}${i.mandatory ? '; thinking cannot be turned off' : ''}.`;
}
