#!/usr/bin/env node
// Runs one image prompt against a curated list of cheap OpenRouter image models and writes a gallery.
//   OPENROUTER_API_KEY=sk-or-... node tools/model-test/run.mjs [--dry] [--budget 4] [--only a,b] [--aspect 1:1]
// Prompt is read from tools/model-test/prompt.txt (gitignored). Output: tools/model-test/results/<timestamp>/
//
// Reference-image mode (do two character portraits keep their faces in a scene image?):
//   node tools/model-test/run.mjs --refs [--portrait-model black-forest-labs/flux.2-klein-4b] [--portraits a.png,b.png]
//   Needs tools/model-test/portrait-a.txt and portrait-b.txt (one text-to-image prompt per character, gitignored),
//   unless --portraits is given. The two portraits are generated once, then passed as input_references together
//   with prompt.txt to every model in REF_MODELS. Reported cost includes any per-reference-image surcharge.
//   Add --isolate to run four variants per model (text only / portrait A only / portrait B only / both) to find
//   out WHAT gets blocked: the text, a particular portrait, or references in general. Blocked requests cost $0.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = n => args.includes(`--${n}`);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const BUDGET = Number(opt('budget', 4));
const ASPECT = opt('aspect', '1:1');
const only = opt('only', '')?.split(',').filter(Boolean);
const REFS = flag('refs');
const API = process.env.OPENROUTER_BASE ?? 'https://openrouter.ai/api/v1';
// Models that accept reference images AND passed the moderation test.
const REF_MODELS = ['black-forest-labs/flux.2-klein-4b', 'black-forest-labs/flux.2-pro', 'sourceful/riverflow-v2.5-fast',
  'sourceful/riverflow-v2-fast', 'qwen/qwen-image-3', 'qwen/qwen-image-3-pro',
  'black-forest-labs/flux-3-image-klein', 'qwen/qwen-image-2.1-turbo', 'qwen/qwen-image-2.1-pro'];

// est = rough $/image at the cheapest setting (null = token-priced/unknown; real cost is read from the response).
// opts = provider passthrough params that RELAX moderation where the provider exposes such a knob.
const L = { quality: 'low' };
const OAI = { moderation: 'low' };
const ALL = [
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
  // Added to OpenRouter in mid-October 2026:
  { id: 'black-forest-labs/flux-3-image-klein', est: 0.008, body: { resolution: '768' }, prov: ['black-forest-labs', { safety_tolerance: 5 }] },
  { id: 'qwen/qwen-image-2.1-turbo', est: 0.0184, body: { resolution: '1K' } },
  { id: 'qwen/qwen-image-2.1-pro', est: 0.046, body: { resolution: '1K' } },
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
];
const MODELS = ALL.filter(m => (REFS ? REF_MODELS.includes(m.id) : true) && (!only?.length || only.includes(m.id)));

const VARIANTS = REFS && flag('isolate') ? 4 : 1;
const total = MODELS.reduce((s, m) => s + (m.est ?? 0.03) * VARIANTS, 0) + (REFS && !opt('portraits') ? 0.03 : 0);
console.log(`${MODELS.length} models, estimated total ≈ $${total.toFixed(2)} (budget $${BUDGET})`);
if (flag('dry')) { MODELS.forEach(m => console.log(' ', m.id, m.est ?? '(token-priced)')); process.exit(0); }

const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('Set OPENROUTER_API_KEY'); process.exit(1); }
const read = f => readFileSync(join(here, f), 'utf8').trim();
const dir = join(here, 'results', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(dir, { recursive: true });
let spent = 0;

/** One image request. Returns { status, cost, b64?, ext?, error?, ms }. */
async function gen(model, prompt, { body = {}, prov, refs = [] } = {}) {
  const req = { model, prompt, n: 1, aspect_ratio: ASPECT, ...body };
  if (prov) req.provider = { options: { [prov[0]]: prov[1] } };
  if (refs.length) req.input_references = refs.map(url => ({ type: 'image_url', image_url: { url } }));
  const t0 = Date.now();
  const out = { status: 'error', cost: 0 };
  try {
    const res = await fetch(`${API}/images`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    const j = await res.json().catch(() => ({}));
    out.cost = j.usage?.cost ?? 0;
    spent += out.cost;
    const img = j.data?.[0];
    if (res.ok && img?.b64_json) {
      out.status = 'image'; out.b64 = img.b64_json;
      out.ext = (img.media_type ?? 'image/png').split('/')[1].replace('+xml', '');
    } else out.error = j.error?.message ?? `HTTP ${res.status} ${JSON.stringify(j).slice(0, 300)}`;
  } catch (e) { out.error = String(e); }
  out.ms = Date.now() - t0;
  return out;
}
const mime = ext => (ext === 'jpg' ? 'jpeg' : ext);
const save = (name, r) => { writeFileSync(join(dir, name), Buffer.from(r.b64, 'base64')); return name; };

const prompt = read('prompt.txt');
const rows = [];
let refUrls = [];
const extra = [];

if (REFS) {
  const pm = opt('portrait-model', 'black-forest-labs/flux.2-klein-4b');
  const given = opt('portraits', '');
  if (given) {
    refUrls = given.split(',').map(f => {
      const ext = f.split('.').pop().toLowerCase();
      return `data:image/${mime(ext)};base64,${readFileSync(f).toString('base64')}`;
    });
  } else {
    for (const [n, f] of [['a', 'portrait-a.txt'], ['b', 'portrait-b.txt']]) {
      if (!existsSync(join(here, f))) { console.error(`Missing tools/model-test/${f} (or pass --portraits a.png,b.png)`); process.exit(1); }
      const r = await gen(pm, read(f), { prov: ALL.find(m => m.id === pm)?.prov });
      console.log(`portrait ${n}: ${r.status} $${r.cost.toFixed(4)} ${r.error ?? ''}`);
      if (r.status !== 'image') process.exit(1);
      extra.push({ id: `portrait ${n}`, file: save(`portrait-${n}.${r.ext}`, r), cost: r.cost, status: 'portrait' });
      refUrls.push(`data:image/${mime(r.ext)};base64,${r.b64}`);
    }
  }
}
const finalPrompt = REFS
  ? 'Reference image 1 shows the first character and reference image 2 shows the second character. Keep each ' +
    'person\'s face, hair and build consistent with their reference image. Scene: ' + prompt
  : prompt;

const configs = REFS && flag('isolate')
  ? [
    { label: 'text only', prompt, refs: [] },
    { label: 'portrait A only', prompt: finalPrompt, refs: refUrls.slice(0, 1) },
    { label: 'portrait B only', prompt: finalPrompt, refs: refUrls.slice(1, 2) },
    { label: 'both portraits', prompt: finalPrompt, refs: refUrls },
  ]
  : [{ label: '', prompt: finalPrompt, refs: refUrls }];

for (const m of MODELS) {
  for (const c of configs) {
    const id = c.label ? `${m.id} [${c.label}]` : m.id;
    if (spent + (m.est ?? 0.05) > BUDGET) { rows.push({ id, status: 'skipped (budget)' }); continue; }
    const r = await gen(m.id, c.prompt, { body: m.body, prov: m.prov, refs: c.refs });
    const row = { id, settings: { ...m.body, ...(m.prov?.[1] ?? {}) }, cost: r.cost, status: r.status, ms: r.ms, error: r.error };
    if (r.b64) row.file = save(`${id.replace(/[\/ \[\]]+/g, '_')}.${r.ext}`, r);
    rows.push(row);
    console.log(`${row.status.padEnd(7)} ${id}  $${row.cost.toFixed(4)}  ${row.error ?? ''}`.slice(0, 220));
  }
}
rows.unshift(...extra);

writeFileSync(join(dir, 'results.json'), JSON.stringify({ prompt: finalPrompt, aspect: ASPECT, refs: REFS, spent, rows }, null, 1));
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
writeFileSync(join(dir, 'index.html'), `<!doctype html><meta charset=utf-8><title>Model test</title>
<style>body{font:14px system-ui;background:#111;color:#eee;margin:16px}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.c{background:#1c1c1c;border-radius:8px;padding:8px}img{width:100%;border-radius:6px}.e{color:#f88;font-size:12px;word-break:break-word}</style>
<p>${esc(finalPrompt)}</p><p>Spent: $${spent.toFixed(3)}</p><div class=g>${rows.map(r => `<div class=c><b>${esc(r.id)}</b><br>${r.status} · $${(r.cost ?? 0).toFixed(4)}
${r.file ? `<img src="${esc(r.file)}">` : `<div class=e>${esc(r.error ?? '')}</div>`}<small>${esc(JSON.stringify(r.settings ?? {}))}</small></div>`).join('')}</div>`);
console.log(`\nSpent $${spent.toFixed(3)}. Open ${join(dir, 'index.html')}`);
