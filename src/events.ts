/**
 * The on-disk record format, and the fold that turns it into current state.
 *
 * ## Why an append-only log instead of a database
 *
 * This server is launched by `npx` inside someone else's editor. A native
 * module (better-sqlite3 and friends) that fails to build on their platform is
 * not a degraded experience, it is a **server that never starts**, and they
 * will never tell us why. An append-only JSONL file has no build step, no
 * driver, and no version skew.
 *
 * The cost is that current state is recomputed on load. For one document that
 * is a few thousand short lines — microseconds — and chapter prose is
 * deliberately NOT in the log (see `paths.chapterTextPath`), so the file stays
 * small no matter how long the book gets.
 */

export type EntityEvent = {
  t: 'entity';
  ch: number;
  /** As written by the author, e.g. `Ariadne`. Matched case-insensitively. */
  name: string;
  /** Free text: `alive and in Vienna`, `已失明`, `promoted to captain`. */
  state: string;
  /**
   * Left the story for good — died, was destroyed, departed permanently.
   *
   * Explicit rather than inferred from `state`. Keyword-sniffing free text for
   * "dead" misfires on `feared she was dead` and does not work at all in
   * languages the caller may be writing in.
   */
  gone?: boolean;
  note?: string;
  at: string;
};

export type ChapterEvent = {
  t: 'chapter';
  ch: number;
  summary: string;
  /** Characters of prose stored alongside; 0 when only a summary was given. */
  chars: number;
  /** True when no summary was supplied and the head of the prose was used. */
  derived?: boolean;
  at: string;
};

export type ThreadEvent =
  | {
      t: 'thread';
      op: 'open';
      id: string;
      ch: number;
      summary: string;
      kind?: string;
      deadline: number;
      at: string;
    }
  | { t: 'thread'; op: 'progress'; id: string; ch: number; at: string }
  | {
      t: 'thread';
      op: 'resolve';
      id: string;
      ch: number;
      note: string;
      at: string;
    };

/** A chapter summary's embedding, present only when an endpoint is configured. */
export type EmbedEvent = {
  t: 'embed';
  ch: number;
  /** base64 float32, produced by `longform-memory`'s `encodeVector`. */
  vec: string;
  /** Vectors from different models are not comparable; recorded to skip them. */
  model: string;
  at: string;
};

export type MemoryEvent =
  | ChapterEvent
  | EntityEvent
  | ThreadEvent
  | EmbedEvent;

export type ChapterRecord = {
  chapter: number;
  summary: string;
  chars: number;
  derived: boolean;
};

export type EntityRecord = {
  /** Display form: whatever spelling was used most recently. */
  name: string;
  timeline: Array<{
    chapter: number;
    state: string;
    /**
     * 🚨 Tri-state, and all three states are load-bearing:
     * `true` = left the story · `false` = **explicitly back** ·
     * `undefined` = an ordinary state update that says nothing about presence.
     *
     * Collapsing `false` and `undefined` into one boolean (the obvious way to
     * write this) removes the only way an author has to say "yes, the
     * resurrection is intentional" — and a continuity warning you cannot
     * switch off is a warning people switch the whole tool off to escape.
     */
    gone?: boolean;
    note?: string;
  }>;
  /** Currently absent since this chapter; 0 if present. Cleared by `gone:false`. */
  goneAtChapter: number;
  lastChapter: number;
};

export type ThreadRecord = {
  id: string;
  summary: string;
  kind?: string;
  status: 'open' | 'progressing' | 'resolved';
  deadlineChapter: number;
  openedAtChapter: number;
  lastActivatedChapter: number;
  resolutionNote?: string;
};

export type MemoryState = {
  chapters: Map<number, ChapterRecord>;
  entities: Map<string, EntityRecord>;
  threads: Map<string, ThreadRecord>;
  embeddings: Map<number, { vec: string; model: string }>;
  /** Lines that did not parse. Surfaced, never silently swallowed. */
  corruptLines: number;
};

export function emptyState(): MemoryState {
  return {
    chapters: new Map(),
    entities: new Map(),
    threads: new Map(),
    embeddings: new Map(),
    corruptLines: 0,
  };
}

/** Entities are addressed case- and space-insensitively; `Dr. Vane` == `dr. vane`. */
export function entityKey(name: string): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Fold an event stream into current state.
 *
 * **Pure**: no I/O, no clock. That is what makes the whole storage layer
 * testable without touching a filesystem, and it is why the reader below can
 * hand it lines from anywhere.
 *
 * Re-recording a chapter overwrites its summary rather than appending a second
 * one — writers revise, and two summaries of the same chapter in the recall
 * block reads as a duplication bug.
 */
export function fold(events: Iterable<MemoryEvent>): MemoryState {
  const state = emptyState();
  for (const e of events) {
    switch (e.t) {
      case 'chapter':
        state.chapters.set(e.ch, {
          chapter: e.ch,
          summary: e.summary,
          chars: e.chars,
          derived: e.derived === true,
        });
        break;

      case 'entity': {
        const key = entityKey(e.name);
        if (!key) break;
        const rec = state.entities.get(key) ?? {
          name: e.name,
          timeline: [],
          goneAtChapter: 0,
          lastChapter: 0,
        };
        rec.name = e.name;
        rec.timeline.push({
          chapter: e.ch,
          state: e.state,
          gone: typeof e.gone === 'boolean' ? e.gone : undefined,
          note: e.note,
        });
        rec.lastChapter = Math.max(rec.lastChapter, e.ch);
        /*
          Only an explicit boolean moves this. An ordinary state update after a
          death must NOT clear it — that pairing is exactly what
          `check_continuity` reports, and clearing it here would delete the
          finding before anyone could see it. Deciding *whether* that pairing
          is a bug is the checker's job, not the recorder's.
        */
        if (e.gone === true) rec.goneAtChapter = e.ch;
        else if (e.gone === false) rec.goneAtChapter = 0;
        state.entities.set(key, rec);
        break;
      }

      case 'thread': {
        if (e.op === 'open') {
          state.threads.set(e.id, {
            id: e.id,
            summary: e.summary,
            kind: e.kind,
            status: 'open',
            deadlineChapter: e.deadline,
            openedAtChapter: e.ch,
            lastActivatedChapter: e.ch,
          });
          break;
        }
        const t = state.threads.get(e.id);
        if (!t) break; // progress/resolve for an id we never opened
        if (e.op === 'progress') {
          // Resolved is terminal: a stray later "progress" must not reopen it.
          if (t.status !== 'resolved') t.status = 'progressing';
          t.lastActivatedChapter = Math.max(t.lastActivatedChapter, e.ch);
        } else {
          t.status = 'resolved';
          t.resolutionNote = e.note;
          t.lastActivatedChapter = Math.max(t.lastActivatedChapter, e.ch);
        }
        break;
      }

      case 'embed':
        state.embeddings.set(e.ch, { vec: e.vec, model: e.model });
        break;
    }
  }
  return state;
}

/**
 * Parse one log line. Returns null for blank or unreadable lines.
 *
 * A truncated tail (power loss mid-append) must cost you that one line, not
 * the whole book — so this never throws.
 */
export function parseLine(line: string): MemoryEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as MemoryEvent;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.t !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
