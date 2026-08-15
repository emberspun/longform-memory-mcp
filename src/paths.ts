/**
 * Where memory lives on disk, and the one place a project name is validated.
 *
 * Everything here is local to the machine running the server. No network, no
 * account, no telemetry — that is a product promise, so keep it true.
 */
import { homedir } from 'node:os';
import path from 'node:path';

/** Root directory. Override with `LONGFORM_MEMORY_HOME`. */
export function memoryHome(): string {
  const custom = process.env.LONGFORM_MEMORY_HOME?.trim();
  return custom ? path.resolve(custom) : path.join(homedir(), '.longform-memory');
}

/** Project used when a tool call does not name one. */
export function defaultProject(): string {
  const fromEnv = process.env.LONGFORM_MEMORY_PROJECT?.trim();
  return fromEnv ? sanitizeProject(fromEnv) : 'default';
}

/**
 * 🚨 The project name arrives from tool input, i.e. **from a language model**.
 *
 * Untrusted by definition: `../../.ssh` is a perfectly plausible token for a
 * model to emit, and `path.join` would happily walk out of the memory root.
 * So this is an allow-list, not a deny-list — anything outside
 * `[A-Za-z0-9._-]` is folded to `-`, and the traversal-shaped results that
 * survive that fold (`.`, `..`, `...`) are rejected outright.
 *
 * Also collapses to lower case: `MyBook` and `mybook` addressing two different
 * memories would look, from the outside, exactly like data loss.
 */
export function sanitizeProject(raw: string): string {
  const folded = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    // Runs of dots carry no meaning once separators are gone, and a leading one
    // would quietly create a hidden directory the user cannot find.
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .slice(0, 64);
  if (!folded) return 'default';
  return folded;
}

export function projectDir(project: string): string {
  return path.join(memoryHome(), sanitizeProject(project));
}

export function eventLogPath(project: string): string {
  return path.join(projectDir(project), 'events.jsonl');
}

export function chapterTextDir(project: string): string {
  return path.join(projectDir(project), 'chapters');
}

/**
 * Zero-padded so a plain `ls` sorts the way a reader expects. Six digits
 * because serialised fiction genuinely reaches five (and this costs nothing).
 */
export function chapterTextPath(project: string, chapter: number): string {
  const n = String(Math.max(0, Math.floor(chapter))).padStart(6, '0');
  return path.join(chapterTextDir(project), `${n}.txt`);
}
