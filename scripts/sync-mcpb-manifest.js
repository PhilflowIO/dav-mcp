#!/usr/bin/env node
/**
 * Write the derived fields of manifest.json (the MCP Bundle manifest).
 *
 * Two manifest fields repeat facts that already have an owner: `version`
 * belongs to package.json, and `tools` is what src/tools/index.js registers.
 * Copying them by hand makes the manifest a second truth that drifts, so this
 * script writes both from their owners. __tests__/mcpb-manifest.test.js fails
 * when the committed manifest.json differs from what this script would write.
 *
 * Usage: npm run mcpb:sync
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { tools } from '../src/tools/index.js';

const root = new URL('../', import.meta.url);
const manifestPath = fileURLToPath(new URL('manifest.json', root));

/**
 * The tool list as the manifest declares it: name and description of every
 * registered tool, in registration order.
 *
 * @returns {Array<{name: string, description: string}>}
 */
export function registeredTools() {
  return tools.map(({ name, description }) => ({ name, description }));
}

/**
 * The manifest with its derived fields taken from their owners.
 *
 * @param {Object} manifest - Parsed manifest.json
 * @returns {Object} manifest with `version` and `tools` replaced
 */
export function syncedManifest(manifest) {
  const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  return {
    ...manifest,
    version: packageJson.version,
    tools: registeredTools(),
  };
}

/**
 * manifest.json as this script writes it.
 *
 * @param {Object} manifest - Parsed manifest.json
 * @returns {string}
 */
export function serializeManifest(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const synced = syncedManifest(manifest);
  writeFileSync(manifestPath, serializeManifest(synced));
  console.log(`manifest.json: version ${synced.version}, ${synced.tools.length} tools`);
}
