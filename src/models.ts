// Image models that passed the NSFW-prompt test (tools/model-test). Price = measured $/image at 1:1.
export interface ImageModel {
  id: string;
  label: string;
  price: number;
  speed: string;
  /** Provider passthrough options that relax moderation, if the provider has such a knob. */
  prov?: [provider: string, options: Record<string, unknown>];
}

export const IMAGE_MODELS: ImageModel[] = [
  { id: 'black-forest-labs/flux.2-klein-4b', label: 'FLUX.2 klein 4B', price: 0.014, speed: '~4s', prov: ['black-forest-labs', { safety_tolerance: 5 }] },
  { id: 'black-forest-labs/flux.2-pro', label: 'FLUX.2 pro', price: 0.03, speed: '~13s', prov: ['black-forest-labs', { safety_tolerance: 5 }] },
  { id: 'sourceful/riverflow-v2.5-fast', label: 'Riverflow v2.5 fast', price: 0.022, speed: '~40s' },
  { id: 'sourceful/riverflow-v2-fast', label: 'Riverflow v2 fast', price: 0.02, speed: '~3.5min' },
  { id: 'qwen/qwen-image-3', label: 'Qwen Image 3', price: 0.03, speed: '~85s' },
  { id: 'qwen/qwen-image-3-pro', label: 'Qwen Image 3 pro', price: 0.04, speed: '~60s' },
];

export const modelInfo = (id: string) => IMAGE_MODELS.find(m => m.id === id);
export const modelLabel = (m: ImageModel) => `${m.label} — $${m.price.toFixed(3)} · ${m.speed}`;
