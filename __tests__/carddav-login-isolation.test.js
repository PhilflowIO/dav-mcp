import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import http from 'node:http';

// Each half's login stays on its own endpoint (#158). Repros of a security
// review: with separate CardDAV credentials, a host the calendar login was
// redirected to must not receive the CardDAV login, and neither endpoint
// may redirect its login onto the other half's configured host.
const { tsdavManager } = await import('../src/tsdav-client.js');
const { buildTsdavConfig } = await import('../src/auth-config.js');

const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
const CAL_AUTH = basic('alex', 'cal-secret');
const CARD_AUTH = basic('alex', 'card-secret');

const multistatus = (href, prop) =>
  '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" ' +
  'xmlns:card="urn:ietf:params:xml:ns:carddav">' +
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop>` +
  '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';

// A DAV server that serves both halves and records the Authorization header
// of every request. `redirect(path)` may return a URL to answer 301 with.
function davServer(redirect = () => null) {
  const auths = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      auths.push(req.headers.authorization ?? null);
      const path = new URL(req.url, 'http://local').pathname;
      const location = redirect(path);
      if (location) { res.writeHead(301, { location }); return res.end(); }
      if (path.startsWith('/.well-known/')) { res.writeHead(404); return res.end(); }
      const prop = body.includes('calendar-home-set')
        ? '<cal:calendar-home-set><d:href>/calendars/user/</d:href></cal:calendar-home-set>'
        : body.includes('addressbook-home-set')
          ? '<card:addressbook-home-set><d:href>/addressbooks/user/</d:href></card:addressbook-home-set>'
          : body.includes('current-user-principal')
            ? '<d:current-user-principal><d:href>/principals/user/</d:href></d:current-user-principal>'
            : null;
      res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
      res.end(prop ? multistatus(path, prop) : multistatus(path, '<d:displayname>x</d:displayname>'));
    });
  });
  return {
    auths,
    async start() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      this.origin = `http://127.0.0.1:${server.address().port}`;
      return this;
    },
    stop: () => new Promise(resolve => server.close(resolve)),
  };
}

let servers;
const start = async (...redirects) => {
  servers = await Promise.all(redirects.map(r => davServer(r).start()));
  return servers;
};
beforeEach(() => { servers = []; });
afterEach(async () => { await Promise.all(servers.map(s => s.stop())); });

const login = (env) => tsdavManager.initialize(buildTsdavConfig({
  CALDAV_USERNAME: 'alex', CALDAV_PASSWORD: 'cal-secret', ...env,
})).then(() => null, e => e);

describe('separate CardDAV credentials on the calendar URL', () => {
  test('a host the calendar discovery was redirected to never gets the CardDAV login', async () => {
    let elsewhere;
    const [dav, other] = await start(
      path => (path === '/.well-known/caldav' ? `${elsewhere}/` : null),
      () => null,
    );
    elsewhere = other.origin;

    expect(await login({ CALDAV_SERVER_URL: `${dav.origin}/`, CARDDAV_PASSWORD: 'card-secret' })).toBeNull();
    // the calendar login was sent to the other host, as its redirect said
    expect(other.auths).toContain(CAL_AUTH);

    const error = await tsdavManager.getCardDavClient()
      .davRequest({ url: `${other.origin}/addressbooks/user/book/`, init: { method: 'PROPFIND', headers: { depth: '0' } } })
      .then(() => null, e => e);
    expect(error).toBeInstanceOf(Error);
    expect(other.auths).not.toContain(CARD_AUTH);
  });
});

describe('a login redirected onto the other half\'s configured host', () => {
  test('the contacts host redirecting to the calendar host fails the login, naming CARDDAV_SERVER_URL', async () => {
    let calHost;
    const [cal, card] = await start(() => null, path => `${calHost}${path}`);
    calHost = cal.origin;

    const error = await login({
      CALDAV_SERVER_URL: `${cal.origin}/`, CARDDAV_SERVER_URL: `${card.origin}/`, CARDDAV_PASSWORD: 'card-secret',
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('(CardDAV client)');
    expect(error.message).toContain('configured as CALDAV_SERVER_URL');
    expect(error.message).toContain('set CARDDAV_SERVER_URL');
    expect(cal.auths).not.toContain(CARD_AUTH);
  });

  test('the calendar host redirecting to the contacts host fails the login, naming CALDAV_SERVER_URL', async () => {
    let cardHost;
    const [cal, card] = await start(path => `${cardHost}${path}`, () => null);
    cardHost = card.origin;

    const error = await login({
      CALDAV_SERVER_URL: `${cal.origin}/`, CARDDAV_SERVER_URL: `${card.origin}/`, CARDDAV_PASSWORD: 'card-secret',
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('(CalDAV client)');
    expect(error.message).toContain('configured as CARDDAV_SERVER_URL');
    expect(error.message).toContain('set CALDAV_SERVER_URL');
    expect(card.auths).not.toContain(CAL_AUTH);
  });
});

// The other half's hosts are refused as the other policy holds them at the
// moment of the check, not only its configured host: a per-account host one
// login was redirected to is just as much the other half's.
describe('hosts the other half learned while logging in', () => {
  const both = { CARDDAV_PASSWORD: 'card-secret' };
  const env = (cal, card) => ({ CALDAV_SERVER_URL: `${cal.origin}/`, CARDDAV_SERVER_URL: `${card.origin}/`, ...both });

  test('iCloud shape: each half redirected to a per-account host of its own logs in, each login on its own host', async () => {
    const hosts = {};
    const [cal, card, calAccount, cardAccount] = await start(
      path => (path === '/.well-known/caldav' ? `${hosts.calAccount}/` : null),
      path => (path === '/.well-known/carddav' ? `${hosts.cardAccount}/` : null),
      () => null,
      () => null,
    );
    hosts.calAccount = calAccount.origin;
    hosts.cardAccount = cardAccount.origin;

    expect(await login(env(cal, card))).toBeNull();
    expect(tsdavManager.availableAccountTypes()).toEqual(['caldav', 'carddav']);
    expect(calAccount.auths).toContain(CAL_AUTH);
    expect(calAccount.auths).not.toContain(CARD_AUTH);
    expect(cardAccount.auths).toContain(CARD_AUTH);
    expect(cardAccount.auths).not.toContain(CAL_AUTH);
  });

  test('Fastmail shape: two hosts, no redirects, both log in on their own host', async () => {
    const [cal, card] = await start(() => null, () => null);
    expect(await login(env(cal, card))).toBeNull();
    expect(tsdavManager.availableAccountTypes()).toEqual(['caldav', 'carddav']);
    expect(cal.auths).not.toContain(CARD_AUTH);
    expect(card.auths).not.toContain(CAL_AUTH);
  });

  test('the contacts host redirecting to the calendar\'s per-account host fails, and that host never gets the CardDAV login', async () => {
    const hosts = {};
    const [cal, card, account] = await start(
      path => (path === '/.well-known/caldav' ? `${hosts.account}/` : null),
      path => `${hosts.account}${path}`,
      () => null,
    );
    hosts.account = account.origin;

    const error = await login(env(cal, card));
    expect(error?.message).toContain('(CardDAV client)');
    expect(error.message).toContain('a host the login for CALDAV_SERVER_URL goes to');
    expect(account.auths).toContain(CAL_AUTH);
    expect(account.auths).not.toContain(CARD_AUTH);
  });

  test('the calendar host redirecting to the contacts per-account host: the second login is kept off it', async () => {
    const hosts = {};
    const [cal, card, account] = await start(
      path => `${hosts.account}${path}`,
      path => (path === '/.well-known/carddav' ? `${hosts.account}/` : null),
      () => null,
    );
    hosts.account = account.origin;

    expect(await login(env(cal, card))).toBeNull();
    // the calendar logs in first and takes the host; the contacts discovery
    // redirect to it is refused, tsdav falls back to the configured contacts
    // URL, and one host never gets both logins
    expect(tsdavManager.getCardDavClient().account.homeUrl).toBe(`${card.origin}/addressbooks/user/`);
    expect(account.auths.includes(CAL_AUTH) && account.auths.includes(CARD_AUTH)).toBe(false);
    expect(card.auths).not.toContain(CAL_AUTH);
    expect(cal.auths).not.toContain(CARD_AUTH);
  });

  test('a tool call on the contacts client to the calendar\'s per-account host is refused before sending', async () => {
    const hosts = {};
    const [cal, card, account] = await start(
      path => (path === '/.well-known/caldav' ? `${hosts.account}/` : null),
      () => null,
      () => null,
    );
    hosts.account = account.origin;
    expect(await login(env(cal, card))).toBeNull();

    const error = await tsdavManager.getCardDavClient()
      .davRequest({ url: `${account.origin}/addressbooks/user/book/`, init: { method: 'PROPFIND', headers: { depth: '0' } } })
      .then(() => null, e => e);
    expect(error?.message).toContain('a host the login for CALDAV_SERVER_URL goes to');
    expect(account.auths).not.toContain(CARD_AUTH);
  });
});

describe('secrets in configuration errors', () => {
  test('the plain-http refusal shows the CardDAV origin, not the password in its URL', () => {
    let error;
    try {
      buildTsdavConfig({
        CALDAV_SERVER_URL: 'https://dav.example.com/', CALDAV_USERNAME: 'alex', CALDAV_PASSWORD: 'cal-secret',
        CARDDAV_SERVER_URL: 'http://bob:hunter2@card.example.com/dav/',
      });
    } catch (e) { error = e; }
    expect(error?.name).toBe('ConfigurationError');
    expect(error.message).toContain('http://card.example.com');
    expect(error.message).not.toContain('hunter2');
    expect(error.message).not.toContain('bob');
  });

  test('a non-http URL with credentials is named without them', async () => {
    const error = await tsdavManager.initialize({
      serverUrl: 'https://dav.example.com/', authMethod: 'Basic', username: 'alex', password: 'cal-secret',
      cardDav: { serverUrl: 'ftp://bob:hunter2@card.example.com/', username: 'alex', password: 'cal-secret' },
    }).then(() => null, e => e);
    expect(error?.name).toBe('ConfigurationError');
    expect(error.message).toContain('CARDDAV_SERVER_URL ftp://card.example.com/');
    expect(error.message).not.toContain('hunter2');
  });
});
