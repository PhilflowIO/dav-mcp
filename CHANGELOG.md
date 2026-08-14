# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **dotenv printed a banner to stdout under the stdio transport**, so the first
  thing a strict MCP client read was not JSON-RPC. Same hazard as #48, from a
  dependency rather than our own code.
- **The version reported to clients was hardcoded** and still said `3.0.1` in
  five places. It now comes from `package.json`, with a protocol-level test that
  speaks to the real server over stdio and asserts the two agree.

## [4.0.0] - 2026-08-14

A correctness release. Several tools returned confidently wrong answers or
accepted input that produced invalid objects on the server; the fixes change
behaviour, hence the major version.

### Breaking Changes

- **`update_event` no longer takes dates through `fields`.** `DTSTART`, `DTEND`
  and `DURATION` are rejected there; use the new top-level `start_date`,
  `end_date` and `all_day` parameters instead (#56). The flat map cannot express
  this property family: an all-day value needs a `VALUE=DATE` parameter, which
  the map could only add as a *duplicate* property, and writing `DTEND` on an
  event stored as `DTSTART` + `DURATION` left both present, which RFC 5545 3.6.1
  forbids.
- **The `fields` map of `update_event`, `update_todo` and `update_contact` now
  validates its keys and values** (#44). Keys must be bare property names and
  values must be single-line. Parameterised keys (`DTSTART;VALUE=DATE`) and
  multi-line values are rejected.
- **Query tools return at most 20 results by default** (#34). `calendar_query`,
  `todo_query` and `addressbook_query` previously returned everything in range.
  Pass `limit` (max 500) to raise it; the response states how many matched in
  total.

### Security

- **Property and component injection through the `fields` map** (#44). Keys and
  values reached `updatePropertyWithValue` unvalidated, and that function keys on
  the property *name* alone. A value could terminate the VEVENT and open a
  second, fully caller-shaped one; a key containing `:` or a line break injected
  properties outright; a `VALARM` with `ACTION:EMAIL` and an arbitrary attendee
  could be attached. Verified by re-parsing the emitted documents. Reachable
  through ordinary tool arguments, which matters here because the caller is a
  model that routinely handles untrusted text.
- **Carriage returns survived `sanitizeICalString`**, and `create_event` and
  `create_contact` emitted LF line endings where RFC 5545 3.1 and RFC 6350 3.2
  require CRLF (#47).

### Fixed

- **Recurring events showed the series start, not the occurrence in the queried
  range** (#45). "What's on next week" returned each series once, dated at its
  original start — often years back. Present with a wrong date is worse than
  absent. Expansion is client-side, so it does not depend on a server
  implementing `CALDAV:expand`, and it also surfaces `RECURRENCE-ID` overrides,
  which were silently dropped. The walk is capped so a degenerate `RRULE` cannot
  stall a response.
- **Times were rendered in the server's timezone, not the event's** (#46). A
  meeting booked for 14:00 Berlin showed as 12:00 on a UTC host. An
  Exchange-style TZID made the date vanish entirely, and date-only values shifted
  a day east of Greenwich. Unresolvable TZIDs now render from the offset in the
  object's own VTIMEZONE (#54).
- **Deletes reported success even when the server refused them** (#9). `fetch`
  does not reject on 4xx, and the Response was discarded, so a 403 looked exactly
  like a 204. Server-independent, contrary to the issue's Radicale framing.
- **`[object Object]` as the collection name** (#38), across five call sites plus
  an explicit `null` path that a default parameter does not catch.
- **Contact photos overflowed the context** (#33). One contact with an embedded
  `PHOTO` produced ~171k characters, 99.9% of it base64 echoed into the raw data
  block. Against a real address book: 456k characters of raw cards render in 8.9k.
- **`client.fetchTodos is not a function`** (#41). The fork's committed `dist/`
  had lost the whole VTODO surface to an upstream sync, and a git install never
  rebuilt it, so six of the eight todo tools were dead for npm users while
  working locally. Fixed in the fork; the pin moves to that build and a test now
  asserts the client exposes what this server calls.
- **The tool-call logger could corrupt the JSON-RPC stream** (#48) by writing to
  stdout under the stdio transport.
- Success messages no longer read "created successfully successful".

### Added

- **`freebusy_query`** (#36): answers "when am I free?" client-side, since the
  native CalDAV `free-busy-query` REPORT fails on most servers people run.
  `TRANSP:TRANSPARENT` and cancelled events do not block; recurring series are
  expanded; touching intervals merge.
- **All-day events** (#43): `create_event` and `update_event` accept a bare
  `YYYY-MM-DD` `start_date`/`end_date` (or an explicit `all_day` flag) and emit
  `DTSTART;VALUE=DATE` / `DTEND;VALUE=DATE`. `update_event` gained top-level
  `start_date`/`end_date`/`all_day` parameters, which convert an event in both
  directions; the `fields` map cannot express a parameterised property.
  The all-day `DTEND` is exclusive, as RFC 5545 3.8.2.2 requires.
- **`limit`** on the three query tools, with the result set sorted before
  truncation so the subset is the earliest rather than arbitrary (#34, #32).

### Internal

- Tests: 76 → 237, including the first formatter, handler and timezone coverage.
  The suite runs under host timezones from Pacific/Midway to Pacific/Auckland,
  which is where the date-shifting bugs hid.
- Removed `src/utils/tool-helpers.js` (no importers, duplicated
  `src/tools/shared/helpers.js`).

## [3.0.1] - 2026-01-20

### Added
- **CLI flags**: `--http` and `--port` flags for easier server startup
  - `npx dav-mcp` → STDIO mode (default)
  - `npx dav-mcp --http` → HTTP mode on port 3000
  - `npx dav-mcp --http --port=8080` → HTTP mode with custom port

### Changed
- **README restructured** by user type (Claude Desktop, n8n, Docker)
- **Simplified setup**: No git clone needed for most users, just `npx dav-mcp`
- **Cleaned up `.env.example`**: Removed unnecessary `MCP_SERVER_NAME` and `MCP_SERVER_VERSION`

## [3.0.0] - 2026-01-20

### Breaking Changes
- **Removed HTTP+SSE transport**: The deprecated `/sse` and `/messages` endpoints have been removed
- **New transports**: Replaced with STDIO and Stateless HTTP transports
- **n8n users**: Must update endpoint from `/sse` to `/mcp`

### Added
- **STDIO transport** (`src/server-stdio.js`): For local clients (Claude Desktop, Cursor, npx)
- **Stateless HTTP transport** (`src/server-http.js`): For remote clients (n8n, cloud deployments)
- **MIGRATION.md**: Upgrade guide for migrating from v2.x

### Changed
- Default `npm start` now runs STDIO server (was SSE)
- Logger now writes to stderr in STDIO mode (preserves stdout for JSON-RPC)
- Dockerfile updated to use HTTP server
- Simplified HTTP server (stateless, no session management)

### Removed
- `src/index.js` (old HTTP+SSE server)
- Session management in HTTP transport
- `/sse` endpoint
- `/messages` endpoint

### Migration
See [MIGRATION.md](MIGRATION.md) for detailed upgrade instructions.

## [2.7.0] - 2025-10-30

### Added
- **OAuth2 Authentication Support**: Full OAuth2 support for Google Calendar and other OAuth2-enabled CalDAV servers
  - New `AUTH_METHOD` environment variable to switch between Basic Auth and OAuth2
  - Support for Google Calendar via OAuth2 with automatic token refresh
  - CalDAV discovery via RFC 4791 (no Google Calendar API required)
  - Tested with Google Calendar (5 calendars discovered and fully functional)
  - All CRUD operations (Create, Read, Update, Delete) working with OAuth2
- OAuth2 test suite with 10 comprehensive test cases
- OAuth2 configuration in `.env.example` with detailed setup instructions

### Changed
- **Field-agnostic updates**: Integrated tsdav-utils for universal field update support
  - `update_event` now supports all RFC 5545 iCalendar properties (SUMMARY, DESCRIPTION, LOCATION, DTSTART, DTEND, STATUS, etc.)
  - `update_todo` now supports all RFC 5545 VTODO properties (SUMMARY, DESCRIPTION, STATUS, PRIORITY, DUE, PERCENT-COMPLETE, etc.)
  - `update_contact` now supports all RFC 6350 vCard properties (FN, N, EMAIL, TEL, ORG, TITLE, NOTE, URL, ADR, BDAY, etc.)
  - All update tools now accept custom X-* properties for extensions (e.g., X-ZOOM-LINK, X-MEETING-ROOM)
- Replaced manual iCal/vCard string manipulation with structured field updates via tsdav-utils
- Simplified update tool implementations (reduced code by 40-45% per tool)
- Updated input schemas to accept any RFC property name (field-agnostic validation)
- Enhanced `tsdav-client.js` to support both Basic Auth and OAuth2 authentication methods
- Updated `index.js` initialization logic to auto-detect authentication method

### Dependencies
- Added: tsdav-utils (v0.1.0) - Field-agnostic utility layer for RFC-compliant updates

### Compatibility
- Fully backward compatible with existing Basic Auth setup
- No breaking changes - existing configurations continue to work
- Google Calendar tested and verified with OAuth2

## [2.6.0] - Previous Release

Initial release with 26 MCP tools for CalDAV, CardDAV, and VTODO operations.

