# Migration Guide: MCP Transports

This guide helps you set up dav-mcp with the modern STDIO or Streamable HTTP transports.

## Available Transports

| Feature | STDIO | Streamable HTTP |
|---------|-------|-----------------|
| Use Case | Local clients | Remote/cloud |
| Network | None (stdin/stdout) | HTTP/HTTPS |
| Security | Highest | High |
| Clients | Claude Desktop, Cursor | n8n, cloud apps |
| Endpoints | N/A | Single `/mcp` |

> **Note**: HTTP+SSE transport is no longer supported. Use STDIO or Streamable HTTP.

## Local Clients (Claude Desktop, Cursor)

### Claude Desktop Configuration
```json
{
  "mcpServers": {
    "dav-mcp": {
      "command": "node",
      "args": ["/path/to/dav-mcp/src/server-stdio.js"],
      "env": {
        "CALDAV_SERVER_URL": "https://your-caldav-server.com/dav",
        "CALDAV_USERNAME": "your-username",
        "CALDAV_PASSWORD": "your-password"
      }
    }
  }
}
```

### Via npx (after npm publish)
```json
{
  "mcpServers": {
    "dav-mcp": {
      "command": "npx",
      "args": ["dav-mcp"],
      "env": {
        "CALDAV_SERVER_URL": "https://your-caldav-server.com/dav",
        "CALDAV_USERNAME": "your-username",
        "CALDAV_PASSWORD": "your-password"
      }
    }
  }
}
```

## Remote Clients (n8n)

### Start the Streamable HTTP Server
```bash
npm run start:http
```

### n8n MCP Configuration
```
MCP Server URL: http://localhost:3000/mcp
Authorization: Bearer YOUR_BEARER_TOKEN
```

The HTTP server runs in stateless mode - each request is independent.

## OAuth2 (Google Calendar)

```bash
AUTH_METHOD=OAuth
GOOGLE_USER=your-email@gmail.com
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REFRESH_TOKEN=your-refresh-token
```

## Starting the Servers

```bash
# STDIO (default, for local clients)
npm start
npm run start:stdio

# Streamable HTTP (for remote clients)
npm run start:http

# Development mode
npm run dev        # STDIO with watch
npm run dev:http   # HTTP with watch
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `CALDAV_SERVER_URL` | CalDAV server URL | Yes (Basic Auth) |
| `CALDAV_USERNAME` | CalDAV username | Yes (Basic Auth) |
| `CALDAV_PASSWORD` | CalDAV password | Yes (Basic Auth) |
| `AUTH_METHOD` | `Basic` or `OAuth` | No (default: Basic) |
| `BEARER_TOKEN` | API authentication token | Yes (HTTP server) |
| `PORT` | HTTP server port | No (default: 3000) |

## Need Help?

- Open an issue: https://github.com/PhilflowIO/dav-mcp/issues
