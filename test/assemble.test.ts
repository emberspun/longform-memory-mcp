import { describe, expect, it } from 'vitest';
import { estimateTokens } from 'longform-memory';
import { assemble, SECTION_HEADINGS } from '../src/assemble.js';
import { emptyState, type MemoryState } from '../src/events.js';

/** A book of `n` chapters whose summaries are `size` tokens each. */
function book(n: number, size: number, entities = 0): MemoryState {
  const state = emptyState();
  const body = 'w'.repeat(Math.max(1, size) * 4);
  for (let ch = 1; ch <= n; ch++) {
    state.chapters.set(ch, {
      chapter: ch,
      summary: `${body}`,
      chars: 0,
      derived: false,
    });
  }
  for (let i = 0; i < entities; i++) {
    // Spread each entity's history across the whole book. Bunching them at the
    // end makes the entity section empty at early chapters, which reads as a
    // size difference in the assembled block that is really just the fixture.
    const timeline = [];
    for (let ch = 1 + i; ch <= n; ch += Math.max(1, Math.floor(n / 12))) {
      timeline.push({ chapter: ch, state: body });
    }
    state.entities.set(`e${i}`, {
      name: `Entity${i}`,
      timeline,
      goneAtChapter: 0,
      lastChapter: timeline[timeline.length - 1]?.chapter ?? 1,
    });
  }
  return state;
}

describe('assemble', () => {
  /**
   * The whole promise of the package, asserted the only way it can honestly be
   * asserted: sweeping item sizes.
   *
   * A single fixture size proves nothing here. The core's own budget bug only
   * reproduced when items were large enough for a section to overflow AND small
   * enough that the redistribution pass had spare to hand out — one size lands
   * on one side of that and reports green.
   */
  it('never exceeds the requested budget, at any item size', () => {
    const BUDGET = 1200;
    const overruns: Array<{ size: number; used: number }> = [];
    for (let size = 1; size <= 150; size++) {
      const state = book(400, size, 30);
      const out = assemble({ state, chapter: 401, budget: BUDGET });
      if (out.usedTokens > BUDGET) {
        overruns.push({ size, used: out.usedTokens });
      }
    }
    expect(overruns).toEqual([]);
  });

  /**
   * The reported number must describe the text actually returned.
   *
   * Section headings live outside `fitSections`, so this is exactly where an
   * under-report creeps in — and an under-reported budget is worse than no
   * budget, because it is trusted.
   */
  it('reports the token count of the text it actually returns', () => {
    const state = book(200, 40, 20);
    const out = assemble({ state, chapter: 201, budget: 3000 });
    expect(out.usedTokens).toBe(estimateTokens(out.text));
    expect(out.text).toContain(SECTION_HEADINGS.recent);
  });

  /**
   * The entire pitch: doubling the document does not grow the block.
   *
   * Measured at 500 vs 1000 rather than 50 vs 1000, and the distinction is
   * real. Below roughly chapter 120 the skeleton has not yet hit its 12-entry
   * cap, so it is still *filling up* — an early chapter genuinely carries less
   * memory because there is less to carry. The claim is not "identical from
   * chapter one", it is "bounded, and flat once saturated". Asserting the
   * stronger thing would be asserting something untrue.
   */
  it('costs the same at chapter 1000 as at chapter 500', () => {
    const state = book(1000, 30, 25);
    const half = assemble({ state, chapter: 500, budget: 4000 });
    const full = assemble({ state, chapter: 1000, budget: 4000 });
    expect(Math.abs(full.usedTokens - half.usedTokens)).toBeLessThan(60);
    expect(full.skeletonChapters.length).toBeLessThanOrEqual(12);
    expect(full.usedTokens).toBeLessThanOrEqual(4000);
  });

  /** ...and while it is still filling up, it only ever grows toward the ceiling. */
  it('grows monotonically toward the ceiling, never past it', () => {
    const state = book(1000, 30, 25);
    let previous = 0;
    for (const chapter of [10, 50, 120, 300, 600, 1000]) {
      const out = assemble({ state, chapter, budget: 4000 });
      expect(out.usedTokens).toBeLessThanOrEqual(4000);
      expect(out.usedTokens).toBeGreaterThanOrEqual(previous - 60);
      previous = out.usedTokens;
    }
  });

  it('renders chapters oldest-first even though it budgets newest-first', () => {
    const state = book(60, 8, 0);
    const out = assemble({ state, chapter: 61, budget: 6000 });
    expect(out.recentChapters).toEqual([...out.recentChapters].sort((a, b) => a - b));
    const first = out.text.indexOf('[ch.53]');
    const last = out.text.indexOf('[ch.60]');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(last);
  });

  /**
   * A state recorded *in* the chapter being written must not come back as
   * established fact — that is the future leaking into its own prompt.
   */
  it('never surfaces an entity state recorded in the chapter being written', () => {
    const state = emptyState();
    state.chapters.set(1, { chapter: 1, summary: 'opening', chars: 0, derived: false });
    state.entities.set('vera', {
      name: 'Vera',
      timeline: [
        { chapter: 1, state: 'unharmed' },
        { chapter: 2, state: 'revealed as the informant' },
      ],
      goneAtChapter: 0,
      lastChapter: 2,
    });
    const out = assemble({ state, chapter: 2, budget: 6000 });
    expect(out.text).toContain('unharmed');
    expect(out.text).not.toContain('informant');
  });

  it('does not retrieve a chapter the recent window already carries', () => {
    const state = book(30, 10, 0);
    const out = assemble({
      state,
      chapter: 30,
      budget: 6000,
      retrieval: [
        { chapter: 29, summary: 'in the recent window', score: 1 },
        { chapter: 3, summary: 'genuinely distant', score: 0.9 },
      ],
    });
    expect(out.retrievalChapters).toEqual([3]);
  });
});
