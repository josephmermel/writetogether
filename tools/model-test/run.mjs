#!/usr/bin/env node
// Runs one image prompt against a curated list of cheap OpenRouter image models and writes a gallery.
//   OPENROUTER_API_KEY=sk-or-... node tools/model-test/run.mjs [--dry] [--budget 4] [--only a,b] [--aspect 1:1]
// Prompt is read from tools/model-test/prompt.txt (gitignored). Output: tools/model-test/results/<timestamp>/
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = n => args.includes(`--${n}`);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const BUDGET = Number(opt('budget', 4));
const ASPECT = opt('aspect', '1:1');
const only = opt('only', '')?.split(',').filter(Boolean);

// est = rough $/image at the cheapest setting (null = token-priced/unknown; real cost is read from the response).
// opts = provider passthrough params that RELAX moderation where the provider exposes such a knob.
const L = { quality: 'low' };
const OAI = { moderation: 'low' };
const MODELS = [
  { id: 'recraft/recraft-v4.1-flash', est: 0.007 },
  { id: 'openai/gpt-image-1-mini', est: 0.005, body: L, prov: ['openai', OAI] },
  { id: 'openai/gpt-image-2', est: 0.006, body: L, prov: ['openai', OAI] },
  { id: 'openai/gpt-image-2.5-flare', est: 0.01, body: L, prov: ['openai', OAI] },
  { id: 'openai/gpt-image-2.5-sunburst', est: 0.01, body: L, prov: ['openai', OAI] },
  { id: 'openai/gpt-5-image-mini', est: 0.01, body: L, prov: ['openai', OAI] },
  { id: 'openai/gpt-image-1', est: 0.011, body: L, prov: ['openai', OAI] },
  { id: 'openai/gpt-5.4-image-2', est: 0.02, body: L, prov: ['openai', OAI] },
  { id: 'black-forest-labs/flux.2-klein-4b', est: 0.014, prov: ['black-forest-labs', { safety_tolerance: 5 }] },
  { id: 'black-forest-labs/flux.2-pro', est: 0.03, prov: ['black-forest-labs', { safety_tolerance: 5 }] },
  { id: 'bytedance-seed/seedream-5-0-flash', est: 0.018 },
  { id: 'bytedance-seed/seedream-5-0-lite', est: 0.035 },
  { id: 'bytedance-seed/seedream-4.5', est: 0.04 },
  { id: 'sourceful/riverflow-v2.5-fast', est: 0.019 },
  { id: 'sourceful/riverflow-v2-fast', est: 0.02 },
  { id: 'qwen/qwen-image-3', est: 0.03 },
  { id: 'qwen/qwen-image-3-pro', est: 0.04 },
  { id: 'x-ai/grok-imagine-image-2.0', est: 0.04, body: L }, // control: known to pass
  { id: 'recraft/recraft-v4.1', est: 0.035 },
  { id: 'recraft/recraft-v4-styles', est: 0.035 },
  { id: 'recraft/recraft-v4', est: 0.04 },
  { id: 'recraft/recraft-v3', est: 0.04 },
  { id: 'tencent/hy-image-v3.5-preview', est: null },
  { id: 'meta/muse-image', est: null },
  { id: 'microsoft/mai-image-2.6-flash', est: null },
  { id: 'krea/krea-2-medium-turbo', est: null },
  { id: 'krea/krea-2-medium', est: null },
  { id: 'google/gemini-3.1-flash-lite-image', est: 0.034 },
  { id: 'google/gemini-nano-banana-2.1', est: 0.034 },
  { id: 'google/gemini-2.5-flash-image', est: 0.039 },
].filter(m => !only?.length || only.includes(m.id));

const total = MODELS.reduce((s, m) => s + (m.est ?? 0.03), 0);
console.log(`${MODELS.length} models, estimated total ≈ $${total.toFixed(2)} (budget $${BUDGET})`);
if (flag('dry')) { MODELS.forEach(m => console.log(' ', m.id, m.est ?? '(token-priced)')); process.exit(0); }

const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('Set OPENROUTER_API_KEY'); process.exit(1); }
const prompt = readFileSync(join(here, 'prompt.txt'), 'utf8').trim();
const dir = join(here, 'results', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(dir, { recursive: true });

let spent = 0;
const rows = [];
for (const m of MODELS) {
  if (spent + (m.est ?? 0.05) > BUDGET) { rows.push({ id: m.id, status: 'skipped (budget)' }); continue; }
  const body = { model: m.id, prompt, n: 1, aspect_ratio: ASPECT, ...m.body };
  if (m.prov) body.provider = { options: { [m.prov[0]]: m.prov[1] } };
  const t0 = Date.now();
  const row = { id: m.id, settings: { ...m.body, ...(m.prov?.[1] ?? {}) } };
  try {
    const res = await fetch('https://openrouter.ai/api/v1/images', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    row.cost = j.usage?.cost ?? 0;
    spent += row.cost;
    const img = j.data?.[0];
    if (res.ok && img?.b64_json) {
      const ext = (img.media_type ?? 'image/png').split('/')[1].replace('+xml', '');
      row.file = `${m.id.replace(/\//g, '__')}.${ext}`;
      writeFileSync(join(dir, row.file), Buffer.from(img.b64_json, 'base64'));
      row.status = 'image';
    } else {
      row.status = 'error';
      row.error = j.error?.message ?? `HTTP ${res.status} ${JSON.stringify(j).slice(0, 300)}`;
    }
  } catch (e) { row.status = 'error'; row.error = String(e); }
  row.ms = Date.now() - t0;
  rows.push(row);
  console.log(`${row.status.padEnd(7)} ${m.id}  $${(row.cost ?? 0).toFixed(4)}  ${row.error ?? ''}`.slice(0, 200));
}

writeFileSync(join(dir, 'results.json'), JSON.stringify({ prompt, aspect: ASPECT, spent, rows }, null, 1));
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
writeFileSync(join(dir, 'index.html'), `<!doctype html><meta charset=utf-8><title>Model test</title>
<style>body{font:14px system-ui;background:#111;color:#eee;margin:16px}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.c{background:#1c1c1c;border-radius:8px;padding:8px}img{width:100%;border-radius:6px}.e{color:#f88;font-size:12px;word-break:break-word}</style>
<p>${esc(prompt)}</p><p>Spent: $${spent.toFixed(3)}</p><div class=g>${rows.map(r => `<div class=c><b>${esc(r.id)}</b><br>${r.status} · $${(r.cost ?? 0).toFixed(4)}
${r.file ? `<img src="${esc(r.file)}">` : `<div class=e>${esc(r.error ?? '')}</div>`}<small>${esc(JSON.stringify(r.settings ?? {}))}</small></div>`).join('')}</div>`);
console.log(`\nSpent $${spent.toFixed(3)}. Open ${join(dir, 'index.html')}`);
