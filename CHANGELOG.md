# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-10-01

### Added
- Initial release of tsdav-mcp-server
- MCP SSE server for CalDAV/CardDAV integration
- 10 MCP tools for calendar and contact management:
  - CalDAV: list_calendars, list_events, create_event, update_event, delete_event
  - CardDAV: list_addressbooks, list_contacts, create_contact, update_contact, delete_contact
- Bearer token authentication with timing-safe comparison
- CORS configuration with allowed origins
- Rate limiting for API endpoints (100 req/15min)
- Input validation with Zod schemas
- Structured logging with Pino
- MCP-compliant error handling with standard error codes
- Support for both SSE and stdio transports
- n8n integration support
- Environment-based configuration
- Health check endpoint
- Request/session ID tracing

### Security
- Timing-safe Bearer token comparison
- Input sanitization for iCal/vCard strings
- Stack trace hiding in production
- Secure credential handling
- CORS protection
- Rate limiting

[0.1.0]: https://github.com/yourusername/tsdav-mcp-server/releases/tag/v0.1.0
