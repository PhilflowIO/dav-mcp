# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.7.0] - 2025-10-30

### Added
- **OAuth2 Authentication Support**: Full OAuth2 support for Google Calendar and other OAuth2-enabled CalDAV servers
  - New `AUTH_METHOD` environment variable to switch between Basic Auth and OAuth2
  - Support for Google Calendar via OAuth2 with automatic token refresh
  - CalDAV discovery via RFC 4791 (no Google Calendar API required)
  - Tested with Google Calendar (5 calendars discovered and fully functional)
  - All CRUD operations (Create, Read, Update, Delete) working with OAuth2
- OAuth2 test suite with 10 comprehensive test cases
- OAuth2 configuration in `.env.example` with detailed setup instructions

### Changed
- **Field-agnostic updates**: Integrated tsdav-utils for universal field update support
  - `update_event` now supports all RFC 5545 iCalendar properties (SUMMARY, DESCRIPTION, LOCATION, DTSTART, DTEND, STATUS, etc.)
  - `update_todo` now supports all RFC 5545 VTODO properties (SUMMARY, DESCRIPTION, STATUS, PRIORITY, DUE, PERCENT-COMPLETE, etc.)
  - `update_contact` now supports all RFC 6350 vCard properties (FN, N, EMAIL, TEL, ORG, TITLE, NOTE, URL, ADR, BDAY, etc.)
  - All update tools now accept custom X-* properties for extensions (e.g., X-ZOOM-LINK, X-MEETING-ROOM)
- Replaced manual iCal/vCard string manipulation with structured field updates via tsdav-utils
- Simplified update tool implementations (reduced code by 40-45% per tool)
- Updated input schemas to accept any RFC property name (field-agnostic validation)
- Enhanced `tsdav-client.js` to support both Basic Auth and OAuth2 authentication methods
- Updated `index.js` initialization logic to auto-detect authentication method

### Dependencies
- Added: tsdav-utils (v0.1.0) - Field-agnostic utility layer for RFC-compliant updates

### Compatibility
- Fully backward compatible with existing Basic Auth setup
- No breaking changes - existing configurations continue to work
- Google Calendar tested and verified with OAuth2

## [2.6.0] - Previous Release

Initial release with 26 MCP tools for CalDAV, CardDAV, and VTODO operations.

