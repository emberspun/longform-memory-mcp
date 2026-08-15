/**
 * Deterministic continuity checks.
 *
 * ## The governing constraint: a false positive costs more than a miss
 *
 * A panel that cries wolf trains the writer to ignore the panel — and then the
 * one real finding scrolls past unread. So every check here either (a) fires
 * only on facts the caller stated outright, or (b) is labelled `likely` and
 * **ships the sentence it tripped on**, so a human settles it in two seconds.
 *
 * There is deliberately no semantic contradiction detection. "The manor has
 * three towers in ch.4 and four in ch.60" needs a model, and a model guessing
 * at it produces exactly the wolf-crying panel described above. The host
 * calling this server *is* a model and can do that job with the prose in hand;
 * this tool's job is the part a model is bad at — remembering, exactly, across
 * a thousand chapters.
 */
import { UNRESOLVED_THREAD_STATUSES } from 'longform-memory';
import type { MemoryState } from './events.js';

export type FindingKind =
  /** Marked gone, then recorded acting again. Caller's own two statements. */
  | 'returned-after-exit'
  /** Marked gone, then the prose has them speaking or moving. Heuristic. */
  | 'speaks-after-exit'
  /** Past its deadline chapter and still unresolved. */
  | 'overdue-thread';

export type Finding = {
  kind: FindingKind;
  /** `certain` = derived from recorded facts. `likely` = matched on prose. */
  confidence: 'certain' | 'likely';
  chapter: number;
  subject: string;
  detail: string;
  /** Verbatim prose. Present on every `likely` finding — that is the point. */
  quote?: string;
};

/**
 * Verbs that place a character *on stage* rather than merely in someone's
 * thoughts. Adjacency to the name is doing the real filtering: `Tom had said`
 * and `the letter Tom wrote` do not match, because something sits in between.
 */
const EN_VERBS =
  'said|says|asked|asks|replied|replies|answered|answers|whispered|whispers|shouted|shouts|muttered|mutters|murmured|murmurs|called|calls|cried|cries|laughed|laughs|nodded|nods|shrugged|shrugs|smiled|smiles|grinned|frowned|turned|turns|stepped|steps|walked|walks|entered|enters|arrived|arrives|stood|stands|sat|sits|grabbed|grabs|drew|draws|raised|raises|pointed|points';

/** Same idea for CJK, where the verb simply abuts the name with no space. */
const CJK_VERBS =
  '说|道|問|问|答|喊|叫|笑|哭|走|站|坐|拿|抓|转身|轉身|点头|點頭|摇头|搖頭|开口|開口|看向|望向|伸手|推开|推開';

/**
 * Words that reframe a sentence as memory, dream or hypothesis.
 *
 * Present anywhere in the sentence, they veto the finding. This is the single
 * highest-yield false-positive filter: the overwhelmingly common way a dead
 * character "speaks" in a later chapter is someone recalling them.
 */
const IRREALIS =
  /\b(remember(?:ed|s|ing)?|recall(?:ed|s|ing)?|memor(?:y|ies)|dream(?:ed|t|s|ing)?|imagin(?:e|ed|es|ing)|ghost|vision|flashback|as if|would have|used to|once told)\b|想起|记得|記得|回忆|回憶|梦|夢|仿佛|彷彿|幻觉|幻覺|似乎听|似乎聽|曾经说|曾經說/iu;

function hasCjk(s: string): boolean {
  return /[぀-ヿ㐀-䶿一-鿿가-힯]/u.test(s);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A regex that finds the name *acting* in prose.
 *
 * Boundary handling differs by script and it matters: `(?<!\p{L})` around a
 * CJK name never matches, because the very verb we are looking for is itself a
 * letter. Latin names get real boundaries; CJK names rely on the verb
 * adjacency alone, which is what makes them detectable in the first place.
 */
export function onStagePattern(name: string): RegExp | null {
  const n = escapeRe(name.trim());
  if (!n) return null;
  if (hasCjk(name)) {
    return new RegExp(`${n}\\s*(?:${CJK_VERBS})`, 'u');
  }
  const b = '(?<![\\p{L}\\p{N}_])';
  const a = '(?![\\p{L}\\p{N}_])';
  return new RegExp(
    `(?:${b}${n}${a}\\s+(?:${EN_VERBS})${a})|(?:${b}(?:${EN_VERBS})${a}\\s+${b}${n}${a})`,
    'iu'
  );
}

/** Split prose into sentences. Crude on purpose — it only has to bound a quote. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？…])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

const MAX_QUOTE_CHARS = 240;

function clipQuote(s: string): string {
  return s.length <= MAX_QUOTE_CHARS ? s : s.slice(0, MAX_QUOTE_CHARS) + '…';
}

/**
 * The chapter spans during which an entity is supposed to be absent.
 *
 * Opened by `gone: true`, closed by an explicit `gone: false`. Spans rather
 * than a single "is gone" flag, because a character can plausibly die, be
 * brought back on purpose, and die again — and a finding raised inside the
 * first absence must survive the second, or a later resurrection would quietly
 * erase a real error found earlier.
 *
 * `to` is `Number.MAX_SAFE_INTEGER` for an absence nobody has ended.
 */
export function absenceWindows(
  timeline: Array<{ chapter: number; gone?: boolean }>
): Array<{ from: number; to: number }> {
  const ordered = [...timeline].sort((a, b) => a.chapter - b.chapter);
  const windows: Array<{ from: number; to: number }> = [];
  let open: { from: number; to: number } | null = null;
  for (const point of ordered) {
    if (point.gone === true) {
      if (!open) {
        open = { from: point.chapter, to: Number.MAX_SAFE_INTEGER };
        windows.push(open);
      }
    } else if (point.gone === false && open) {
      // The return chapter itself is a chapter they are *present* for, so the
      // absence ends the chapter before it. Off by one here would report the
      // author's own deliberate comeback scene as the error.
      open.to = point.chapter - 1;
      open = null;
    }
  }
  return windows;
}

export type ContinuityInput = {
  state: MemoryState;
  /** Inclusive chapter window to inspect. */
  from: number;
  to: number;
  /** Prose lookup, injected so this module stays free of filesystem access. */
  readText: (chapter: number) => string;
};

export function checkContinuity(input: ContinuityInput): Finding[] {
  const { state, from, to, readText } = input;
  const findings: Finding[] = [];

  // ── 1 & 2: characters who left the story and then did not stay gone ──────
  for (const entity of state.entities.values()) {
    const absences = absenceWindows(entity.timeline);
    if (!absences.length) continue;

    // ① The caller's own two statements disagree. No prose involved.
    for (const point of entity.timeline) {
      if (point.gone !== undefined) continue; // true = re-exit, false = author says back
      const window = absences.find(
        (w) => point.chapter > w.from && point.chapter <= w.to
      );
      if (!window) continue;
      findings.push({
        kind: 'returned-after-exit',
        confidence: 'certain',
        chapter: point.chapter,
        subject: entity.name,
        detail: `Left the story in ch.${window.from}, but ch.${point.chapter} records them as "${point.state}".`,
      });
    }

    // ② The prose has them on stage while they are supposed to be gone.
    const pattern = onStagePattern(entity.name);
    if (!pattern) continue;
    for (const window of absences) {
      const start = Math.max(from, window.from + 1);
      const end = Math.min(to, window.to);
      for (let ch = start; ch <= end; ch++) {
        const text = readText(ch);
        if (!text) continue;
        for (const sentence of sentences(text)) {
          if (!pattern.test(sentence)) continue;
          if (IRREALIS.test(sentence)) continue; // memory, dream, hypothetical
          findings.push({
            kind: 'speaks-after-exit',
            confidence: 'likely',
            chapter: ch,
            subject: entity.name,
            detail: `Left the story in ch.${window.from}, but appears to act in ch.${ch}.`,
            quote: clipQuote(sentence),
          });
          break; // one finding per chapter per entity; the rest is noise
        }
      }
    }
  }

  // ── 3: promises the document made and has not kept ───────────────────────
  for (const thread of state.threads.values()) {
    if (!UNRESOLVED_THREAD_STATUSES.includes(thread.status)) continue;
    if (!thread.deadlineChapter || thread.deadlineChapter >= to) continue;
    findings.push({
      kind: 'overdue-thread',
      confidence: 'certain',
      chapter: thread.deadlineChapter,
      subject: thread.summary,
      detail: `Opened in ch.${thread.openedAtChapter}, due by ch.${thread.deadlineChapter}, still ${thread.status} at ch.${to} (${to - thread.deadlineChapter} chapters overdue).`,
    });
  }

  // Certain before likely, then by chapter — the settled facts read first.
  return findings.sort(
    (a, b) =>
      Number(b.confidence === 'certain') - Number(a.confidence === 'certain') ||
      a.chapter - b.chapter
  );
}
