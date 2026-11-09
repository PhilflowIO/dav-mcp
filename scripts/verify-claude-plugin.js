#!/usr/bin/env node
/**
 * Check the Claude plugin as a user gets it, after Claude Code has installed
 * it: the plugin folder copied somewhere, its dependencies installed from the
 * lockfile (`npm ci --ignore-scripts`, as Claude Code runs it).
 *
 * Starts the server from .mcp.json with ${CLAUDE_PLUGIN_ROOT} and
 * ${user_config.*} filled in, and checks that initialize reports the plugin's
 * version and tools/list answers. The DAV server URL is unreachable on
 * purpose: the server must start without it and connect on the first tool
 * call.
 *
 * Usage: node scripts/verify-claude-plugin.js <installed-plugin-dir>
 */

import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { bootServer } from './mcp-boot.js';

// Values for the boot check, by user_config key. Settings with a default use it.
const DUMMY_USER_CONFIG = {
  server_url: 'https://example.invalid/dav/',
  username: 'verify',
  password: 'verify',
};

const pluginArg = process.argv[2];
if (!pluginArg) {
  console.error('Usage: node scripts/verify-claude-plugin.js <installed-plugin-dir>');
  process.exit(2);
}
const pluginDir = resolve(pluginArg);
const plugin = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
const server = JSON.parse(readFileSync(join(pluginDir, '.mcp.json'), 'utf8')).mcpServers['dav-mcp'];

const substitute = (value) => value
  .replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginDir)
  .replace(/\$\{user_config\.([a-z_]+)\}/g, (_, key) => {
    const filled = DUMMY_USER_CONFIG[key] ?? plugin.userConfig[key]?.default;
    if (filled === undefined) throw new Error(`no value for user_config.${key}`);
    return String(filled);
  });

let responses;
try {
  responses = await bootServer({
    command: server.command,
    args: server.args.map(substitute),
    env: Object.fromEntries(Object.entries(server.env).map(([name, value]) => [name, substitute(value)])),
    clientName: 'verify-claude-plugin',
  });
} catch (error) {
  console.error(`::error::server from the plugin did not answer: ${error.message}`);
  if (error.stderr) console.error(error.stderr);
  process.exit(1);
}

const serverInfo = responses.get(1).result?.serverInfo;
const tools = responses.get(2).result?.tools ?? [];
console.log(`initialize: ${serverInfo?.name} ${serverInfo?.version}, tools/list: ${tools.length} tools`);
if (serverInfo?.name !== plugin.name || serverInfo?.version !== plugin.version) {
  console.error(`::error::server reports ${serverInfo?.name} ${serverInfo?.version}, plugin.json says ${plugin.name} ${plugin.version}`);
  process.exit(1);
}
if (tools.length === 0) {
  console.error('::error::tools/list returned no tools');
  process.exit(1);
}
console.log(`${plugin.name} ${plugin.version}: plugin verified`);
