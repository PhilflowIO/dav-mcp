# tsdav MCP Server

MCP (Model Context Protocol) SSE Server for tsdav - CalDAV/CardDAV integration for n8n and other AI systems.

## 🚀 Features

- **CalDAV Integration**: Complete calendar and event management
- **CardDAV Integration**: Complete address book and contact management
- **MCP SSE Protocol**: Compatible with n8n, Claude Desktop and other MCP clients
- **10 Tools**: All essential CRUD operations for calendars and contacts
- **Bearer Auth**: Optional for secure connections
- **Multi-Session**: Supports multiple simultaneous client connections

## ✅ What Works

- ✅ **CalDAV & CardDAV**: Full CRUD operations for calendars and contacts
- ✅ **Authentication**: HTTP Basic Auth (for Nextcloud, Radicale, Baikal, iCloud with app password)
- ✅ **MCP Transports**: SSE (for n8n) and Stdio (for Claude Desktop)
- ✅ **Security**: Bearer Token Auth, Rate Limiting, CORS, Input Validation, Structured Logging
- ✅ **Session Management**: Multi-client support with automatic session cleanup
- ✅ **Production Ready**: Error handling, graceful shutdown, health checks
- ✅ **Testing**: Jest test suite with 33 tests, GitHub Actions CI/CD

## ⏳ What's Not Yet Supported

- ❌ **OAuth2**: Currently only HTTP Basic Auth (no Google Calendar/Microsoft 365 OAuth)
- ❌ **Advanced iCal Features**: RRULE (recurring events), VALARM (alarms), ATTENDEES (participants)
- ❌ **Advanced CalDAV Queries**: Filtering by properties, full-text search
- ❌ **Bulk Operations**: Create/update/delete multiple events/contacts at once
- ❌ **Pagination**: For very large calendars/address books

## 🌐 Supported CalDAV/CardDAV Providers

| Provider | Status | Auth Method |
|----------|--------|-------------|
| **Radicale** | ✅ Tested | Basic Auth |
| **Nextcloud** | ✅ Should work | Basic Auth |
| **Baikal** | ✅ Should work | Basic Auth |
| **iCloud** | ✅ With app password | Basic Auth |
| **Google Calendar** | ❌ Not yet | OAuth2 required |
| **Microsoft 365** | ❌ Not yet | OAuth2 required |

## 📋 Available Tools

### CalDAV Tools

1. **list_calendars** - List all calendars
2. **list_events** - List all events (with optional time range filter)
3. **create_event** - Create new event
4. **update_event** - Update event
5. **delete_event** - Delete event

### CardDAV Tools

6. **list_addressbooks** - List all address books
7. **list_contacts** - List all contacts
8. **create_contact** - Create new contact
9. **update_contact** - Update contact
10. **delete_contact** - Delete contact

## 🛠️ Installation

```bash
# Install dependencies
npm install

# Configure .env file
cp .env.example .env
nano .env
```

## ⚙️ Configuration

Edit the `.env` file:

```env
# CalDAV/CardDAV Server
CALDAV_SERVER_URL=https://dav.example.com
CALDAV_USERNAME=your-username
CALDAV_PASSWORD=your-password-here

# MCP Server
PORT=3000
MCP_SERVER_NAME=tsdav-mcp-server
MCP_SERVER_VERSION=1.0.0

# Authentication (optional)
BEARER_TOKEN=your-secure-token-here
```

## 🔗 n8n Integration

### Step 1: Start MCP Server

Use Docker (recommended):
```bash
docker-compose up -d
```

Or run directly:
```bash
npm start
```

Server runs on: `http://localhost:3000`

### Step 2: Configure n8n AI Agent

1. **Add "MCP Client Tool" node** and configure:
   - **SSE Endpoint**: `http://localhost:3000/sse`
   - **Authentication**: `Bearer` (optional)
   - **Bearer Token**: From your `.env` file
   - **Tools**: "All tools from the MCP server"

2. **Connect AI Agent node** to the MCP Client Tool

3. **Use natural language** to interact with your calendar:
   - "List all my calendars"
   - "Create a meeting tomorrow at 2pm"
   - "Show me all events in October"

### Step 3: Example Tool Usage

#### Example 1: List calendars

```javascript
// Tool: list_calendars
// Input: {} (no parameters)
// Output: List of all calendars with URLs, names, colors
```

#### Example 2: Create event

```javascript
// Tool: create_event
// Input:
{
  "calendar_url": "https://dav.example.com/your-username/your-calendar-uuid/",
  "summary": "Team Meeting",
  "start_date": "2025-10-15T10:00:00.000Z",
  "end_date": "2025-10-15T11:00:00.000Z",
  "description": "Monthly team sync",
  "location": "Conference Room A"
}
```

#### Example 3: Get events with time range

```javascript
// Tool: list_events
// Input:
{
  "calendar_url": "https://dav.example.com/your-username/your-calendar-uuid/",
  "time_range_start": "2025-10-01T00:00:00.000Z",
  "time_range_end": "2025-10-31T23:59:59.999Z"
}
```

#### Example 4: Create contact

```javascript
// Tool: create_contact
// Input:
{
  "addressbook_url": "https://dav.example.com/your-username/your-addressbook-uuid/",
  "full_name": "John Doe",
  "family_name": "Doe",
  "given_name": "John",
  "email": "john.doe@example.com",
  "phone": "+1 234 567 8900",
  "organization": "Acme Corp"
}
```

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

### Option 3: Deploy on VPS/Cloud

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

1. **Never** commit credentials in code
2. **Always** keep `.env` in `.gitignore`
3. **Use HTTPS** for production
4. **Generate strong tokens** (min. 32 characters)
5. **Configure firewall** (open only necessary ports)

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

## 📊 Monitoring

The server automatically logs:
- New SSE connections
- Client IPs
- User agents
- Errors and exceptions

## 🐛 Troubleshooting

### Server doesn't start

```bash
# Port already in use?
lsof -i :3000

# Credentials correct?
cat .env
```

### n8n can't connect

1. Server running? → `curl http://localhost:3000/health`
2. Port accessible? → Check firewall
3. Bearer token correct? → Check `.env`
4. URL correct? → `http://localhost:3000/sse` (not `/messages`)

### Tools don't work

1. tsdav login successful? → Check server logs
2. Calendar/address book exists? → Verify URLs
3. Credentials correct? → Check `.env`

## 📚 Resources

- [tsdav Documentation](https://tsdav.vercel.app/docs/intro)
- [MCP Specification](https://modelcontextprotocol.io/specification/2025-03-26)
- [n8n MCP Client Docs](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/)

## 📄 License

MIT

## 🤝 Contributing

Pull requests are welcome!

## 💬 Support

For questions or issues, please create a GitHub issue.

---

**Made with ❤️ using tsdav and MCP**
