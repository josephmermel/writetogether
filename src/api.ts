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
): Promise<string> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers: headers(key), signal,
    body: JSON.stringify({ model, messages, stream: true }),
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
export async function generateImage(key: string, model: string, prompt: string, aspect: string): Promise<string> {
  const res = await fetch(`${BASE}/images`, {
    method: 'POST', headers: headers(key),
    body: JSON.stringify({ model, prompt, n: 1, aspect_ratio: aspect }),
  });
  if (!res.ok) return fail(res);
  const item = (await res.json()).data?.[0];
  if (item?.b64_json) return `data:${item.media_type ?? 'image/png'};base64,${item.b64_json}`;
  if (item?.url) return item.url;
  throw new Error('No image returned (the model may have refused the prompt)');
}
