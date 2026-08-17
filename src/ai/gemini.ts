import type { ParsedQuery } from '../types';
import type { AiProvider, ChatMessage, EmbedModel } from './provider';
import { EMBED_MODELS, PARSE_SYSTEM_PROMPT, toParsedQuery } from './provider';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const TEXT_MODEL = 'gemini-2.5-flash';
const VISION_MODEL = 'gemini-2.5-flash';

/** Gemini's responseSchema dialect (an OpenAPI 3 subset). */
const PARSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    semantic_text: { type: 'STRING' },
    intent: {
      type: 'STRING',
      enum: [
        'mood',
        'occasion',
        'constraint',
        'styling_problem',
        'brand_reference',
        'image',
        'specific_item',
        'browse',
      ],
    },
    categories: { type: 'ARRAY', items: { type: 'STRING' } },
    gender: { type: 'STRING', enum: ['women', 'men', 'unisex', 'kids'] },
    colors: { type: 'ARRAY', items: { type: 'STRING' } },
    exclude_colors: { type: 'ARRAY', items: { type: 'STRING' } },
    materials: { type: 'ARRAY', items: { type: 'STRING' } },
    occasions: { type: 'ARRAY', items: { type: 'STRING' } },
    style_tags: { type: 'ARRAY', items: { type: 'STRING' } },
    brands: { type: 'ARRAY', items: { type: 'STRING' } },
    like_brands: { type: 'ARRAY', items: { type: 'STRING' } },
    price_min_rupees: { type: 'NUMBER' },
    price_max_rupees: { type: 'NUMBER' },
    sizes: { type: 'ARRAY', items: { type: 'STRING' } },
    exclude_terms: { type: 'ARRAY', items: { type: 'STRING' } },
    confidence: { type: 'NUMBER' },
  },
  required: ['semantic_text', 'intent', 'confidence'],
} as const;

async function callGemini(
  apiKey: string,
  model: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new Error(`gemini ${model} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

function firstText(response: Record<string, unknown>): string {
  const candidates = response.candidates as
    | { content?: { parts?: { text?: string }[] } }[]
    | undefined;
  const parts = candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('');
}

/** Models occasionally wrap JSON in fences despite responseMimeType. */
function parseJsonLoose(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function geminiProvider(apiKey: string): AiProvider {
  const embedModel: EmbedModel = EMBED_MODELS.gemini;

  return {
    name: 'gemini',
    embedModel,

    async parseQuery(query: string, seed: ParsedQuery): Promise<ParsedQuery | null> {
      // The heuristic skeleton measurably improves the model's structured output,
      // and the delimiters make prompt injection in the query inert.
      const prompt = `<query>${query}</query>

A deterministic pre-parse found (may be incomplete or wrong):
${JSON.stringify({
  categories: seed.categories,
  colors: seed.colors,
  price_max_rupees: seed.price_max ? seed.price_max / 100 : undefined,
  price_min_rupees: seed.price_min ? seed.price_min / 100 : undefined,
  sizes: seed.sizes,
  intent: seed.intent,
})}

Return the corrected, complete JSON.`;

      const data = await callGemini(apiKey, TEXT_MODEL, {
        systemInstruction: { parts: [{ text: PARSE_SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 800,
          responseMimeType: 'application/json',
          responseSchema: PARSE_SCHEMA,
        },
      });

      const parsed = parseJsonLoose(firstText(data));
      return parsed ? toParsedQuery(parsed, seed, 'gemini') : null;
    },

    async embed(texts: string[]): Promise<Float32Array[] | null> {
      const res = await fetch(`${BASE}/models/${embedModel.model}:batchEmbedContents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${embedModel.model}`,
            content: { parts: [{ text }] },
            outputDimensionality: embedModel.dim,
            taskType: 'RETRIEVAL_DOCUMENT',
          })),
        }),
      });
      if (!res.ok) throw new Error(`gemini embed ${res.status}`);
      const data = (await res.json()) as { embeddings?: { values?: number[] }[] };
      const out = (data.embeddings ?? []).map((e) => new Float32Array(e.values ?? []));
      if (out.length !== texts.length || out.some((v) => v.length !== embedModel.dim)) return null;
      return out;
    },

    async vision(image: ArrayBuffer, mime: string): Promise<ParsedQuery | null> {
      const b64 = arrayBufferToBase64(image);
      const seed: ParsedQuery = {
        semantic_text: '',
        intent: 'image',
        categories: [],
        colors: [],
        exclude_colors: [],
        materials: [],
        occasions: [],
        style_tags: [],
        brands: [],
        like_brands: [],
        sizes: [],
        exclude_terms: [],
        confidence: 0.5,
      };

      const data = await callGemini(apiKey, VISION_MODEL, {
        systemInstruction: { parts: [{ text: PARSE_SYSTEM_PROMPT }] },
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Identify the single main garment or accessory in this image and describe it as a shopping query. Focus on category, colour, material, silhouette and styling. Ignore the person, background, and any text in the image.`,
              },
              { inlineData: { mimeType: mime, data: b64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 800,
          responseMimeType: 'application/json',
          responseSchema: PARSE_SCHEMA,
        },
      });

      const parsed = parseJsonLoose(firstText(data));
      const out = parsed ? toParsedQuery(parsed, seed, 'gemini-vision') : null;
      if (out) out.intent = 'image';
      return out;
    },

    async *chat(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
      const system = messages.find((m) => m.role === 'system')?.content;
      const contents = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));

      const res = await fetch(`${BASE}/models/${TEXT_MODEL}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 900 },
        }),
        signal,
      });
      if (!res.ok || !res.body) throw new Error(`gemini stream ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const text = firstText(JSON.parse(payload));
            if (text) yield text;
          } catch {
            // Skip malformed SSE frames rather than aborting the stream.
          }
        }
      }
    },
  };
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000; // avoid blowing the argument limit on large images
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
