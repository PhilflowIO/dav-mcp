#!/usr/bin/env node
/**
 * Write the version of the Claude plugin (claude-plugin/).
 *
 * The plugin starts the published npm package pinned to an exact version
 * (`npx -y dav-mcp@<version>`): the Claude directory refuses an unpinned
 * launcher. That version, and the plugin's own `version`, belong to
 * package.json, so this script writes both from it.
 * __tests__/claude-plugin.test.js fails when the committed files differ from
 * what this script would write.
 *
 * Usage: npm run plugin:sync
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

const root = new URL('../', import.meta.url);
export const pluginJsonPath = fileURLToPath(new URL('claude-plugin/.claude-plugin/plugin.json', root));
export const mcpJsonPath = fileURLToPath(new URL('claude-plugin/.mcp.json', root));

const packageVersion = () =>
  JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version;

/**
 * plugin.json with its version taken from package.json.
 *
 * @param {Object} plugin - Parsed plugin.json
 * @returns {Object}
 */
export function syncedPlugin(plugin) {
  return { ...plugin, version: packageVersion() };
}

/**
 * .mcp.json with the dav-mcp server pinned to the package.json version.
 *
 * @param {Object} mcp - Parsed .mcp.json
 * @returns {Object}
 */
export function syncedMcpConfig(mcp) {
  const server = mcp.mcpServers['dav-mcp'];
  return {
    ...mcp,
    mcpServers: {
      ...mcp.mcpServers,
      'dav-mcp': { ...server, args: ['-y', `dav-mcp@${packageVersion()}`] },
    },
  };
}

/**
 * A JSON file as this script writes it.
 *
 * @param {Object} value
 * @returns {string}
 */
export function serializeJson(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const plugin = syncedPlugin(JSON.parse(readFileSync(pluginJsonPath, 'utf8')));
  const mcp = syncedMcpConfig(JSON.parse(readFileSync(mcpJsonPath, 'utf8')));
  writeFileSync(pluginJsonPath, serializeJson(plugin));
  writeFileSync(mcpJsonPath, serializeJson(mcp));
  console.log(`claude-plugin: version ${plugin.version}, server ${mcp.mcpServers['dav-mcp'].args.join(' ')}`);
}
