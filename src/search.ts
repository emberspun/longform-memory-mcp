/**
 * Recall across the whole document.
 *
 * Two tiers, and **the response always names which one ran**. A search that
 * silently degrades from semantic to lexical is indistinguishable, from the
 * outside, from a search that is simply bad — and the user's conclusion will be
 * "this thing can't find anything", not "my endpoint is misconfigured".
 */
import { encodeVector, searchTopK } from 'longform-memory';
import type { ChapterRecord } from './events.js';

export type SearchMode = 'lexical' | 'semantic';

export type SearchHit = {
  chapter: number;
  summary: string;
  score: number;
};

export type SearchOutcome = {
  mode: SearchMode;
  hits: SearchHit[];
  /** Set when semantic was configured but could not be used. Never silent. */
  note?: string;
};

// ── Tokenising ─────────────────────────────────────────────────────────────

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/u;

/**
 * Words for Latin scripts, character bigrams for CJK.
 *
 * CJK has no spaces, so single characters are far too common to discriminate
 * and whole strings never match. Bigrams are the standard answer and need no
 * segmenter — which matters, because a segmenter would be a dependency, and a
 * dependency is the thing this package is built to avoid.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = String(text ?? '').toLowerCase();
  for (const chunk of lower.split(/[^\p{L}\p{N}]+/u)) {
    if (!chunk) continue;
    if (CJK.test(chunk)) {
      const chars = [...chunk];
      if (chars.length === 1) out.push(chars[0]);
      for (let i = 0; i + 1 < chars.length; i++) {
        out.push(chars[i] + chars[i + 1]);
      }
    } else {
      out.push(chunk);
    }
  }
  return out;
}

// ── Lexical: BM25 ──────────────────────────────────────────────────────────

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * Okapi BM25 over chapter summaries.
 *
 * Real ranking, not a substring match: term saturation (`k1`) stops one
 * repeated word from dominating, and length normalisation (`b`) stops long
 * summaries from winning by sheer surface area. Over a few hundred short
 * documents this is both exact and instant.
 */
export function lexicalSearch(
  query: string,
  docs: ChapterRecord[],
  k: number
): SearchHit[] {
  const queryTerms = tokenize(query);
  if (!queryTerms.length || !docs.length) return [];

  const tokenized = docs.map((d) => ({ doc: d, terms: tokenize(d.summary) }));
  const avgLen =
    tokenized.reduce((sum, t) => sum + t.terms.length, 0) / tokenized.length ||
    1;

  const docFreq = new Map<string, number>();
  for (const { terms } of tokenized) {
    for (const term of new Set(terms)) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  const N = tokenized.length;
  const hits: SearchHit[] = [];
  for (const { doc, terms } of tokenized) {
    const counts = new Map<string, number>();
    for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);

    let score = 0;
    for (const term of new Set(queryTerms)) {
      const tf = counts.get(term);
      if (!tf) continue;
      const df = docFreq.get(term) ?? 0;
      // +0.5/+0.5 smoothing keeps IDF positive for terms in every document.
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const norm = tf * (BM25_K1 + 1);
      const denom =
        tf + BM25_K1 * (1 - BM25_B + (BM25_B * terms.length) / avgLen);
      score += idf * (norm / denom);
    }
    if (score > 0) hits.push({ chapter: doc.chapter, summary: doc.summary, score });
  }

  hits.sort((a, b) => b.score - a.score || a.chapter - b.chapter);
  return hits.slice(0, k);
}

// ── Semantic: opt-in, user's own endpoint ──────────────────────────────────

export type EmbedConfig = {
  url: string;
  key: string;
  model: string;
};

/**
 * Read the embedding endpoint from the environment. Absent = lexical only.
 *
 * Deliberately requires the caller to set all three: a half-configured
 * endpoint that quietly does nothing is worse than no feature.
 */
export function embedConfig(): EmbedConfig | null {
  const url = process.env.LONGFORM_MEMORY_EMBED_URL?.trim();
  const key = process.env.LONGFORM_MEMORY_EMBED_KEY?.trim();
  const model = process.env.LONGFORM_MEMORY_EMBED_MODEL?.trim();
  if (!url || !key || !model) return null;
  return { url, key, model };
}

const EMBED_TIMEOUT_MS = 20_000;

/** One OpenAI-compatible `/embeddings` call. Throws; callers decide policy. */
export async function embed(
  config: EmbedConfig,
  input: string
): Promise<string> {
  const res = await fetch(config.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: config.model, input }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`embedding endpoint returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const vector = data?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || !vector.length) {
    throw new Error('embedding endpoint returned no vector');
  }
  return encodeVector(vector);
}

/**
 * Semantic search over stored chapter vectors, falling back loudly.
 *
 * Vectors recorded under a different model are dropped rather than compared:
 * `searchTopK` already skips mismatched dimensions, but two models can share a
 * dimension count and still be unrelated spaces, which produces confident
 * nonsense instead of an obvious failure.
 */
export async function semanticSearch(
  config: EmbedConfig,
  query: string,
  docs: ChapterRecord[],
  embeddings: Map<number, { vec: string; model: string }>,
  k: number
): Promise<SearchOutcome> {
  const usable = docs
    .map((doc) => ({ doc, stored: embeddings.get(doc.chapter) }))
    .filter((row) => row.stored && row.stored.model === config.model);

  if (!usable.length) {
    return {
      mode: 'lexical',
      hits: lexicalSearch(query, docs, k),
      note: `No chapter embeddings stored for model "${config.model}" yet — re-run remember_chapter to build them. Fell back to lexical search.`,
    };
  }

  let queryVec: string;
  try {
    queryVec = await embed(config, query);
  } catch (error) {
    return {
      mode: 'lexical',
      hits: lexicalSearch(query, docs, k),
      note: `Semantic search unavailable (${(error as Error).message}). Fell back to lexical search.`,
    };
  }

  const decoded = Array.from(decodeQuery(queryVec));
  const scored = searchTopK(
    decoded,
    usable,
    (row) => row.stored!.vec,
    { k }
  );
  return {
    mode: 'semantic',
    hits: scored.map((s) => ({
      chapter: s.row.doc.chapter,
      summary: s.row.doc.summary,
      score: s.score,
    })),
  };
}

/** base64 float32 -> numbers, so the encoded query can go back through `searchTopK`. */
function decodeQuery(b64: string): Float32Array {
  const binary = Buffer.from(b64, 'base64');
  return new Float32Array(
    binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength)
  );
}
