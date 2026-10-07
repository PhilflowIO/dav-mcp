# Privacy Policy

_Last updated: 2026-10-07_

dav-mcp is open-source software that you run yourself. It connects an AI
assistant, such as Claude, to your own CalDAV/CardDAV server. The maintainers
of dav-mcp operate no service behind it: no account, no backend, no analytics.
This policy describes what the software does with your data.

## What data dav-mcp handles

- **Your server credentials**: the server URL, username and password (or, for
  Google, the OAuth client ID, client secret and refresh token) that you
  configure.
- **Your calendars, contacts and tasks**: the events, vCards and to-dos that a
  tool call reads from or writes to your server.

## How it is used

dav-mcp uses your credentials only to sign in to the server you configured. It
reads or writes calendar, contact and task data only when the assistant calls
one of its tools, and only to answer that call. The result of the call goes
back to the assistant that made it.

## Where it goes

- **Your DAV server.** dav-mcp sends requests only to the server you
  configured. With Google OAuth it also contacts Google's token endpoint to
  refresh the access token.
- **The AI assistant you connected.** Tool results become part of your
  conversation with that assistant. What happens to them there is governed by
  the assistant provider's privacy policy, for Claude
  [Anthropic's](https://www.anthropic.com/legal/privacy).
- **Nobody else.** dav-mcp has no telemetry, sends no usage data, and shares
  nothing with the maintainers or any third party.

Installing dav-mcp downloads the package from the npm registry and one
dependency from GitHub. That is a download of software, not a transfer of
your data.

## Storage and retention

dav-mcp keeps nothing between runs. Credentials stay in your configuration
(your MCP client's settings, a plugin's secure settings, or environment
variables) and in memory while the process runs. Calendar and contact data is
held in memory only for the duration of a tool call.

Two logs exist, both under your control:

- **Server log** (stderr): operational messages such as startup, the server
  URL and errors. It does not contain the contents of your calendars or
  contacts. Your MCP client decides whether and where it keeps stderr.
- **Tool-call log**: **off by default**. If you set `LOG_TOOL_CALLS=true`, every
  tool call is written with its arguments, which include calendar and contact
  data, to a file only your user account can read
  (`~/.local/state/dav-mcp/tool-calls.jsonl` by default). It is kept until you
  delete it.

## Self-hosted HTTP mode

If you or your organization run dav-mcp as an HTTP server, the operator of
that server controls its logs, network and retention. The statements above
describe the software; the operator is responsible for how they run it.

## Changes

Changes to this policy are made in this file and are visible in the
repository's history.

## Contact

Questions about privacy: [hello@philflow.io](mailto:hello@philflow.io) or a
[GitHub issue](https://github.com/PhilflowIO/dav-mcp/issues).
