/**
 * The six tools, as plain functions.
 *
 * Kept free of the MCP SDK so they can be tested without a transport, and so
 * the protocol layer in `server.ts` stays a thin adapter with nothing to hide.
 */
import {
  DEFAULT_THREAD_LABELS,
  compareThreadUrgency,
  planOwedPayoff,
  planThreadOps,
  renderKnownThreads,
  UNRESOLVED_THREAD_STATUSES,
  type RawThreadItem,
} from 'longform-memory';
import { assemble, RECENT_WINDOW, type RecallResult } from './assemble.js';
import { checkContinuity, type Finding } from './continuity.js';
import { entityKey, type MemoryEvent, type MemoryState, type ThreadRecord } from './events.js';
import { defaultProject, sanitizeProject } from './paths.js';
import {
  embed,
  embedConfig,
  lexicalSearch,
  semanticSearch,
  type SearchOutcome,
} from './search.js';
import {
  appendEvents,
  deriveSummary,
  knownProjects,
  loadState,
  readChapterText,
  writeChapterText,
} from './store.js';

export type ProjectArg = { project?: string };

function resolveProject(arg?: string): string {
  return arg?.trim() ? sanitizeProject(arg) : defaultProject();
}

function now(): string {
  return new Date().toISOString();
}

/**
 * The message shown when a project turns out to be empty.
 *
 * 🚨 Never return a cheerful blank. The project name is model-supplied, so a
 * single typo produces a perfectly valid, perfectly empty answer, and the user
 * concludes the server forgot their book rather than that a letter was wrong.
 */
function emptyProjectNote(project: string): string {
  const known = knownProjects();
  const listed = known.length
    ? `Projects with memory on this machine: ${known.map((p) => `"${p}"`).join(', ')}.`
    : 'No project on this machine has any memory yet.';
  return `No memory recorded for project "${project}". ${listed}`;
}

function isEmpty(state: MemoryState): boolean {
  return (
    state.chapters.size === 0 &&
    state.entities.size === 0 &&
    state.threads.size === 0
  );
}

/**
 * Unresolved threads in the order the model will be shown them.
 *
 * 🚨 **This ordering is a contract between two tools.** `list_open_threads`
 * numbers them `[T1..Tn]`; `remember_chapter` resolves the model's `ref: "T3"`
 * back to an id using the same list. Sort differently in either place and
 * "resolve T3" closes a different thread than the one the model meant — which
 * is strictly worse than not matching at all, because it destroys information
 * silently and confidently.
 */
export function orderedOpenThreads(
  state: MemoryState,
  chapter: number
): ThreadRecord[] {
  return [...state.threads.values()]
    .filter((t) => UNRESOLVED_THREAD_STATUSES.includes(t.status))
    .sort((a, b) => compareThreadUrgency(a, b, chapter));
}

// ── 1. remember_chapter ────────────────────────────────────────────────────

export type RememberInput = ProjectArg & {
  chapter: number;
  text?: string;
  summary?: string;
  entities?: Array<{
    name: string;
    state: string;
    gone?: boolean;
    note?: string;
  }>;
  threads?: RawThreadItem[];
  totalChapters?: number;
};

export type RememberResult = {
  project: string;
  chapter: number;
  summaryDerived: boolean;
  proseChars: number;
  entitiesRecorded: number;
  threadsOpened: number;
  threadsProgressed: number;
  threadsResolved: number;
  skipped: Array<{ reason: string; summary: string }>;
  notes: string[];
};

export async function rememberChapter(
  input: RememberInput
): Promise<RememberResult> {
  const project = resolveProject(input.project);
  const chapter = Math.max(1, Math.floor(input.chapter));
  const state = loadState(project);
  const events: MemoryEvent[] = [];
  const notes: string[] = [];
  const at = now();

  const text = input.text ?? '';
  let proseChars = 0;
  if (text.trim()) proseChars = writeChapterText(project, chapter, text);

  const given = input.summary?.trim();
  const summary = given || (text.trim() ? deriveSummary(text) : '');
  const summaryDerived = !given && Boolean(summary);
  if (summaryDerived) {
    notes.push(
      'No summary supplied — stored the opening of the prose instead. Recall quality depends on real summaries; pass `summary` next time.'
    );
  }
  if (!summary) {
    notes.push('Neither `summary` nor `text` supplied — nothing to recall later.');
  } else {
    events.push({ t: 'chapter', ch: chapter, summary, chars: proseChars, derived: summaryDerived, at });
  }

  for (const e of input.entities ?? []) {
    const name = e?.name?.trim();
    if (!name || !e?.state?.trim()) continue;
    events.push({
      t: 'entity',
      ch: chapter,
      name,
      state: e.state.trim(),
      ...(typeof e.gone === 'boolean' ? { gone: e.gone } : {}),
      ...(e.note?.trim() ? { note: e.note.trim() } : {}),
      at,
    });
  }

  // Same ordering the model was shown — see `orderedOpenThreads`.
  const known = orderedOpenThreads(state, chapter);
  const ops = planThreadOps({
    items: input.threads ?? [],
    known: known.map((t) => ({ id: t.id, status: t.status })),
    chapterNumber: chapter,
    totalChapters: Math.max(0, Math.floor(input.totalChapters ?? 0)),
  });

  const skipped: RememberResult['skipped'] = [];
  let opened = 0;
  let progressed = 0;
  let resolved = 0;
  // Deterministic ids: no clock, no randomness, so a replayed log is identical.
  let openSeq = countThreadsOpenedIn(state, chapter);
  for (const op of ops) {
    switch (op.kind) {
      case 'open':
        events.push({
          t: 'thread',
          op: 'open',
          id: `ch${chapter}-${openSeq++}`,
          ch: chapter,
          summary: op.summary,
          ...(op.threadType ? { kind: op.threadType } : {}),
          deadline: op.deadlineChapter,
          at,
        });
        opened++;
        break;
      case 'progress':
        events.push({ t: 'thread', op: 'progress', id: op.id, ch: chapter, at });
        progressed++;
        break;
      case 'resolve':
        events.push({
          t: 'thread',
          op: 'resolve',
          id: op.id,
          ch: chapter,
          note: op.resolutionNote,
          at,
        });
        resolved++;
        break;
      case 'skip':
        skipped.push({ reason: op.reason, summary: op.summary });
        break;
    }
  }

  const cfg = embedConfig();
  if (cfg && summary) {
    try {
      events.push({ t: 'embed', ch: chapter, vec: await embed(cfg, summary), model: cfg.model, at });
    } catch (error) {
      notes.push(
        `Embedding failed (${(error as Error).message}); this chapter is searchable lexically but not semantically.`
      );
    }
  }

  appendEvents(project, events);

  if (skipped.some((s) => s.reason === 'unmatched-ref')) {
    notes.push(
      'Some thread operations referenced ids that are not on record and were skipped — never guessed at. Call list_open_threads first to get current [T1..Tn] numbering.'
    );
  }

  return {
    project,
    chapter,
    summaryDerived,
    proseChars,
    entitiesRecorded: events.filter((e) => e.t === 'entity').length,
    threadsOpened: opened,
    threadsProgressed: progressed,
    threadsResolved: resolved,
    skipped,
    notes,
  };
}

function countThreadsOpenedIn(state: MemoryState, chapter: number): number {
  let n = 0;
  for (const t of state.threads.values()) {
    if (t.openedAtChapter === chapter) n++;
  }
  return n;
}

// ── 2. recall_context ──────────────────────────────────────────────────────

export type RecallInput = ProjectArg & {
  chapter: number;
  budget?: number;
  /** What this chapter is about; sharpens retrieval. Falls back to ch-1's summary. */
  query?: string;
};

export type RecallToolResult = {
  project: string;
  chapter: number;
  empty?: string;
  recall?: RecallResult;
  retrievalMode?: SearchOutcome['mode'];
  retrievalNote?: string;
  corruptLines: number;
};

export async function recallContext(
  input: RecallInput
): Promise<RecallToolResult> {
  const project = resolveProject(input.project);
  const chapter = Math.max(1, Math.floor(input.chapter));
  const state = loadState(project);
  if (isEmpty(state)) {
    return { project, chapter, empty: emptyProjectNote(project), corruptLines: state.corruptLines };
  }

  const recentStart = Math.max(1, chapter - RECENT_WINDOW);
  const query =
    input.query?.trim() || state.chapters.get(chapter - 1)?.summary || '';
  // Only chapters the recent window will not already carry in full are worth
  // retrieving — otherwise retrieval spends budget duplicating its neighbour.
  const candidates = [...state.chapters.values()].filter(
    (c) => c.chapter < recentStart
  );

  let outcome: SearchOutcome = { mode: 'lexical', hits: [] };
  if (query && candidates.length) {
    const cfg = embedConfig();
    outcome = cfg
      ? await semanticSearch(cfg, query, candidates, state.embeddings, 8)
      : { mode: 'lexical', hits: lexicalSearch(query, candidates, 8) };
  }

  return {
    project,
    chapter,
    recall: assemble({ state, chapter, budget: input.budget, retrieval: outcome.hits }),
    retrievalMode: outcome.mode,
    retrievalNote: outcome.note,
    corruptLines: state.corruptLines,
  };
}

// ── 3. list_open_threads ───────────────────────────────────────────────────

export type ThreadsInput = ProjectArg & {
  chapter?: number;
  totalChapters?: number;
};

export type ThreadsResult = {
  project: string;
  chapter: number;
  empty?: string;
  rendered: string;
  total: number;
  overdue: number;
  mustResolve: { summary: string; overdueBy: number } | null;
  threads: Array<{
    ref: string;
    summary: string;
    status: string;
    deadlineChapter: number;
    openedAtChapter: number;
    overdueBy: number;
  }>;
};

export function listOpenThreads(input: ThreadsInput): ThreadsResult {
  const project = resolveProject(input.project);
  const state = loadState(project);
  const latest = Math.max(0, ...state.chapters.keys());
  const chapter = Math.max(1, Math.floor(input.chapter ?? (latest || 1)));

  const ordered = orderedOpenThreads(state, chapter);
  const rendered = renderKnownThreads(
    ordered.map((t) => ({
      summary: t.summary,
      status: t.status,
      deadlineChapter: t.deadlineChapter,
    })),
    DEFAULT_THREAD_LABELS
  );

  const owed = ordered
    .filter((t) => t.deadlineChapter > 0 && t.deadlineChapter <= chapter)
    .map((t) => ({
      summary: t.summary,
      openedAtChapter: t.openedAtChapter,
      deadlineChapter: t.deadlineChapter,
      overdueBy: chapter - t.deadlineChapter,
    }));
  const { mustResolve } = planOwedPayoff(
    owed,
    chapter,
    Math.max(0, Math.floor(input.totalChapters ?? 0))
  );

  return {
    project,
    chapter,
    empty: isEmpty(state) ? emptyProjectNote(project) : undefined,
    rendered,
    total: ordered.length,
    overdue: owed.length,
    mustResolve: mustResolve
      ? { summary: mustResolve.summary, overdueBy: mustResolve.overdueBy }
      : null,
    threads: ordered.map((t, i) => ({
      ref: `T${i + 1}`,
      summary: t.summary,
      status: t.status,
      deadlineChapter: t.deadlineChapter,
      openedAtChapter: t.openedAtChapter,
      overdueBy: t.deadlineChapter > 0 ? Math.max(0, chapter - t.deadlineChapter) : 0,
    })),
  };
}

// ── 4. check_continuity ────────────────────────────────────────────────────

export type ContinuityToolInput = ProjectArg & {
  fromChapter?: number;
  toChapter?: number;
};

export type ContinuityToolResult = {
  project: string;
  from: number;
  to: number;
  empty?: string;
  findings: Finding[];
};

export function continuity(input: ContinuityToolInput): ContinuityToolResult {
  const project = resolveProject(input.project);
  const state = loadState(project);
  const chapters = [...state.chapters.keys()];
  const latest = chapters.length ? Math.max(...chapters) : 0;
  const from = Math.max(1, Math.floor(input.fromChapter ?? 1));
  const to = Math.max(from, Math.floor(input.toChapter ?? latest));

  return {
    project,
    from,
    to,
    empty: isEmpty(state) ? emptyProjectNote(project) : undefined,
    findings: checkContinuity({
      state,
      from,
      to,
      readText: (ch) => readChapterText(project, ch),
    }),
  };
}

// ── 5. entity_card ─────────────────────────────────────────────────────────

export type EntityInput = ProjectArg & { name: string };

export type EntityResult = {
  project: string;
  name: string;
  found: boolean;
  note?: string;
  current?: { state: string; chapter: number; gone: boolean };
  timeline: Array<{ chapter: number; state: string; gone?: boolean; note?: string }>;
};

export function entityCard(input: EntityInput): EntityResult {
  const project = resolveProject(input.project);
  const state = loadState(project);
  const key = entityKey(input.name);
  const record = state.entities.get(key);

  if (!record) {
    const near = [...state.entities.values()]
      .filter((e) => entityKey(e.name).includes(key) || key.includes(entityKey(e.name)))
      .map((e) => e.name)
      .slice(0, 5);
    return {
      project,
      name: input.name,
      found: false,
      note: isEmpty(state)
        ? emptyProjectNote(project)
        : near.length
          ? `Nothing recorded for "${input.name}". Similar names on record: ${near.join(', ')}.`
          : `Nothing recorded for "${input.name}" in project "${project}".`,
      timeline: [],
    };
  }

  const timeline = [...record.timeline].sort((a, b) => a.chapter - b.chapter);
  const last = timeline[timeline.length - 1];
  return {
    project,
    name: record.name,
    found: true,
    current: {
      state: last.state,
      chapter: last.chapter,
      gone: record.goneAtChapter > 0,
    },
    timeline,
  };
}

// ── 6. search_memory ───────────────────────────────────────────────────────

export type SearchInput = ProjectArg & { query: string; k?: number };

export type SearchResult = {
  project: string;
  query: string;
  empty?: string;
} & SearchOutcome;

export async function searchMemory(input: SearchInput): Promise<SearchResult> {
  const project = resolveProject(input.project);
  const state = loadState(project);
  const k = Math.min(20, Math.max(1, Math.floor(input.k ?? 6)));
  const docs = [...state.chapters.values()];

  if (isEmpty(state)) {
    return {
      project,
      query: input.query,
      empty: emptyProjectNote(project),
      mode: 'lexical',
      hits: [],
    };
  }

  const cfg = embedConfig();
  const outcome = cfg
    ? await semanticSearch(cfg, input.query, docs, state.embeddings, k)
    : { mode: 'lexical' as const, hits: lexicalSearch(input.query, docs, k) };

  return { project, query: input.query, ...outcome };
}
