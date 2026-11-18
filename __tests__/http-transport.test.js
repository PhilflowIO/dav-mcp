import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn } from 'child_process';
import crypto from 'crypto';
import http from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// The HTTP server runs here as it does in production: the real
// src/server-http.js in its own process, the real MCP client talking to it
// over the network. Only the DAV server behind it is a stub. The suite runs on
// every Node.js version in CI, which is the point: an MCP SDK update once left
// the transport without a global it needed on an older Node.js, and every
// request failed while all unit tests stayed green.

const TOKEN = crypto.randomBytes(32).toString('hex');

// Enough DAV for tsdav to log in (discovery, principal, home sets) and for
// list_calendars and list_addressbooks to get an answer.
const davStub = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (req.method !== 'PROPFIND') {
      res.writeHead(405).end();
      return;
    }
    let collection = '';
    if (req.url.startsWith('/calendars/user/')) {
      collection = '<d:response><d:href>/calendars/user/work/</d:href><d:propstat><d:prop>' +
        '<d:displayname>Work</d:displayname>' +
        '<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>' +
        '<cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>' +
        '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
    } else if (req.url.startsWith('/addressbooks/user/')) {
      collection = '<d:response><d:href>/addressbooks/user/friends/</d:href><d:propstat><d:prop>' +
        '<d:displayname>Friends</d:displayname>' +
        '<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>' +
        '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
    }
    res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
    res.end(
      '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" ' +
      'xmlns:card="urn:ietf:params:xml:ns:carddav">' +
      `<d:response><d:href>${req.url}</d:href><d:propstat><d:prop>` +
      '<d:current-user-principal><d:href>/principals/user/</d:href></d:current-user-principal>' +
      '<cal:calendar-home-set><d:href>/calendars/user/</d:href></cal:calendar-home-set>' +
      '<card:addressbook-home-set><d:href>/addressbooks/user/</d:href></card:addressbook-home-set>' +
      '<d:resourcetype><d:collection/></d:resourcetype>' +
      '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>' +
      `${collection}</d:multistatus>`,
    );
  });
});

const listen = (server) => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

const freePort = async () => {
  const probe = http.createServer();
  const port = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  return port;
};

const serverEnv = (davPort, env) => ({
  PATH: process.env.PATH,
  NODE_ENV: 'test',
  BEARER_TOKEN: TOKEN,
  CALDAV_SERVER_URL: `http://127.0.0.1:${davPort}/`,
  CALDAV_USERNAME: 'user',
  CALDAV_PASSWORD: 'pass',
  // pinned empty so the checkout's own .env (if any) cannot add a second
  // endpoint the server would try to log onto
  CARDDAV_SERVER_URL: '',
  CARDDAV_USERNAME: '',
  CARDDAV_PASSWORD: '',
  ...env,
});

// Starts src/server-http.js against the DAV stub. Resolves once /health
// answers; rejects with the server's output if it exits or never comes up.
const startServer = async (davPort, env = {}) => {
  const port = await freePort();
  const server = { url: new URL(`http://127.0.0.1:${port}/mcp`), output: '' };
  server.child = spawn(process.execPath, ['src/server-http.js'], {
    env: serverEnv(davPort, { PORT: String(port), ...env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.child.stdout.on('data', d => { server.output += d; });
  server.child.stderr.on('data', d => { server.output += d; });

  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      if ((await fetch(new URL('/health', server.url))).ok) return server;
    } catch {
      // not listening yet
    }
    if (server.child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`HTTP server did not come up:\n${server.output}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

const stopServer = async (server) => {
  if (server?.child && server.child.exitCode === null) {
    const exited = new Promise(resolve => server.child.once('exit', resolve));
    server.child.kill();
    await exited;
  }
};

// Starts the server with a configuration it must refuse; resolves with its
// exit code and output.
const startRefused = (davPort, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['src/server-http.js'], {
    env: serverEnv(davPort, { PORT: '0', ...env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  child.on('error', reject);
  const timer = setTimeout(() => { child.kill(); resolve({ code: 'still running', output }); }, 10000);
  child.on('exit', (code) => { clearTimeout(timer); resolve({ code, output }); });
});

let davPort;
let server;
let mcpUrl;

beforeAll(async () => {
  davPort = await listen(davStub);
  server = await startServer(davPort);
  mcpUrl = server.url;
}, 30000);

afterAll(async () => {
  await stopServer(server);
  davStub.closeAllConnections?.();
  await new Promise(resolve => davStub.close(resolve));
});

const connect = async (name) => {
  const client = new Client({ name, version: '1' });
  await client.connect(new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  }));
  return client;
};

const text = (result) => result.content[0].text;

describe('HTTP transport', () => {
  test('a client can initialize, list the tools and call one', async () => {
    const client = await connect('solo');
    const { tools } = await import('../src/tools/index.js');

    const listed = (await client.listTools()).tools;
    expect(listed).toHaveLength(tools.length);
    expect(listed.map(t => [t.name, t.annotations]))
      .toEqual(tools.map(t => [t.name, t.annotations]));
    const result = await client.callTool({ name: 'list_calendars', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('Work');

    await client.close();
  }, 20000);

  // MCP clients number their requests from 0, so two clients send the same
  // ids. A server or transport shared between requests routes an answer to
  // whoever asked last under that id (GHSA-345p-7cg4-v4c7); server-http.js
  // builds both per request, and this is the test that it stays that way.
  test('concurrent clients each get the answer to their own request', async () => {
    const [a, b] = await Promise.all([connect('a'), connect('b')]);

    const rounds = await Promise.all(Array.from({ length: 10 }, () => Promise.all([
      a.callTool({ name: 'list_calendars', arguments: {} }),
      b.callTool({ name: 'list_addressbooks', arguments: {} }),
    ])));

    for (const [fromA, fromB] of rounds) {
      expect(fromA.isError).toBeFalsy();
      expect(text(fromA)).toContain('Work');
      expect(text(fromA)).not.toContain('Friends');
      expect(fromB.isError).toBeFalsy();
      expect(text(fromB)).toContain('Friends');
      expect(text(fromB)).not.toContain('Work');
    }

    await a.close();
    // closing one client's connection leaves the other's untouched
    expect((await b.listTools()).tools.length).toBeGreaterThan(0);
    await b.close();
  }, 30000);

  test('a request without the bearer token is refused before it reaches MCP', async () => {
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });

  test('/health says which account types the server logged in for', async () => {
    const health = await (await fetch(new URL('/health', mcpUrl))).json();
    expect(health.status).toBe('healthy');
    expect(health.availableAccountTypes).toEqual(['caldav', 'carddav']);
  });
});

describe('HTTP transport: BEARER_TOKEN is checked before the server listens', () => {
  // An unset token used to start a server that answered 500 to every MCP
  // request; the example value from .env.example started one anybody could
  // use. Both now stop at startup and say how to make a token.
  test.each([
    ['unset', '', 'BEARER_TOKEN is not set'],
    ['the .env.example placeholder', 'your-secure-token-here', 'BEARER_TOKEN is the example value'],
    ['the README example', 'your-secret-token', 'BEARER_TOKEN is the example value'],
    ['31 characters', 'a'.repeat(31), 'BEARER_TOKEN has 31 characters; at least 32 are required'],
  ])('%s: exits 1 and says how to generate a token', async (_, token, message) => {
    const { code, output } = await startRefused(davPort, { BEARER_TOKEN: token });
    expect(code).toBe(1);
    expect(output).toContain(message);
    expect(output).toContain('openssl rand -hex 32');
    expect(output).not.toContain('HTTP Server running');
  }, 20000);
});
