/**
 * Filesystem side of the memory: read the log, append to it, park prose.
 *
 * Everything that can be decided without touching disk lives in `events.ts`.
 * This file is the thin, boring shell around it.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  chapterTextDir,
  chapterTextPath,
  eventLogPath,
  memoryHome,
  projectDir,
  sanitizeProject,
} from './paths.js';
import {
  fold,
  parseLine,
  type MemoryEvent,
  type MemoryState,
  emptyState,
} from './events.js';

/** Prose kept per chapter. Enough for continuity quoting, bounded on purpose. */
export const MAX_STORED_PROSE_CHARS = 200_000;

/** Head of the prose used as a stand-in when no summary was supplied. */
const DERIVED_SUMMARY_CHARS = 400;

export function loadState(project: string): MemoryState {
  const file = eventLogPath(project);
  if (!existsSync(file)) return emptyState();
  const raw = readFileSync(file, 'utf8');
  const events: MemoryEvent[] = [];
  let corrupt = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parseLine(line);
    if (parsed) events.push(parsed);
    else corrupt++;
  }
  const state = fold(events);
  state.corruptLines = corrupt;
  return state;
}

/**
 * Append events.
 *
 * Written as one `appendFileSync` of the whole batch: a single append syscall
 * on an `O_APPEND` descriptor will not interleave with another process's
 * append, so two editors pointed at the same book cannot shred each other's
 * lines. (They can still race on *content* — last writer wins — which is the
 * same guarantee a text editor gives, and is fine for a single-author tool.)
 */
export function appendEvents(project: string, events: MemoryEvent[]): void {
  if (!events.length) return;
  const dir = projectDir(project);
  mkdirSync(dir, { recursive: true });
  const payload = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  appendFileSync(eventLogPath(project), payload, 'utf8');
}

export function writeChapterText(
  project: string,
  chapter: number,
  text: string
): number {
  const trimmed = text.slice(0, MAX_STORED_PROSE_CHARS);
  mkdirSync(chapterTextDir(project), { recursive: true });
  writeFileSync(chapterTextPath(project, chapter), trimmed, 'utf8');
  return trimmed.length;
}

/** Prose for one chapter, or `''` when it was never stored. */
export function readChapterText(project: string, chapter: number): string {
  const file = chapterTextPath(project, chapter);
  if (!existsSync(file)) return '';
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** First `DERIVED_SUMMARY_CHARS` of prose, for when the caller gave no summary. */
export function deriveSummary(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= DERIVED_SUMMARY_CHARS) return flat;
  return flat.slice(0, DERIVED_SUMMARY_CHARS) + '…';
}

/**
 * Projects that actually have memory on disk.
 *
 * 🚨 Exists to make a typo loud. The project name is model-supplied, so
 * `recall_context` against `my-nvoel` would otherwise return a clean, cheerful,
 * completely empty result — indistinguishable from "the book has no memory",
 * which is how you get someone concluding the server is broken. Tools quote
 * this list back whenever they find nothing.
 */
export function knownProjects(): string[] {
  const home = memoryHome();
  if (!existsSync(home)) return [];
  try {
    return readdirSync(home, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => existsSync(eventLogPath(name)))
      .sort();
  } catch {
    return [];
  }
}

export { sanitizeProject };
