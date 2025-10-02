# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an MCP (Model Context Protocol) Server that provides CalDAV/CardDAV integration for AI systems like n8n and Claude Desktop. It wraps the `tsdav` library to expose calendar and contact management through 10 standardized MCP tools.

## Architecture

### Core Components

1. **tsdav-client.js** - Singleton manager for CalDAV/CardDAV clients
   - Initializes two DAVClient instances (CalDAV and CardDAV)
   - Handles authentication and login
   - Provides `getCalDavClient()` and `getCardDavClient()` methods

2. **tools.js** - MCP tool definitions (10 tools total)
   - 5 CalDAV tools: list_calendars, list_events, create_event, update_event, delete_event
   - 5 CardDAV tools: list_addressbooks, list_contacts, create_contact, update_contact, delete_contact
   - Each tool has: name, description, inputSchema (JSON Schema), handler function

3. **index.js** - Express SSE server (primary server for n8n)
   - GET /sse - SSE endpoint for MCP connections
   - POST /messages - Message handling endpoint
   - GET /health - Health check
   - GET / - Server info
   - Supports multi-session management with Bearer token authentication

4. **server-stdio.js** - Stdio MCP server (for Claude Desktop)
   - Simpler stdio-based transport
   - Use with `npm run start:stdio`

### Key Patterns

- **Session Management**: Each SSE connection creates a new MCP server instance with unique sessionId
- **Transport Storage**: Active transports stored in `transports` object keyed by sessionId
- **Authentication**: Optional Bearer token authentication via BEARER_TOKEN environment variable
- **Keep-Alive**: 30-second intervals send keepalive messages to maintain SSE connections

## Commands

### Development
```bash
npm install          # Install dependencies
npm start           # Start SSE server (for n8n)
npm run start:stdio # Start stdio server (for Claude Desktop)
npm run dev         # Start with auto-reload
```

### Testing
```bash
node test-mcp-client.js       # Test MCP client connection
node carddav-test.js          # Test CardDAV functionality
node full-test.js             # Full integration test
node test-delete.js           # Test delete operations
```

### Environment Setup
Copy `.env.example` to `.env` and configure:
- CALDAV_SERVER_URL - Your CalDAV/CardDAV server URL
- CALDAV_USERNAME - Username for authentication
- CALDAV_PASSWORD - Password for authentication
- PORT - Server port (default: 3000)
- BEARER_TOKEN - Optional Bearer token for authentication

## Tool Development

When adding new tools to `tools.js`:

1. Follow the existing structure with name, description, inputSchema, handler
2. Use `tsdavManager.getCalDavClient()` or `tsdavManager.getCardDavClient()` to access clients
3. Always return MCP-compliant response: `{ content: [{ type: 'text', text: JSON.stringify(...) }] }`
4. Handle errors and throw descriptive Error messages
5. For create operations, use unique UIDs: `${type}-${Date.now()}`
6. For iCal dates, use `formatICalDate()` helper to convert ISO 8601 to iCal format

## CalDAV/CardDAV Integration

### iCal Format
Events use iCalendar (RFC 5545) format with required fields:
- UID, DTSTAMP, DTSTART, DTEND, SUMMARY
- Optional: DESCRIPTION, LOCATION

### vCard Format
Contacts use vCard 3.0 format with required fields:
- UID, FN (full name), REV (revision timestamp)
- Optional: N (structured name), EMAIL, TEL, ORG, NOTE

### URL Structure
- Calendar URLs: `{serverUrl}/{username}/{calendar-uuid}/`
- Event URLs: `{calendarUrl}{event-uid}.ics`
- Address book URLs: `{serverUrl}/{username}/{addressbook-uuid}/`
- vCard URLs: `{addressbookUrl}{contact-uid}.vcf`

### ETags
All update/delete operations require ETags for concurrency control. Always fetch current object before updating/deleting.

## n8n Integration

The SSE server is designed for n8n's MCP Client Tool node:
1. Start server with `npm start`
2. In n8n, configure MCP Client Tool with SSE endpoint: `http://localhost:3000/sse`
3. Optionally add Bearer token authentication
4. Select "All tools from the MCP server" or choose specific tools

## MCP Protocol Details

This server implements MCP SSE transport:
- Client initiates SSE connection to /sse
- Server creates unique sessionId and returns it via SSE endpoint event
- Client sends JSON-RPC requests to /messages?sessionId={sessionId}
- Server routes requests to appropriate MCP server instance
- Responses sent back via SSE stream

The server handles two MCP request types:
- `tools/list` - Returns list of available tools
- `tools/call` - Executes a tool with provided arguments

## Backups

Project backups are stored in:
- `/home/dave/Dokumente/projects/tsdav_mcp_backup_20251001_134146/` - Pre-production hardening backup
- `/home/dave/Dokumente/projects/tsdav_mcp_backup_20251001_153556/` - Current stable backup (session cleanup + all Phase 1-3 complete)

Always create a timestamped backup before major changes:
```bash
BACKUP_DIR="/home/dave/Dokumente/projects/tsdav_mcp_backup_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp -r /home/dave/Dokumente/projects/tsdav_mcp/* "$BACKUP_DIR/"
```

## Production Readiness Status

### ✅ Completed (Phase 1-3):
- **Security Hardening**:
  - Stack trace exposure fixed (development-only)
  - Zod input validation for all tools
  - Timing-safe Bearer token comparison
  - CORS configuration with allowed origins
  - Rate limiting (100 req/15min)
  - Input sanitization for iCal/vCard strings

- **Code Quality**:
  - Dead code removed (index-simple.js, index-sse-fixed.js)
  - MCP error codes standardized (JSON-RPC 2.0)
  - Structured logging with Pino (no emojis, request/session IDs)
  - Session cleanup with TTL (1 hour, cleanup every 5 min)
  - Graceful shutdown (SIGTERM/SIGINT handlers)
  - Health endpoint with metrics

- **NPM Package Ready**:
  - LICENSE (MIT)
  - Complete package.json metadata
  - CHANGELOG.md, SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md
  - .npmignore configured
  - Version 0.1.0 (Beta)

### ⏳ Pending (Optional for 1.0.0):
- Unit/Integration tests
- Git repository initialization
- README translation to English
- iCal/vCard library migration (currently using template strings)

## Roadmap

### Current Implementation (10 tools, 36% tsdav coverage):

**CalDAV (5/11 methods):**
- ✅ list_calendars (`fetchCalendars`)
- ✅ list_events (`fetchCalendarObjects`)
- ✅ create_event (`createCalendarObject`)
- ✅ update_event (`updateCalendarObject`)
- ✅ delete_event (`deleteCalendarObject`)

**CardDAV (5/7 methods):**
- ✅ list_addressbooks (`fetchAddressBooks`)
- ✅ list_contacts (`fetchVCards`)
- ✅ create_contact (`createVCard`)
- ✅ update_contact (`updateVCard`)
- ✅ delete_contact (`deleteVCard`)

### Phase 4: LLM Output Optimization (Priority: HIGH)

**Problem**: Current tool outputs return raw JSON strings that are hard for LLMs to parse and understand.

**Current Output Example:**
```javascript
return {
  content: [{
    type: 'text',
    text: JSON.stringify([{url: "...", etag: "...", data: "BEGIN:VCALENDAR..."}])
  }]
};
```

**Target Output (LLM-Friendly):**
```javascript
return {
  content: [{
    type: 'text',
    text: `Found 3 events:

## 1. Team Meeting
- **When**: October 15, 2025, 10:00-11:00 AM
- **Where**: Conference Room A
- **Description**: Monthly team sync
- **Calendar**: Work Calendar
- **URL**: https://dav.example.com/...

## 2. Sprint Planning
- **When**: October 16, 2025, 2:00-3:00 PM
- **Where**: Online (Zoom)
- **Calendar**: Work Calendar

## 3. Doctor Appointment
- **When**: October 17, 2025, 9:00-9:30 AM
- **Where**: Medical Center
- **Calendar**: Personal Calendar

---
<details>
<summary>Raw Data (Click to expand)</summary>

\`\`\`json
${JSON.stringify(events, null, 2)}
\`\`\`
</details>`
  }]
};
```

**Implementation Plan:**
1. Create `src/formatters.js` with helper functions:
   - `formatEvent()` - Format single event to Markdown
   - `formatEventList()` - Format event list with summary
   - `formatContact()` - Format contact to Markdown
   - `formatContactList()` - Format contact list
   - `formatCalendar()` - Format calendar info
   - `formatError()` - User-friendly error messages

2. Update all tool handlers in `tools.js` to use formatters
3. Add configuration option for output format (markdown/json/both)
4. Include raw data in collapsible sections for reference

**Benefits:**
- LLMs can easily extract key information
- Better user experience when viewing in chat
- Maintains backward compatibility (raw data still available)
- Follows MCP best practices for content formatting

### Phase 5: Missing tsdav Methods (Priority: MEDIUM)

**HIGH PRIORITY Methods (implement first):**

1. **calendarQuery** - Advanced event filtering
   - Filter by date range, component type, properties
   - Use case: "Find all recurring events", "Events in October with 'meeting' in title"
   - Difficulty: Medium (3-4 hours)
   - Impact: ⭐⭐⭐⭐⭐

2. **addressBookQuery** - Advanced contact filtering
   - Filter by name, email, organization, properties
   - Use case: "Find all contacts at @example.com", "Contacts in 'Sales' department"
   - Difficulty: Medium (3-4 hours)
   - Impact: ⭐⭐⭐⭐⭐

3. **makeCalendar** - Create new calendars
   - Create new calendar collections on the server
   - Use case: "Create a new calendar called 'Projects'"
   - Difficulty: Easy (1-2 hours)
   - Impact: ⭐⭐⭐⭐ (completes CRUD for calendars)

4. **freeBusyQuery** - Check availability
   - Query free/busy time without exposing event details
   - Use case: Meeting scheduling, availability checking
   - Difficulty: Medium (3-4 hours)
   - Impact: ⭐⭐⭐⭐

5. **syncCalendars** - Efficient sync with change detection
   - Detect created/updated/deleted calendars efficiently
   - Use case: Keep local/remote in sync, avoid full re-fetch
   - Difficulty: Hard (5-8 hours)
   - Impact: ⭐⭐⭐⭐⭐

**MEDIUM PRIORITY Methods:**

6. **calendarMultiGet** - Fetch multiple specific events
   - Get specific events by URL efficiently
   - Use case: "Get these 5 events by URL"
   - Difficulty: Medium (2-3 hours)
   - Impact: ⭐⭐⭐

7. **addressBookMultiGet** - Fetch multiple specific contacts
   - Get specific contacts by URL efficiently
   - Difficulty: Medium (2-3 hours)
   - Impact: ⭐⭐⭐

8. **smartCollectionSync** - Intelligent sync
   - Adaptive sync with automatic method selection
   - Difficulty: Hard (5-8 hours)
   - Impact: ⭐⭐⭐

9. **isCollectionDirty** - Quick sync check
   - Check if collection changed via ctag comparison
   - Use case: "Has calendar changed since last sync?"
   - Difficulty: Easy (1-2 hours)
   - Impact: ⭐⭐⭐

**LOW PRIORITY Methods:**

10. **fetchCalendarUserAddresses** - Get user URIs
11. **supportedReportSet** - Server capability discovery
12. Low-level WebDAV methods (davRequest, propfind, etc.)

### Phase 6: Testing Infrastructure (Priority: MEDIUM)

**Unit Tests:**
- Tool input validation
- Date formatting
- Error handling
- Session management
- Authentication

**Integration Tests:**
- CalDAV operations (CRUD)
- CardDAV operations (CRUD)
- MCP protocol compliance
- SSE connection handling

**E2E Tests:**
- n8n integration workflow
- Real CalDAV server (Radicale in Docker)
- Large dataset handling
- Connection recovery

**Target**: 80% code coverage

### Phase 7: Additional Features (Priority: LOW)

- **Pagination support** for large result sets
- **Caching layer** (Redis/node-cache) for frequently accessed data
- **Extended iCal support**: RRULE, VALARM, ATTENDEES, VTIMEZONE, all-day events
- **Extended vCard support**: Multiple emails/phones, addresses, photos
- **Bulk operations**: create_events, update_events, delete_events (plural)
- **Search tools**: Full-text search for events and contacts
- **TypeScript migration** for better type safety
- **Web UI** for server management and monitoring

## Development Guidelines

### Adding New Tools

When implementing missing tsdav methods:

1. **Create validation schema** in `src/validation.js`:
```javascript
export const calendarQuerySchema = z.object({
  calendar_url: z.string().url(),
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
  component_type: z.enum(['VEVENT', 'VTODO', 'VJOURNAL']).optional(),
});
```

2. **Add tool definition** in `src/tools.js`:
```javascript
{
  name: 'calendar_query',
  description: 'Advanced query for calendar events with filters',
  inputSchema: {
    type: 'object',
    properties: {
      calendar_url: { type: 'string', description: '...' },
      start_date: { type: 'string', description: '...' },
      end_date: { type: 'string', description: '...' },
    },
    required: ['calendar_url'],
  },
  handler: async (args) => {
    const validated = validateInput(calendarQuerySchema, args);
    const client = tsdavManager.getCalDavClient();

    // Use tsdav method
    const result = await client.calendarQuery({
      url: validated.calendar_url,
      props: {...},
      filters: {...},
      timezone: {...},
    });

    // Format for LLM (Phase 4)
    return formatEventList(result);
  }
}
```

3. **Add formatter** in `src/formatters.js` (when Phase 4 is done)
4. **Update CLAUDE.md** roadmap to mark as completed
5. **Add to CHANGELOG.md**

### LLM Output Best Practices

From MCP specification and research:

1. **Use Markdown formatting** for readability
2. **Structure data hierarchically** (headings, lists, tables)
3. **Be concise but complete** - Include relevant context
4. **Provide actionable errors** - Tell user how to fix issues
5. **Use collapsible sections** for raw/detailed data
6. **Annotate content** when useful (priority, audience, timestamps)
7. **Handle pagination explicitly** - Tell user when content is truncated
8. **Consistent formatting** across all tools

### Security Considerations

- **Never expose credentials** in logs or responses
- **Validate all inputs** with Zod schemas
- **Sanitize iCal/vCard strings** to prevent injection
- **Use timing-safe comparison** for tokens
- **Log security events** (auth failures, rate limits)
- **Implement rate limiting** on all public endpoints
- **Configure CORS** with specific allowed origins
- **Hide stack traces** in production (NODE_ENV check)

### Phase 8: Extended Authentication Support (Priority: LOWEST)

**Problem**: Currently only Basic Auth is supported. Some providers (especially Google) require OAuth2.

**Current Implementation:**
```javascript
// src/tsdav-client.js:29
authMethod: 'Basic',
```

**Target Providers:**
- ✅ **Nextcloud** - Basic Auth (works now)
- ✅ **Radicale** - Basic Auth (works now)
- ✅ **iCloud** - Basic Auth with App-Specific Password (works now)
- ✅ **Baikal** - Basic Auth (works now)
- ❌ **Google Calendar/Contacts** - Requires OAuth2 + App Password
- ❌ **Microsoft 365** - Requires OAuth2

**Implementation Plan:**

1. **Add OAuth2 configuration to .env:**
```bash
# OAuth2 (optional, for Google/Microsoft)
OAUTH2_ENABLED=false
OAUTH2_CLIENT_ID=
OAUTH2_CLIENT_SECRET=
OAUTH2_REFRESH_TOKEN=
AUTH_METHOD=Basic  # Basic, OAuth, Digest, Custom
```

2. **Update tsdav-client.js:**
```javascript
const authConfig = process.env.AUTH_METHOD === 'OAuth'
  ? {
      authMethod: 'OAuth',
      authFunction: async () => {
        // Implement OAuth2 token refresh
        const token = await refreshOAuth2Token();
        return { Authorization: `Bearer ${token}` };
      }
    }
  : {
      authMethod: 'Basic',
      credentials: {
        username: config.username,
        password: config.password,
      }
    };

this.calDavClient = new DAVClient({
  serverUrl: config.serverUrl,
  ...authConfig,
  defaultAccountType: 'caldav',
});
```

3. **Add OAuth2 token refresh helper:**
- Implement token refresh flow for Google/Microsoft
- Store refresh tokens securely
- Handle token expiration
- Add validation schema for OAuth config

4. **Update documentation:**
- Add setup guides for each provider
- Document OAuth2 app registration process
- Provide example .env configurations

**Benefits:**
- Support for Google Calendar/Contacts
- Support for Microsoft 365 CalDAV/CardDAV
- Broader provider compatibility
- Enterprise-ready authentication

**Effort Estimate:** 8-12 hours

**Note:** This is lowest priority since Basic Auth covers most self-hosted and privacy-focused providers (Nextcloud, Radicale, Baikal). OAuth2 is mainly needed for Google/Microsoft.
- du hast für git MCP tools verwende immer diese