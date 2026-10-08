#!/usr/bin/env node
/**
 * Write the version of the Claude plugin (claude-plugin/).
 *
 * The plugin starts the published npm package pinned to an exact version
 * (`npx -y dav-mcp@<version>`): the Claude directory refuses an unpinned
 * launcher. That version, and the plugin's own `version`, are taken from
 * package.json, so this script writes both from it.
 *
 * Run it after the release workflow has published that version to npm, not
 * in the release pull request. The Claude directory follows `main`, and the
 * release workflow only publishes a version that is already on `main`, so
 * the plugin on `main` keeps the previous published version until then
 * (CONTRIBUTING.md, Releases). __tests__/claude-plugin.test.js checks that
 * the pin is consistent and no newer than package.json; the `plugin-pin` CI
 * job checks that it is on npm.
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

const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Compare two `x.y.z` or `x.y.z-pre` versions by semver precedence.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a < b, 0 when equal, positive when a > b
 */
export function compareVersions(a, b) {
  const pa = a.match(RELEASE_VERSION);
  const pb = b.match(RELEASE_VERSION);
  if (!pa || !pb) throw new Error(`not a release version: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  // A version without a prerelease ranks above any prerelease of it.
  if (!pa[4] || !pb[4]) return (pa[4] ? -1 : 0) + (pb[4] ? 1 : 0);
  const ia = pa[4].split('.');
  const ib = pb[4].split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    if (ia[i] === undefined) return -1;
    if (ib[i] === undefined) return 1;
    const na = /^\d+$/.test(ia[i]);
    const nb = /^\d+$/.test(ib[i]);
    if (na && nb) {
      const diff = Number(ia[i]) - Number(ib[i]);
      if (diff !== 0) return diff;
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (ia[i] !== ib[i]) {
      return ia[i] < ib[i] ? -1 : 1;
    }
  }
  return 0;
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
