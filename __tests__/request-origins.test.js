import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import http from 'node:http';

// A tool URL decides where tsdav sends the login. These tests stand up real
// HTTP listeners — the configured DAV server and a foreign one — and drive the
// real client manager, real tsdav clients and the real tools, so "refused"
// means the foreign listener never saw a request, not that a mock was skipped.

const { RequestOrigins, RequestOriginError, activateRequestOrigins, requestUrlProblem } =
  await import('../src/request-origins.js');
const { tsdavManager } = await import('../src/tsdav-client.js');
const { tools } = await import('../src/tools/index.js');
const { multiGetObjects } = await import('../src/tools/shared/multiget.js');

const multistatus = (responses) =>
  '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" ' +
  `xmlns:card="urn:ietf:params:xml:ns:carddav">${responses}</d:multistatus>`;

const propResponse = (href, prop) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop>` +
  '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';

/**
 * A minimal CalDAV/CardDAV server: enough for tsdav to log in and list
 * collections. Every request is recorded.
 *
 * @param {object} [options]
 * @param {(req) => string|undefined} [options.redirect] - Location to send
 *   for /.well-known/ requests
 * @param {() => string} [options.extraCalendarHref] - an absolute href for a
 *   calendar on another origin, listed next to the server's own
 * @param {(req, res, path, body) => boolean} [options.handle] - answers a
 *   request itself when it returns true
 */
function davServer(options = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
      const path = new URL(req.url, 'http://local').pathname;
      if (options.handle?.(req, res, path, body)) return;
      if (path.startsWith('/.well-known/')) {
        const location = options.redirect?.(req);
        if (location) {
          res.writeHead(301, { location });
        } else {
          res.writeHead(404);
        }
        return res.end();
      }
      const xml = (status, responses) => {
        res.writeHead(status, { 'content-type': 'application/xml; charset=utf-8' });
        res.end(multistatus(responses));
      };
      if (body.includes('current-user-principal')) {
        return xml(207, propResponse(path,
          '<d:current-user-principal><d:href>/principals/user/</d:href></d:current-user-principal>'));
      }
      if (body.includes('calendar-home-set')) {
        return xml(207, propResponse(path,
          '<cal:calendar-home-set><d:href>/calendars/user/</d:href></cal:calendar-home-set>'));
      }
      if (body.includes('addressbook-home-set')) {
        return xml(207, propResponse(path,
          '<card:addressbook-home-set><d:href>/addressbooks/user/</d:href></card:addressbook-home-set>'));
      }
      if (req.method === 'PROPFIND' && path === '/calendars/user/') {
        const calendar = (href, name) => propResponse(href,
          `<d:displayname>${name}</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>` +
          '<cal:supported-calendar-component-set><cal:comp name="VEVENT"/><cal:comp name="VTODO"/></cal:supported-calendar-component-set>');
        const extra = options.extraCalendarHref?.();
        return xml(207, calendar('/calendars/user/work/', 'Work') + (extra ? calendar(extra, 'Elsewhere') : ''));
      }
      if (req.method === 'PROPFIND' && path === '/addressbooks/user/') {
        return xml(207, propResponse('/addressbooks/user/contacts/',
          '<d:displayname>Contacts</d:displayname><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>'));
      }
      // Anything else: an empty multistatus for reads, success for writes.
      if (req.method === 'PROPFIND' || req.method === 'REPORT') return xml(207, '');
      res.writeHead(req.method === 'PUT' ? 201 : 204, { etag: '"1"' });
      res.end();
    });
  });
  return {
    hits,
    async start() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      this.origin = `http://127.0.0.1:${server.address().port}`;
      return this;
    },
    stop: () => new Promise(resolve => server.close(resolve)),
  };
}

const login = (server) => tsdavManager.initialize({
  serverUrl: `${server.origin}/`,
  authMethod: 'Basic',
  username: 'user',
  password: 'secret',
});

// ---------------------------------------------------------------------------

describe('before any login', () => {
  test('no URL is accepted, not even one that looks right', () => {
    expect(requestUrlProblem('https://dav.example.com/calendars/user/work/'))
      .toMatch(/not connected to a DAV server yet/);
  });
});

describe('the policy', () => {
  const policy = (serverUrl = 'https://dav.example.com/dav/') => {
    const origins = new RequestOrigins({ serverUrl, tokenUrl: 'https://accounts.example.com/o/oauth2/token' });
    origins.endDiscovery();
    return origins;
  };

  test('accepts the configured URL and everything below it', () => {
    expect(policy().problem('https://dav.example.com/dav/calendars/user/work/x.ics')).toBeNull();
    expect(policy().problem('https://dav.example.com:443/dav/')).toBeNull();
    expect(policy().problem('https://DAV.Example.COM/dav')).toBeNull();
  });

  test('refuses other paths on the same host, so other tenants of a shared host do not get the login', () => {
    for (const url of ['https://dav.example.com/other/', 'https://dav.example.com/~tenant/x.ics',
      'https://dav.example.com/dav-evil/', 'https://dav.example.com/dav/../other/', 'https://dav.example.com/dav/%2e%2e/other/']) {
      expect(policy().problem(url)).toMatch(/is outside the configured DAV account/);
    }
  });

  // what a server that decodes the path, or honours ;parameters, would see
  test.each([
    '/dav-evil/', '/DAV/x', '/da%76/x', '/dav%2f../x',
    '/dav/../x', '/dav/%2e%2e/x', '/dav/.%2E/x', '/dav/..\\x',
    '/dav/..%2fx', '/dav/..%5cx', '/dav/%2e%2e%2fx', '/dav/a%2F..%2F..%2Fx',
    '/dav/..;/x', '/dav/..;jsessionid=1/x', '/dav/a/..;/..;/x',
    '/dav/%252e%252e/x', '/dav/%252fx', '/dav/%255cx', '/dav/%zz/x',
  ])('refuses %s, which leaves /dav/', (path) => {
    expect(policy().problem(`https://dav.example.com${path}`)).not.toBeNull();
  });

  test.each([
    '/dav', '/dav/', '/dav//../x', '/dav/x?/../../',
    '/dav/cal/abc%2Fdef.ics', '/dav/cal/a%5Cb.vcf', '/dav/a/..;/b', '/dav/x%00/', '/dav/;p=1/x',
  ])('accepts %s, which stays below /dav/', (path) => {
    expect(policy().problem(`https://dav.example.com${path}`)).toBeNull();
  });

  test('refuses another host, another port and another scheme, naming what is allowed', () => {
    for (const url of ['https://attacker.example/dav/x', 'https://dav.example.com:8443/dav/x',
      'https://dav.example.com.attacker.example/dav/x', 'https://dav.example.com\\@attacker.example/dav/',
      'https://dav.example.com%2eattacker.example/dav/', '//attacker.example/dav/', 'https:/\\attacker.example/dav/']) {
      const problem = policy().problem(url);
      expect(problem).not.toBeNull();
    }
    expect(policy().problem('https://attacker.example/dav/x')).toContain('https://dav.example.com/dav/');
  });

  test('refuses a downgrade from https to http, even on the same host', () => {
    expect(policy().problem('http://dav.example.com/dav/calendars/')).toMatch(/plain http.*configured over https/);
  });

  test('never trusts an http URL the server names when it is configured over https', () => {
    const origins = policy();
    expect(origins.trust('http://p01-caldav.example.com/calendars/')).toBe(false);
    expect(origins.problem('http://p01-caldav.example.com/calendars/')).toMatch(/plain http/);
  });

  test('refuses user info in a URL', () => {
    expect(policy().problem('https://user:pw@dav.example.com/dav/')).toMatch(/user name or password/);
    expect(policy().trust('https://user:pw@other.example.com/')).toBe(false);
  });

  test('refuses non-http schemes', () => {
    expect(policy().problem('file:///etc/passwd')).toMatch(/not an http\(s\) URL/);
    expect(policy().problem('data:text/plain,hi')).toMatch(/not an http\(s\) URL/);
  });

  test('accepts what is below a URL the server named, not the rest of its host', () => {
    const origins = policy();
    origins.trust('https://p42-caldav.example.com:443/123/calendars/');
    expect(origins.problem('https://p42-caldav.example.com/123/calendars/work/')).toBeNull();
    expect(origins.problem('https://p42-caldav.example.com/456/calendars/work/')).toMatch(/outside/);
  });

  test('the OAuth token endpoint is neither a tool argument nor a target of DAV requests', async () => {
    const origins = policy();
    expect(origins.problem('https://accounts.example.com/o/oauth2/token')).toMatch(/outside/);
    let calls = 0;
    const base = async () => { calls += 1; return new Response('{}'); };
    await expect(origins.fetch(base)('https://accounts.example.com/o/oauth2/token')).rejects.toBeInstanceOf(RequestOriginError);
    // and the token fetch reaches the token endpoint only
    await origins.tokenFetch(base)('https://accounts.example.com/o/oauth2/token', { method: 'POST' });
    await expect(origins.tokenFetch(base)('https://accounts.example.com/other')).rejects.toBeInstanceOf(RequestOriginError);
    await expect(origins.tokenFetch(base)('https://dav.example.com/dav/')).rejects.toBeInstanceOf(RequestOriginError);
    expect(calls).toBe(1);
  });

  test('the token endpoint does not redirect the token request anywhere else', async () => {
    const sent = [];
    const base = async (url) => {
      sent.push(String(url));
      return new Response(null, { status: 302, headers: { location: 'https://auth2.example.com/token' } });
    };
    await expect(policy().tokenFetch(base)('https://accounts.example.com/o/oauth2/token', { method: 'POST', body: 'a=b' }))
      .rejects.toThrow(/not the configured OAuth token endpoint/);
    expect(sent).toEqual(['https://accounts.example.com/o/oauth2/token']);
  });

  test('a server URL with user info or a non-http scheme is a configuration error', () => {
    expect(() => new RequestOrigins({ serverUrl: 'https://u:p@dav.example.com/' }))
      .toThrow(expect.objectContaining({ name: 'ConfigurationError' }));
    expect(() => new RequestOrigins({ serverUrl: 'ftp://dav.example.com/' }))
      .toThrow(expect.objectContaining({ name: 'ConfigurationError' }));
  });

  test('its fetch refuses before calling the network', async () => {
    let calls = 0;
    const guarded = policy().fetch(async () => { calls += 1; return new Response(''); });
    await expect(guarded('https://attacker.example/x')).rejects.toBeInstanceOf(RequestOriginError);
    await expect(guarded(new URL('https://attacker.example/x'))).rejects.toBeInstanceOf(RequestOriginError);
    await expect(guarded(new Request('https://attacker.example/x'))).rejects.toBeInstanceOf(RequestOriginError);
    expect(calls).toBe(0);
  });

  describe('redirects', () => {
    // a fake network: answers by URL, records what was sent where
    const network = (routes) => {
      const sent = [];
      const fetch = async (url, init = {}) => {
        sent.push({ url: String(url), method: init.method, redirect: init.redirect,
          authorization: new Headers(init.headers).get('authorization'), body: init.body });
        const route = routes[String(url)];
        return route ? route() : new Response(null, { status: 204 });
      };
      return { sent, fetch };
    };
    const redirect = (status, location) => () => new Response('', { status, headers: { location } });

    test('a redirect out of the account is refused, and nothing is sent there', async () => {
      for (const status of [301, 302, 303, 307, 308]) {
        const net = network({ 'https://dav.example.com/dav/cal/x.ics': redirect(status, 'https://attacker.example/steal') });
        const error = await policy().fetch(net.fetch)('https://dav.example.com/dav/cal/x.ics', {
          method: 'PUT', body: 'SECRET', headers: { authorization: 'Basic c2VjcmV0' },
        }).then(() => null, e => e);
        expect(error).toBeInstanceOf(RequestOriginError);
        expect(error.message).toMatch(/redirected .* to https:\/\/attacker\.example\/steal.*did not take effect/);
        expect(net.sent.map(r => r.url)).toEqual(['https://dav.example.com/dav/cal/x.ics']);
        expect(net.sent[0].redirect).toBe('manual');
      }
    });

    test.each([
      ['a relative Location climbing out', '../outside'],
      ['an encoded dot-segment Location', '/dav/%2e%2e/admin'],
      ['a scheme-relative Location', '//evil.invalid/x'],
      ['a ;parameter dot-segment Location', '/dav/..;/admin'],
    ])('%s is refused', async (_name, location) => {
      const net = network({ 'https://dav.example.com/dav/r': redirect(307, location) });
      await expect(policy().fetch(net.fetch)('https://dav.example.com/dav/r', { method: 'PUT', body: 'x' }))
        .rejects.toBeInstanceOf(RequestOriginError);
      expect(net.sent).toHaveLength(1);
    });

    test('a chain that ends outside is refused at the hop that leaves', async () => {
      const net = network({
        'https://dav.example.com/dav/chain1': redirect(302, '/dav/chain2'),
        'https://dav.example.com/dav/chain2': redirect(307, 'https://attacker.example/x'),
      });
      await expect(policy().fetch(net.fetch)('https://dav.example.com/dav/chain1', { method: 'PUT', body: 'secret' }))
        .rejects.toThrow(/attacker\.example/);
      expect(net.sent.map(r => r.url)).toEqual(['https://dav.example.com/dav/chain1', 'https://dav.example.com/dav/chain2']);
    });

    test('a redirect loop ends in an error', async () => {
      const net = network({ 'https://dav.example.com/dav/loop': redirect(302, '/dav/loop') });
      await expect(policy().fetch(net.fetch)('https://dav.example.com/dav/loop')).rejects.toThrow(/more than 20 times/);
    });

    test('a redirect to another path on the same host outside the account is refused too', async () => {
      const net = network({ 'https://dav.example.com/dav/x': redirect(307, '/~tenant/x') });
      await expect(policy().fetch(net.fetch)('https://dav.example.com/dav/x', { method: 'DELETE' }))
        .rejects.toThrow(/outside the configured DAV account/);
      expect(net.sent).toHaveLength(1);
    });

    test('a redirect inside the account is followed with the semantics of fetch', async () => {
      const net = network({
        'https://dav.example.com/dav/a': redirect(307, '/dav/b'),
        'https://dav.example.com/dav/b': redirect(303, '/dav/c'),
      });
      const response = await policy().fetch(net.fetch)('https://dav.example.com/dav/a', {
        method: 'PUT', body: 'data', headers: { authorization: 'Basic x', 'content-type': 'text/calendar' },
      });
      expect(response.status).toBe(204);
      expect(net.sent.map(r => [r.url, r.method, r.body, r.authorization])).toEqual([
        ['https://dav.example.com/dav/a', 'PUT', 'data', 'Basic x'],
        ['https://dav.example.com/dav/b', 'PUT', 'data', 'Basic x'],
        ['https://dav.example.com/dav/c', 'GET', undefined, 'Basic x'],
      ]);
    });

    test('a hop to another origin inside the account drops the login header', async () => {
      const origins = policy();
      origins.trust('https://p42.example.com/123/');
      const net = network({ 'https://dav.example.com/dav/a': redirect(307, 'https://p42.example.com/123/a') });
      await origins.fetch(net.fetch)('https://dav.example.com/dav/a', { headers: { authorization: 'Basic x' } });
      expect(net.sent[1].authorization).toBeNull();
    });

    test('a caller that follows redirects itself gets the 3xx, and its next hop is checked', async () => {
      const net = network({ 'https://dav.example.com/dav/a': redirect(307, 'https://attacker.example/') });
      const guarded = policy().fetch(net.fetch);
      const response = await guarded('https://dav.example.com/dav/a', { redirect: 'manual' });
      expect(response.status).toBe(307);
      await expect(guarded('https://attacker.example/', { redirect: 'manual' })).rejects.toBeInstanceOf(RequestOriginError);
      expect(net.sent).toHaveLength(1);
    });

    test('during login a redirect is followed and its target joins the account; afterwards nothing is learned', async () => {
      const origins = new RequestOrigins({ serverUrl: 'https://dav.example.com/' });
      const net = network({
        'https://dav.example.com/.well-known/caldav': redirect(301, 'https://root.example.com/dav/'),
        'https://dav.example.com/x': redirect(301, 'https://later.example.com/'),
      });
      await origins.fetch(net.fetch)('https://dav.example.com/.well-known/caldav', { redirect: 'manual' });
      expect(origins.problem('https://root.example.com/dav/principals/')).toBeNull();

      origins.endDiscovery();
      await expect(origins.fetch(net.fetch)('https://dav.example.com/x')).rejects.toThrow(/later\.example\.com/);
      expect(origins.problem('https://later.example.com/')).not.toBeNull();
    });

    test('a login redirected from https to http is refused, and the error says so', async () => {
      const origins = new RequestOrigins({ serverUrl: 'https://dav.example.com/' });
      const net = network({ 'https://dav.example.com/.well-known/caldav': redirect(301, 'http://dav.example.com/dav/') });
      await origins.fetch(net.fetch)('https://dav.example.com/.well-known/caldav', { redirect: 'manual' });
      await expect(origins.fetch(net.fetch)('http://dav.example.com/dav/'))
        .rejects.toThrow(/redirected the login from https to plain http/);

      const followed = new RequestOrigins({ serverUrl: 'https://dav.example.com/' });
      const net2 = network({ 'https://dav.example.com/': redirect(302, 'http://dav.example.com/dav/') });
      await expect(followed.fetch(net2.fetch)('https://dav.example.com/'))
        .rejects.toThrow(/redirected the login from https to plain http/);
      expect(net2.sent).toHaveLength(1);
    });
  });

  describe('collections listed in the home', () => {
    const HOME = 'https://dav.example.com/dav/calendars/user/';
    const listing = (responses) =>
      '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
      `${responses}</d:multistatus>`;
    const calendar = (href, extraProps = '') =>
      `<d:response><d:href>${href}</d:href><d:propstat><d:prop>` +
      `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>${extraProps}` +
      '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
    const learnFrom = async (body, { url = HOME, method = 'PROPFIND' } = {}) => {
      const origins = policy();
      const fetch = origins.fetch(async () => new Response(body, { status: 207, headers: { 'content-type': 'application/xml' } }), { listingOf: HOME });
      await fetch(url, { method });
      return origins;
    };

    test('a calendar the home lists elsewhere becomes reachable', async () => {
      const origins = await learnFrom(listing(calendar('https://p42.example.com/123/work/')));
      expect(origins.problem('https://p42.example.com/123/work/x.ics')).toBeNull();
      expect(origins.problem('https://p42.example.com/123/other/')).toMatch(/outside/);
    });

    test.each([
      ['an escaped href in a property', calendar('/dav/calendars/user/work/',
        '<c:calendar-description>&lt;d:href&gt;https://escaped.attacker.test/&lt;/d:href&gt;</c:calendar-description>')],
      ['an href in CDATA', calendar('/dav/calendars/user/work/',
        '<c:calendar-description><![CDATA[notes <d:href>https://cdata.attacker.test/</d:href>]]></c:calendar-description>')],
      ['an href inside a property', calendar('/dav/calendars/user/work/',
        '<d:owner><d:href>https://owner-prop.attacker.test/x</d:href></d:owner>')],
      ['a response that is no collection', '<d:response><d:href>https://plain.attacker.test/</d:href><d:propstat><d:prop>' +
        '<d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'],
      ['a whole response inside CDATA', calendar('/dav/calendars/user/work/',
        '<c:calendar-description><![CDATA[<d:response><d:href>https://cdata2.attacker.test/</d:href><d:propstat><d:prop>' +
        '<d:resourcetype><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response>]]></c:calendar-description>')],
      ['a response whose propstat is a 404', '<d:response><d:href>https://s404.attacker.test/</d:href><d:propstat><d:prop>' +
        '<d:resourcetype><c:calendar/></d:resourcetype></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>'],
      ['a calendar element in a foreign namespace', '<d:response><d:href>https://wrongns.attacker.test/</d:href><d:propstat><d:prop>' +
        '<d:resourcetype><x:calendar xmlns:x="urn:evil"/></d:resourcetype></d:prop>' +
        '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'],
      ['an href in a foreign namespace', '<d:response><x:href xmlns:x="urn:x">https://ns.attacker.test/</x:href>' +
        '<d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype></d:prop>' +
        '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'],
    ])('%s is not learned', async (_name, responses) => {
      const origins = await learnFrom(listing(responses));
      expect(origins.allowedPrefixes().join(' ')).not.toMatch(/attacker/);
    });

    test('an entity declared in a DOCTYPE is not expanded into an href', async () => {
      const body = '<?xml version="1.0"?><!DOCTYPE m [<!ENTITY e "https://entity.attacker.test/">]>' +
        listing(calendar('&e;'));
      const origins = await learnFrom(body);
      expect(origins.allowedPrefixes().join(' ')).not.toMatch(/attacker/);
    });

    test('a listed collection whose name holds an encoded slash is reachable', async () => {
      const origins = await learnFrom(listing(calendar('https://p42.example.com/123/a%2Fb/')));
      expect(origins.problem('https://p42.example.com/123/a%2Fb/x.ics')).toBeNull();
    });

    test('only the home listing teaches, not any other multistatus', async () => {
      const body = listing(calendar('https://p42.example.com/123/work/'));
      for (const options of [{ url: 'https://dav.example.com/dav/calendars/user/work/' }, { method: 'REPORT' }]) {
        const origins = await learnFrom(body, options);
        expect(origins.problem('https://p42.example.com/123/work/')).not.toBeNull();
      }
    });
  });
});

// ---------------------------------------------------------------------------

describe('against real listeners', () => {
  let dav;
  let attacker;

  beforeAll(async () => {
    dav = await davServer().start();
    attacker = await davServer().start();
    await login(dav);
  });

  afterAll(async () => {
    await dav.stop();
    await attacker.stop();
  });

  beforeEach(() => {
    attacker.hits.length = 0;
  });

  // Values for the non-URL parameters that make each call valid, so a refusal
  // can only come from the URL. A new tool with a URL parameter fails the
  // coverage test below until it is listed here.
  const FIXTURES = {
    list_events: {},
    create_event: { summary: 's', start_date: '2026-10-01T10:00:00Z', end_date: '2026-10-01T11:00:00Z' },
    update_event: { event_etag: '"1"', fields: { SUMMARY: 's' } },
    update_event_raw: { event_etag: '"1"', updated_ical_data: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' },
    delete_event: { event_etag: '"1"' },
    calendar_query: { summary_filter: 's' },
    freebusy_query: { time_range_start: '2026-10-01T00:00:00Z', time_range_end: '2026-10-02T00:00:00Z' },
    update_calendar: { display_name: 'n' },
    delete_calendar: {},
    calendar_multi_get: {},
    list_contacts: {},
    create_contact: { full_name: 'n' },
    update_contact: { vcard_etag: '"1"', fields: { FN: 'n' } },
    update_contact_raw: { vcard_etag: '"1"', updated_vcard_data: 'BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n' },
    delete_contact: { vcard_etag: '"1"' },
    addressbook_query: { name_filter: 'n' },
    addressbook_multi_get: {},
    list_todos: {},
    create_todo: { summary: 's' },
    update_todo: { todo_etag: '"1"', fields: { SUMMARY: 's' } },
    update_todo_raw: { todo_etag: '"1"', updated_ical_data: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' },
    delete_todo: { todo_etag: '"1"' },
    todo_query: { summary_filter: 's' },
    todo_multi_get: {},
  };

  const urlParams = (tool) => Object.entries(tool.inputSchema?.properties ?? {})
    .filter(([name]) => /url/i.test(name))
    .map(([name, schema]) => ({ name, array: schema.type === 'array' }));

  const urlTools = tools.filter(tool => urlParams(tool).length > 0);

  // A plausible URL on a given origin for a parameter
  const urlFor = (origin, name) => {
    if (/addressbook/.test(name)) return `${origin}/addressbooks/user/contacts/`;
    if (/vcard|contact/.test(name)) return `${origin}/addressbooks/user/contacts/c.vcf`;
    if (/calendar/.test(name)) return `${origin}/calendars/user/work/`;
    return `${origin}/calendars/user/work/item.ics`;
  };

  const argsFor = (tool, origin) => {
    const args = { ...FIXTURES[tool.name] };
    for (const { name, array } of urlParams(tool)) {
      args[name] = array ? [urlFor(origin, name)] : urlFor(origin, name);
    }
    return args;
  };

  const cases = urlTools.flatMap(tool => urlParams(tool).map(param => [tool.name, param.name, tool, param]));

  test('every tool that takes a URL is covered', () => {
    // 24 of the 27 tools take a URL; list_calendars, list_addressbooks and
    // make_calendar do not.
    expect(urlTools.length).toBeGreaterThanOrEqual(24);
    for (const tool of urlTools) expect(FIXTURES).toHaveProperty([tool.name]);
  });

  test.each(cases)('%s refuses a foreign %s before any request', async (_toolName, _param, tool, param) => {
    const args = argsFor(tool, dav.origin);
    const evil = urlFor(attacker.origin, param.name);
    // in an array the foreign URL hides behind a good one
    args[param.name] = param.array ? [urlFor(dav.origin, param.name), evil] : evil;
    const davHitsBefore = dav.hits.length;

    const error = await tool.handler(args).then(() => null, e => e);

    expect(error).not.toBeNull();
    expect(error.message).toMatch(/is outside the configured DAV account/);
    expect(error.message).toContain(dav.origin);
    expect(attacker.hits).toHaveLength(0);
    // refused while validating: no request at all, not even to the real server
    expect(dav.hits.length).toBe(davHitsBefore);
  });

  test.each(urlTools.map(tool => [tool.name, tool]))('%s still works with URLs on the configured server', async (_name, tool) => {
    const davHitsBefore = dav.hits.length;
    const error = await tool.handler(argsFor(tool, dav.origin)).then(() => null, e => e);
    // the stub server cannot satisfy every tool, but the call got past
    // validation and reached it
    if (error) expect(error.message).not.toMatch(/Validation failed|Request refused/);
    expect(dav.hits.length).toBeGreaterThan(davHitsBefore);
    expect(attacker.hits).toHaveLength(0);
  });

  test('an http downgrade on the same host and port is refused for an https server', () => {
    // covered by the policy tests; here the listener is plain http, so the
    // other direction must still be refused: another scheme is another origin
    const problem = requestUrlProblem(`${dav.origin.replace('http:', 'https:')}/calendars/user/work/`);
    expect(problem).toMatch(/is outside the configured DAV account/);
  });

  describe('a request that bypasses the tool schemas still cannot leave the server', () => {
    const evil = () => `${attacker.origin}/calendars/user/work/`;
    const attempts = {
      davRequest: (c) => c.davRequest({ url: evil(), init: { method: 'PROPFIND', namespace: 'd', body: { propfind: {} } } }),
      propfind: (c) => c.propfind({ url: evil(), props: { 'd:displayname': {} }, depth: '0' }),
      deleteObject: (c) => c.deleteObject({ url: evil() }),
      createObject: (c) => c.createObject({ url: `${evil()}x.ics`, data: 'x' }),
      updateObject: (c) => c.updateObject({ url: `${evil()}x.ics`, data: 'x', etag: '"1"' }),
      makeCalendar: (c) => c.makeCalendar({ url: evil(), props: { displayname: 'x' } }),
      fetchCalendarObjects: (c) => c.fetchCalendarObjects({ calendar: { url: evil() } }),
      deleteCalendarObject: (c) => c.deleteCalendarObject({ calendarObject: { url: `${evil()}x.ics`, etag: '"1"' } }),
      fetchVCards: (c) => tsdavManager.getCardDavClient().fetchVCards({ addressBook: { url: evil() } }),
      multiGetObjects: (c) => multiGetObjects(c, { kind: 'calendar', collectionUrl: evil(), objectUrls: [`${evil()}x.ics`] }),
      // a fetch handed to a single call does not replace the check
      'propfind with its own fetch': (c) => c.propfind({ url: evil(), props: {}, depth: '0', fetch: globalThis.fetch }),
      'davRequest with its own fetch': (c) => c.davRequest({ url: evil(), init: { method: 'GET' }, fetch: globalThis.fetch }),
      'fetchCalendars with its own fetch': (c) => c.fetchCalendars({
        account: { ...c.account, rootUrl: evil(), homeUrl: evil() }, fetch: globalThis.fetch,
      }),
    };

    test.each(Object.entries(attempts))('%s', async (_name, attempt) => {
      const error = await attempt(tsdavManager.getCalDavClient()).then(() => null, e => e);
      expect(error).toBeInstanceOf(RequestOriginError);
      expect(attacker.hits).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------

describe('origins the server names during login and listing', () => {
  let entry;
  let root;
  let elsewhere;

  beforeAll(async () => {
    // entry redirects discovery to root (another port, so another origin), as
    // servers move a client from the configured URL to their DAV root; root
    // lists one calendar on a third origin, as iCloud lists calendars on a
    // per-account host
    elsewhere = await davServer().start();
    root = await davServer({ extraCalendarHref: () => `${elsewhere.origin}/calendars/user/shared/` }).start();
    entry = await davServer({ redirect: () => `${root.origin}/` }).start();
    await login(entry);
  });

  afterAll(async () => {
    await entry.stop();
    await root.stop();
    await elsewhere.stop();
  });

  test('the origin discovery redirected to is accepted, and used', async () => {
    expect(requestUrlProblem(`${root.origin}/calendars/user/work/`)).toBeNull();
    expect(root.hits.some(hit => hit.url === '/principals/user/')).toBe(true);
  });

  test('a calendar the server lists on another origin becomes reachable once listed', async () => {
    const shared = `${elsewhere.origin}/calendars/user/shared/`;
    expect(requestUrlProblem(shared)).toMatch(/is outside the configured DAV account/);

    const listCalendars = tools.find(tool => tool.name === 'list_calendars');
    await listCalendars.handler({});

    expect(requestUrlProblem(shared)).toBeNull();
    const listEvents = tools.find(tool => tool.name === 'list_events');
    await listEvents.handler({ calendar_url: shared }).catch(() => {});
    expect(elsewhere.hits.length).toBeGreaterThan(0);
  });
});

describe('a failed login', () => {
  test('keeps the previous clients and their policy', async () => {
    const good = await davServer().start();
    await login(good);
    const client = tsdavManager.getCalDavClient();

    await expect(tsdavManager.initialize({ serverUrl: 'not a url', authMethod: 'Basic', username: 'u', password: 'p' }))
      .rejects.toThrow();

    expect(tsdavManager.getCalDavClient()).toBe(client);
    expect(requestUrlProblem(`${good.origin}/calendars/user/work/`)).toBeNull();
    await good.stop();
    activateRequestOrigins(null);
  });
});

describe('a server that redirects a request out of the account', () => {
  let dav;
  let attacker;

  beforeAll(async () => {
    attacker = await davServer().start();
    dav = await davServer({
      handle: (req, res, path) => {
        if (!path.startsWith('/calendars/user/work/redir')) return false;
        res.writeHead(307, { location: `${attacker.origin}/steal` });
        res.end();
        return true;
      },
    }).start();
  });

  afterAll(async () => {
    await dav.stop();
    await attacker.stop();
  });

  test.each(['Basic', 'Digest'])('with %s, neither the request nor its body reach the target', async (authMethod) => {
    await tsdavManager.initialize({ serverUrl: `${dav.origin}/`, authMethod, username: 'user', password: 'secret' });
    attacker.hits.length = 0;
    const tool = (name) => tools.find(t => t.name === name);

    const deleted = await tool('delete_event').handler({
      event_url: `${dav.origin}/calendars/user/work/redir1.ics`, event_etag: '"1"',
    }).then(() => null, e => e);
    const updated = await tool('update_event_raw').handler({
      event_url: `${dav.origin}/calendars/user/work/redir2.ics`, event_etag: '"1"',
      updated_ical_data: 'BEGIN:VCALENDAR\r\nX-SECRET:body\r\nEND:VCALENDAR\r\n',
    }).then(() => null, e => e);

    // an error, never a success for a request that went elsewhere (under
    // Digest tsdav follows the redirect itself, and its next hop is refused)
    expect(deleted?.message).toMatch(/Request refused: .*\/steal/);
    expect(updated?.message).toMatch(/Request refused: .*\/steal/);
    expect(attacker.hits).toHaveLength(0);
  });
});

describe('a shared host', () => {
  let dav;

  beforeAll(async () => {
    // the account lives below /dav.php/, as on Baikal; other paths on the
    // host belong to someone else
    const base = '/dav.php';
    dav = await davServer({
      handle: (req, res, path, body) => {
        const xml = (responses) => {
          res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
          res.end(multistatus(responses));
        };
        if (path.startsWith('/.well-known/')) {
          res.writeHead(301, { location: `${base}/` });
          res.end();
          return true;
        }
        if (body.includes('current-user-principal')) {
          xml(propResponse(path, `<d:current-user-principal><d:href>${base}/principals/user/</d:href></d:current-user-principal>`));
          return true;
        }
        if (body.includes('calendar-home-set')) {
          xml(propResponse(path, `<cal:calendar-home-set><d:href>${base}/calendars/user/</d:href></cal:calendar-home-set>`));
          return true;
        }
        if (body.includes('addressbook-home-set')) {
          xml(propResponse(path, `<card:addressbook-home-set><d:href>${base}/addressbooks/user/</d:href></card:addressbook-home-set>`));
          return true;
        }
        return false;
      },
    }).start();
    await tsdavManager.initialize({ serverUrl: `${dav.origin}/dav.php`, authMethod: 'Basic', username: 'user', password: 'secret' });
  });

  afterAll(() => dav.stop());

  test('only the account below the server\'s DAV root gets the login', async () => {
    expect(requestUrlProblem(`${dav.origin}/dav.php/calendars/user/work/x.ics`)).toBeNull();
    const before = dav.hits.length;
    const error = await tools.find(t => t.name === 'delete_event').handler({
      event_url: `${dav.origin}/~tenant/inbox.ics`, event_etag: '"1"',
    }).then(() => null, e => e);
    expect(error.message).toMatch(/is outside the configured DAV account/);
    expect(dav.hits.length).toBe(before);
  });
});

describe('OAuth', () => {
  let dav;
  let token;

  beforeAll(async () => {
    token = await davServer({
      handle: (req, res, path) => {
        if (path !== '/o/oauth2/token') return false;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'bearer-token', expires_in: 3600, token_type: 'Bearer' }));
        return true;
      },
    }).start();
    dav = await davServer().start();
    await tsdavManager.initialize({
      serverUrl: `${dav.origin}/`, authMethod: 'OAuth', username: 'user@example.com',
      clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', tokenUrl: `${token.origin}/o/oauth2/token`,
    });
  });

  afterAll(async () => {
    await dav.stop();
    await token.stop();
  });

  test('logs in through the token endpoint, which DAV requests then cannot reach', async () => {
    expect(token.hits.some(hit => hit.url === '/o/oauth2/token')).toBe(true);
    expect(dav.hits.some(hit => hit.authorization === 'Bearer bearer-token')).toBe(true);
    const before = token.hits.length;

    expect(requestUrlProblem(`${token.origin}/o/oauth2/token`)).toMatch(/outside/);
    const error = await tsdavManager.getCalDavClient()
      .davRequest({ url: `${token.origin}/o/oauth2/token`, init: { method: 'GET' } })
      .then(() => null, e => e);
    expect(error).toBeInstanceOf(RequestOriginError);
    expect(token.hits.length).toBe(before);
  });
});
