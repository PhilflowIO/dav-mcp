# dav-mcp for Claude

Your calendar, your contacts and your to-do list, on your own server, now in
conversation with Claude. Ask "when am I free on Thursday?", "move the
dentist to next week", "who do I know at Acme?" or "what's still open for the
launch?" and Claude answers from, and acts on, the data you already keep in
Nextcloud, iCloud, Baikal, Radicale or any other CalDAV/CardDAV server. No
new account, no sync service in between: Claude talks to the server you
already trust.

The plugin brings two things:

- **The dav-mcp server**, 27 tools to search, create, update and delete
  events, contacts (vCard) and to-dos (VTODO), manage calendars, and answer
  free/busy questions.
- **A skill** that teaches Claude to use them well: search instead of listing
  everything, get time zones and all-day events right, read before it writes,
  and confirm before it deletes.

Every tool says what it does to your data: read-only lookups are marked
read-only, and tools that overwrite or delete are marked destructive, so your
Claude Code permission settings can let lookups through and stop changes for
your approval.

## Setup

When you enable the plugin, Claude Code asks for:

| Setting | What to enter |
|---|---|
| Server URL | Your server's DAV address, e.g. `https://cloud.example.com/remote.php/dav/` for Nextcloud, `https://caldav.icloud.com/` for iCloud, `https://dav.example.com/dav.php/` for Baikal |
| Username | Your username on that server |
| Password | Your password, or an app-specific password (required for iCloud, recommended for Nextcloud) |
| Authentication method | `Basic` works almost everywhere. Choose `Digest` if your server only accepts Digest and the connection isn't HTTPS |

The password is kept in your system's secure credential store, not in a
settings file. Change any value later with `/config`.

Google Calendar uses OAuth instead of a password; set it up with the manual
configuration in the [main README](https://github.com/PhilflowIO/dav-mcp#google-calendar-oauth2).

## Requirements

- Claude Code (the plugin's server runs on your computer)
- Node.js 18 or newer (20 or newer for `Digest`), with `npx` on your `PATH`

## What runs and where data goes

On first use, the plugin runs `npx -y dav-mcp@<version>`, which downloads that
exact version of [dav-mcp](https://www.npmjs.com/package/dav-mcp) from the npm
registry, and one of its dependencies from GitHub, and starts it on your
computer. The server connects only to the DAV server you configured. Results
of tool calls go back to Claude as part of your conversation. dav-mcp has no
telemetry and sends nothing to its maintainers or anyone else.

## Privacy Policy

dav-mcp stores nothing between runs and keeps no log of your calendar or
contact data unless you turn one on. The full policy, covering collection,
use, storage, sharing and retention, is in
[PRIVACY.md](https://github.com/PhilflowIO/dav-mcp/blob/main/PRIVACY.md).

## Support

Questions and bugs: [GitHub issues](https://github.com/PhilflowIO/dav-mcp/issues)
or [hello@philflow.io](mailto:hello@philflow.io).

## License

MIT, see [LICENSE](LICENSE).
