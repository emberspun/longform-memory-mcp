/**
 * Library surface.
 *
 * The server is normally launched as a binary, but everything it does is
 * callable directly — useful for embedding the same memory model in your own
 * pipeline, and it is what keeps the tools testable without a transport.
 *
 * @see https://github.com/emberspun/longform-memory-mcp
 */
export { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';

export {
  continuity,
  entityCard,
  listOpenThreads,
  orderedOpenThreads,
  recallContext,
  rememberChapter,
  searchMemory,
} from './tools.js';
export type {
  ContinuityToolInput,
  ContinuityToolResult,
  EntityInput,
  EntityResult,
  RecallInput,
  RecallToolResult,
  RememberInput,
  RememberResult,
  SearchInput,
  SearchResult,
  ThreadsInput,
  ThreadsResult,
} from './tools.js';

export { assemble, RECENT_WINDOW, SECTION_HEADINGS } from './assemble.js';
export type { RecallResult, SectionDiagnostic } from './assemble.js';

export { absenceWindows, checkContinuity, onStagePattern, sentences } from './continuity.js';
export type { Finding, FindingKind } from './continuity.js';

export { emptyState, entityKey, fold, parseLine } from './events.js';
export type {
  ChapterRecord,
  EntityRecord,
  MemoryEvent,
  MemoryState,
  ThreadRecord,
} from './events.js';

export { embedConfig, lexicalSearch, tokenize } from './search.js';
export type { SearchHit, SearchMode, SearchOutcome } from './search.js';

export {
  appendEvents,
  deriveSummary,
  knownProjects,
  loadState,
  readChapterText,
  writeChapterText,
} from './store.js';

export {
  chapterTextPath,
  defaultProject,
  eventLogPath,
  memoryHome,
  projectDir,
  sanitizeProject,
} from './paths.js';
