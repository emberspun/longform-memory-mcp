import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  continuity,
  entityCard,
  listOpenThreads,
  recallContext,
  rememberChapter,
  searchMemory,
} from '../src/tools.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'lfm-'));
  process.env.LONGFORM_MEMORY_HOME = home;
  process.env.LONGFORM_MEMORY_PROJECT = 'testbook';
  /*
    🚨 Scrub the embedding config explicitly.

    These tests must not depend on what the developer happens to have exported.
    Left alone, a machine with an endpoint configured would send real requests
    from a unit test — passing locally, failing in CI, or worse, passing in both
    while measuring two different code paths.
  */
  delete process.env.LONGFORM_MEMORY_EMBED_URL;
  delete process.env.LONGFORM_MEMORY_EMBED_KEY;
  delete process.env.LONGFORM_MEMORY_EMBED_MODEL;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.LONGFORM_MEMORY_HOME;
  delete process.env.LONGFORM_MEMORY_PROJECT;
});

describe('remember_chapter', () => {
  it('stores a summary, entities and threads, and reports what it wrote', async () => {
    const result = await rememberChapter({
      chapter: 1,
      summary: 'Ines finds the sealed letter and tells no one.',
      text: 'Ines turned the letter over twice before hiding it.',
      entities: [{ name: 'Ines', state: 'hiding the letter' }],
      threads: [{ summary: 'who sealed the letter', deadlineChapter: 12 }],
      totalChapters: 40,
    });
    expect(result.threadsOpened).toBe(1);
    expect(result.entitiesRecorded).toBe(1);
    expect(result.summaryDerived).toBe(false);
    expect(result.proseChars).toBeGreaterThan(0);
    expect(result.skipped).toEqual([]);
  });

  /** Degrading is fine. Degrading silently is not. */
  it('says so out loud when it has to invent a summary from the prose', async () => {
    const result = await rememberChapter({
      chapter: 1,
      text: 'A long stretch of prose with no summary supplied at all.',
    });
    expect(result.summaryDerived).toBe(true);
    expect(result.notes.join(' ')).toContain('No summary supplied');
  });

  it('never opens a new thread from an unmatched progress reference', async () => {
    await rememberChapter({ chapter: 1, summary: 'opening' });
    const result = await rememberChapter({
      chapter: 2,
      summary: 'second',
      threads: [{ action: 'progress', ref: 'T7', summary: 'a thread that is not on record' }],
    });
    expect(result.threadsOpened).toBe(0);
    expect(result.skipped).toEqual([
      { reason: 'unmatched-ref', summary: 'a thread that is not on record' },
    ]);
    expect(result.notes.join(' ')).toContain('list_open_threads');
  });

  it('replaces a chapter summary on a second pass instead of duplicating it', async () => {
    await rememberChapter({ chapter: 4, summary: 'first draft of ch 4' });
    await rememberChapter({ chapter: 4, summary: 'revised ch 4' });
    const recall = await recallContext({ chapter: 5 });
    expect(recall.recall!.text).toContain('revised ch 4');
    expect(recall.recall!.text).not.toContain('first draft');
  });
});

describe('the [T#] contract between list_open_threads and remember_chapter', () => {
  /**
   * 🚨 The highest-stakes invariant in this package.
   *
   * The model is shown `[T1..Tn]` by one tool and answers `ref: "T2"` to
   * another. If the two orderings ever diverge, "resolve T2" closes a thread
   * the model never meant to touch — silently, confidently, irreversibly. A
   * mismatch that simply failed would be far less costly.
   */
  it('resolves the ref the model was actually shown', async () => {
    await rememberChapter({
      chapter: 1,
      summary: 'three promises made',
      threads: [
        { summary: 'A: the locked room', deadlineChapter: 30 },
        { summary: 'B: the missing brother', deadlineChapter: 5 },
        { summary: 'C: the debt', deadlineChapter: 12 },
      ],
      totalChapters: 40,
    });

    const listed = listOpenThreads({ chapter: 8, totalChapters: 40 });
    expect(listed.total).toBe(3);
    // Overdue first (B, due ch.5), then by deadline: C (12), A (30).
    expect(listed.threads.map((t) => t.summary)).toEqual([
      'B: the missing brother',
      'C: the debt',
      'A: the locked room',
    ]);
    expect(listed.rendered).toContain('[T1] B: the missing brother');

    const target = listed.threads[1]; // "T2" == C
    const result = await rememberChapter({
      chapter: 8,
      summary: 'the debt is settled',
      threads: [{ action: 'resolve', ref: 'T2', summary: target.summary, resolutionNote: 'paid' }],
      totalChapters: 40,
    });
    expect(result.threadsResolved).toBe(1);

    const after = listOpenThreads({ chapter: 8, totalChapters: 40 });
    expect(after.threads.map((t) => t.summary)).toEqual([
      'B: the missing brother',
      'A: the locked room',
    ]);
  });

  it('flags the overdue thread that must be paid off now', async () => {
    await rememberChapter({
      chapter: 1,
      summary: 'a promise',
      threads: [{ summary: 'the missing brother', deadlineChapter: 4 }],
      totalChapters: 40,
    });
    const listed = listOpenThreads({ chapter: 9, totalChapters: 40 });
    expect(listed.overdue).toBe(1);
    expect(listed.mustResolve?.overdueBy).toBe(5);
  });
});

describe('empty projects', () => {
  /**
   * A model-supplied project name is one typo away from a clean, cheerful,
   * completely empty answer. That answer must never look like a working one.
   */
  it('names the mistake instead of returning a blank result', async () => {
    await rememberChapter({ project: 'real-book', chapter: 1, summary: 'x' });
    const recall = await recallContext({ project: 'raelbook', chapter: 2 });
    expect(recall.empty).toContain('No memory recorded for project "raelbook"');
    expect(recall.empty).toContain('real-book');

    const search = await searchMemory({ project: 'raelbook', query: 'x' });
    expect(search.empty).toBeTruthy();
    const card = entityCard({ project: 'raelbook', name: 'Ines' });
    expect(card.found).toBe(false);
    expect(card.note).toContain('raelbook');
  });
});

describe('entity_card', () => {
  it('returns a timeline and the current state', async () => {
    await rememberChapter({
      chapter: 2,
      summary: 's',
      entities: [{ name: 'Ines', state: 'in the archive' }],
    });
    await rememberChapter({
      chapter: 7,
      summary: 's',
      entities: [{ name: 'ines', state: 'arrested', note: 'at the border' }],
    });
    const card = entityCard({ name: 'INES' });
    expect(card.found).toBe(true);
    expect(card.current).toEqual({ state: 'arrested', chapter: 7, gone: false });
    expect(card.timeline.map((p) => p.chapter)).toEqual([2, 7]);
  });

  it('suggests near misses rather than just saying no', async () => {
    await rememberChapter({
      chapter: 1,
      summary: 's',
      entities: [{ name: 'Dr. Vane', state: 'at the clinic' }],
    });
    const card = entityCard({ name: 'Vane' });
    expect(card.found).toBe(false);
    expect(card.note).toContain('Dr. Vane');
  });
});

describe('check_continuity end to end', () => {
  it('quotes the prose it tripped on', async () => {
    await rememberChapter({
      chapter: 3,
      summary: 'Marek dies at the ford.',
      entities: [{ name: 'Marek', state: 'killed at the ford', gone: true }],
    });
    await rememberChapter({
      chapter: 6,
      summary: 'The crossing.',
      text: 'Rain all morning. Marek said the bridge was out. They turned back.',
    });
    const result = continuity({});
    const finding = result.findings.find((f) => f.kind === 'speaks-after-exit');
    expect(finding?.quote).toBe('Marek said the bridge was out.');
  });
});

describe('search_memory', () => {
  it('states which mode ran, so a fallback is never mistaken for a bad index', async () => {
    await rememberChapter({ chapter: 1, summary: 'A letter arrives bearing a broken seal.' });
    await rememberChapter({ chapter: 2, summary: 'Breakfast, and an argument about money.' });
    const result = await searchMemory({ query: 'the broken seal' });
    expect(result.mode).toBe('lexical');
    expect(result.hits[0].chapter).toBe(1);
  });
});
