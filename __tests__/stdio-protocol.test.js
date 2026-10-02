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

// A wrong configuration will not be any better on the first tool call. Over
// stdio it used to be swallowed as "DAV server not reachable at startup" and
// the server reported ready; the HTTP server already exited.
const start = (script, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PORT: '0',
      BEARER_TOKEN: 'test-token',
      CALDAV_SERVER_URL: 'https://example.invalid',
      CALDAV_USERNAME: 'x',
      CALDAV_PASSWORD: 'y',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  child.on('error', reject);
  const timer = setTimeout(() => { child.kill(); resolve({ code: 'still running', output }); }, 6000);
  child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
});

describe('configuration errors are fatal at startup', () => {
  test.each([
    ['stdio', 'src/server-stdio.js'],
    ['http', 'src/server-http.js'],
  ])('%s: an unknown AUTH_METHOD exits 1 and names the valid values', async (_, script) => {
    const { code, output } = await start(script, { AUTH_METHOD: 'Bearer' });
    expect(code).toBe(1);
    expect(output).toContain("Unsupported AUTH_METHOD 'Bearer'");
    expect(output).toContain('Valid values: Basic (default), Digest, OAuth (or OAuth2).');
    expect(output).not.toContain('server ready');
  }, 20000);

  test.each([
    ['stdio', 'src/server-stdio.js'],
    ['http', 'src/server-http.js'],
  ])('%s: missing credentials for the chosen method exit 1', async (_, script) => {
    const { code, output } = await start(script, { AUTH_METHOD: 'oauth2' });
    expect(code).toBe(1);
    expect(output).toContain('OAuth2 requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN');
  }, 20000);

  test('stdio: an unreachable DAV server is not a configuration error — the server stays up', async () => {
    const { code, output } = await start('src/server-stdio.js', {});
    expect(code).toBe('still running');
    expect(output).toContain('will retry on first tool call');
    expect(output).toContain('dav-mcp STDIO server ready');
  }, 20000);
});
