/**
 * `recall_context`: turn a whole document's memory into one constant-size block.
 *
 * This is the reason the package exists. Chapter 1000 gets the same budget as
 * chapter 10 — see `longform-memory`'s `fitSections` and `skeletonChapters` for
 * why the skeleton is capped by *count* rather than sampled by stride.
 */
import {
  DEFAULT_MEMORY_BUDGET,
  estimateTokens,
  fitSections,
  skeletonChapters,
  type MemorySection,
} from 'longform-memory';
import type { ChapterRecord, MemoryState } from './events.js';
import type { SearchHit } from './search.js';

/** Chapters immediately before the target offered to the "recent" section. */
export const RECENT_WINDOW = 8;

/** Entities offered to the "entity" section, most recently touched first. */
export const ENTITY_CANDIDATES = 40;

/**
 * Section headings.
 *
 * English on purpose even for documents written in other languages: these are
 * *structural metadata* addressed to the model assembling the next chapter, not
 * prose that ends up in the book. (The sister rule in `longform-memory`'s
 * thread labels is the opposite — those are quoted back by the model and must
 * match the document's language. Do not merge the two.)
 */
export const SECTION_HEADINGS: Record<MemorySection, string> = {
  entity: '## Entities — current state',
  recent: '## Recent chapters',
  skeleton: '## Earlier arc (sampled)',
  retrieval: '## Related from earlier',
};

type EntityItem = {
  name: string;
  state: string;
  chapter: number;
  gone: boolean;
};

type ChapterItem = { chapter: number; summary: string };

/*
  One formatter per section, used for BOTH budgeting and rendering, and each
  line **carries its own trailing newline**.

  Both halves of that matter. If the two formatters diverge the diagnostics
  become fiction — the block reports 1,900 tokens while the text pasted into the
  prompt is 2,400, and the overflow surfaces as a context error with no trail
  back to here. And if the newline lives in a `join('\n')` instead of in the
  item, the separators are free at budgeting time and real at render time,
  which is the same lie in miniature: ~60 lines, ~15 tokens over.
*/
const fmtEntity = (e: EntityItem): string =>
  `- ${e.name}: ${e.state}${e.gone ? ' [left the story]' : ''} (as of ch.${e.chapter})\n`;

const fmtChapter = (c: ChapterItem): string =>
  `[ch.${c.chapter}] ${c.summary}\n`;

/**
 * Budget the headings before anything else gets to spend.
 *
 * `fitSections` only ever sees item text, so a heading it does not know about
 * is a heading that silently overruns the caller's ceiling. Reserved for all
 * four sections unconditionally: a variable reserve would make the amount of
 * memory you get depend on which sections happened to be empty, and "chapter
 * 1000 costs the same as chapter 10" is the one promise this package makes.
 */
const HEADING_RESERVE = Object.values(SECTION_HEADINGS).reduce(
  (sum, heading) => sum + estimateTokens(`${heading}\n\n`),
  0
);

export type SectionDiagnostic = {
  usedTokens: number;
  kept: number;
  dropped: number;
};

export type RecallResult = {
  /** Ready to paste into a prompt. */
  text: string;
  /** Estimated tokens of `text` itself — headings included. Never exceeds `budget`. */
  usedTokens: number;
  budget: number;
  sections: Record<MemorySection, SectionDiagnostic>;
  /** Which chapters ended up in each chapter-based section. */
  recentChapters: number[];
  skeletonChapters: number[];
  retrievalChapters: number[];
};

export type AssembleInput = {
  state: MemoryState;
  /** The chapter about to be written. Everything below it is history. */
  chapter: number;
  budget?: number;
  /** Retrieval hits, already ranked. Pass `[]` to skip that section. */
  retrieval?: SearchHit[];
};

/** Entity cards, most recently updated first — stale ones fall off the tail. */
function entityItems(state: MemoryState, upTo: number): EntityItem[] {
  const items: EntityItem[] = [];
  for (const entity of state.entities.values()) {
    /*
      Only what was known *before* this chapter. Feeding back a state recorded
      in the chapter being written is a subtle way to leak the future into the
      prompt, and it reads to the model as established fact.
    */
    const visible = entity.timeline.filter((p) => p.chapter < upTo);
    const last = visible[visible.length - 1];
    if (!last) continue;
    items.push({
      name: entity.name,
      state: last.state,
      chapter: last.chapter,
      gone: entity.goneAtChapter > 0 && entity.goneAtChapter < upTo,
    });
  }
  items.sort((a, b) => b.chapter - a.chapter || a.name.localeCompare(b.name));
  return items.slice(0, ENTITY_CANDIDATES);
}

function chapterItems(
  state: MemoryState,
  numbers: number[]
): ChapterItem[] {
  const out: ChapterItem[] = [];
  for (const n of numbers) {
    const rec: ChapterRecord | undefined = state.chapters.get(n);
    if (rec?.summary) out.push({ chapter: n, summary: rec.summary });
  }
  return out;
}

export function assemble(input: AssembleInput): RecallResult {
  const { state, chapter } = input;
  const budget = input.budget ?? DEFAULT_MEMORY_BUDGET;

  const recentStart = Math.max(1, chapter - RECENT_WINDOW);
  const recentNumbers: number[] = [];
  for (let n = chapter - 1; n >= recentStart; n--) recentNumbers.push(n);

  /*
    Both chapter sections are offered newest-first, because `fitItems` cuts
    from the tail and the oldest entry is the one you can most afford to lose.
    They are rendered oldest-first further down — a prompt that counts backwards
    is measurably harder for a model to follow.
  */
  const skeletonNumbers = skeletonChapters(chapter, recentStart).reverse();

  const recent = chapterItems(state, recentNumbers);
  const skeleton = chapterItems(state, skeletonNumbers);
  const entity = entityItems(state, chapter);
  const retrieval: ChapterItem[] = (input.retrieval ?? [])
    // Never repeat something the recent window already carries in full.
    .filter((hit) => hit.chapter < recentStart)
    .map((hit) => ({ chapter: hit.chapter, summary: hit.summary }));

  const fitted = fitSections(
    {
      entity: { items: entity, toText: fmtEntity },
      recent: { items: recent, toText: fmtChapter },
      skeleton: { items: skeleton, toText: fmtChapter },
      retrieval: { items: retrieval, toText: fmtChapter },
    },
    Math.max(0, budget - HEADING_RESERVE)
  );

  const byChapter = (a: ChapterItem, b: ChapterItem) => a.chapter - b.chapter;
  const blocks: string[] = [];
  const push = (section: MemorySection, lines: string[]) => {
    if (!lines.length) return;
    blocks.push(`${SECTION_HEADINGS[section]}\n${lines.join('')}`);
  };

  push('entity', fitted.entity.kept.map(fmtEntity));
  push('recent', [...fitted.recent.kept].sort(byChapter).map(fmtChapter));
  push('skeleton', [...fitted.skeleton.kept].sort(byChapter).map(fmtChapter));
  push('retrieval', [...fitted.retrieval.kept].sort(byChapter).map(fmtChapter));

  const diagnostic = (
    f: { kept: unknown[]; usedTokens: number; dropped: number }
  ): SectionDiagnostic => ({
    usedTokens: f.usedTokens,
    kept: f.kept.length,
    dropped: f.dropped,
  });

  const text = blocks.join('\n');
  return {
    text,
    // The truth about what the caller is about to paste, not the item subtotal.
    usedTokens: estimateTokens(text),
    budget,
    sections: {
      entity: diagnostic(fitted.entity),
      recent: diagnostic(fitted.recent),
      skeleton: diagnostic(fitted.skeleton),
      retrieval: diagnostic(fitted.retrieval),
    },
    recentChapters: fitted.recent.kept.map((c) => c.chapter).sort((a, b) => a - b),
    skeletonChapters: fitted.skeleton.kept
      .map((c) => c.chapter)
      .sort((a, b) => a - b),
    retrievalChapters: fitted.retrieval.kept
      .map((c) => c.chapter)
      .sort((a, b) => a - b),
  };
}

export { estimateTokens };
