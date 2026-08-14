import { describe, test, expect } from '@jest/globals';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Under the stdio transport, stdout carries JSON-RPC and nothing else. Anything
// else printed there — a dotenv banner, a stray console.log — makes a strict
// client fail on the first message, which is invisible in unit tests.
const speak = (messages) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['src/server-stdio.js'], {
    env: {
      ...process.env,
      MCP_TRANSPORT: 'stdio',
      CALDAV_SERVER_URL: 'https://example.invalid',
      CALDAV_USERNAME: 'x',
      CALDAV_PASSWORD: 'y',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  child.stdout.on('data', d => { stdout += d; });
  child.on('error', reject);

  messages.forEach(m => child.stdin.write(JSON.stringify(m) + '\n'));

  setTimeout(() => {
    child.kill();
    resolve(stdout.trim().split('\n').filter(Boolean));
  }, 4000);
});

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};

describe('stdio transport keeps stdout clean', () => {
  test('every line on stdout is valid JSON-RPC', async () => {
    const lines = await speak([INITIALIZE, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    expect(lines.length).toBeGreaterThan(0);
    lines.forEach(line => expect(() => JSON.parse(line)).not.toThrow());
  }, 20000);

  test('the version reported to clients matches package.json', async () => {
    const [first] = await speak([INITIALIZE]);
    expect(JSON.parse(first).result.serverInfo.version).toBe(packageJson.version);
  }, 20000);

  test('every registered tool is advertised', async () => {
    const lines = await speak([INITIALIZE, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    const listed = lines.map(l => JSON.parse(l)).find(m => m.id === 2);
    const { tools } = await import('../src/tools/index.js');
    expect(listed.result.tools).toHaveLength(tools.length);
  }, 20000);
});
