/**
 * A real client, a real child process, a real stdio handshake.
 *
 * Everything else in this suite calls the tool functions directly, which proves
 * the logic and proves nothing about the thing users actually run. The failures
 * that only show up here are the expensive ones: a bin that is not executable,
 * a schema the SDK rejects at registration time, an ESM import that resolves
 * under vitest and not under plain node.
 *
 * ⚠️ The client-driven cases below do NOT catch a stray write to stdout —
 * measured, not assumed. A `console.log` inside a tool handler leaves every one
 * of them green, because the transport reports the unparseable line through
 * `onerror` and carries on with the next one. Real clients are less forgiving
 * and less clear about it, so stdout hygiene gets its own raw test at the
 * bottom of this file.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let home: string;
let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  // Build first: this test must exercise the published artifact, not the
  // sources. A stale dist/ passing here would be worse than no test.
  execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], {
    cwd: root,
    stdio: 'pipe',
  });

  home = mkdtempSync(path.join(tmpdir(), 'lfm-proto-'));
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'dist', 'bin.js')],
    env: {
      PATH: process.env.PATH ?? '',
      LONGFORM_MEMORY_HOME: home,
      LONGFORM_MEMORY_PROJECT: 'protobook',
    },
    stderr: 'pipe',
  });
  client = new Client({ name: 'test-harness', version: '0' });
  await client.connect(transport);
}, 120_000);

afterAll(async () => {
  await client?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })
    .content;
  return (content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

describe('stdio protocol', () => {
  it('advertises exactly the six tools of the contract', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_continuity',
      'entity_card',
      'list_open_threads',
      'recall_context',
      'remember_chapter',
      'search_memory',
    ]);
  });

  it('gives every tool a description a directory listing can show', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description ?? '', tool.name).not.toBe('');
      expect((tool.description ?? '').length, tool.name).toBeGreaterThan(60);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('runs a full write-then-recall cycle over the wire', async () => {
    const wrote = await client.callTool({
      name: 'remember_chapter',
      arguments: {
        chapter: 1,
        summary: 'Ines finds the sealed letter and tells no one.',
        text: 'Ines turned the letter over twice before hiding it under the floorboard.',
        entities: [{ name: 'Ines', state: 'hiding the letter' }],
        threads: [{ summary: 'who sealed the letter', deadlineChapter: 12 }],
        totalChapters: 40,
      },
    });
    expect(textOf(wrote)).toContain('Recorded chapter 1');

    const recalled = await client.callTool({
      name: 'recall_context',
      arguments: { chapter: 2, budget: 3000 },
    });
    const block = textOf(recalled);
    expect(block).toContain('Ines finds the sealed letter');
    expect(block).toContain('## Entities — current state');
    expect(block).toMatch(/\d+\/3000 tokens/);

    const threads = await client.callTool({
      name: 'list_open_threads',
      arguments: { chapter: 2, totalChapters: 40 },
    });
    expect(textOf(threads)).toContain('[T1] who sealed the letter');
  });

  /** The schema is enforced by the SDK, not by us — check that it actually is. */
  it('rejects a call that violates the input schema', async () => {
    const result = await client.callTool({
      name: 'recall_context',
      arguments: { chapter: 'not a number' },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it('reports an empty project by name instead of returning a blank block', async () => {
    const result = await client.callTool({
      name: 'search_memory',
      arguments: { project: 'no-such-book', query: 'anything' },
    });
    expect(textOf(result)).toContain('no-such-book');
  });
});

/**
 * stdout hygiene, checked at the byte level.
 *
 * For a stdio server, stdout **is** the transport. One `console.log` anywhere —
 * a debug line, a dependency's startup banner — puts a non-JSON line into the
 * stream. The SDK's own client shrugs it off, so the suite above cannot see it;
 * a user's client reports a parse error that points nowhere near the cause.
 */
describe('stdout carries protocol frames and nothing else', () => {
  it('emits only valid JSON lines across a full handshake and tool call', async () => {
    const child = spawn(process.execPath, [path.join(root, 'dist', 'bin.js')], {
      env: {
        PATH: process.env.PATH ?? '',
        LONGFORM_MEMORY_HOME: mkdtempSync(path.join(tmpdir(), 'lfm-raw-')),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });

    const send = (msg: unknown) =>
      child.stdin.write(JSON.stringify(msg) + '\n');

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw', version: '0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'remember_chapter',
        arguments: { chapter: 1, summary: 'a summary', text: 'some prose' },
      },
    });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });

    // Poll until the last id comes back, rather than sleeping a fixed amount:
    // a fixed sleep passes on a fast machine and flakes on a loaded one.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !out.includes('"id":3')) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const timedOut = !out.includes('"id":3');
    child.kill();

    /*
      Assert the timeout separately and first. Without this, a slow or dead
      child produces a truncated buffer and the failure surfaces as a confusing
      "line count" or "not JSON" error pointing at the wrong cause — which is
      how a flake ends up mis-diagnosed as a real defect, or vice versa.
    */
    expect(timedOut, `no reply to id 3 within 15s; stdout so far: ${out.slice(0, 400)}`).toBe(false);

    const lines = out.split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const notJson = lines.filter((line) => {
      try {
        JSON.parse(line);
        return false;
      } catch {
        return true;
      }
    });
    expect(notJson).toEqual([]);
  }, 30_000);
});
