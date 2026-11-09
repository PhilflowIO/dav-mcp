/**
 * Start a stdio MCP server the way a client does and ask it for its tools.
 *
 * Shared by scripts/verify-mcpb.js (the MCP Bundle) and
 * scripts/verify-claude-plugin.js (the Claude plugin). The server runs from a
 * fresh temporary directory with only PATH and the given env, so neither a
 * stray .env nor the caller's environment can help it start.
 */

import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const BOOT_TIMEOUT_MS = 15000;

/**
 * Send initialize, then tools/list, and resolve with the responses by id
 * (1: initialize, 2: tools/list). Rejects when the server exits, writes
 * anything but JSON-RPC to stdout, or does not answer in time; the error
 * carries the server's stderr.
 *
 * @param {Object} options
 * @param {string} options.command - `node` runs the node that runs this script
 * @param {string[]} options.args
 * @param {Object<string, string>} options.env
 * @param {string} options.clientName
 * @returns {Promise<Map<number, Object>>}
 */
export function bootServer({ command, args, env, clientName }) {
  const cwd = mkdtempSync(join(tmpdir(), `${clientName}-`));
  const executable = command === 'node' ? process.execPath : command;
  const child = spawn(executable, args, {
    cwd,
    env: { PATH: process.env.PATH, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return new Promise((resolvePromise, reject) => {
    const responses = new Map();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      rmSync(cwd, { recursive: true, force: true });
      if (error) reject(Object.assign(error, { stderr }));
      else resolvePromise(responses);
    };
    const timer = setTimeout(() => finish(new Error(`no tools/list answer within ${BOOT_TIMEOUT_MS} ms`)), BOOT_TIMEOUT_MS);

    child.stderr.on('data', d => { stderr += d; });
    child.on('error', finish);
    child.on('exit', (code) => finish(new Error(`server exited with code ${code} before answering`)));
    child.stdout.on('data', (data) => {
      stdout += data;
      const lines = stdout.split('\n');
      stdout = lines.pop();
      for (const line of lines.filter(Boolean)) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error(`non-JSON line on stdout: ${line.slice(0, 200)}`));
          return;
        }
        responses.set(message.id, message);
        if (message.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
        }
        if (message.id === 2) finish();
      }
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: clientName, version: '1' } },
    }) + '\n');
  });
}
