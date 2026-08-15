import { describe, expect, it } from 'vitest';
import {
  absenceWindows,
  checkContinuity,
  onStagePattern,
} from '../src/continuity.js';
import { emptyState, type MemoryState } from '../src/events.js';

function withEntity(
  name: string,
  timeline: Array<{ chapter: number; state: string; gone?: boolean }>
): MemoryState {
  const state = emptyState();
  const goneAt = [...timeline]
    .sort((a, b) => a.chapter - b.chapter)
    .reduce((acc, p) => (p.gone === true ? p.chapter : p.gone === false ? 0 : acc), 0);
  state.entities.set(name.toLowerCase(), {
    name,
    timeline,
    goneAtChapter: goneAt,
    lastChapter: Math.max(...timeline.map((p) => p.chapter)),
  });
  for (let ch = 1; ch <= 40; ch++) {
    state.chapters.set(ch, { chapter: ch, summary: `ch ${ch}`, chars: 0, derived: false });
  }
  return state;
}

const noText = () => '';

describe('absenceWindows', () => {
  it('closes an absence the chapter BEFORE an explicit return', () => {
    expect(
      absenceWindows([
        { chapter: 12, gone: true },
        { chapter: 30, gone: false },
      ])
    ).toEqual([{ from: 12, to: 29 }]);
  });

  it('leaves an unended absence open', () => {
    const [w] = absenceWindows([{ chapter: 5, gone: true }]);
    expect(w.from).toBe(5);
    expect(w.to).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('handles die / return / die again as two separate windows', () => {
    expect(
      absenceWindows([
        { chapter: 4, gone: true },
        { chapter: 10, gone: false },
        { chapter: 22, gone: true },
      ])
    ).toEqual([
      { from: 4, to: 9 },
      { from: 22, to: Number.MAX_SAFE_INTEGER },
    ]);
  });
});

describe('onStagePattern', () => {
  const hits = (name: string, sentence: string) =>
    onStagePattern(name)!.test(sentence);

  it('matches a character acting', () => {
    expect(hits('Marek', 'Marek said nothing at all.')).toBe(true);
    expect(hits('Marek', '"Not tonight," replied Marek.')).toBe(true);
  });

  /** A bare mention is not an appearance. Flagging it is how a panel dies. */
  it('does not match a bare mention', () => {
    expect(hits('Marek', "Marek's coat still hung by the door.")).toBe(false);
    expect(hits('Marek', 'They buried Marek beneath the elm.')).toBe(false);
  });

  /** Something between the name and the verb means it is not happening now. */
  it('does not match when the verb is not adjacent', () => {
    expect(hits('Marek', 'Marek had said it once, years ago.')).toBe(false);
  });

  it('does not match a longer name that merely contains this one', () => {
    expect(hits('Ann', 'Anna said she would wait.')).toBe(false);
    expect(hits('Ann', 'Ann said she would wait.')).toBe(true);
  });

  it('matches CJK, where the verb abuts the name with no space', () => {
    expect(hits('林霜', '林霜说道，语气很轻。')).toBe(true);
    expect(hits('林霜', '桌上还留着林霜的信。')).toBe(false);
  });
});

describe('checkContinuity', () => {
  it('flags a character who acts in the prose after leaving the story', () => {
    const state = withEntity('Marek', [
      { chapter: 3, state: 'alive' },
      { chapter: 12, state: 'killed at the ford', gone: true },
    ]);
    const findings = checkContinuity({
      state,
      from: 1,
      to: 20,
      readText: (ch) => (ch === 18 ? 'Marek said the bridge was out.' : ''),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('speaks-after-exit');
    expect(findings[0].confidence).toBe('likely');
    expect(findings[0].quote).toBe('Marek said the bridge was out.');
  });

  /**
   * The single most common way a dead character "speaks" again is somebody
   * remembering them. Getting this wrong is what turns the tool into noise.
   */
  it('does not flag remembrance, dreams or hypotheticals', () => {
    const state = withEntity('Marek', [
      { chapter: 12, state: 'killed at the ford', gone: true },
    ]);
    const prose: Record<number, string> = {
      14: 'She remembered how Marek laughed at the ford.',
      15: 'In the dream Marek said her name again.',
      16: 'It was as if Marek walked beside her still.',
      17: 'Marek would have said the same thing.',
    };
    const findings = checkContinuity({
      state,
      from: 1,
      to: 20,
      readText: (ch) => prose[ch] ?? '',
    });
    expect(findings).toEqual([]);
  });

  /**
   * Same filter, exercised on a CJK entity.
   *
   * Written as its own case after the first version buried a Chinese sentence
   * in the English fixture above — where the entity was `Marek`, so the CJK
   * branch was never reached and the line was decorative. A green assertion
   * that cannot fail is worse than a missing one.
   */
  it('applies the same filter to CJK, and still catches the real thing', () => {
    const state = withEntity('林霜', [
      { chapter: 9, state: '坠崖', gone: true },
    ]);
    const remembered = checkContinuity({
      state,
      from: 1,
      to: 20,
      readText: (ch) => (ch === 14 ? '他想起林霜说过的那句话。' : ''),
    });
    expect(remembered).toEqual([]);

    const real = checkContinuity({
      state,
      from: 1,
      to: 20,
      readText: (ch) => (ch === 14 ? '林霜说道，语气很轻。' : ''),
    });
    expect(real).toHaveLength(1);
    expect(real[0].quote).toBe('林霜说道，语气很轻。');
  });

  it('flags the caller contradicting their own record, without any prose', () => {
    const state = withEntity('Marek', [
      { chapter: 12, state: 'killed at the ford', gone: true },
      { chapter: 19, state: 'riding north' },
    ]);
    const findings = checkContinuity({ state, from: 1, to: 25, readText: noText });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('returned-after-exit');
    expect(findings[0].confidence).toBe('certain');
    expect(findings[0].chapter).toBe(19);
  });

  /** An author who says "yes, on purpose" must be able to switch this off. */
  it('goes quiet after an explicit return', () => {
    const state = withEntity('Marek', [
      { chapter: 12, state: 'killed at the ford', gone: true },
      { chapter: 20, state: 'pulled from the river alive', gone: false },
      { chapter: 24, state: 'riding north' },
    ]);
    const findings = checkContinuity({
      state,
      from: 1,
      to: 30,
      readText: (ch) => (ch >= 20 ? 'Marek said little on the road.' : ''),
    });
    expect(findings).toEqual([]);
  });

  /** ...but a real finding from before the return is not erased by it. */
  it('keeps a finding raised before the return', () => {
    const state = withEntity('Marek', [
      { chapter: 12, state: 'killed at the ford', gone: true },
      { chapter: 20, state: 'pulled from the river alive', gone: false },
    ]);
    const findings = checkContinuity({
      state,
      from: 1,
      to: 30,
      readText: (ch) => (ch === 15 ? 'Marek said the bridge was out.' : ''),
    });
    expect(findings.map((f) => f.chapter)).toEqual([15]);
  });

  it('does not flag the return chapter itself', () => {
    const state = withEntity('Marek', [
      { chapter: 12, state: 'gone', gone: true },
      { chapter: 20, state: 'back', gone: false },
    ]);
    const findings = checkContinuity({
      state,
      from: 1,
      to: 30,
      readText: (ch) => (ch === 20 ? 'Marek walked into the yard.' : ''),
    });
    expect(findings).toEqual([]);
  });

  it('flags a thread past its deadline', () => {
    const state = emptyState();
    state.chapters.set(30, { chapter: 30, summary: 's', chars: 0, derived: false });
    state.threads.set('a', {
      id: 'a',
      summary: 'who sent the second letter',
      status: 'progressing',
      deadlineChapter: 20,
      openedAtChapter: 4,
      lastActivatedChapter: 12,
    });
    state.threads.set('b', {
      id: 'b',
      summary: 'already paid off',
      status: 'resolved',
      deadlineChapter: 15,
      openedAtChapter: 2,
      lastActivatedChapter: 15,
    });
    const findings = checkContinuity({ state, from: 1, to: 30, readText: noText });
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('overdue-thread');
    expect(findings[0].detail).toContain('10 chapters overdue');
  });

  it('reports certain findings before likely ones', () => {
    const state = withEntity('Marek', [
      { chapter: 5, state: 'gone', gone: true },
      { chapter: 25, state: 'riding north' },
    ]);
    const findings = checkContinuity({
      state,
      from: 1,
      to: 30,
      readText: (ch) => (ch === 8 ? 'Marek said the bridge was out.' : ''),
    });
    expect(findings.map((f) => f.confidence)).toEqual(['certain', 'likely']);
  });
});
