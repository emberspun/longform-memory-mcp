/**
 * MCP wiring. A thin adapter over `tools.ts` — no logic lives here.
 *
 * ## The design decision that shapes everything else
 *
 * This server never calls a language model. The client calling it **is** one.
 * So `remember_chapter` does not extract entities from prose; it asks the host
 * to hand over what it already understood while reading. That is why there is
 * no API key, no account, no network, and no per-user cost — and why the tool
 * descriptions below are written as instructions to a model rather than as
 * documentation for a human.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { memoryHome } from './paths.js';
import {
  renderContinuity,
  renderEntity,
  renderRecall,
  renderRemember,
  renderSearch,
  renderThreads,
} from './render.js';
import {
  continuity,
  entityCard,
  listOpenThreads,
  recallContext,
  rememberChapter,
  searchMemory,
} from './tools.js';

export const SERVER_NAME = 'longform-memory';
export const SERVER_VERSION = '0.1.1';

const project = z
  .string()
  .optional()
  .describe(
    'Which document this is. Omit to use LONGFORM_MEMORY_PROJECT (default: "default"). Use one name per book and keep it identical across calls — a typo silently starts a new, empty memory.'
  );

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

const entitySchema = z.object({
  name: z.string().describe('Exactly as written in the prose.'),
  state: z
    .string()
    .describe(
      'Short factual state at the end of this chapter: "hiding in the cellar, arm broken".'
    ),
  gone: z
    .boolean()
    .optional()
    .describe(
      'true = died / was destroyed / left for good. false = explicitly back after having been gone (this is how you silence a continuity warning you have decided is intentional). Omit when the chapter says nothing about presence.'
    ),
  note: z.string().optional(),
});

const threadSchema = z.object({
  action: z
    .enum(['open', 'progress', 'resolve'])
    .optional()
    .describe('Default "open".'),
  ref: z
    .string()
    .optional()
    .describe(
      'For progress/resolve: the [T#] from the most recent list_open_threads call at THIS chapter number. An unrecognised ref is skipped, never guessed at.'
    ),
  summary: z.string().describe('One line: what is promised and still owed.'),
  threadType: z.string().optional(),
  deadlineChapter: z
    .number()
    .optional()
    .describe('Chapter this should pay off by. 0 or absent means "by the ending".'),
  resolutionNote: z.string().optional().describe('For resolve: how it paid off.'),
});

export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        'Persistent, constant-size memory for writing a long document (novel, manual, series).',
        '',
        'Rhythm for each chapter:',
        '  1. recall_context(chapter) — paste the returned block into your drafting context.',
        '  2. list_open_threads(chapter) — see what the document still owes the reader.',
        '  3. write the chapter.',
        '  4. remember_chapter(chapter, ...) — hand back a summary, entity states and thread moves.',
        '',
        'Step 4 is where the value is created. You are the model doing the extraction:',
        'this server stores and budgets, it never calls a model of its own.',
        `Everything is stored locally under ${memoryHome()}. Nothing is sent anywhere.`,
      ].join('\n'),
    }
  );

  server.registerTool(
    'remember_chapter',
    {
      title: 'Remember a chapter',
      description: [
        'Fold a finished chapter into the document memory.',
        '',
        'Before calling, read the chapter and produce:',
        '  · summary — 2-4 sentences. What CHANGED, not what happened. This is the',
        '    single biggest lever on recall quality months from now.',
        '  · entities — every character/place/object whose state moved, with its',
        '    state as of the end of this chapter.',
        '  · threads — promises made to the reader. Open new ones; advance or',
        '    resolve existing ones by their [T#] from list_open_threads.',
        '',
        'Passing `text` as well stores the prose locally, which is what lets',
        'check_continuity quote the exact sentence it tripped on later.',
        'Calling again for the same chapter replaces its summary — safe to redo after a revision.',
      ].join('\n'),
      inputSchema: {
        project,
        chapter: z.number().int().min(1).describe('1-based chapter number.'),
        summary: z.string().optional(),
        text: z.string().optional().describe('Full prose. Stored locally, never uploaded.'),
        entities: z.array(entitySchema).optional(),
        threads: z.array(threadSchema).optional(),
        totalChapters: z
          .number()
          .int()
          .optional()
          .describe('Planned length, if known. Used to give new threads a sane deadline.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => text(renderRemember(await rememberChapter(args)))
  );

  server.registerTool(
    'recall_context',
    {
      title: 'Recall context for a chapter',
      description: [
        'THE main tool. Returns one paste-ready block holding everything worth',
        'knowing before writing this chapter: entity states, the last few chapter',
        'summaries, a sampled skeleton of the whole arc, and older material',
        'retrieved as relevant.',
        '',
        'The block is a constant size no matter how long the document is —',
        'chapter 1000 costs the same tokens as chapter 10. Per-section token',
        'accounting comes back with it, so when something is missing you can see',
        'which section ran out of room rather than guessing.',
        '',
        'Call this BEFORE drafting, not after.',
      ].join('\n'),
      inputSchema: {
        project,
        chapter: z.number().int().min(1).describe('The chapter about to be written.'),
        budget: z
          .number()
          .int()
          .min(200)
          .optional()
          .describe(
            'Token ceiling for the block (default 6000). Resist raising it far: long contexts make models skip the middle.'
          ),
        query: z
          .string()
          .optional()
          .describe(
            "What this chapter is about — sharpens retrieval. Defaults to the previous chapter's summary."
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => text(renderRecall(await recallContext(args)))
  );

  server.registerTool(
    'list_open_threads',
    {
      title: 'List unresolved threads',
      description: [
        'What the document has promised the reader and not yet delivered, most',
        'urgent first, with overdue ones flagged and at most one marked as due now.',
        '',
        'The [T#] numbering is what remember_chapter matches `ref` against, and it',
        'is only valid for the chapter number you pass here — list again if you move on.',
      ].join('\n'),
      inputSchema: {
        project,
        chapter: z
          .number()
          .int()
          .optional()
          .describe('Defaults to the latest chapter on record.'),
        totalChapters: z.number().int().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => text(renderThreads(listOpenThreads(args)))
  );

  server.registerTool(
    'check_continuity',
    {
      title: 'Check continuity',
      description: [
        'Find places where the document contradicts its own record: a character',
        'who left the story and then acts again, a thread past its deadline.',
        '',
        'Findings are labelled "certain" (two recorded facts disagree) or "likely"',
        '(matched the prose — flashbacks and hearsay are possible, so the offending',
        'sentence is quoted for you to judge).',
        '',
        'It does NOT look for semantic contradictions — that needs a reader, which',
        'is you. This covers the part you cannot do: remembering exactly, across',
        'a thousand chapters.',
      ].join('\n'),
      inputSchema: {
        project,
        fromChapter: z.number().int().optional(),
        toChapter: z.number().int().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => text(renderContinuity(continuity(args)))
  );

  server.registerTool(
    'entity_card',
    {
      title: 'Entity card',
      description:
        'Everything on record about one character, place or object: its current state and the chapter-by-chapter timeline of how it got there. Names match case-insensitively.',
      inputSchema: { project, name: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => text(renderEntity(entityCard(args)))
  );

  server.registerTool(
    'search_memory',
    {
      title: 'Search memory',
      description: [
        'Find chapters by what happened in them, reaching past the recent window.',
        '',
        'Lexical (BM25) by default and offline. Becomes true semantic search when',
        'LONGFORM_MEMORY_EMBED_URL / _KEY / _MODEL are configured — with your own',
        'endpoint, not ours. The reply always states which mode actually ran.',
      ].join('\n'),
      inputSchema: {
        project,
        query: z.string(),
        k: z.number().int().min(1).max(20).optional().describe('Default 6.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => text(renderSearch(await searchMemory(args)))
  );

  return server;
}
