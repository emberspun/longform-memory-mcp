/**
 * Tool results as text.
 *
 * What an MCP client actually feeds its model is the `content` block, so this
 * file is the real output of the server — a beautifully structured object the
 * model never sees is worth nothing. Diagnostics are rendered inline for the
 * same reason: hidden in a side channel, they may as well not exist.
 */
import type { MemorySection } from 'longform-memory';
import type {
  ContinuityToolResult,
  EntityResult,
  RecallToolResult,
  RememberResult,
  SearchResult,
  ThreadsResult,
} from './tools.js';

const SECTION_ORDER: MemorySection[] = [
  'entity',
  'recent',
  'skeleton',
  'retrieval',
];

export function renderRemember(r: RememberResult): string {
  const lines = [
    `Recorded chapter ${r.chapter} in project "${r.project}".`,
    `  summary: ${r.summaryDerived ? 'derived from prose (no summary given)' : 'stored'}` +
      `  ·  prose: ${r.proseChars ? `${r.proseChars} chars` : 'not stored'}`,
    `  entities: ${r.entitiesRecorded}  ·  threads: +${r.threadsOpened} opened, ${r.threadsProgressed} advanced, ${r.threadsResolved} resolved`,
  ];
  if (r.skipped.length) {
    lines.push(`  skipped ${r.skipped.length}:`);
    for (const s of r.skipped) {
      lines.push(`    - [${s.reason}] ${s.summary || '(no summary)'}`);
    }
  }
  for (const note of r.notes) lines.push(`  ! ${note}`);
  return lines.join('\n');
}

export function renderRecall(r: RecallToolResult): string {
  if (r.empty) return r.empty;
  const recall = r.recall!;
  const pct = recall.budget
    ? Math.round((recall.usedTokens / recall.budget) * 100)
    : 0;

  const diag = SECTION_ORDER.map((key) => {
    const s = recall.sections[key];
    return `  ${key.padEnd(9)} ${String(s.usedTokens).padStart(5)} tok  ${s.kept} kept${s.dropped ? `, ${s.dropped} dropped` : ''}`;
  }).join('\n');

  const parts = [
    recall.text || '(nothing recorded before this chapter yet)',
    '',
    '---',
    `Memory block for chapter ${r.chapter}: ${recall.usedTokens}/${recall.budget} tokens (${pct}%).`,
    diag,
    `  retrieval mode: ${r.retrievalMode ?? 'lexical'}`,
  ];
  if (r.retrievalNote) parts.push(`  ! ${r.retrievalNote}`);
  if (r.corruptLines) {
    parts.push(`  ! ${r.corruptLines} unreadable line(s) in the memory log were skipped.`);
  }
  parts.push(
    'Open threads are NOT in this block — call list_open_threads for those.'
  );
  return parts.join('\n');
}

export function renderThreads(r: ThreadsResult): string {
  if (r.empty) return r.empty;
  if (!r.total) return `No unresolved threads on record at chapter ${r.chapter}.`;

  const lines = [
    `${r.total} unresolved thread(s) as of chapter ${r.chapter}${r.overdue ? `, ${r.overdue} overdue` : ''}:`,
    '',
    r.rendered,
    '',
    'Reference these by their [T#] when calling remember_chapter — the numbering is',
    'only valid for this chapter number, so re-list if you move on.',
  ];
  if (r.mustResolve) {
    lines.push(
      '',
      `MUST pay off in this chapter (${r.mustResolve.overdueBy} chapters overdue): ${r.mustResolve.summary}`
    );
  }
  return lines.join('\n');
}

export function renderContinuity(r: ContinuityToolResult): string {
  if (r.empty) return r.empty;
  if (!r.findings.length) {
    return [
      `No continuity problems found in chapters ${r.from}–${r.to}.`,
      'Checked: characters recorded as having left the story who act again, and',
      'threads past their deadline. Semantic contradictions are NOT checked —',
      'read the prose for those.',
    ].join('\n');
  }

  const lines = [`${r.findings.length} finding(s) in chapters ${r.from}–${r.to}:`, ''];
  for (const f of r.findings) {
    lines.push(
      `[${f.confidence}] ch.${f.chapter} · ${f.kind} · ${f.subject}`,
      `  ${f.detail}`
    );
    if (f.quote) lines.push(`  > ${f.quote}`);
    lines.push('');
  }
  lines.push(
    '"certain" findings come from two recorded facts contradicting each other.',
    '"likely" findings matched the prose and may be flashback or hearsay — the',
    'quoted sentence is there so you can settle it without re-reading the chapter.'
  );
  return lines.join('\n');
}

export function renderEntity(r: EntityResult): string {
  if (!r.found) return r.note ?? `Nothing recorded for "${r.name}".`;
  const lines = [
    `${r.name} — ${r.current!.state} (as of ch.${r.current!.chapter})${r.current!.gone ? ' · has left the story' : ''}`,
    '',
    'Timeline:',
  ];
  for (const point of r.timeline) {
    const flag =
      point.gone === true ? ' [left the story]' : point.gone === false ? ' [back]' : '';
    lines.push(
      `  ch.${point.chapter}: ${point.state}${flag}${point.note ? ` — ${point.note}` : ''}`
    );
  }
  return lines.join('\n');
}

export function renderSearch(r: SearchResult): string {
  if (r.empty) return r.empty;
  const head = `${r.hits.length} result(s) for "${r.query}" (${r.mode} search).`;
  if (!r.hits.length) {
    return [
      head,
      r.note ? `! ${r.note}` : '',
      r.mode === 'lexical'
        ? 'Lexical search matches wording, not meaning. Try the words the text itself would use.'
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const lines = [head, ''];
  for (const hit of r.hits) {
    lines.push(`[ch.${hit.chapter}] (${hit.score.toFixed(3)}) ${hit.summary}`);
  }
  if (r.note) lines.push('', `! ${r.note}`);
  return lines.join('\n');
}
