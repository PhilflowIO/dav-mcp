✅ **Event updated successfully**

- **ETag**: "etag-after-update"
- **Message**: Updated 2 field(s): DTSTART, DTEND
- **Series**: series start DTSTART;TZID=Europe/Berlin:20260105T091500 -> DTSTART;TZID=Europe/Berlin:20260105T100000; moved along: 1 cancelled date (EXDATE)

---
<details>
<summary>Rohdaten (JSON)</summary>

```json
{
  "success": true,
  "etag": "\"etag-after-update\"",
  "updated_fields": [
    "DTSTART",
    "DTEND"
  ],
  "message": "Updated 2 field(s): DTSTART, DTEND",
  "series": {
    "summary": "series start DTSTART;TZID=Europe/Berlin:20260105T091500 -> DTSTART;TZID=Europe/Berlin:20260105T100000; moved along: 1 cancelled date (EXDATE)",
    "overrides_moved": 0,
    "exdates_moved": 1,
    "rdates_moved": 0,
    "dtstart": {
      "from": "DTSTART;TZID=Europe/Berlin:20260105T091500",
      "to": "DTSTART;TZID=Europe/Berlin:20260105T100000"
    }
  }
}
```
</details>
