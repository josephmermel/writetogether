// Image models that passed the NSFW-prompt test (tools/model-test). Price = measured $/image at 1:1.
export interface ImageModel {
  id: string;
  label: string;
  price: number;
  speed: string;
  /** Reference-image support: max images, and measured extra $ per reference image. Absent = not usable. */
  maxRefs?: number;
  refCost?: number;
  /** Output size tier sent as `resolution` (some models price by tier; omit for the model default). */
  resolution?: string;
  /** Provider passthrough options that relax moderation, if the provider has such a knob. */
  prov?: [provider: string, options: Record<string, unknown>];
}

export const IMAGE_MODELS: ImageModel[] = [
  { id: 'black-forest-labs/flux.2-klein-4b', label: 'FLUX.2 klein 4B', price: 0.014, speed: '~4s', maxRefs: 4, refCost: 0.001, prov: ['black-forest-labs', { safety_tolerance: 5 }] },
  { id: 'black-forest-labs/flux.2-pro', label: 'FLUX.2 pro', price: 0.03, speed: '~13s', maxRefs: 8, refCost: 0.015, prov: ['black-forest-labs', { safety_tolerance: 5 }] },
  // New in Oct 2026, not yet checked against the moderation test. BFL approves safety_tolerance per model:
  // for FLUX 3 the maximum approved for this account is 4 (sending 5 returns a 422). Reference cost unmeasured.
  { id: 'black-forest-labs/flux-3-image-klein', label: 'FLUX 3 Klein (new)', price: 0.008, speed: 'untested', maxRefs: 10, refCost: 0, resolution: '768', prov: ['black-forest-labs', { safety_tolerance: 4 }] },
  // Qwen Image 2.1 Turbo: flat $0.0184 at 1K and 2K; reference images are free on OpenRouter. Qwen Image 3 had its
  // references blocked by Alibaba's moderation; 2.1 is untested with references (blocked ones fall back to text-only).
  { id: 'qwen/qwen-image-2.1-turbo', label: 'Qwen Image 2.1 Turbo', price: 0.0184, speed: 'untested', maxRefs: 4, refCost: 0, resolution: '1K' },
  { id: 'sourceful/riverflow-v2.5-fast', label: 'Riverflow v2.5 fast', price: 0.022, speed: '~40s', maxRefs: 4, refCost: 0.065 },
  { id: 'sourceful/riverflow-v2-fast', label: 'Riverflow v2 fast', price: 0.02, speed: '~3.5min', maxRefs: 4, refCost: 0.2 },
  // Qwen: Alibaba's moderation blocked requests once reference images were attached, so no maxRefs.
  { id: 'qwen/qwen-image-3', label: 'Qwen Image 3', price: 0.03, speed: '~85s' },
  { id: 'qwen/qwen-image-3-pro', label: 'Qwen Image 3 pro', price: 0.04, speed: '~60s' },
];

export const modelInfo = (id: string) => IMAGE_MODELS.find(m => m.id === id);
export const modelLabel = (m: ImageModel) => `${m.label} — $${m.price.toFixed(3)} · ${m.speed}`;

export interface TextModel { id: string; label: string }

export const TEXT_MODELS: TextModel[] = [
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash' },
  { id: '~deepseek/deepseek-flash-latest', label: 'DeepSeek Flash (latest)' },
];

// Defaults for new installs. Saved settings in the browser take precedence.
export const DEFAULT_CHAT_MODEL = TEXT_MODELS[0].id;
export const DEFAULT_PROMPT_MODEL = ''; // '' = same as the chat model
export const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[0].id;
