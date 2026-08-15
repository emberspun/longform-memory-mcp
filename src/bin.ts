#!/usr/bin/env node
/**
 * stdio entry point. `npx longform-memory-mcp` lands here.
 *
 * 🚨 **Nothing may ever be written to stdout except protocol frames.** stdout
 * *is* the transport: one stray `console.log` — a debug line, a dependency's
 * banner — corrupts the JSON-RPC stream and the client reports a cryptic parse
 * error rather than pointing at the log line. Diagnostics go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { memoryHome } from './paths.js';

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `${SERVER_NAME} ${SERVER_VERSION} ready · memory at ${memoryHome()}\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `longform-memory-mcp failed to start: ${(error as Error)?.message ?? error}\n`
  );
  process.exit(1);
});
