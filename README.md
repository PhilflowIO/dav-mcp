# dav-mcp

**Give your AI agents the power of organization** — Transform them into orchestrating assistants managing calendars, contacts, and tasks.

Built on 26 production-ready tools spanning CalDAV, CardDAV, and VTODO protocols.

Built for n8n, Claude Desktop, and any MCP client.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://badge.fury.io/js/dav-mcp.svg)](https://www.npmjs.com/package/dav-mcp)

---

### The Orchestration 

When partial tools force your AI to improvise, complete tools let it **execute precise operations across all components**.

| Capability | dav-mcp | Most MCPs |
|------------|---------|-------------------|
| **Calendar Management** | ✅ Full CRUD (11 tools) | ⚠️ Create + list only (2-3 tools) |
| **Contact Management** | ✅ Complete CardDAV (8 tools) | ❌ Often missing entirely |
| **Task Management** | ✅ Full VTODO support (7 tools) | ❌ Rarely included |
| **Field-Based Updates** | ✅ All RFC properties + custom fields | ❌ Rarely available |
| **Server-Side Filtering** | ✅ Efficient queries | ❌ Dumps all data |
| **Multi-Provider** | ✅ Any CalDAV/CardDAV server | ⚠️ Limited provider support |
| **Total Tools** | **26 tools** | **2-6 tools** |


---

## 🚀 Full Feature Set

### Protocol Support
- **26 MCP Tools**: Full CRUD operations for calendars, contacts, and tasks
- **CalDAV Integration**: ~88% tsdav coverage (11 tools)
- **CardDAV Integration**: 100% tsdav coverage (8 tools)
- **VTODO Support**: Full task management with status, priorities, due dates (7 tools)
- **Field-Based Updates**: Field-agnostic updates via tsdav-utils - supports all RFC 5545/6350 properties + custom X-* fields
- **RFC-Compliant**: ical.js for RFC 5545 (iCalendar) and RFC 6350 (vCard) support

### Production-Ready Infrastructure
- **MCP Protocol**: STDIO transport for local clients, Stateless HTTP for remote
- **Multi-Server Tested**: Works with Radicale, Baikal, Nextcloud, iCloud
- **Bearer Auth**: Token authentication for HTTP transport
- **Structured Logging**: Custom JSON logger with millisecond precision

### Efficiency Features
- **Server-Side Filtering**: calendar_query, addressbook_query, todo_query with smart filters reduce data transfer
- **LLM-Optimized Tool Design**: PREFERRED/WARNING labels guide AI to efficient choices
- **Batch Operations**: multi_get tools fetch multiple specific items without loading entire collections

---

## 📋 Available Tools (26 Total)


### CalDAV Tools (11 tools)

1. **list_calendars** - List all available calendars
2. **list_events** - List ALL events (⚠️ WARNING: use calendar_query for filtered searches)
3. **create_event** - Create a new calendar event
4. **update_event** - ⭐ PREFERRED: Update any event field (SUMMARY, LOCATION, DTSTART, STATUS, custom X-* properties)
5. **update_event_raw** - Update event with raw iCal data (advanced)
6. **delete_event** - Delete an event permanently
7. **calendar_query** - ⭐ PREFERRED: Search and filter events efficiently by text, date range, or location
8. **make_calendar** - Create a new calendar collection
9. **update_calendar** - Update calendar properties (display name, description, color, timezone)
10. **delete_calendar** - Permanently delete a calendar and all its events
11. **calendar_multi_get** - Batch fetch multiple specific events by URLs

### CardDAV Tools (8 tools)

12. **list_addressbooks** - List all available address books
13. **list_contacts** - List ALL contacts (⚠️ WARNING: use addressbook_query for filtered searches)
14. **create_contact** - Create a new contact (vCard)
15. **update_contact** - ⭐ PREFERRED: Update any contact field (FN, EMAIL, TEL, ORG, ADR, custom X-* properties)
16. **update_contact_raw** - Update contact with raw vCard data (advanced)
17. **delete_contact** - Delete a contact permanently
18. **addressbook_query** - ⭐ PREFERRED: Search and filter contacts efficiently by name, email, or organization
19. **addressbook_multi_get** - Batch fetch multiple specific contacts by URLs

### VTODO Tools (7 tools)

20. **list_todos** - List ALL todos/tasks (⚠️ WARNING: use todo_query for filtered searches)
21. **create_todo** - Create a new todo/task with optional due date, priority, status
22. **update_todo** - ⭐ PREFERRED: Update any todo field (SUMMARY, STATUS, PRIORITY, DUE, PERCENT-COMPLETE, custom X-* properties)
23. **update_todo_raw** - Update todo with raw VTODO iCal data (advanced)
24. **delete_todo** - Delete a todo/task permanently
25. **todo_query** - ⭐ PREFERRED: Search and filter todos efficiently by status/due date
26. **todo_multi_get** - Batch fetch multiple specific todos by URLs

---

## 💡 Real-World Applications

See how complete tool coverage transforms basic operations into powerful workflows.

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

## 🛠️ Start Orchestrating in 5 Minutes

### Installation

```bash
git clone https://github.com/PhilflowIO/dav-mcp.git
cd dav-mcp
npm install
cp .env.example .env
```

### Configuration

Edit `.env`:

```env
# CalDAV/CardDAV Server
CALDAV_SERVER_URL=https://dav.example.com
CALDAV_USERNAME=your_username
CALDAV_PASSWORD=your_password

# MCP Server
PORT=3000
MCP_SERVER_NAME=dav-mcp
MCP_SERVER_VERSION=2.6.0

# Authentication (optional)
BEARER_TOKEN=your-secure-token-here
```

### Start Server

**STDIO** (for Claude Desktop, Cursor, local clients):
```bash
npm start
# Or: npx dav-mcp (after npm install -g dav-mcp)
```

**HTTP** (for n8n, remote clients):
```bash
BEARER_TOKEN=your-secret-token npm run start:http
# Server runs on: http://localhost:3000/mcp
```

---

## 🔗 Integration

### n8n Workflow

1. **Start HTTP server**: `BEARER_TOKEN=your-token npm run start:http`
2. **Add "AI Agent" node**
3. **Add "MCP Client Tool" node** and connect to AI Agent
4. **Configure the connection:**
   - **MCP Endpoint**: `http://localhost:3000/mcp`
   - **Authentication Method**: `Bearer`
   - **Bearer Token**: Your token

5. **Example prompts:**

```
"List all my calendars"
"Create a meeting tomorrow at 2 PM"
"Show me all events in October"
"Find all contacts at Google"
"Create a new contact for Jane Smith"
"Show overdue tasks with high priority"
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dav-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/dav-mcp/src/server-stdio.js"],
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

**Restart Claude Desktop** after adding the configuration.

---

## 🌐 Works Across All Major Providers

Works with any CalDAV/CardDAV server that follows RFC 4791 and RFC 6352:

- ✅ **Nextcloud** - Full support
- ✅ **Baikal** - Full support
- ✅ **Radicale** - Full support
- ✅ **iCloud** - Works with app-specific password
- ✅ **Any RFC-compliant server** - Standard protocol support


## 🔒 Security

- **Input Validation**: All inputs validated with Zod schemas before execution
- **Rate Limiting**: 100 requests/minute per session
- **Bearer Auth**: Optional token authentication
- **No Credential Storage**: Pass-through only, never logged or cached
- **Structured Logging**: Audit trail with request IDs, no PII exposure
- **CORS Protection**: Whitelist origins, block cross-site attacks



## 📚 Documentation

- **[MCP Specification](https://modelcontextprotocol.io/specification/2025-03-26)** - Model Context Protocol docs
- **[tsdav Docs](https://tsdav.vercel.app/docs/intro)** - CalDAV/CardDAV library reference
- **[CalDAV RFC 4791](https://datatracker.ietf.org/doc/html/rfc4791)** - CalDAV protocol specification
- **[CardDAV RFC 6352](https://datatracker.ietf.org/doc/html/rfc6352)** - CardDAV protocol specification

---

## 🤝 Contributing

Pull requests are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details

---

## 🙏 Acknowledgments

Built with:
- **[tsdav](https://github.com/natelindev/tsdav)** - Excellent TypeScript CalDAV/CardDAV library
- **[tsdav-utils](https://github.com/PhilflowIO/tsdav-utils)** - Field-agnostic utility layer for RFC-compliant field updates
- **[MCP SDK](https://modelcontextprotocol.io)** - Model Context Protocol by Anthropic
- **[ical.js](https://github.com/kewisch/ical.js)** - RFC-compliant iCalendar parser

---

**Questions? Issues?** Create a [GitHub issue](https://github.com/PhilflowIO/dav-mcp/issues)

---

*Built for AI agents managing calendars, contacts, and tasks*
