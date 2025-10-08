# tsdav-mcp-server Development Roadmap

This document outlines the planned development phases for tsdav-mcp-server, a production-ready MCP (Model Context Protocol) server for CalDAV/CardDAV/VTODO integration.

**Current Version:** 1.2.1
**Last Updated:** 2025-10-07

---

## Version History

### v1.2.1 - Automated Test Suite (Current)
**Status:** In Progress
**Released:** TBD

**Focus:** LLM Tool Selection Validation

**Completed:**
- ✅ Comprehensive test case library (55 test cases)
- ✅ MCP test runner with 5x repetition for reliability
- ✅ n8n webhook integration for LLM testing
- ✅ Test data generator for realistic integration tests
- ✅ HTML report generation

**Deliverables:**
- `tests/integration/test-cases.json` - 55 test cases covering CalDAV, CardDAV, VTODO, and edge cases
- `tests/integration/mcp-test-runner.js` - Automated test runner with 80% success threshold
- `tests/integration/setup-test-data.js` - Real test data generator
- Package scripts: `npm run test:integration`, `npm run test:setup-data`

**Why This Matters:**
Initial testing revealed LLMs frequently select wrong tools (e.g., `list_events` instead of `calendar_query`). This test suite validates tool selection accuracy and guides optimization.

---

### v1.2.0 - VTODO Support
**Status:** Completed
**Released:** 2025-10-07

**Focus:** Task/Todo Management

**Delivered:**
- ✅ 6 new VTODO tools (list_todos, create_todo, update_todo, delete_todo, todo_query, todo_multi_get)
- ✅ ical.js integration for VTODO parsing
- ✅ Markdown formatters with emoji status indicators
- ✅ Full validation schemas for all todo operations
- ✅ 23 total tools (10 CalDAV + 7 CardDAV + 6 VTODO)

**Coverage:** ~97% tsdav API (23/24 methods - missing only syncCalendars)

---

### v1.1.0 - Docker Production Deployment
**Status:** Completed
**Released:** 2025-10-02

**Focus:** Production Infrastructure

**Delivered:**
- ✅ Multi-stage Dockerfile with security hardening
- ✅ Traefik integration with SSL/TLS
- ✅ Health checks and graceful shutdown
- ✅ Non-root user (UID 1000)
- ✅ Deployment in separate private repo (tsdav-mcp-deployment)

**Note:** Deployment files kept private to protect infrastructure configuration.

---

### v1.0.0 - Production Ready
**Status:** Completed
**Released:** 2025-10-01

**Focus:** Security & Production Hardening

**Delivered:**
- ✅ 17 MCP tools (10 CalDAV + 7 CardDAV)
- ✅ Input validation with Zod schemas
- ✅ Rate limiting and CORS
- ✅ Structured logging with Pino
- ✅ Session management for SSE
- ✅ Bearer token authentication
- ✅ 35 passing tests
- ✅ LLM token optimization (PREFERRED/WARNING labels)

---

## Planned Development

### v1.2.2 - Tool Optimization (PRIORITY)
**Status:** Planned
**Estimated Effort:** 6-8 hours
**Target:** Q4 2025

**Goals:**
1. Analyze test results from v1.2.1
2. Optimize tool descriptions based on failure patterns
3. Add more explicit use case examples
4. Improve parameter descriptions
5. Re-run tests to validate improvements

**Success Criteria:**
- 90%+ tool selection accuracy on test suite
- Reduced ambiguity in tool descriptions
- Fewer "common mistakes" in test results

**Deliverables:**
- Updated tool descriptions in `src/tools.js`
- Test result comparison report
- Documentation updates

---

### v1.3.0 - ical.js Full Integration
**Status:** Planned
**Estimated Effort:** 8-10 hours
**Target:** Q4 2025

**Goals:**
1. Replace manual iCal string building with ical.js
2. Add support for advanced iCal features:
   - RRULE (recurring events/todos)
   - VALARM (alarms/reminders)
   - ATTENDEES (meeting participants)
   - EXDATE/RDATE (exception dates)
3. Improve parsing robustness
4. Add validation for iCal data

**Why This Matters:**
Current implementation builds iCal strings manually, which is error-prone. ical.js provides RFC 5545 compliance and handles edge cases.

**Deliverables:**
- Updated event/todo handlers using ical.js
- Support for recurring events/todos
- Alarm/reminder support
- Attendee management tools
- Comprehensive ical.js tests

---

### v1.4.0 - Advanced Calendar Management
**Status:** Planned
**Estimated Effort:** 6-8 hours
**Target:** Q1 2026

**Goals:**
1. Add `sync_calendars` tool (final missing tsdav method)
2. Implement calendar-level operations:
   - Update calendar properties (color, description, timezone)
   - Delete calendars
   - Calendar sharing/permissions (if supported by server)
3. Add bulk operations:
   - `create_events` (plural) - batch create
   - `update_events` (plural) - batch update
   - `delete_events` (plural) - batch delete
4. Pagination for large result sets

**Success Criteria:**
- 100% tsdav API coverage (24/24 methods)
- Efficient bulk operations
- Calendar management parity with native apps

**Deliverables:**
- sync_calendars tool with change detection
- Calendar update/delete tools
- Bulk operation tools
- Pagination support

---

### v1.5.0 - Multi-Account Support
**Status:** Planned
**Estimated Effort:** 12-16 hours
**Target:** Q1 2026

**Goals:**
1. Support multiple DAV accounts simultaneously
2. Account manager refactor (singleton → multi-instance)
3. OAuth2 support for Google Calendar, Microsoft 365, FastMail
4. Account-level tool parameters

**Current Limitation:**
Only 1 provider/account at a time due to singleton client architecture.

**Implementation:**
- Refactor `tsdav-client.js` to support multiple clients
- Add `account_id` parameter to all tools
- Implement OAuth2 token refresh logic
- Provider-specific configurations
- Multi-account config in .env

**Success Criteria:**
- Manage 3+ accounts simultaneously
- OAuth2 working for Google/Microsoft
- Seamless account switching

**Deliverables:**
- Multi-account client manager
- OAuth2 integration (Google, Microsoft, FastMail)
- Updated tool schemas with account_id
- Multi-account documentation

---

### v1.6.0 - Real-time Sync & Webhooks
**Status:** Planned
**Estimated Effort:** 16-20 hours
**Target:** Q2 2026

**Goals:**
1. WebSocket support for real-time calendar updates
2. Webhook notifications for calendar changes
3. Push sync (server → client)
4. Conflict resolution strategies
5. Offline support with local caching

**Use Cases:**
- Real-time calendar updates in AI assistants
- Proactive notifications ("Your meeting starts in 10 minutes")
- Multi-device sync without polling

**Challenges:**
- Not all CalDAV servers support push notifications
- WebSocket scalability
- State management

**Deliverables:**
- WebSocket transport for MCP
- Webhook endpoint for calendar changes
- Push notification support
- Conflict resolution logic
- Local cache layer

---

### v2.0.0 - TypeScript Migration
**Status:** Planned
**Estimated Effort:** 20-30 hours
**Target:** Q3 2026

**Goals:**
1. Full TypeScript conversion
2. Type-safe tool definitions
3. Auto-generated type declarations
4. Improved IDE support
5. Better error detection

**Breaking Changes:**
- May require ESM module updates
- Type definitions may change APIs
- Build process changes

**Success Criteria:**
- 100% TypeScript coverage
- Zero `any` types
- Full type inference
- Type-safe MCP SDK integration

**Deliverables:**
- TypeScript source in `src/`
- Type declaration files
- Build tooling (tsc)
- Updated documentation
- Migration guide

---

## Phase 7 (Previously Planned) - CI/CD Pipeline

**Status:** Deferred
**Reason:** Prioritizing tool optimization and feature completeness first

**Will Include:**
- GitHub Actions workflows
- Automated Docker builds
- GHCR (GitHub Container Registry) integration
- Cross-repo deployment triggers
- Automated health checks
- Rollback capabilities

**Planned for:** Post v2.0.0

---

## Provider Support Roadmap

| Provider | Current Status | Target Version |
|----------|---------------|----------------|
| **Nextcloud** | ✅ Supported | v1.0.0+ |
| **Radicale** | ✅ Supported | v1.0.0+ |
| **Baikal** | ✅ Supported | v1.0.0+ |
| **iCloud** | ✅ Supported (Basic Auth + App Password) | v1.0.0+ |
| **Google Calendar** | ❌ Not Yet (OAuth2 required) | v1.5.0 |
| **Microsoft 365** | ❌ Not Yet (OAuth2 required) | v1.5.0 |
| **FastMail** | ❌ Not Yet (OAuth2 required) | v1.5.0 |
| **Generic CalDAV** | ✅ Supported (Basic Auth) | v1.0.0+ |

---

## Feature Requests & Community Feedback

**How to Submit:**
- GitHub Issues: https://github.com/PhilflowIO/tsdav-mcp-server/issues
- Label: `enhancement` or `feature-request`

**Under Consideration:**
- CalDAV server discovery (DNS SRV records)
- Calendar export/import (iCal file format)
- Email invitations (VEVENT with MAILTO)
- Custom property support (X-* extensions)
- Server capability detection
- Offline-first architecture

---

## Development Principles

1. **LLM-First Design** - Tool descriptions optimized for AI understanding
2. **Security by Default** - Input validation, rate limiting, secure defaults
3. **Production Ready** - Every release must be production-grade
4. **Backward Compatibility** - Avoid breaking changes where possible
5. **Comprehensive Testing** - Both unit and integration tests required
6. **Real-World Usage** - Test with actual CalDAV servers (Radicale, Nextcloud)
7. **Documentation Excellence** - Keep README simple, CLAUDE.md technical

---

## Contributing

Want to help shape the roadmap?

1. **Test v1.2.1** - Run integration tests and report accuracy results
2. **Tool Optimization** - Submit improved tool descriptions
3. **Feature Requests** - Open GitHub issues with use cases
4. **Provider Testing** - Test with different CalDAV servers
5. **Bug Reports** - Help identify edge cases

See `CONTRIBUTING.md` for details (coming soon).

---

## Questions?

- GitHub Issues: https://github.com/PhilflowIO/tsdav-mcp-server/issues
- Documentation: See `README.md` and `CLAUDE.md`

---

**Last Updated:** 2025-10-07
**Maintained By:** PhilflowIO
**License:** MIT
