# Helper-Funktionen Übersicht

Dieses Dokument beschreibt alle extrahierten Helper-Funktionen in `src/utils/tool-helpers.js`.

## Funktionen

### 1. escapeXml(text)
**Zweck:** XML-Sonderzeichen escapen (Sicherheit)  
**Parameter:** `text` (string) - Text zum Escapen  
**Returns:** XML-sicherer String  
**Verwendet in:** buildPropPatchXml

**Beispiel:**
```javascript
escapeXml('Foo & Bar <script>'); 
// → 'Foo &amp; Bar &lt;script&gt;'
```

---

### 2. getValidatedCalendar(client, calendarUrl)
**Zweck:** Calendar validieren und zurückgeben  
**Parameter:**
- `client` - CalDAV client instance
- `calendarUrl` - URL des Calendars

**Returns:** Calendar-Objekt  
**Throws:** Error wenn Calendar nicht gefunden  
**Verwendet in:** list_events, create_event, (weitere)

**Beispiel:**
```javascript
const calendar = await getValidatedCalendar(client, 'https://dav.example.com/cal/work/');
// → { url: '...', displayName: 'Work', ... }
```

---

### 3. getValidatedAddressBook(client, addressBookUrl)
**Zweck:** AddressBook validieren und zurückgeben  
**Parameter:**
- `client` - CardDAV client instance
- `addressBookUrl` - URL des AddressBooks

**Returns:** AddressBook-Objekt  
**Throws:** Error wenn AddressBook nicht gefunden  
**Verwendet in:** list_contacts, create_contact, addressbook_query

**Beispiel:**
```javascript
const addressBook = await getValidatedAddressBook(client, 'https://dav.example.com/card/contacts/');
// → { url: '...', displayName: 'Contacts', ... }
```

---

### 4. buildTimeRangeOptions(startDate, endDate)
**Zweck:** Zeitbereich-Optionen für CalDAV-Queries bauen  
**Parameter:**
- `startDate` (optional) - ISO 8601 Start-Datum
- `endDate` (optional) - ISO 8601 End-Datum

**Returns:** Options-Objekt mit timeRange Property  
**Logik:** Wenn nur start → end = start + 1 Jahr  
**Verwendet in:** list_events, calendar_query

**Beispiel:**
```javascript
// Beide Dates
buildTimeRangeOptions('2025-01-01T00:00:00.000Z', '2025-12-31T23:59:59.000Z')
// → { timeRange: { start: '2025-01-01...', end: '2025-12-31...' } }

// Nur Start (auto-extend)
buildTimeRangeOptions('2025-01-01T00:00:00.000Z', undefined)
// → { timeRange: { start: '2025-01-01...', end: '2026-01-01...' } }

// Keine Dates
buildTimeRangeOptions(undefined, undefined)
// → {}
```

---

### 5. searchMultipleCalendars(client, calendars, fetchOptions)
**Zweck:** Mehrere Calendars durchsuchen und Ergebnisse aggregieren  
**Parameter:**
- `client` - CalDAV client instance
- `calendars` - Array von Calendar-Objekten
- `fetchOptions` - Options für fetchCalendarObjects (z.B. timeRange)

**Returns:** Array von Events/Items mit `_calendarName` Property  
**Verwendet in:** calendar_query

**Beispiel:**
```javascript
const calendars = [workCal, homeCal, projectsCal];
const events = await searchMultipleCalendars(client, calendars, { timeRange: {...} });
// Jedes Event hat: event._calendarName = "Work Calendar"
```

---

### 6. searchMultipleTodoCalendars(client, calendars)
**Zweck:** Mehrere Calendars nach Todos durchsuchen  
**Parameter:**
- `client` - CalDAV client instance
- `calendars` - Array von Calendar-Objekten

**Returns:** Array von Todos mit `_calendarName` Property  
**Verwendet in:** todo_query

**Beispiel:**
```javascript
const todos = await searchMultipleTodoCalendars(client, [cal1, cal2]);
// Jedes Todo hat: todo._calendarName = "Work"
```

---

### 7. buildPropPatchXml(properties)
**Zweck:** WebDAV PROPPATCH XML für Calendar-Updates bauen  
**Parameter:** Object mit optional:
- `display_name` - Neuer Display-Name
- `description` - Neue Beschreibung
- `color` - Neue Farbe (Hex)
- `timezone` - Neue Timezone (z.B. "Europe/Berlin")

**Returns:** Complete PROPPATCH XML string  
**Throws:** Error bei invalider Timezone  
**Sicherheit:** Verwendet escapeXml()!  
**Verwendet in:** update_calendar

**Beispiel:**
```javascript
const xml = buildPropPatchXml({
  display_name: 'My Work & Projects',
  color: '#FF5733',
  timezone: 'Europe/Berlin'
});
// → <?xml version="1.0" ...><d:propertyupdate>...</d:propertyupdate>
```

---

### 8. applyFilters(items, filters, extractors)
**Zweck:** Generische Filter-Funktion mit case-insensitive matching  
**Parameter:**
- `items` - Array zu filtern
- `filters` - Object mit Filter-Werten (z.B. { summary_filter: 'meeting' })
- `extractors` - Object mit Regex-Pattern (z.B. { summary_filter: /SUMMARY:(.+)/ })

**Returns:** Gefiltertes Array  
**Verwendet in:** calendar_query, addressbook_query, todo_query

**Beispiel:**
```javascript
const filtered = applyFilters(
  events,
  { summary_filter: 'meeting', location_filter: 'room' },
  {
    summary_filter: /SUMMARY:(.+)/,
    location_filter: /LOCATION:(.+)/
  }
);
// → Nur Events mit "meeting" im Summary UND "room" in Location
```

---

### 9. resolveCalendarsToSearch(client, calendarUrl)
**Zweck:** Bestimmt welche Calendars durchsucht werden  
**Parameter:**
- `client` - CalDAV client instance
- `calendarUrl` (optional) - Spezifischer Calendar URL

**Returns:** Array von Calendars  
**Logik:**
- Wenn calendarUrl → [single calendar]
- Wenn undefined → [all calendars]

**Throws:** Error wenn spezifischer Calendar nicht gefunden  
**Verwendet in:** calendar_query, todo_query

**Beispiel:**
```javascript
// Spezifischer Calendar
const calendars = await resolveCalendarsToSearch(client, 'https://...');
// → [specificCalendar]

// Alle Calendars
const calendars = await resolveCalendarsToSearch(client, undefined);
// → [cal1, cal2, cal3, ...]
```

---

### 10. getCalendarDisplayName(calendars)
**Zweck:** Display-Name für Single/Multi-Calendar-Searches generieren  
**Parameter:** `calendars` - Array von Calendar-Objekten  
**Returns:** String für Anzeige  
**Verwendet in:** calendar_query, todo_query

**Beispiel:**
```javascript
getCalendarDisplayName([workCal])
// → "Work Calendar"

getCalendarDisplayName([workCal, homeCal, projectsCal])
// → "All Calendars (3)"
```

---

## Verwendungs-Statistik

| Funktion | Aufrufe | Verwendet in |
|----------|---------|--------------|
| escapeXml | intern | buildPropPatchXml |
| getValidatedCalendar | 3x | list_events, create_event, + 1 |
| getValidatedAddressBook | 3x | list_contacts, create_contact, addressbook_query |
| buildTimeRangeOptions | 2x | list_events, calendar_query |
| searchMultipleCalendars | 1x | calendar_query |
| searchMultipleTodoCalendars | 1x | todo_query |
| buildPropPatchXml | 1x | update_calendar |
| applyFilters | 3x | calendar_query, addressbook_query, todo_query |
| resolveCalendarsToSearch | 2x | calendar_query, todo_query |
| getCalendarDisplayName | 2x | calendar_query, todo_query |

## Best Practices

### Import
```javascript
import {
  getValidatedCalendar,
  buildTimeRangeOptions,
  applyFilters
} from './utils/tool-helpers.js';
```

### Error Handling
Alle Helper-Funktionen werfen beschreibende Errors mit Hilfe-Tipps:

```javascript
try {
  const calendar = await getValidatedCalendar(client, invalidUrl);
} catch (error) {
  // Error includes:
  // - Calendar not found: <url>
  // - Available calendar URLs: <list>
  // - Please use list_calendars first...
}
```

### JSDoc
Alle Funktionen haben vollständige JSDoc-Dokumentation:

```javascript
/**
 * Validates and retrieves a calendar by URL
 *
 * @param {Object} client - The CalDAV client instance
 * @param {string} calendarUrl - The URL of the calendar to find
 * @returns {Promise<Object>} The validated calendar object
 * @throws {Error} If calendar is not found with helpful error message
 *
 * @example
 * const calendar = await getValidatedCalendar(client, 'https://...');
 */
```

## Testing

### Unit-Test Beispiel
```javascript
describe('buildTimeRangeOptions', () => {
  it('should auto-extend to 1 year when only start provided', () => {
    const result = buildTimeRangeOptions('2025-01-01T00:00:00.000Z', undefined);
    expect(result.timeRange.end).toBe('2026-01-01T00:00:00.000Z');
  });
});
```

### Integration-Test
Die Helper-Funktionen werden indirekt durch die Handler-Tests getestet.
