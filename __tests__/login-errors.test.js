import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { spawn } from 'child_process';
import { createServer } from 'http';
import { readFileSync } from 'fs';

// A failed login has to tell the user where dav-mcp's settings live (#123).
// They are not always in a .env file: the Claude Code plugin keeps them in
// its plugin options, the Claude Desktop extension in its extension
// settings, and npx or Docker in environment variables. dav-mcp cannot tell
// which of these started it, so the message names all three.
//
// The client manager builds real tsdav clients; only fetch is replaced, and
// before tsdav and request-origins.js load, because both bind the platform
// fetch when they are imported.

const SERVER = 'https://dav.example.com/';
const TOKEN_URL = 'https://oauth.example.com/token';

let respond;
const realFetch = globalThis.fetch;
globalThis.fetch = jest.fn(async (url, init = {}) => respond(String(url), init));

const { buildTsdavConfig } = await import('../src/auth-config.js');
const { tsdavManager } = await import('../src/tsdav-client.js');
const { formatMCPError, MCP_ERROR_CODES } = await import('../src/error-handler.js');
globalThis.fetch = realFetch;

const passwordEnv = { CALDAV_SERVER_URL: SERVER, CALDAV_USERNAME: 'alex', CALDAV_PASSWORD: 'wrong' };
const oauthEnv = {
  AUTH_METHOD: 'OAuth',
  GOOGLE_SERVER_URL: SERVER,
  GOOGLE_USER: 'alex@example.com',
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  GOOGLE_REFRESH_TOKEN: 'revoked',
  GOOGLE_TOKEN_URL: TOKEN_URL,
};

const EXTENSION_NAME = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')).display_name;

const loginError = (env) => tsdavManager.initialize(buildTsdavConfig(env)).catch(e => e);

const expectPasswordSettingsNamed = (message) => {
  // the Claude Code plugin
  expect(message).toContain('/plugin');
  expect(message).toContain('Configure options');
  // the Claude Desktop extension (MCP bundle), listed under its display name
  expect(message).toContain(`Settings → Extensions → ${EXTENSION_NAME}`);
  // npx, Docker, a checkout
  expect(message).toContain('CALDAV_USERNAME');
  expect(message).toContain('CALDAV_PASSWORD');
  expect(message).toContain('.env');
};

beforeEach(() => {
  respond = async (url) => {
    if (new URL(url).pathname.startsWith('/.well-known/')) {
      return new Response('', { status: 404, statusText: 'Not Found' });
    }
    return new Response('Unauthorized', {
      status: 401, statusText: 'Unauthorized', headers: { 'www-authenticate': 'Basic realm="dav"' },
    });
  };
});

describe('a login the server refuses', () => {
  test('is an authentication error that keeps the cause and names every place the password is set', async () => {
    const error = await loginError(passwordEnv);

    expect(error.name).toBe('AuthenticationError');
    expect(formatMCPError(error).code).toBe(MCP_ERROR_CODES.AUTH_ERROR);
    expect(error.message).toContain(SERVER);
    expect(error.message).toContain('401 Unauthorized');
    expectPasswordSettingsNamed(error.message);
    expect(error.message).not.toContain('Verify server settings in .env file');
    // the URL is fine; the credentials were refused
    expect(error.message).not.toContain('does not lead to a CalDAV/CardDAV server');
  });

  // Baïkal: the configured /dav.php/ answers 401, tsdav then tries the server
  // root as another candidate, which answers 405. The refusal must survive the
  // later answer (review of #134: it used to be read from the last response).
  test('Baïkal shape: a 405 from the server root after the 401 is still a refused login', async () => {
    respond = async (url) => {
      const { pathname } = new URL(url);
      if (pathname.startsWith('/.well-known/')) return new Response('', { status: 404, statusText: 'Not Found' });
      if (pathname === '/') return new Response('', { status: 405, statusText: 'Method Not Allowed' });
      return new Response('', {
        status: 401, statusText: 'Unauthorized', headers: { 'www-authenticate': 'Basic realm="dav"' },
      });
    };

    const error = await loginError({ ...passwordEnv, CALDAV_SERVER_URL: `${SERVER}dav.php/` });

    expect(error.name).toBe('AuthenticationError');
    expect(formatMCPError(error).code).toBe(MCP_ERROR_CODES.AUTH_ERROR);
    expect(error.message).toContain('401 Unauthorized');
  });

  test('OAuth: a refused refresh token names the GOOGLE_ variables, not the plugin options', async () => {
    respond = async (url) => (url.startsWith(TOKEN_URL)
      ? new Response('{"error":"invalid_grant"}', {
        status: 400, statusText: 'Bad Request', headers: { 'content-type': 'application/json' },
      })
      : new Response('', { status: 500 }));

    const error = await loginError(oauthEnv);

    expect(error.name).toBe('AuthenticationError');
    expect(formatMCPError(error).code).toBe(MCP_ERROR_CODES.AUTH_ERROR);
    expect(error.message).toContain('GOOGLE_REFRESH_TOKEN');
    expect(error.message).toContain('.env');
    // neither the plugin nor the extension can set up OAuth
    expect(error.message).not.toContain('Configure options');
  });
});

describe('a login that fails for another reason', () => {
  test('a 403 at login keeps its status: forbidden, not "not a DAV server"', async () => {
    respond = async (url) => (new URL(url).pathname.startsWith('/.well-known/')
      ? new Response('', { status: 404, statusText: 'Not Found' })
      : new Response('', { status: 403, statusText: 'Forbidden' }));

    const error = await loginError(passwordEnv);

    expect(formatMCPError(error).code).toBe(MCP_ERROR_CODES.AUTH_ERROR);
    expect(error.message).toContain('the server answered 403');
    expect(error.message).toContain('CALDAV_USERNAME');
  });

  test('OAuth: a token endpoint answering 429 is a rate limit, not a refused login', async () => {
    respond = async (url) => (url.startsWith(TOKEN_URL)
      ? new Response('', { status: 429, statusText: 'Too Many Requests' })
      : new Response('', { status: 500 }));

    const error = await loginError(oauthEnv);

    expect(error.name).not.toBe('AuthenticationError');
    expect(formatMCPError(error).code).toBe(MCP_ERROR_CODES.NETWORK_ERROR);
    expect(error.message).toContain('the token endpoint answered 429');
  });

  test('an unreachable server is a network error and still says where the URL is set', async () => {
    respond = async () => { throw new TypeError('fetch failed'); };

    const error = await loginError(passwordEnv);

    expect(formatMCPError(error).code).toBe(MCP_ERROR_CODES.NETWORK_ERROR);
    expect(error.message).toContain('fetch failed');
    expect(error.message).toContain('CALDAV_SERVER_URL');
    expectPasswordSettingsNamed(error.message);
  });

  // A DAV path that answers 405 or 404 to PROPFIND is not a DAV endpoint:
  // the server URL is wrong. Not -32600 (an invalid MCP request) and not a
  // server fault: a configuration error, saying to check the URL.
  test.each([
    [405, 'Method Not Allowed'],
    [404, 'Not Found'],
    [400, 'Bad Request'],
  ])('a login answered %i is a configuration error that says to check the server URL', async (status, statusText) => {
    respond = async () => new Response('', { status, statusText });

    const error = await loginError(passwordEnv);

    expect(formatMCPError(error).code).toBe(MCP_ERROR_CODES.CONFIGURATION_ERROR);
    expect(error.message).toContain(`the server answered ${status}`);
    expect(error.message).toContain('Check the server URL');
  });

  test('a server that answers, but not as a DAV server, is a configuration error naming the URL setting', async () => {
    respond = async () => new Response('<html>Welcome</html>', {
      status: 200, statusText: 'OK', headers: { 'content-type': 'text/html' },
    });

    const error = await loginError(passwordEnv);

    expect(formatMCPError(error).code).toBe(MCP_ERROR_CODES.CONFIGURATION_ERROR);
    expect(error.message).toContain(SERVER);
    expect(error.message).toContain('CALDAV_SERVER_URL');
  });
});

// CARDDAV_* points the contacts client at its own host (Fastmail serves
// calendars and contacts on two). Each client then has its own endpoint,
// credentials and login answers, and a failure names the half that failed.
describe('a split CardDAV endpoint', () => {
  const CAL_HOST = 'https://cal.example.com';
  const CARD_HOST = 'https://contacts.example.com';

  const splitEnv = {
    CALDAV_SERVER_URL: `${CAL_HOST}/`,
    CALDAV_USERNAME: 'alex',
    CALDAV_PASSWORD: 'wrong',
    CARDDAV_SERVER_URL: `${CARD_HOST}/`,
    CARDDAV_USERNAME: 'alex',
    CARDDAV_PASSWORD: 'also-wrong',
  };

  // A DAV host that accepts Basic and completes discovery: the well-known
  // probes 404, and every PROPFIND is answered with the property it asked for.
  const davResponse = (url, init = {}) => {
    const { pathname } = new URL(url);
    if (pathname.startsWith('/.well-known/')) return new Response('', { status: 404, statusText: 'Not Found' });
    const body = String(init.body);
    const prop = body.includes('calendar-home-set')
      ? '<cal:calendar-home-set><d:href>/calendars/user/</d:href></cal:calendar-home-set>'
      : body.includes('addressbook-home-set')
        ? '<card:addressbook-home-set><d:href>/addressbooks/user/</d:href></card:addressbook-home-set>'
        : '<d:current-user-principal><d:href>/principals/user/</d:href></d:current-user-principal>';
    return new Response(
      '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" ' +
      'xmlns:card="urn:ietf:params:xml:ns:carddav">' +
      `<d:response><d:href>${pathname}</d:href><d:propstat><d:prop>${prop}</d:prop>` +
      '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
      { status: 207, statusText: 'Multi-Status', headers: { 'content-type': 'application/xml; charset=utf-8' } },
    );
  };

  const refused = () => new Response('Unauthorized', {
    status: 401, statusText: 'Unauthorized', headers: { 'www-authenticate': 'Basic realm="dav"' },
  });

  test('both clients complete discovery on their own hosts', async () => {
    respond = davResponse;
    await tsdavManager.initialize(buildTsdavConfig(splitEnv));

    expect(tsdavManager.getCalDavClient().account.homeUrl).toBe(`${CAL_HOST}/calendars/user/`);
    expect(tsdavManager.getCardDavClient().account.homeUrl).toBe(`${CARD_HOST}/addressbooks/user/`);
  });

  test('a CardDAV host that refuses names the CardDAV endpoint, client and settings', async () => {
    respond = async (url, init) => (url.startsWith(CARD_HOST) ? refused() : davResponse(url, init));

    const error = await loginError(splitEnv);

    expect(error.name).toBe('AuthenticationError');
    expect(formatMCPError(error).code).toBe(MCP_ERROR_CODES.AUTH_ERROR);
    expect(error.message).toContain(CARD_HOST);
    expect(error.message).toContain('(CardDAV client)');
    expect(error.message).toContain('CARDDAV_SERVER_URL');
    expectPasswordSettingsNamed(error.message);
  });

  // The CalDAV host answered, so shared login answers would read the silent
  // CardDAV host as "not a DAV server". Its own answers say: never reached.
  test('an unreachable CardDAV host is a network error, not a wrong-URL error', async () => {
    respond = async (url, init) => {
      if (url.startsWith(CARD_HOST)) throw new TypeError('fetch failed');
      return davResponse(url, init);
    };

    const error = await loginError(splitEnv);

    expect(formatMCPError(error).code).toBe(MCP_ERROR_CODES.NETWORK_ERROR);
    expect(error.message).toContain(CARD_HOST);
    expect(error.message).not.toContain('does not lead to a CalDAV/CardDAV server');
  });

  test('a CalDAV failure on a split setup names the CalDAV client', async () => {
    respond = async (url, init) => (url.startsWith(CAL_HOST) ? refused() : davResponse(url, init));

    const error = await loginError(splitEnv);

    expect(error.name).toBe('AuthenticationError');
    expect(error.message).toContain(CAL_HOST);
    expect(error.message).toContain('(CalDAV client)');
    expect(error.message).not.toContain('(CardDAV client)');
  });

  // CARDDAV_PASSWORD alone, sharing the CalDAV URL: the failing login is
  // still the contacts one, so the label must not depend on the URL alone.
  test('a credentials-only CardDAV override still names the CardDAV client', async () => {
    const badCardAuth = `Basic ${Buffer.from('alex:also-wrong').toString('base64')}`;
    respond = async (url, init) => (new Headers(init.headers).get('authorization') === badCardAuth
      ? refused()
      : davResponse(url, init));

    const error = await loginError({
      CALDAV_SERVER_URL: `${CAL_HOST}/`,
      CALDAV_USERNAME: 'alex',
      CALDAV_PASSWORD: 'wrong',
      CARDDAV_PASSWORD: 'also-wrong',
    });

    expect(error.name).toBe('AuthenticationError');
    expect(error.message).toContain(CAL_HOST);
    expect(error.message).toContain('(CardDAV client)');
  });

  test('a bad GOOGLE_SERVER_URL is reported under its own name, not the CalDAV variable', async () => {
    const error = await loginError({ ...oauthEnv, GOOGLE_SERVER_URL: 'https://u:p@dav.example.com/' });

    expect(error.name).toBe('ConfigurationError');
    expect(error.message).toContain('GOOGLE_SERVER_URL');
    expect(error.message).toContain('GOOGLE_USER');
    expect(error.message).not.toContain('CALDAV_SERVER_URL');
  });
});

// Over stdio the login happens again on the first tool call when it failed
// at startup. Its failure used to escape the tool call as a JSON-RPC
// internal error (-32603) carrying only tsdav's message.
describe('stdio: the first tool call after a refused login', () => {
  test('is a tool error with the authentication code and the settings hint', async () => {
    const listener = createServer((req, res) => {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dav"' });
      res.end('Unauthorized');
    });
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${listener.address().port}/dav/`;

    const child = spawn(process.execPath, ['src/server-stdio.js'], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        CALDAV_SERVER_URL: url,
        CALDAV_USERNAME: 'alex',
        CALDAV_PASSWORD: 'wrong',
        // pinned empty so the checkout's own .env (if any) cannot add a second
        // endpoint the server would try to log onto
        CARDDAV_SERVER_URL: '',
        CARDDAV_USERNAME: '',
        CARDDAV_PASSWORD: '',
        LOG_LEVEL: 'silent',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });
    const reply = new Promise((resolve) => {
      child.stdout.on('data', () => {
        const message = stdout.split('\n').filter(Boolean).map(l => JSON.parse(l)).find(m => m.id === 2);
        if (message) resolve(message);
      });
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }) + '\n');
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_calendars', arguments: {} },
    }) + '\n');

    try {
      const message = await reply;
      expect(message.error).toBeUndefined();
      expect(message.result.isError).toBe(true);
      const error = JSON.parse(message.result.content[0].text);
      expect(error.code).toBe(MCP_ERROR_CODES.AUTH_ERROR);
      expect(error.message).toContain('401 Unauthorized');
      expectPasswordSettingsNamed(error.message);
    } finally {
      child.kill();
      listener.close();
    }
  }, 20000);
});
