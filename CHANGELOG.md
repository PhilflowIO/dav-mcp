# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Field-agnostic updates**: Integrated tsdav-utils for universal field update support
  - `update_event` now supports all RFC 5545 iCalendar properties (SUMMARY, DESCRIPTION, LOCATION, DTSTART, DTEND, STATUS, etc.)
  - `update_todo` now supports all RFC 5545 VTODO properties (SUMMARY, DESCRIPTION, STATUS, PRIORITY, DUE, PERCENT-COMPLETE, etc.)
  - `update_contact` now supports all RFC 6350 vCard properties (FN, N, EMAIL, TEL, ORG, TITLE, NOTE, URL, ADR, BDAY, etc.)
  - All update tools now accept custom X-* properties for extensions (e.g., X-ZOOM-LINK, X-MEETING-ROOM)
- Replaced manual iCal/vCard string manipulation with structured field updates via tsdav-utils
- Simplified update tool implementations (reduced code by 40-45% per tool)
- Updated input schemas to accept any RFC property name (field-agnostic validation)

### Added
- **New dependency**: tsdav-utils v0.1.0 for field-based calendar/contact operations
- Support for updating event locations (LOCATION field)
- Support for updating event date/time (DTSTART, DTEND fields)
- Support for updating event status (STATUS: TENTATIVE/CONFIRMED/CANCELLED)
- Support for updating todo status (STATUS: NEEDS-ACTION/IN-PROCESS/COMPLETED/CANCELLED)
- Support for updating todo priority (PRIORITY: 0-9)
- Support for updating todo due dates (DUE field)
- Support for updating todo completion percentage (PERCENT-COMPLETE: 0-100)
- Support for updating contact addresses (ADR field)
- Support for updating contact birthdays (BDAY field)
- Support for custom X-* properties across all update tools

### Dependencies
- Added: tsdav-utils (v0.1.0) - Field-agnostic utility layer for RFC-compliant updates

## [2.6.0] - Previous Release

Initial release with 26 MCP tools for CalDAV, CardDAV, and VTODO operations.

