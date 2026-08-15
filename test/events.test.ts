import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fold, parseLine, type MemoryEvent } from '../src/events.js';
import { memoryHome, projectDir, sanitizeProject } from '../src/paths.js';
import { tokenize, lexicalSearch } from '../src/search.js';

const at = '2026-08-15T00:00:00.000Z';

describe('fold', () => {
  it('lets a re-recorded chapter replace its summary rather than duplicate it', () => {
    const state = fold([
      { t: 'chapter', ch: 3, summary: 'first pass', chars: 0, at },
      { t: 'chapter', ch: 3, summary: 'after revision', chars: 0, at },
    ]);
    expect(state.chapters.size).toBe(1);
    expect(state.chapters.get(3)!.summary).toBe('after revision');
  });

  /**
   * The tri-state is the whole reason `gone` is not a plain boolean. An
   * ordinary state update must not read as "and they are back".
   */
  it('keeps gone / back / unspecified apart', () => {
    const state = fold([
      { t: 'entity', ch: 5, name: 'Ivo', state: 'drowned', gone: true, at },
      { t: 'entity', ch: 9, name: 'Ivo', state: 'spoken of often', at },
    ]);
    const ivo = state.entities.get('ivo')!;
    expect(ivo.goneAtChapter).toBe(5);
    expect(ivo.timeline[1].gone).toBeUndefined();

    const revived = fold([
      { t: 'entity', ch: 5, name: 'Ivo', state: 'drowned', gone: true, at },
      { t: 'entity', ch: 9, name: 'Ivo', state: 'pulled out alive', gone: false, at },
    ]);
    expect(revived.entities.get('ivo')!.goneAtChapter).toBe(0);
  });

  it('matches entity names case- and space-insensitively', () => {
    const state = fold([
      { t: 'entity', ch: 1, name: 'Dr.  Vane', state: 'a', at },
      { t: 'entity', ch: 2, name: 'dr. vane', state: 'b', at },
    ]);
    expect(state.entities.size).toBe(1);
    expect(state.entities.get('dr. vane')!.timeline).toHaveLength(2);
  });

  it('treats resolved as terminal, so a stray later progress cannot reopen it', () => {
    const state = fold([
      { t: 'thread', op: 'open', id: 'x', ch: 1, summary: 's', deadline: 10, at },
      { t: 'thread', op: 'resolve', id: 'x', ch: 4, note: 'paid off', at },
      { t: 'thread', op: 'progress', id: 'x', ch: 6, at },
    ]);
    expect(state.threads.get('x')!.status).toBe('resolved');
  });

  it('ignores progress/resolve for an id that was never opened', () => {
    const state = fold([
      { t: 'thread', op: 'progress', id: 'ghost', ch: 2, at },
      { t: 'thread', op: 'resolve', id: 'ghost', ch: 3, note: '', at },
    ]);
    expect(state.threads.size).toBe(0);
  });
});

describe('parseLine', () => {
  /** A truncated tail costs you that line, never the book. */
  it('returns null for blank, truncated or non-event lines', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('   ')).toBeNull();
    expect(parseLine('{"t":"chapter","ch":3,"summ')).toBeNull();
    expect(parseLine('{"not":"an event"}')).toBeNull();
    expect(parseLine('null')).toBeNull();
  });

  it('round-trips a real event', () => {
    const event: MemoryEvent = { t: 'chapter', ch: 3, summary: 'x', chars: 0, at };
    expect(parseLine(JSON.stringify(event))).toEqual(event);
  });
});

describe('sanitizeProject', () => {
  /**
   * 🚨 This value comes from a language model. `../../.ssh` is a perfectly
   * plausible token for one to emit.
   */
  it('cannot escape the memory root', () => {
    const root = memoryHome();
    for (const attack of [
      '../../.ssh',
      '..',
      '.',
      '....',
      '/etc/passwd',
      '..\\..\\windows',
      './../../x',
      '../'.repeat(40) + 'etc/shadow',
      'a/../../b',
    ]) {
      /*
        Assert the property that matters — the resolved directory stays inside
        the root — not the shape of the sanitised string. The first version of
        this test banned the substring `..`, which failed on `..-..-.ssh`: a
        perfectly contained directory name that merely looks alarming. Banning
        shapes makes the test fight the implementation; asserting containment
        survives any rewrite of the sanitiser.
      */
      expect(projectDir(attack).startsWith(root + path.sep)).toBe(true);
      expect(path.relative(root, projectDir(attack))).not.toContain('..');
    }
  });

  it('folds case, so one book is never two memories', () => {
    expect(sanitizeProject('MyBook')).toBe(sanitizeProject('mybook'));
    expect(sanitizeProject('  The Long Road  ')).toBe('the-long-road');
  });

  it('falls back rather than producing an empty path segment', () => {
    expect(sanitizeProject('')).toBe('default');
    expect(sanitizeProject('!!!')).toBe('default');
  });
});

describe('lexical search', () => {
  it('splits CJK into bigrams and Latin into words', () => {
    expect(tokenize('the ford')).toEqual(['the', 'ford']);
    expect(tokenize('林霜坠崖')).toEqual(['林霜', '霜坠', '坠崖']);
  });

  it('ranks the chapter that actually discusses the query first', () => {
    const docs = [
      { chapter: 1, summary: 'They arrive at the harbour and rent a room.', chars: 0, derived: false },
      { chapter: 2, summary: 'A letter arrives bearing the seal of the drowned house.', chars: 0, derived: false },
      { chapter: 3, summary: 'Breakfast, and a long argument about money.', chars: 0, derived: false },
    ];
    const hits = lexicalSearch('who sent the sealed letter', docs, 2);
    expect(hits[0].chapter).toBe(2);
  });

  it('returns nothing rather than noise when no term matches', () => {
    const docs = [
      { chapter: 1, summary: 'A quiet morning in the orchard.', chars: 0, derived: false },
    ];
    expect(lexicalSearch('submarine reactor telemetry', docs, 5)).toEqual([]);
  });
});
