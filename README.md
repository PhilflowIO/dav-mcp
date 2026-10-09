# dav-mcp

**Give your AI agents the power of organization** — Transform them into orchestrating assistants managing calendars, contacts, and tasks.

Built on 27 production-ready tools spanning CalDAV, CardDAV, and VTODO protocols.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://badge.fury.io/js/dav-mcp.svg)](https://www.npmjs.com/package/dav-mcp)

---

## Quick Start

### One-click install (Claude Desktop)

1. Download `dav-mcp-<version>.mcpb` from the [latest release](https://github.com/PhilflowIO/dav-mcp/releases/latest). Releases from 4.1.2 on carry this file.
2. Open it with Claude Desktop (macOS or Windows). Claude shows an install dialog.
3. Enter your server URL, username and password. The password is stored as a secret. Leave the authentication method at `Basic` unless your server needs `Digest`.

The `.mcpb` file is an [MCP Bundle](https://github.com/modelcontextprotocol/mcpb): the server with its dependencies, so neither Node.js nor npx needs to be installed.

### Claude Desktop / Cursor (Local)

Add to your MCP config file:

```json
{
  "mcpServers": {
    "dav-mcp": {
      "command": "npx",
      "args": ["-y", "dav-mcp"],
      "env": {
        "CALDAV_SERVER_URL": "https://dav.example.com",
        "CALDAV_USERNAME": "your_username",
        "CALDAV_PASSWORD": "your_password"
      }
    }
  }
}
```

**Config file locations:**
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

Restart Claude Desktop after adding the configuration.

---

### n8n (Remote HTTP)

Start the HTTP server:

```bash
CALDAV_SERVER_URL=https://dav.example.com \
CALDAV_USERNAME=your_username \
CALDAV_PASSWORD=your_password \
BEARER_TOKEN=your-secret-token \
npx dav-mcp --http
```

Then in n8n:
1. Add **AI Agent** node
2. Add **MCP Client Tool** node and connect to AI Agent
3. Configure:
   - **MCP Endpoint**: `http://localhost:3000/mcp`
   - **Authentication**: Bearer
   - **Token**: your-secret-token

**Custom port:**
```bash
npx dav-mcp --http --port=8080
```

---

### Docker

Pull the published image (distroless, runs as non-root, no shell):

```bash
docker run -d --name dav-mcp -p 3000:3000 --env-file .env \
  ghcr.io/philflowio/dav-mcp:latest
```

Tags: `latest`, the exact release (`4.3.0`) and the minor line (`4.3`).
Set `PORT` to serve on a different port; the healthcheck follows it.

Or build from source:

```bash
git clone https://github.com/PhilflowIO/dav-mcp.git
cd dav-mcp
cp .env.example .env
# Edit .env with your credentials
docker-compose up
```

---

## The Orchestration

When partial tools force your AI to improvise, complete tools let it **execute precise operations across all components**.

| Capability | dav-mcp | Most MCPs |
|------------|---------|-----------|
| **Calendar Management** | Full CRUD (12 tools) | Create + list only (2-3 tools) |
| **Contact Management** | Complete CardDAV (8 tools) | Often missing entirely |
| **Task Management** | Full VTODO support (7 tools) | Rarely included |
| **Field-Based Updates** | All RFC properties + custom fields | Rarely available |
| **Free/Busy** | Works on every server (client-side) | Native REPORT, unsupported by most |
| **Server-Side Filtering** | Efficient queries | Dumps all data |
| **Multi-Provider** | Any CalDAV/CardDAV server | Limited provider support |
| **Total Tools** | **27 tools** | **2-6 tools** |

---

## Available Tools (27 Total)

### CalDAV Tools (12 tools)

1. **list_calendars** - List all available calendars
2. **list_events** - List ALL events (use calendar_query for filtered searches)
3. **create_event** - Create a new calendar event
4. **update_event** - PREFERRED: Update any event field (SUMMARY, LOCATION, STATUS, custom X-* properties); move or convert an event with start_date/end_date/all_day
5. **update_event_raw** - Update event with raw iCal data (advanced)
6. **delete_event** - Delete an event permanently
7. **calendar_query** - PREFERRED: Search and filter events efficiently by text, date range, or location
8. **make_calendar** - Create a new calendar collection, optionally with a time zone (an IANA name such as `Europe/Berlin`, sent as a VTIMEZONE)
9. **update_calendar** - Update calendar properties (display name, description, color, time zone)
10. **delete_calendar** - Delete a calendar and all its events
11. **calendar_multi_get** - Batch fetch multiple specific events by URLs
12. **freebusy_query** - Find free and busy time in a range ("when am I free?"), calculated client-side

### CardDAV Tools (8 tools)

13. **list_addressbooks** - List all available address books
14. **list_contacts** - List ALL contacts (use addressbook_query for filtered searches)
15. **create_contact** - Create a new contact (vCard)
16. **update_contact** - PREFERRED: Update any contact field (FN, EMAIL, TEL, ORG, ADR, custom X-* properties)
17. **update_contact_raw** - Update contact with raw vCard data (advanced)
18. **delete_contact** - Delete a contact permanently
19. **addressbook_query** - PREFERRED: Search and filter contacts efficiently by name, email, or organization
20. **addressbook_multi_get** - Batch fetch multiple specific contacts by URLs

### VTODO Tools (7 tools)

21. **list_todos** - List ALL todos/tasks (use todo_query for filtered searches)
22. **create_todo** - Create a new todo/task with optional due date, priority, status
23. **update_todo** - PREFERRED: Update any todo field (SUMMARY, STATUS, PRIORITY, DUE, PERCENT-COMPLETE, custom X-* properties)
24. **update_todo_raw** - Update todo with raw VTODO iCal data (advanced)
25. **delete_todo** - Delete a todo/task permanently
26. **todo_query** - PREFERRED: Search and filter todos efficiently by status/due date
27. **todo_multi_get** - Batch fetch multiple specific todos by URLs

### Time zones

An event or todo written without a time zone (a "floating" time such as
`DTSTART:20261010T090000`, or an all-day date) is read in its calendar's time
zone, as CalDAV specifies (RFC 4791 §9.9): the zone set with `make_calendar` /
`update_calendar`, which `list_calendars` shows. A calendar without one is read
in the zone dav-mcp runs in: the `TZ` environment variable (for example
`TZ=Europe/Berlin` in Docker or an HTTP deployment), else the system's. A time
without a zone given to the create and update tools is read the same way, and
an event stored without a zone stays without one when it is moved.
`freebusy_query` prints its slots in the calendar's zone and names it.

---

## Real-World Applications

### n8n Automation Workflows
- **Meeting Management**: "Show me all Friday meetings" → calendar_query with date filter returns only relevant events
- **Contact Search**: "Find everyone at Google" → addressbook_query with org filter finds matches efficiently
- **Task Reporting**: "Show overdue high-priority tasks" → todo_query with filters returns specific results
- **Scheduled Cleanup**: Daily cron job deletes completed tasks using targeted queries

### Claude Desktop Integration
- **Quick Event Creation**: "Create team meeting tomorrow 2 PM" → create_event executes immediately
- **Contact Lookup**: "What's Sarah's email?" → addressbook_query with name filter finds contact
- **Calendar Overview**: "What's on my calendar next week?" → calendar_query with date range shows events
- **Calendar Management**: "Create a new calendar called Project Luna" → make_calendar creates collection

---

## Works Across All Major Providers

Works with any CalDAV/CardDAV server that follows RFC 4791 and RFC 6352:

- **Nextcloud** - Full support
- **Baikal** - Full support
- **Radicale** - Full support
- **iCloud** - Works with app-specific password
- **Any RFC-compliant server** - Standard protocol support

---

## Authentication

`AUTH_METHOD` selects how dav-mcp logs in (case-insensitive):

| `AUTH_METHOD` | Credentials | Use for |
|---|---|---|
| `Basic` (default) | `CALDAV_USERNAME`, `CALDAV_PASSWORD` | Almost every server. If the server only offers Digest (for example Baikal set to Digest), dav-mcp switches to Digest by itself — no setting needed. |
| `Digest` | `CALDAV_USERNAME`, `CALDAV_PASSWORD` | Servers that only accept Digest (RFC 7616). Unlike the automatic switch under `Basic`, which first sends the password once Basic-encoded and is then rejected, `Digest` never sends the password — use it when the connection is not HTTPS. |
| `OAuth` (or `OAuth2`) | `GOOGLE_*`, see below | Google Calendar |

dav-mcp needs Node.js 22 or newer. A wrong configuration — an unknown
`AUTH_METHOD` value, or missing credentials for the chosen method — stops the
server at startup instead of falling back to Basic.

---

## Google Calendar (OAuth2)

For Google Calendar, use OAuth2 authentication:

```json
{
  "mcpServers": {
    "dav-mcp": {
      "command": "npx",
      "args": ["-y", "dav-mcp"],
      "env": {
        "AUTH_METHOD": "OAuth",
        "GOOGLE_USER": "your@gmail.com",
        "GOOGLE_CLIENT_ID": "your-client-id",
        "GOOGLE_CLIENT_SECRET": "your-client-secret",
        "GOOGLE_REFRESH_TOKEN": "your-refresh-token"
      }
    }
  }
}
```

---

## Security

- **Input Validation**: All inputs validated with Zod schemas before execution
- **Rate Limiting** (HTTP mode): 100 requests per 15 minutes per client address, counted before the bearer token is checked. Clients on loopback or a private network (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) — another container on the same Docker network, for example — get 10,000. Limitation: dav-mcp sees the address of whatever connects to it. Behind a Docker port mapping or a reverse proxy that is the bridge gateway or the proxy, so all outside clients share that one address, its one counter and its raised limit. Rate-limit per client at the proxy if you expose the HTTP transport.
- **Bearer Auth**: Token authentication for HTTP transport
- **No Credential Storage**: Pass-through only, never logged or cached
- **Structured Logging**: Audit trail with request IDs, no PII exposure
- **Tool-Call Log Off by Default**: `LOG_TOOL_CALLS=true` records every tool call with its arguments, for debugging — to `~/.local/state/dav-mcp/tool-calls.jsonl` (or `$XDG_STATE_HOME`, `%LOCALAPPDATA%` on Windows, or `TOOL_CALL_LOG_FILE`), readable by you only. `TOOL_CALL_LOG_MODE=console` sends it to stderr instead.
- **CORS Protection**: Whitelist origins, block cross-site attacks

---

## Privacy Policy

dav-mcp runs on your machine (or your own server) and talks only to the DAV server you configure. It has no telemetry and shares nothing with its maintainers or third parties. Tool results go to the AI assistant that called the tool. Credentials and calendar data are not stored by dav-mcp; the optional tool-call log is off by default. Full policy: [PRIVACY.md](PRIVACY.md). Contact: [hello@philflow.io](mailto:hello@philflow.io).

---

## Documentation

- **[MCP Specification](https://modelcontextprotocol.io/specification/2025-03-26)** - Model Context Protocol docs
- **[tsdav Docs](https://tsdav.vercel.app/docs/intro)** - CalDAV/CardDAV library reference
- **[CalDAV RFC 4791](https://datatracker.ietf.org/doc/html/rfc4791)** - CalDAV protocol specification
- **[CardDAV RFC 6352](https://datatracker.ietf.org/doc/html/rfc6352)** - CardDAV protocol specification

---

## Contributing

Pull requests are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

MIT License - see [LICENSE](LICENSE) for details

---

## Acknowledgments

Built with:
- **[tsdav](https://github.com/natelindev/tsdav)** - Excellent TypeScript CalDAV/CardDAV library
- **[tsdav-utils](https://github.com/PhilflowIO/tsdav-utils)** - Field-agnostic utility layer for RFC-compliant field updates
- **[MCP SDK](https://modelcontextprotocol.io)** - Model Context Protocol by Anthropic
- **[ical.js](https://github.com/kewisch/ical.js)** - RFC-compliant iCalendar parser

---

**Questions? Issues?** Create a [GitHub issue](https://github.com/PhilflowIO/dav-mcp/issues)

---

*Built for AI agents managing calendars, contacts, and tasks*
