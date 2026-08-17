import type { ParsedQuery } from '../types';
import type { AiProvider, ChatMessage, EmbedModel } from './provider';
import { EMBED_MODELS, PARSE_SYSTEM_PROMPT, toParsedQuery } from './provider';

/**
 * Workers AI provider — the default (ADR-5).
 *
 * Available the moment the Cloudflare account is connected, so the product is
 * never blocked on a third-party key. Less precise than Gemini at structured
 * extraction, which is why the heuristic seed is merged into every result.
 */

/**
 * Query parsing is on the blocking search path, so it uses the fast 8B model:
 * the 70B variant measured ~4.5s end-to-end, which exceeded the parse timeout
 * and made every search silently fall back to the heuristic parser. Accuracy
 * loss is limited because the heuristic seed is merged into the result anyway
 * (see toParsedQuery).
 */
const PARSE_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

/** Chat is streamed, so a larger, slower model is fine — tokens arrive live. */
const CHAT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const VISION_MODEL = '@cf/llava-hf/llava-1.5-7b-hf';

/**
 * Extract a JSON object from a model response.
 *
 * Deliberately shape-tolerant: Workers AI's `response` field is usually a string
 * but can arrive already-parsed as an object, which previously threw
 * `text.trim is not a function` and silently disabled AI parsing for every
 * search. When it is already an object, that IS the answer — use it directly.
 */
export function coerceJsonObject(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;

  const cleaned = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  if (!cleaned) return null;

  try {
    return JSON.parse(cleaned);
  } catch {
    // Models often wrap JSON in a sentence; take the outermost braces.
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

export function workersAiProvider(ai: Ai): AiProvider {
  const embedModel: EmbedModel = EMBED_MODELS['workers-ai'];

  return {
    name: 'workers-ai',
    embedModel,

    async parseQuery(query: string, seed: ParsedQuery): Promise<ParsedQuery | null> {
      const userPrompt = `<query>${query}</query>

A deterministic pre-parse found (may be incomplete):
${JSON.stringify({
  categories: seed.categories,
  colors: seed.colors,
  occasions: seed.occasions,
  price_max_rupees: seed.price_max ? seed.price_max / 100 : undefined,
  price_min_rupees: seed.price_min ? seed.price_min / 100 : undefined,
  sizes: seed.sizes,
  intent: seed.intent,
})}

Respond with ONLY the JSON object.`;

      const res = (await ai.run(PARSE_MODEL, {
        messages: [
          { role: 'system', content: PARSE_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 700,
      })) as { response?: unknown };

      const parsed = coerceJsonObject(res.response);
      return parsed ? toParsedQuery(parsed, seed, 'workers-ai') : null;
    },

    async embed(texts: string[]): Promise<Float32Array[] | null> {
      // bge-small accepts up to 100 inputs per call.
      const res = (await ai.run(embedModel.model, { text: texts })) as {
        data?: number[][];
      };
      const rows = res.data ?? [];
      if (rows.length !== texts.length) return null;
      const out = rows.map((r) => new Float32Array(r));
      if (out.some((v) => v.length !== embedModel.dim)) return null;
      return out;
    },

    async vision(image: ArrayBuffer, _mime: string): Promise<ParsedQuery | null> {
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
        confidence: 0.4,
      };

      // LLaVA produces a caption, not JSON. Caption first, then reuse the text
      // parser on the caption — two cheap calls beat one unreliable one.
      const caption = (await ai.run(VISION_MODEL, {
        image: [...new Uint8Array(image)],
        prompt:
          'Describe only the main clothing item or accessory: its type, colour, fabric and silhouette. One sentence, no preamble.',
        max_tokens: 120,
      })) as { description?: unknown };

      const text = typeof caption.description === 'string' ? caption.description.trim() : '';
      if (!text) return null;

      const { heuristicParse } = await import('./heuristic');
      const fromCaption = heuristicParse(text);
      fromCaption.intent = 'image';
      fromCaption.provider = 'workers-ai-vision';
      fromCaption.semantic_text = text.slice(0, 300);
      fromCaption.confidence = Math.max(0.4, fromCaption.confidence - 0.1);
      return toParsedQuery(
        {
          semantic_text: fromCaption.semantic_text,
          intent: 'image',
          categories: fromCaption.categories,
          colors: fromCaption.colors,
          materials: fromCaption.materials,
          style_tags: fromCaption.style_tags,
          occasions: fromCaption.occasions,
          confidence: fromCaption.confidence,
        },
        { ...seed, semantic_text: fromCaption.semantic_text },
        'workers-ai-vision',
      );
    },

    async *chat(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
      const stream = (await ai.run(CHAT_MODEL, {
        messages,
        stream: true,
        temperature: 0.7,
        max_tokens: 900,
      })) as ReadableStream;

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          if (signal?.aborted) break;
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
              const obj = JSON.parse(payload) as { response?: string };
              if (obj.response) yield obj.response;
            } catch {
              // Ignore malformed frames.
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
