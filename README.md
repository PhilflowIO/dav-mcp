# dav-mcp

**Give your AI agents the power of organization** — Transform them into orchestrating assistants managing calendars, contacts, and tasks.

Built on 23 production-ready tools spanning CalDAV, CardDAV, and VTODO protocols.

Built for n8n, Claude Desktop, and any MCP client.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://badge.fury.io/js/dav-mcp.svg)](https://www.npmjs.com/package/dav-mcp)

---

### The Orchestration 

When partial tools force your AI to improvise, complete tools let it **execute precise operations across all components**.

| Capability | dav-mcp | Most MCPs |
|------------|---------|-------------------|
| **Calendar Management** | ✅ Full CRUD (10 tools) | ⚠️ Create + list only (2-3 tools) |
| **Contact Management** | ✅ Complete CardDAV (7 tools) | ❌ Often missing entirely |
| **Task Management** | ✅ Full VTODO support (6 tools) | ❌ Rarely included |
| **Server-Side Filtering** | ✅ Efficient queries | ❌ Dumps all data |
| **Multi-Provider** | ✅ Any CalDAV/CardDAV server | ⚠️ Limited provider support |
| **Total Tools** | **23 tools** | **2-6 tools** |


---

## 🚀 Full Feature Set

### Protocol Support
- **23 MCP Tools**: Full CRUD operations for calendars, contacts, and tasks
- **CalDAV Integration**: ~88% tsdav coverage (10 tools)
- **CardDAV Integration**: 100% tsdav coverage (7 tools)
- **VTODO Support**: Full task management with status, priorities, due dates (6 tools)
- **RFC-Compliant**: ical.js for RFC 5545 (iCalendar) and RFC 6350 (vCard) support

### Production-Ready Infrastructure
- **MCP SSE Protocol**: Compatible with n8n, Claude Desktop, and other MCP clients
- **Multi-Server Tested**: Works with Radicale, Baikal, Nextcloud, iCloud
- **Multi-Session Support**: Handle multiple concurrent client connections
- **Keep-Alive Heartbeats**: Stable SSE connections with 30-second intervals
- **Bearer Auth**: Optional token authentication for secure connections
- **Structured Logging**: Custom JSON logger with millisecond precision

### Efficiency Features
- **Server-Side Filtering**: calendar_query, addressbook_query, todo_query with smart filters reduce data transfer
- **LLM-Optimized Tool Design**: PREFERRED/WARNING labels guide AI to efficient choices
- **Batch Operations**: multi_get tools fetch multiple specific items without loading entire collections

---

## 📋 Available Tools (23 Total)


### CalDAV Tools (10 tools)

1. **list_calendars** - List all available calendars
2. **list_events** - List ALL events (⚠️ WARNING: use calendar_query for filtered searches)
3. **create_event** - Create a new calendar event
4. **update_event** - Update an existing event
5. **delete_event** - Delete an event permanently
6. **calendar_query** - ⭐ PREFERRED: Search and filter events efficiently by text, date range, or location
7. **make_calendar** - Create a new calendar collection
8. **update_calendar** - Update calendar properties (display name, description, color, timezone)
9. **delete_calendar** - Permanently delete a calendar and all its events
10. **calendar_multi_get** - Batch fetch multiple specific events by URLs

### CardDAV Tools (7 tools)

11. **list_addressbooks** - List all available address books
12. **list_contacts** - List ALL contacts (⚠️ WARNING: use addressbook_query for filtered searches)
13. **create_contact** - Create a new contact (vCard)
14. **update_contact** - Update an existing contact
15. **delete_contact** - Delete a contact permanently
16. **addressbook_query** - ⭐ PREFERRED: Search and filter contacts efficiently by name, email, or organization
17. **addressbook_multi_get** - Batch fetch multiple specific contacts by URLs

### VTODO Tools (6 tools)

18. **list_todos** - List ALL todos/tasks (⚠️ WARNING: use todo_query for filtered searches)
19. **create_todo** - Create a new todo/task with optional due date, priority, status
20. **update_todo** - Update existing todo (e.g., mark completed, change status)
21. **delete_todo** - Delete a todo/task permanently
22. **todo_query** - ⭐ PREFERRED: Search and filter todos efficiently by status/due date
23. **todo_multi_get** - Batch fetch multiple specific todos by URLs

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
MCP_SERVER_VERSION=2.5.1

# Authentication (optional)
BEARER_TOKEN=your-secure-token-here
```

### Start Server

```bash
npm start
# Server runs on: http://localhost:3000
```

---

## 🔗 Integration

### n8n Workflow

1. **Add "AI Agent" node**
2. **Add "MCP Client Tool" node** and connect to AI Agent
3. **Configure the connection:**
   - **SSE Endpoint**: `http://localhost:3000/sse`
   - **Authentication Method**: `Bearer` (optional)
   - **Bearer Token**: Your token from .env

4. **Example prompts:**

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
- **[MCP SDK](https://modelcontextprotocol.io)** - Model Context Protocol by Anthropic
- **[ical.js](https://github.com/kewisch/ical.js)** - RFC-compliant iCalendar parser

---

**Questions? Issues?** Create a [GitHub issue](https://github.com/PhilflowIO/dav-mcp/issues)

---

*Built for AI agents managing calendars, contacts, and tasks*
