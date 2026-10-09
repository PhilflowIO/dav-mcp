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
| `AUTH_METHOD` | `Basic`, `Digest` or `OAuth` | No (default: Basic) |
| `BEARER_TOKEN` | API authentication token | Yes (HTTP server) |
| `PORT` | HTTP server port | No (default: 3000) |

## Upgrading: `AUTH_METHOD` is now checked

Up to 4.0.1 only the exact values `OAuth` and `Oauth` selected OAuth2; every
other value, including a typo, silently ran Basic. Now:

- The value is case-insensitive, and surrounding quotes or spaces are ignored
  (`AUTH_METHOD="Basic"` from a Docker env file is fine).
- `Digest` is a valid value (see the README).
- `oauth`, `oauth2` and `OAuth2` now select OAuth2. If you had one of these set
  while actually using `CALDAV_*` credentials, the server used to run Basic and
  now stops at startup asking for `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
  and `GOOGLE_REFRESH_TOKEN`. Set `AUTH_METHOD=Basic` or remove the variable.
- Any other value stops the server at startup with the list of valid values.

## Upgrading to 5.0: Node.js 22 or newer

Up to 4.x dav-mcp ran on Node.js 18 or newer. Node.js 18 and 20 are
end-of-life, and dav-mcp's own dependencies already required Node.js 20. Now:

- `npm install dav-mcp` and `npx dav-mcp` need Node.js 22 or newer. Check with
  `node --version`; on an older version npm warns about the engine range, and
  dav-mcp is neither tested nor supported there.
- The workarounds for Node.js 18 are gone, including the startup error for
  Digest-only servers on a runtime without WebCrypto.
- The MCP Bundle (`.mcpb`) declares Node.js 22 or newer as well; Claude
  Desktop checks that range when it installs the bundle.
- The Docker image already runs on Node.js 22; nothing changes there.

If you run dav-mcp with `npx` or a global install, update Node.js to 22 or
newer (for example from [nodejs.org](https://nodejs.org)) before updating
dav-mcp.

## Need Help?

- Open an issue: https://github.com/PhilflowIO/dav-mcp/issues
