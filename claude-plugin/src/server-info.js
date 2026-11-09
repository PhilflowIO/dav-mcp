import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/**
 * The version we report to MCP clients.
 *
 * Read from package.json rather than hardcoded: the literal sat in five places
 * and still said 3.0.1 after two releases, so every client was told the wrong
 * version.
 */
const packageJson = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
);

export const SERVER_NAME = process.env.MCP_SERVER_NAME || packageJson.name;
export const SERVER_VERSION = process.env.MCP_SERVER_VERSION || packageJson.version;
