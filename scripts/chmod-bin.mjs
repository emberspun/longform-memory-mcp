/**
 * Make the built entry executable.
 *
 * `npx longform-memory-mcp` works via npm's bin shim on most setups, but a
 * non-executable target still breaks direct `./node_modules/.bin/...` calls and
 * some Windows/WSL shims. tsc does not preserve the mode, so set it here.
 */
import { chmod } from 'node:fs/promises';

await chmod(new URL('../dist/bin.js', import.meta.url), 0o755);
