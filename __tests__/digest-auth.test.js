import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { createHash } from 'node:crypto';

// The whole path a Digest-only server takes through dav-mcp (#74): the client
// manager builds real tsdav clients, tsdav answers the server's 401 challenge,
// and discovery completes. Only fetch is replaced — and before tsdav loads,
// because tsdav binds the platform fetch when it is imported.

const SERVER = 'https://dav.example.com';
const PASSWORD = 'correct horse battery staple';
const CHALLENGE = 'Digest realm="BaikalDAV", qop="auth", algorithm=SHA-256, nonce="abc123", opaque="xyz"';

const requests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = jest.fn(async (url, init = {}) => {
  // tsdav passes a plain object, its Digest retry a Headers instance
  const authorization = new Headers(init.headers).get('authorization');
  const path = new URL(url).pathname;
  const record = { method: init.method, path, authorization };
  requests.push(record);

  if (path.startsWith('/.well-known/')) {
    record.status = 404;
    return new Response('', { status: 404, statusText: 'Not Found' });
  }
  if (!authorization?.startsWith('Digest ')) {
    record.status = 401;
    return new Response('', { status: 401, statusText: 'Unauthorized', headers: { 'www-authenticate': CHALLENGE } });
  }
  record.status = 207;
  const body = String(init.body);
  const kind = path.includes('addressbook') || body.includes('addressbook') ? 'addressbooks' : 'calendars';
  const prop = body.includes('current-user-principal')
    ? '<d:current-user-principal><d:href>/principals/user/</d:href></d:current-user-principal>'
    : body.includes('calendar-home-set')
      ? '<cal:calendar-home-set><d:href>/calendars/user/</d:href></cal:calendar-home-set>'
      : body.includes('addressbook-home-set')
        ? '<card:addressbook-home-set><d:href>/addressbooks/user/</d:href></card:addressbook-home-set>'
        : `<d:displayname>${kind}</d:displayname>`;
  return new Response(
    '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
    `<d:response><d:href>${path}</d:href><d:propstat><d:prop>${prop}</d:prop>` +
    '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
    { status: 207, statusText: 'Multi-Status', headers: { 'content-type': 'application/xml; charset=utf-8' } },
  );
});

const { buildTsdavConfig } = await import('../src/auth-config.js');
const { tsdavManager } = await import('../src/tsdav-client.js');
globalThis.fetch = realFetch;

const env = (authMethod) => ({
  CALDAV_SERVER_URL: `${SERVER}/`,
  CALDAV_USERNAME: 'user',
  CALDAV_PASSWORD: PASSWORD,
  ...(authMethod && { AUTH_METHOD: authMethod }),
});

const toServer = () => requests.filter(r => !r.path.startsWith('/.well-known/'));
const basicCredentials = `Basic ${Buffer.from(`user:${PASSWORD}`).toString('base64')}`;

beforeEach(() => {
  requests.length = 0;
});

// Digest needs WebCrypto, which Node.js 18 does not expose as a global.
const hasWebCrypto = Boolean(globalThis.crypto?.subtle);
const withWebCrypto = hasWebCrypto ? test : test.skip;
const withoutWebCrypto = hasWebCrypto ? test.skip : test;

describe('a Digest-only server', () => {
  withoutWebCrypto('without WebCrypto (Node.js 18) startup fails with an error that says why', async () => {
    await expect(tsdavManager.initialize(buildTsdavConfig(env('Digest'))))
      .rejects.toThrow(/Digest authentication requires the WebCrypto API/);
  });

  withWebCrypto('AUTH_METHOD=Digest: 401 challenge, one retry with a Digest response, login completes', async () => {
    await tsdavManager.initialize(buildTsdavConfig(env('Digest')));

    const [first, retry] = toServer();
    expect(first).toMatchObject({ status: 401, authorization: null });
    expect(retry).toMatchObject({ method: first.method, path: first.path, status: 207 });
    expect(retry.authorization).toMatch(/^Digest username="user", realm="BaikalDAV", /);
    const field = (name) => new RegExp(`${name}="?([^",]+)"?`).exec(retry.authorization)[1];
    expect(field('nonce')).toBe('abc123');
    expect(field('opaque')).toBe('xyz');
    expect(field('algorithm')).toBe('SHA-256');
    // RFC 7616 §3.4.1: the server would compute exactly this from its copy of the password
    const sha256 = (text) => createHash('sha256').update(text).digest('hex');
    const ha1 = sha256(`user:BaikalDAV:${PASSWORD}`);
    const ha2 = sha256(`${retry.method}:${field('uri')}`);
    expect(field('response')).toBe(
      sha256(`${ha1}:abc123:${field('nc')}:${field('cnonce')}:auth:${ha2}`));

    // the password never goes over the wire, in no encoding
    for (const { authorization } of requests) {
      expect(authorization ?? '').not.toContain(PASSWORD);
      expect(authorization ?? '').not.toMatch(/^Basic /);
    }
    // one challenge per client (CalDAV, CardDAV), everything else authenticated
    expect(toServer().filter(r => r.status === 401)).toHaveLength(2);
    expect(tsdavManager.getCalDavClient().account.homeUrl).toBe(`${SERVER}/calendars/user/`);
    expect(tsdavManager.getCardDavClient().account.homeUrl).toBe(`${SERVER}/addressbooks/user/`);
  });

  withWebCrypto('default AUTH_METHOD: Basic is rejected once per client, then tsdav switches to Digest', async () => {
    await tsdavManager.initialize(buildTsdavConfig(env()));

    const [first, retry] = toServer();
    expect(first).toMatchObject({ status: 401, authorization: basicCredentials });
    expect(retry).toMatchObject({ path: first.path, status: 207 });
    expect(retry.authorization).toMatch(/^Digest username="user"/);

    expect(toServer().filter(r => r.status === 401)).toHaveLength(2);
    expect(toServer().filter(r => r.authorization === basicCredentials)).toHaveLength(2);
    expect(tsdavManager.getCalDavClient().account.homeUrl).toBe(`${SERVER}/calendars/user/`);
  });
});
