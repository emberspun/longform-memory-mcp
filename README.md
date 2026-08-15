<div align="center">

<img src="./assets/hero.webp" alt="A long row of numbered archive cards receding into the distance, with only a dozen pulled out and set aside in focus" width="100%" />

# longform-memory-mcp

**Your AI writing assistant remembers chapter 3 when it writes chapter 300 — and the prompt never gets bigger.**

[![CI](https://github.com/emberspun/longform-memory-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/emberspun/longform-memory-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/longform-memory-mcp?logo=npm&color=cb3837)](https://www.npmjs.com/package/longform-memory-mcp)
[![downloads](https://img.shields.io/npm/dm/longform-memory-mcp?color=cb3837)](https://www.npmjs.com/package/longform-memory-mcp)

[![MCP](https://img.shields.io/badge/MCP-server-6E56CF.svg)](https://modelcontextprotocol.io)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![no API key](https://img.shields.io/badge/API%20key-not%20required-brightgreen.svg)](#privacy)
[![offline](https://img.shields.io/badge/network-never-brightgreen.svg)](#privacy)
[![tests](https://img.shields.io/badge/tests-54%20passing-brightgreen.svg)](./test)

**[Documentation and the numbers behind it →](https://emberspun.com/open-source/longform-memory)**

</div>

---

## Install

One line in your MCP config. No account, no key, no sign-up.

**Claude Desktop** — `claude_desktop_config.json`
**Cursor** — `~/.cursor/mcp.json`
**Windsurf, Cline, Zed, Continue** — same shape

```json
{
  "mcpServers": {
    "longform-memory": {
      "command": "npx",
      "args": ["-y", "longform-memory-mcp"],
      "env": { "LONGFORM_MEMORY_PROJECT": "my-novel" }
    }
  }
}
```

**Claude Code**

```bash
claude mcp add longform-memory -e LONGFORM_MEMORY_PROJECT=my-novel -- npx -y longform-memory-mcp
```

Restart your client. Then say: *"remember this chapter"* and *"recall context for chapter 12"*.

---

## The problem it solves

Write anything long with an LLM — a novel, a manual, a course, a serialised story — and you hit the same wall twice.

**Withhold the past and it contradicts itself.** A character who died in chapter 12 speaks in chapter 30. The key planted in chapter 3 is never mentioned again.

**Send the past and you cannot afford it.** Pasting every prior summary is O(n): tens of thousands of tokens by chapter 100, and by chapter 1000 it does not fit at all. Filling the window also makes things *worse* — models skip the middle.

Both are the same problem wearing two hats: **there is no budget ceiling.**

```
   memory in the prompt
         │
   61k  ─┤                                              ╭──── just paste it all
         │                                        ╭─────╯
   30k  ─┤                          ╭─────────────╯
         │            ╭─────────────╯
    4k  ─┤════════════╪═════════════╪═════════════╪════ longform-memory
         └──────┬─────┴──────┬──────┴──────┬──────┴────
               10           100           500        1000     chapter
```

Measured on a real 1000-chapter book: **61,331 tokens → 4,396**, and going from chapter 500 to chapter 1000 grew the block by **2 tokens**.

---

## The six tools

| tool | what it does |
| --- | --- |
| `recall_context` | **The main one.** One paste-ready block: entity states, recent chapters, a sampled skeleton of the whole arc, and older material retrieved as relevant — at a fixed token size, with per-section accounting. |
| `remember_chapter` | Folds a finished chapter in: summary, entity state changes, thread moves. Optionally stores the prose locally. |
| `list_open_threads` | What the document promised the reader and has not delivered, most urgent first, overdue flagged. |
| `check_continuity` | Characters who left the story and act again; threads past their deadline. **Quotes the sentence it tripped on.** |
| `entity_card` | One character/place/object: current state plus the chapter-by-chapter timeline of how it got there. |
| `search_memory` | Find chapters by what happened in them, reaching past the recent window. BM25 offline; true semantic search if you configure your own embedding endpoint. |

### The rhythm

```
   ┌─ recall_context(12) ──────► paste into your drafting context
   │
   ├─ list_open_threads(12) ───► what's still owed
   │
   ├─ …write chapter 12…
   │
   └─ remember_chapter(12, …) ─► summary · entity states · thread moves
```

Step four is where the value is made. **Your assistant is the model doing the extraction** — it just read the chapter, so it already knows what changed.

---

## It never calls a model

<img src="./assets/constant.webp" alt="A single slim card box on a desk, holding a small set of cards with room to spare, casting a long shadow" align="right" width="38%" />

This server has **no LLM inside it**. The client calling it already is one.

So `remember_chapter` does not run an extraction pass over your prose — it asks your assistant to hand over what it understood while reading. That single decision is why there is:

- **no API key** to obtain, paste, rotate or leak
- **no account**, no sign-up, no rate limit
- **no cost** to anyone, at any usage level
- **no network call**, ever

<br clear="right" />

## Privacy

Everything lives in plain files under `~/.longform-memory/<project>/`:

```
~/.longform-memory/my-novel/
├── events.jsonl        # append-only: summaries, entity states, threads
└── chapters/
    ├── 000001.txt      # your prose, only if you passed `text`
    └── 000002.txt
```

Readable, greppable, `rm`-able, and yours. **No telemetry.** The only outbound request this package can ever make is to an embedding endpoint you configure yourself — and if you configure none, the code path never runs.

Why an append-only log rather than SQLite: this server is launched by `npx` inside someone else's editor, and a native module that fails to build there is not a degraded experience — it is a server that never starts, and you would never find out why.

---

## Configuration

| variable | default | meaning |
| --- | --- | --- |
| `LONGFORM_MEMORY_PROJECT` | `default` | Which document. One entry per book, or pass `project` per call. |
| `LONGFORM_MEMORY_HOME` | `~/.longform-memory` | Where memory is stored. |
| `LONGFORM_MEMORY_EMBED_URL` | — | OpenAI-compatible `/embeddings` endpoint. **Optional.** |
| `LONGFORM_MEMORY_EMBED_KEY` | — | Your key, for your endpoint. |
| `LONGFORM_MEMORY_EMBED_MODEL` | — | e.g. `text-embedding-3-small`. |

All three embedding variables must be set together — a half-configured endpoint that quietly does nothing is worse than no feature. `search_memory` always states which mode actually ran.

---

## What it deliberately does not do

- **No semantic contradiction detection.** "Three towers in chapter 4, four in chapter 60" needs a reader. A detector guessing at that produces a panel full of false alarms, and a panel that cries wolf is a panel nobody reads. `check_continuity` covers the part a model is bad at — remembering exactly, across a thousand chapters.
- **No writing.** It does not generate, rewrite or critique prose.
- **No cloud sync.** One machine, one directory.
- **No automatic extraction.** If your client does not send entity states and threads, you get summary storage — and the reply tells you so rather than pretending.

---

## Use it as a library

The server is a thin adapter; everything is callable directly.

```ts
import { recallContext, rememberChapter } from 'longform-memory-mcp';

await rememberChapter({
  project: 'my-novel',
  chapter: 12,
  summary: 'Ines burns the letter and lies to her brother about it.',
  entities: [{ name: 'Ines', state: 'lying to Tomas', note: 'first outright lie' }],
  threads: [{ summary: 'what the letter actually said', deadlineChapter: 30 }],
});

const { recall } = await recallContext({ project: 'my-novel', chapter: 13 });
console.log(recall.text);       // paste-ready block
console.log(recall.sections);   // { entity: { usedTokens, kept, dropped }, … }
```

The budgeting core is published separately, with no dependencies at all:
**[`longform-memory`](https://github.com/emberspun/longform-memory)** (npm) · **[`longform-memory`](https://github.com/emberspun/longform-memory-python)** (PyPI).

---

## Development

```bash
npm install
npm test          # 54 tests, including a real stdio protocol round-trip
npm run build
```

The test suite spawns the built binary and speaks JSON-RPC to it, because the failures that only appear there are the expensive ones — a non-executable bin, a schema the SDK rejects, a stray write to stdout corrupting the transport.

## License

MIT © Emberspun. Built for [Emberspun, an AI book writer for self-publishers](https://emberspun.com) — this memory layer runs there on every chapter.

## Claude Skill

Tool descriptions tell a model what a call returns. They cannot tell it that
recalling *after* drafting is useless, or that a `[T3]` from one chapter must not
be quoted at another. That is sequencing and judgement, and it lives in a skill:

**[emberspun/longform-memory-skill](https://github.com/emberspun/longform-memory-skill)**

```bash
git clone https://github.com/emberspun/longform-memory-skill.git \
  ~/.claude/skills/longform-writing
```

Kept in its own repository so there is exactly one copy — the same text in two
places drifts, and the stale one is the one somebody reads.
