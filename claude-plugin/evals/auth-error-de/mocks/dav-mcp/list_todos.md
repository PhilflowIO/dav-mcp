---
error: true
---
{
  "code": -32003,
  "message": "Login to https://dav.example.com/remote.php/dav/ failed: Invalid credentials: PROPFIND https://dav.example.com/remote.php/dav/ returned 401 Unauthorized. Check the server URL, username and password where dav-mcp was set up: Claude Code plugin: /plugin → Installed → dav-mcp → Configure options; Claude Desktop extension: Settings → Extensions → dav-mcp; npx, Docker or a checkout: CALDAV_SERVER_URL, CALDAV_USERNAME and CALDAV_PASSWORD (the MCP client's config, docker -e, or .env).",
  "data": {
    "type": "AuthenticationError",
    "details": {
      "serverUrl": "https://dav.example.com/remote.php/dav/",
      "status": 401
    }
  }
}
