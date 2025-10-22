# Architektur-Diagramme: tsdav-mcp-server

## C4 Model - Level 1: System Context

```
┌──────────────────────────────────────────────────────────────────┐
│                         System Context                           │
└──────────────────────────────────────────────────────────────────┘

    ┌─────────────┐
    │   LLM/AI    │
    │  (Claude,   │ ──────┐
    │   GPT-4)    │       │
    └─────────────┘       │
                          │ MCP Protocol
    ┌─────────────┐       │ (SSE/Stdio)
    │   n8n       │       │
    │  Workflow   │ ──────┤
    │  Automation │       │
    └─────────────┘       │
                          ▼
                  ┌───────────────┐
                  │  tsdav-mcp-   │ ◄── Bearer Token Auth
                  │    server     │
                  │               │
                  │ Provides      │
                  │ CalDAV/       │
                  │ CardDAV       │
                  │ Tools         │
                  └───────┬───────┘
                          │
                          │ WebDAV/HTTP
                          │
                          ▼
                  ┌───────────────┐
                  │  CalDAV/      │
                  │  CardDAV      │
                  │  Server       │
                  │               │
                  │ (Nextcloud,   │
                  │  Radicale,    │
                  │  Baïkal)      │
                  └───────────────┘
```

---

## C4 Model - Level 2: Container Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    tsdav-mcp-server (Node.js)                             │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │              Express HTTP Server (Port 3000)                  │       │
│  │  ┌────────────┐  ┌──────────┐  ┌───────────────┐            │       │
│  │  │   CORS     │  │   Rate   │  │    Bearer     │            │       │
│  │  │ Middleware │→ │ Limiting │→ │ Auth Filter   │            │       │
│  │  └────────────┘  └──────────┘  └───────┬───────┘            │       │
│  │                                         │                     │       │
│  │                    ┌────────────────────▼──────────┐         │       │
│  │                    │   SSE Transport Layer         │         │       │
│  │                    │   - SSEServerTransport        │         │       │
│  │                    │   - Session Management        │         │       │
│  │                    │   - Connection Lifecycle      │         │       │
│  │                    └────────────┬──────────────────┘         │       │
│  └─────────────────────────────────┼───────────────────────────┘       │
│                                     │                                    │
│  ┌──────────────────────────────────▼──────────────────────────┐       │
│  │               MCP Protocol Handler                           │       │
│  │  ┌──────────────────┐  ┌────────────────────────┐          │       │
│  │  │  tools/list      │  │   tools/call           │          │       │
│  │  │  Handler         │  │   Handler              │          │       │
│  │  └──────────────────┘  └────────┬───────────────┘          │       │
│  └─────────────────────────────────┼──────────────────────────┘       │
│                                     │                                    │
│  ┌──────────────────────────────────▼──────────────────────────┐       │
│  │                 Tool Registry (tools.js)                     │       │
│  │  ┌────────────┐  ┌───────────┐  ┌──────────┐              │       │
│  │  │  CalDAV    │  │  CardDAV  │  │  Todo    │              │       │
│  │  │  Tools (9) │  │  Tools (7)│  │  Tools(6)│              │       │
│  │  └─────┬──────┘  └─────┬─────┘  └────┬─────┘              │       │
│  └────────┼────────────────┼─────────────┼────────────────────┘       │
│           │                │             │                             │
│  ┌────────▼────────────────▼─────────────▼────────────────────┐       │
│  │              Business Logic Layer (MISSING!)                │       │
│  │  Currently embedded in tool handlers (ANTI-PATTERN)         │       │
│  └─────────────────────────────┬─────────────────────────────┘       │
│                                 │                                       │
│  ┌──────────────────────────────▼──────────────────────────┐          │
│  │          tsdavManager (Singleton)                        │          │
│  │  ┌──────────────────┐  ┌──────────────────┐            │          │
│  │  │  CalDAV Client   │  │  CardDAV Client  │            │          │
│  │  │  (DAVClient)     │  │  (DAVClient)     │            │          │
│  │  └──────────────────┘  └──────────────────┘            │          │
│  └─────────────────────────────┬─────────────────────────┘          │
│                                 │                                       │
│  ┌──────────────────────────────▼──────────────────────────┐          │
│  │              Cross-Cutting Concerns                      │          │
│  │  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌─────────┐│          │
│  │  │ Logger  │  │Validator │  │Formatter  │  │  Error  ││          │
│  │  │ (JSON)  │  │  (Zod)   │  │(Markdown) │  │ Handler ││          │
│  │  └─────────┘  └──────────┘  └───────────┘  └─────────┘│          │
│  └─────────────────────────────────────────────────────────┘          │
│                                                                         │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │
                                 │ HTTP/WebDAV
                                 ▼
                        ┌─────────────────┐
                        │  External DAV   │
                        │     Server      │
                        └─────────────────┘
```

---

## C4 Model - Level 3: Component Diagram (Current State)

```
┌─────────────────────────────────────────────────────────────────────┐
│                          src/index.js (475 LOC)                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Express Server Setup                                         │  │
│  │  - app = express()                                            │  │
│  │  - CORS config (25 LOC)                                       │  │
│  │  - Rate Limiting (14 LOC)                                     │  │
│  │  - Body Parser                                                │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Session Management                                           │  │
│  │  - transports = {} (in-memory)                                │  │
│  │  - sessionActivity Map                                        │  │
│  │  - cleanupExpiredSessions()                                   │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Authentication Middleware                                    │  │
│  │  - authenticateBearer(req, res, next)                         │  │
│  │  - Timing-safe token comparison                               │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  MCP Server Factory                                           │  │
│  │  - createMCPServer(sessionId)                                 │  │
│  │  - setRequestHandler(ListToolsRequestSchema)                  │  │
│  │  - setRequestHandler(CallToolRequestSchema)                   │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Route Handlers                                               │  │
│  │  - GET  /            → Info                                   │  │
│  │  - GET  /health      → Health Check                           │  │
│  │  - GET  /sse         → SSE Connection                         │  │
│  │  - POST /messages    → Message Handler                        │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Lifecycle Management                                         │  │
│  │  - start()                                                    │  │
│  │  - gracefulShutdown(signal)                                   │  │
│  │  - Error Handlers (uncaughtException, unhandledRejection)     │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                        src/tools.js (1265 LOC)                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  export const tools = [                                             │
│    ┌────────────────────────────────────────────────────────────┐  │
│    │  CalDAV Tools (9 tools, ~450 LOC)                          │  │
│    │  - list_calendars                                           │  │
│    │  - list_events                                              │  │
│    │  - create_event                                             │  │
│    │  - update_event                                             │  │
│    │  - delete_event                                             │  │
│    │  - calendar_query ⭐ (PREFERRED)                            │  │
│    │  - make_calendar                                            │  │
│    │  - update_calendar                                          │  │
│    │  - delete_calendar                                          │  │
│    │  - calendar_multi_get                                       │  │
│    └────────────────────────────────────────────────────────────┘  │
│                                                                      │
│    ┌────────────────────────────────────────────────────────────┐  │
│    │  CardDAV Tools (7 tools, ~400 LOC)                         │  │
│    │  - list_addressbooks                                        │  │
│    │  - list_contacts                                            │  │
│    │  - create_contact                                           │  │
│    │  - update_contact                                           │  │
│    │  - delete_contact                                           │  │
│    │  - addressbook_query ⭐ (PREFERRED)                         │  │
│    │  - addressbook_multi_get                                    │  │
│    └────────────────────────────────────────────────────────────┘  │
│                                                                      │
│    ┌────────────────────────────────────────────────────────────┐  │
│    │  Todo Tools (6 tools, ~415 LOC)                            │  │
│    │  - list_todos                                               │  │
│    │  - create_todo                                              │  │
│    │  - update_todo                                              │  │
│    │  - delete_todo                                              │  │
│    │  - todo_query ⭐ (PREFERRED)                                │  │
│    │  - todo_multi_get                                           │  │
│    └────────────────────────────────────────────────────────────┘  │
│  ]                                                                   │
│                                                                      │
│  Each tool: { name, description, inputSchema, handler }             │
│  ⚠️  PROBLEM: Business logic embedded in handlers!                  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## C4 Model - Level 3: Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PROPOSED ARCHITECTURE                         │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  Transport Layer                                                     │
│  ┌───────────────┐        ┌───────────────┐                        │
│  │ sse-server.js │        │stdio-server.js│                        │
│  │ (SSE Logic)   │        │(Stdio Logic)  │                        │
│  └───────┬───────┘        └───────┬───────┘                        │
└──────────┼────────────────────────┼─────────────────────────────────┘
           │                        │
           └────────────┬───────────┘
                        │
┌───────────────────────▼─────────────────────────────────────────────┐
│  Server Layer                                                        │
│  ┌──────────────┐        ┌─────────────────┐                       │
│  │mcp-server.js │◄───────│session-manager  │                       │
│  │              │        │.js              │                       │
│  └──────┬───────┘        └─────────────────┘                       │
└─────────┼──────────────────────────────────────────────────────────┘
          │
┌─────────▼──────────────────────────────────────────────────────────┐
│  Tool Layer                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │calendar-     │  │contact-      │  │todo-         │             │
│  │tools.js      │  │tools.js      │  │tools.js      │             │
│  │(Thin Wrapper)│  │(Thin Wrapper)│  │(Thin Wrapper)│             │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘             │
└─────────┼──────────────────┼──────────────────┼────────────────────┘
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Service Layer (NEW!)                                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │CalendarSvc   │  │ContactSvc    │  │TodoSvc       │             │
│  │- query()     │  │- search()    │  │- filter()    │             │
│  │- create()    │  │- create()    │  │- create()    │             │
│  │- update()    │  │- update()    │  │- update()    │             │
│  │- delete()    │  │- delete()    │  │- delete()    │             │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘             │
└─────────┼──────────────────┼──────────────────┼────────────────────┘
          │                  │                  │
          └──────────────────┼──────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────────┐
│  DAV Client Layer                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  DAVClientManager                                             │  │
│  │  ┌────────────────┐        ┌────────────────┐               │  │
│  │  │CalDAV Client   │        │CardDAV Client  │               │  │
│  │  │Pool            │        │Pool            │               │  │
│  │  └────────────────┘        └────────────────┘               │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Cross-Cutting Concerns                                              │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌─────────┐            │
│  │Logger   │  │Validator │  │Formatter  │  │Error    │            │
│  │         │  │          │  │           │  │Handler  │            │
│  └─────────┘  └──────────┘  └───────────┘  └─────────┘            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow Diagram - Current State

```
┌─────────┐
│  LLM    │
└────┬────┘
     │
     │ 1. User Query: "Find events tomorrow"
     ▼
┌─────────────────┐
│  n8n Workflow   │
└────┬────────────┘
     │
     │ 2. MCP Protocol Request
     │    { method: "tools/call", params: { name: "calendar_query", ... } }
     ▼
┌──────────────────────────────────────────────────────────────┐
│  tsdav-mcp-server (index.js)                                 │
│                                                               │
│  3. Bearer Auth Check ────────────────────┐                  │
│  4. Rate Limit Check  ────────────────────┤                  │
│  5. Session Lookup    ────────────────────┤                  │
│                                            │                  │
│  6. MCP Handler ◄──────────────────────────┘                 │
│     ┌──────────────────────────────────┐                     │
│     │ CallToolRequestSchema Handler    │                     │
│     │                                   │                     │
│     │ 7. Find tool in tools array      │                     │
│     │    const tool = tools.find(...); │                     │
│     │                                   │                     │
│     │ 8. Execute handler                │                     │
│     │    await tool.handler(args);     │                     │
│     └────────────┬─────────────────────┘                     │
│                  │                                            │
└──────────────────┼────────────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  tools.js - calendar_query handler                           │
│                                                               │
│  9.  validateInput(calendarQuerySchema, args)                │
│  10. tsdavManager.getCalDavClient() ◄────────────────────┐   │
│  11. client.fetchCalendars()                             │   │
│  12. client.fetchCalendarObjects(...)                    │   │
│  13. Filter events (summary, location)                   │   │
│  14. formatEventList(events, calendar)                   │   │
│                                                          │   │
└──────────────────────────────────────────────────────────┼───┘
                                                           │
                   ┌───────────────────────────────────────┘
                   │
┌──────────────────▼────────────────────────────────────────────┐
│  tsdav-client.js (Singleton)                                  │
│                                                               │
│  - calDavClient = new DAVClient(...)                         │
│  - await calDavClient.login()                                │
│  - return calDavClient                                       │
└────────────────────┬──────────────────────────────────────────┘
                     │
                     │ 15. HTTP PROPFIND Request
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  External DAV Server (Nextcloud/Radicale)                   │
│                                                              │
│  16. Process WebDAV Request                                 │
│  17. Return XML Response                                    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       │ 18. Parse XML
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  tsdav library (external)                                    │
│                                                               │
│  19. Convert XML → JavaScript Objects                        │
│  20. Return { events: [...] }                               │
└────────────────────┬─────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────┐
│  formatters.js                                               │
│                                                               │
│  21. parseICalEvent(event.data) - ICAL.js                   │
│  22. Generate Markdown output                                │
│  23. Return { content: [{ type: 'text', text: '...' }] }    │
└────────────────────┬─────────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────────┐
│  index.js - Response to LLM                                  │
│                                                               │
│  24. Send formatted response via SSE                         │
└────────────────────┬─────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  LLM receives Markdown-formatted events                     │
│                                                              │
│  "Found events: **2**                                       │
│   1. Team Meeting - Tomorrow at 10:00 AM..."               │
└─────────────────────────────────────────────────────────────┘
```

---

## Deployment Diagram

```
┌────────────────────────────────────────────────────────────────┐
│                    Production Environment                       │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │             Docker Container (Node 18+)                   │ │
│  │                                                            │ │
│  │  ┌────────────────────────────────────────────────────┐  │ │
│  │  │  tsdav-mcp-server (Port 3000)                      │  │ │
│  │  │                                                     │  │ │
│  │  │  Environment Variables:                            │  │ │
│  │  │  - CALDAV_SERVER_URL=https://dav.example.com       │  │ │
│  │  │  - CALDAV_USERNAME=user                            │  │ │
│  │  │  - CALDAV_PASSWORD=***                             │  │ │
│  │  │  - BEARER_TOKEN=***                                │  │ │
│  │  │  - PORT=3000                                       │  │ │
│  │  │  - LOG_LEVEL=info                                  │  │ │
│  │  └────────────────────────────────────────────────────┘  │ │
│  │                                                            │ │
│  │  Volumes:                                                  │ │
│  │  - /tmp/mcp-server.log (Logs)                             │ │
│  │                                                            │ │
│  │  Health Check:                                             │ │
│  │  - GET /health every 30s                                  │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │             Reverse Proxy (Nginx/Traefik)                 │ │
│  │                                                            │ │
│  │  HTTPS Termination                                        │ │
│  │  Rate Limiting (Backup)                                   │ │
│  │  Load Balancing (Future)                                  │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
          │                                   │
          │ Internet                          │ Internal Network
          │                                   │
          ▼                                   ▼
┌─────────────────┐              ┌──────────────────────┐
│  LLM Clients    │              │  CalDAV/CardDAV      │
│  (n8n, Claude)  │              │  Server              │
└─────────────────┘              └──────────────────────┘
```

---

## Error Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  Error Scenarios & Handling                                      │
└─────────────────────────────────────────────────────────────────┘

Scenario 1: Invalid Bearer Token
─────────────────────────────────
LLM Request
    │
    ▼
┌──────────────────┐
│authenticateBearer│
└────────┬─────────┘
         │ Token mismatch
         ▼
┌──────────────────┐
│ 401 Unauthorized │
│ { error: "..." } │
└──────────────────┘


Scenario 2: Tool Not Found
──────────────────────────
MCP tools/call
    │
    ▼
┌──────────────────┐
│ tools.find(...)  │
└────────┬─────────┘
         │ null
         ▼
┌──────────────────────────┐
│ MCP_ERROR_CODES.        │
│ METHOD_NOT_FOUND (-32601)│
└──────────────────────────┘


Scenario 3: Validation Error
────────────────────────────
Tool Handler
    │
    ▼
┌──────────────────┐
│ validateInput()  │
└────────┬─────────┘
         │ Zod validation fails
         ▼
┌──────────────────────────┐
│ throw new Error(...)     │
│ "Validation failed: ..." │
└────────┬─────────────────┘
         │
         ▼
┌──────────────────────────┐
│ createToolErrorResponse()│
│ {                        │
│   code: -32002,          │
│   message: "...",        │
│   data: { errors }       │
│ }                        │
└──────────────────────────┘


Scenario 4: DAV Server Error
─────────────────────────────
Tool Handler
    │
    ▼
┌──────────────────┐
│client.fetch...() │
└────────┬─────────┘
         │ Network error / 500 / Timeout
         ▼
┌──────────────────────────┐
│ tsdav throws error       │
└────────┬─────────────────┘
         │
         ▼
┌──────────────────────────┐
│ Caught in try/catch      │
│ (tools.js handler)       │
└────────┬─────────────────┘
         │
         ▼
┌──────────────────────────┐
│ createToolErrorResponse()│
│ {                        │
│   code: -32000,          │
│   message: "...",        │
│   data: { type, stack }  │
│ }                        │
└──────────────────────────┘
         │
         ▼
┌──────────────────────────┐
│ Returned to LLM          │
│ (Server continues!)      │
└──────────────────────────┘


Scenario 5: Uncaught Exception
───────────────────────────────
Anywhere in Code
    │
    ▼
┌──────────────────────────┐
│ process.on('uncaught-   │
│ Exception')              │
└────────┬─────────────────┘
         │
         ▼
┌──────────────────────────┐
│ logger.error()           │
│ (Server CONTINUES)       │
│ ⚠️  DANGEROUS!           │
└──────────────────────────┘
```

---

## Session Management Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  Session Lifecycle                                               │
└─────────────────────────────────────────────────────────────────┘

Client connects
    │
    ▼
┌────────────────────────────────────────────┐
│ GET /sse                                    │
│ Headers:                                   │
│   Authorization: Bearer <token>           │
└────────┬───────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────┐
│ authenticateBearer() ✓                     │
└────────┬───────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────┐
│ Create SSEServerTransport                  │
│ transport = new SSEServerTransport(...)   │
│ sessionId = transport.sessionId (UUID)     │
└────────┬───────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────┐
│ Store transport                            │
│ transports[sessionId] = transport         │
│ sessionActivity.set(sessionId, Date.now()) │
└────────┬───────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────┐
│ Create MCP Server                          │
│ mcpServer = createMCPServer(sessionId)    │
│ await mcpServer.connect(transport)        │
└────────┬───────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────┐
│ Session Active                             │
│                                            │
│ Client can now:                            │
│ - POST /messages?sessionId=...            │
│ - Receive SSE events                       │
└────────┬───────────────────────────────────┘
         │
         │ (Every 5 minutes)
         ▼
┌────────────────────────────────────────────┐
│ cleanupExpiredSessions()                   │
│                                            │
│ IF (now - lastActivity > SESSION_TTL):    │
│   - delete transports[sessionId]          │
│   - sessionActivity.delete(sessionId)     │
└────────────────────────────────────────────┘
         │
         │ (Client disconnects OR timeout)
         ▼
┌────────────────────────────────────────────┐
│ req.on('close') / req.on('error')         │
│                                            │
│ - delete transports[sessionId]            │
│ - sessionActivity.delete(sessionId)       │
│ - logger.info('Session closed')           │
└────────────────────────────────────────────┘
```

---

## Performance Bottlenecks

```
┌─────────────────────────────────────────────────────────────────┐
│  Identified Bottlenecks                                          │
└─────────────────────────────────────────────────────────────────┘

🔴 CRITICAL: tools.js Parsing
─────────────────────────────
Every tools/list request:
  - Parse 1265 LOC file
  - Build 22 tool definitions
  - Map to JSON Schema

Impact: 5-10ms overhead per request
Solution: Pre-compile tool registry


🟡 MEDIUM: DAV Client Singleton
───────────────────────────────
All requests share 1 client:
  - No connection pooling
  - Sequential DAV requests
  - No parallel calendar fetching

Impact: 50-200ms per multi-calendar query
Solution: Connection pooling


🟡 MEDIUM: In-Memory Session Store
──────────────────────────────────
sessionActivity Map grows unbounded:
  - No persistent storage
  - Lost on server restart
  - Not cluster-compatible

Impact: Memory leak risk, scalability limit
Solution: Redis-backed session store


🟢 LOW: Markdown Formatting
───────────────────────────
formatEventList() for 1000 events:
  - String concatenation
  - ICAL.js parsing per event

Impact: 20-50ms for large result sets
Solution: Streaming responses


🟢 LOW: Log Parsing
───────────────────
Integration tests read full log file:
  - fs.readFileSync() entire file
  - Regex on full content

Impact: Test slowdown only
Solution: Use rotating logs + tail
```

---

## Security Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Security Layers                                                 │
└─────────────────────────────────────────────────────────────────┘

Layer 1: Network Security
─────────────────────────
┌────────────────────────────────────────────┐
│ CORS Policy                                │
│ - Allowed Origins: Whitelist              │
│ - Default: localhost:5678, localhost:3000 │
│ - Credentials: Enabled                    │
└────────────────────────────────────────────┘

Layer 2: Rate Limiting
──────────────────────
┌────────────────────────────────────────────┐
│ IP-based Rate Limiting                     │
│ - Local/Docker: 10,000 req/15min          │
│ - External:     100 req/15min             │
│ - Prevents DoS                            │
└────────────────────────────────────────────┘

Layer 3: Authentication
───────────────────────
┌────────────────────────────────────────────┐
│ Bearer Token Authentication                │
│ - Timing-safe comparison                  │
│ - crypto.timingSafeEqual()                │
│ - Prevents timing attacks                 │
└────────────────────────────────────────────┘

Layer 4: Input Validation
─────────────────────────
┌────────────────────────────────────────────┐
│ Zod Schema Validation                      │
│ - URL validation                           │
│ - Email validation                         │
│ - Max length checks                        │
│ - Sanitization (sanitizeICalString)       │
└────────────────────────────────────────────┘

Layer 5: DAV Server Credentials
───────────────────────────────
┌────────────────────────────────────────────┐
│ Environment Variables                      │
│ - CALDAV_USERNAME                          │
│ - CALDAV_PASSWORD                          │
│ - Never logged or exposed                 │
│ - Basic Auth over HTTPS                   │
└────────────────────────────────────────────┘

⚠️  Missing Security Layers:
────────────────────────────
- No HTTPS enforcement (relies on reverse proxy)
- No input sanitization for iCal injection
- No audit logging (who accessed what)
- No encryption at rest
- No secret rotation mechanism
```

---

## Test Architecture (Current)

```
┌─────────────────────────────────────────────────────────────────┐
│  Test Structure                                                  │
└─────────────────────────────────────────────────────────────────┘

tests/
├── integration/
│   ├── mcp-test-runner.js ──────┐
│   │   - 5x repetition per test  │
│   │   - 80% success threshold   │
│   │   - Calls n8n webhook       │
│   │   - Validates LLM response  │
│   │                              │
│   ├── mcp-log-parser.js ────────┤
│   │   - Parses MCP server logs  │
│   │   - Extracts tool calls     │
│   │   - Validates parameters    │
│   │                              │
│   ├── answer-validator.js ──────┤
│   │   - Validates LLM answers   │
│   │   - Checks correctness      │
│   │                              │
│   ├── test-cases.json ──────────┤
│   │   - Test case definitions   │
│   │   - Expected tools          │
│   │   - Validation rules        │
│   │                              │
│   └── setup-test-data.js ───────┘
│       - Creates test calendars
│       - Creates test events
│       - Requires live DAV server!
│
├── optimization/
│   ├── metric-multi-call.js
│   │   - Measures redundant calls
│   │
│   └── metric-unnecessary-list.js
│       - Detects list_* misuse
│
└── ❌ unit/ (MISSING!)
    - No unit tests!


┌─────────────────────────────────────────────────────────────────┐
│  Test Flow (Integration Test)                                   │
└─────────────────────────────────────────────────────────────────┘

1. setup-test-data.js
   ├─> Creates test calendar
   ├─> Creates test events
   └─> Stores test-data-manifest.json

2. Start MCP Server
   ├─> Logs to /tmp/mcp-server.log
   └─> Exposes /sse endpoint

3. Start n8n Workflow
   ├─> Webhook receives LLM prompts
   ├─> Calls MCP via SSE
   └─> Returns LLM responses

4. mcp-test-runner.js
   ├─> For each test case (5x):
   │   ├─> Send prompt to n8n webhook
   │   ├─> Parse MCP logs (mcp-log-parser)
   │   ├─> Validate tool selection
   │   ├─> Validate parameters
   │   └─> Validate answer (answer-validator)
   │
   └─> Generate test report
       ├─> JSON: test-results-{timestamp}.json
       └─> HTML: test-report-{timestamp}.html


⚠️  Test Weaknesses:
────────────────────
1. Requires full stack (MCP + n8n + DAV server)
2. Slow (5x repetition, network calls)
3. Flaky (80% threshold because of variability)
4. No unit tests = hard to debug
5. No mocking = tests DAV server too
```

This completes the architecture diagrams. They visualize the current state, proposed improvements, data flows, deployment, errors, sessions, performance, security, and testing.
