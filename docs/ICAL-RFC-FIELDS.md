# iCalendar (RFC 5545) VEVENT Properties

## Core Properties (RFC 5545)

### Required
- **UID** - Unique identifier
- **DTSTAMP** - Timestamp when created/modified

### Date/Time
- **DTSTART** - Start date/time
- **DTEND** - End date/time (or DURATION)
- **DURATION** - Alternative to DTEND
- **CREATED** - Creation timestamp
- **LAST-MODIFIED** - Last modification timestamp

#### All-day events

An all-day event is a DTSTART/DTEND carrying a DATE value rather than a
DATE-TIME (RFC 5545 3.3.4), and its DTEND is **exclusive**:

```
DTSTART;VALUE=DATE:20260525
DTEND;VALUE=DATE:20260526
```

That is one day, 25 May. `create_event` and `update_event` take this form as a
bare `start_date`/`end_date` of `YYYY-MM-DD` (or an explicit `all_day: true`).

The `fields` map of `update_event` cannot express it: keys there are bare
property names, because a key carrying a parameter would append a second
DTSTART rather than replace the existing one. The dedicated
`start_date`/`end_date`/`all_day` parameters exist for exactly this reason.

### Text Properties
- **SUMMARY** - Title/Subject
- **DESCRIPTION** - Detailed description
- **LOCATION** - Location text
- **COMMENT** - Additional comments
- **CONTACT** - Contact information

### Classification & Status
- **CLASS** - PUBLIC, PRIVATE, CONFIDENTIAL
- **STATUS** - TENTATIVE, CONFIRMED, CANCELLED
- **TRANSP** - OPAQUE, TRANSPARENT (busy/free)
- **PRIORITY** - 0-9 (0=undefined, 1=highest)

### Recurrence
- **RRULE** - Recurrence rule
- **RDATE** - Recurrence dates
- **EXDATE** - Exception dates
- **RECURRENCE-ID** - ID for specific instance

### Relationships
- **RELATED-TO** - Related events
- **SEQUENCE** - Revision sequence number

### Attendees & Organizer
- **ORGANIZER** - Event organizer
- **ATTENDEE** - Participants (multiple)

### Attachments & Resources
- **ATTACH** - File attachments or URLs
- **RESOURCES** - Equipment/resources needed
- **CATEGORIES** - Category tags (multiple)

### Alarms
- **VALARM** component (nested)

### URLs
- **URL** - Associated URL

### Geographic
- **GEO** - Latitude;Longitude

## Extended Properties (RFC 7986) - 2016

- **COLOR** - CSS3 color
- **IMAGE** - Image URLs/data (multiple)
- **CONFERENCE** - Conference call info (multiple)
- **NAME** - Alternative name
- **REFRESH-INTERVAL** - Refresh suggestion

## Scheduling Extensions (RFC 6638)

- **SCHEDULE-AGENT** - SERVER, CLIENT, NONE
- **SCHEDULE-STATUS** - Delivery status
- **SCHEDULE-FORCE-SEND** - Force scheduling

## Event Publishing (RFC 9073) - 2021

- **PARTICIPANT** - Enhanced attendee info
- **VLOCATION** - Virtual location component
- **VRESOURCE** - Resource component
- **STRUCTURED-DATA** - JSON-LD data

## Vendor Extensions

### Microsoft/Outlook
- **X-MICROSOFT-CDO-BUSYSTATUS**
- **X-MICROSOFT-CDO-IMPORTANCE**
- **X-MICROSOFT-DISALLOW-COUNTER**

### Apple
- **X-APPLE-TRAVEL-ADVISORY-BEHAVIOR**
- **X-APPLE-STRUCTURED-LOCATION**

### Google
- **X-GOOGLE-CONFERENCE**
- **X-GOOGLE-HANGOUT**

## Common Non-Standard but Widely Used
- **X-ALT-DESC** - HTML description
- **X-MOZILLA-** prefixed properties
- **X-WR-** prefixed properties (calendar metadata)

## Support Matrix Considerations

Not all servers/clients support all properties:
- **Basic** (all support): UID, SUMMARY, DTSTART, DTEND, DESCRIPTION, LOCATION
- **Common** (most support): RRULE, STATUS, ORGANIZER, ATTENDEE
- **Advanced** (partial): COLOR, IMAGE, CONFERENCE, GEO
- **Rare** (limited): PARTICIPANT, STRUCTURED-DATA

## Timezone Properties (VTIMEZONE component)
- **TZID** - Timezone identifier
- **TZNAME** - Timezone name
- **TZOFFSETFROM** - UTC offset from
- **TZOFFSETTO** - UTC offset to
- **DTSTART** - Start of timezone rule
- **RRULE** - Recurrence for DST changes