import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn } from 'child_process';
import http from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// The HTTP server runs here as it does in production: the real
// src/server-http.js in its own process, the real MCP client talking to it
// over the network. Only the DAV server behind it is a stub. The suite runs on
// every Node.js version in CI, which is the point: an MCP SDK update once left
// the transport without the global `crypto` it needs on Node.js 18, and every
// request failed while all unit tests stayed green.

const TOKEN = 'test-token';

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

let child;
let output = '';
let mcpUrl;

beforeAll(async () => {
  const davPort = await listen(davStub);
  const port = await freePort();
  mcpUrl = new URL(`http://127.0.0.1:${port}/mcp`);

  child = spawn(process.execPath, ['src/server-http.js'], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PORT: String(port),
      BEARER_TOKEN: TOKEN,
      CALDAV_SERVER_URL: `http://127.0.0.1:${davPort}/`,
      CALDAV_USERNAME: 'user',
      CALDAV_PASSWORD: 'pass',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });

  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      if ((await fetch(new URL('/health', mcpUrl))).ok) return;
    } catch {
      // not listening yet
    }
    if (child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`HTTP server did not come up:\n${output}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}, 30000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
  }
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

    expect((await client.listTools()).tools).toHaveLength(tools.length);
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
});
