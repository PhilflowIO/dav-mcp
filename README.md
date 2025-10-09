# tsdav MCP Server

MCP (Model Context Protocol) SSE Server for tsdav - CalDAV/CardDAV integration for n8n and other AI systems.

## 🚀 Features

- **CalDAV Integration**: Complete calendar and event management with full lifecycle support (~96% tsdav coverage)
- **CardDAV Integration**: Complete address book and contact management (100% tsdav coverage)
- **VTODO Support**: Full task/todo management with status, priorities, and due dates
- **MCP SSE Protocol**: Compatible with n8n, Claude Desktop, and other MCP clients
- **23 Tools**: All essential CRUD operations + advanced query & management features
- **LLM-Optimized Outputs**: Markdown-formatted, structured responses for best AI integration
- **RFC-Compliant**: ical.js for RFC 5545 (iCalendar) and RFC 6350 (vCard) support
- **Token-Efficient**: Smart filtering (calendar_query, addressbook_query, todo_query) avoids loading thousands of items unnecessarily
- **Multi-Server Tested**: 100% compatibility with Radicale, Baikal, Nextcloud (see [COMPATIBILITY.md](COMPATIBILITY.md))
- **Custom JSON Logger**: Lightweight structured logging with millisecond precision
- **Bearer Auth**: Optional for secure connections
- **Multi-Session**: Supports multiple concurrent client connections

## 📋 Available Tools (23 total)

### CalDAV Tools (10 tools)

1. **list_calendars** - List all available calendars
2. **list_events** - List ALL events (WARNING: use calendar_query for filtered searches to save tokens)
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
12. **list_contacts** - List ALL contacts (WARNING: use addressbook_query for filtered searches to save tokens)
13. **create_contact** - Create a new contact (vCard)
14. **update_contact** - Update an existing contact
15. **delete_contact** - Delete a contact permanently
16. **addressbook_query** - ⭐ PREFERRED: Search and filter contacts efficiently by name, email, or organization
17. **addressbook_multi_get** - Batch fetch multiple specific contacts by URLs

### VTODO Tools (6 tools)

18. **list_todos** - List ALL todos/tasks (WARNING: use todo_query for filtered searches to save tokens)
19. **create_todo** - Create a new todo/task with optional due date, priority, status
20. **update_todo** - Update existing todo (e.g., mark completed, change status)
21. **delete_todo** - Delete a todo/task permanently
22. **todo_query** - ⭐ PREFERRED: Search and filter todos efficiently by status/due date
23. **todo_multi_get** - Batch fetch multiple specific todos by URLs

## 🛠️ Installation

```bash
# Install dependencies
npm install

# Configure .env file
cp .env.example .env
nano .env

# Start server
npm start

# Development with auto-reload
npm run dev
```

## ⚙️ Configuration

Edit the `.env` file:

```env
# CalDAV/CardDAV Server
CALDAV_SERVER_URL=https://dav.example.com
CALDAV_USERNAME=your_username
CALDAV_PASSWORD=your_password

# MCP Server
PORT=3000
MCP_SERVER_NAME=tsdav-mcp-server
MCP_SERVER_VERSION=2.3.0

# Authentication (optional)
BEARER_TOKEN=your-secure-token-here
```

## 🔗 n8n Integration

### Step 1: Start MCP Server

```bash
npm start
```

Server runs on: `http://localhost:3000`

### Step 2: Use with AI Agent

1. **Add an "AI Agent" node**
2. **Connect the MCP Client Tool node to the AI Agent**
3. **Configure the connection:**
   - **SSE Endpoint**: `http://localhost:3000/sse`
   - **Authentication Method**: `Bearer` (optional)
   - **Bearer Token**: `secure-token-123456` (from .env)
4. **Select tools:**
   - Option 1: "All tools from the MCP server"
   - Option 2: Select specific tools

5. **The AI Agent can now interact with your calendar naturally:**

Example prompts:
- "List all my calendars"
- "Create a meeting tomorrow at 2 PM"
- "Show me all events in October"
- "Find all contacts at Google"
- "Create a new contact for Jane Smith"
- "When am I free tomorrow between 9 AM and 5 PM?"



## 🌐 Remote Access (for n8n Cloud)

If your n8n runs in the cloud, you need to make the MCP server publicly accessible:

### Option 1: ngrok (quick for testing)

```bash
# Install and start ngrok
ngrok http 3000
```

Use the ngrok URL in n8n: `https://xyz.ngrok.io/sse`

### Option 2: Reverse Proxy (Production)

Nginx/Caddy/Traefik configuration with HTTPS and domain.

### Option 3: Deploy to VPS/Cloud

- Docker container
- PM2 for process management
- HTTPS with Let's Encrypt

## 🔒 Security

### Bearer Token Authentication

Set in `.env`:
```env
BEARER_TOKEN=your-very-secure-random-token-here
```

In n8n:
- Authentication Method: `Bearer`
- Token: `your-very-secure-random-token-here`

### Best Practices

1. **Never** commit credentials to code
2. **Always** add `.env` to `.gitignore`
3. **Use HTTPS** for production
4. **Generate strong tokens** (min. 32 characters)
5. **Configure firewall** (only open necessary ports)

## 🧪 Testing

### Health Check

```bash
curl http://localhost:3000/health
```

### Server Info

```bash
curl http://localhost:3000/
```

### Test SSE Connection

```bash
curl -H "Authorization: Bearer secure-token-123456" \
     -H "Accept: text/event-stream" \
     http://localhost:3000/sse
```

### Run Tests

```bash
npm test
```

## 💡 Token Optimization Tips

**IMPORTANT**: Always use the query tools instead of list tools when searching:

- ❌ **DON'T** use `list_events` when you want to find specific events
- ✅ **DO** use `calendar_query` with filters (saves thousands of tokens!)

- ❌ **DON'T** use `list_contacts` when searching for specific people
- ✅ **DO** use `addressbook_query` with filters (saves thousands of tokens!)

The LLM will automatically choose the right tool based on your query thanks to optimized tool descriptions.

## 📊 Monitoring

The server automatically logs:
- New SSE connections
- Client IPs
- User-Agents
- Errors and exceptions

## 🐛 Troubleshooting

### Server won't start

```bash
# Port already in use?
lsof -i :3000

# Credentials correct?
cat .env
```

### n8n can't connect

1. Server running? → `curl http://localhost:3000/health`
2. Port reachable? → Check firewall
3. Bearer token correct? → Check `.env`
4. URL correct? → `http://localhost:3000/sse` (not `/messages`)

### Tools not working

1. tsdav login successful? → Check server logs
2. Calendar/addressbook exists? → Check URLs
3. Credentials correct? → Check `.env`

## 🌐 Provider Compatibility

See **[COMPATIBILITY.md](COMPATIBILITY.md)** for detailed information about:
- Tested CalDAV/CardDAV providers (Radicale, Baikal, Nextcloud)
- Provider-specific quirks and workarounds
- Performance benchmarks
- Recommendations for different use cases

## 📚 Resources

- [tsdav Documentation](https://tsdav.vercel.app/docs/intro)
- [MCP Specification](https://modelcontextprotocol.io/specification/2025-03-26)
- [n8n MCP Client Docs](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/)
- [CalDAV RFC 4791](https://datatracker.ietf.org/doc/html/rfc4791)
- [CardDAV RFC 6352](https://datatracker.ietf.org/doc/html/rfc6352)

## 📄 License

MIT

## 🤝 Contributing

Pull requests are welcome!

## 💬 Support

For questions or issues, please create a GitHub issue.

---

**Made with ❤️ using tsdav and MCP**
