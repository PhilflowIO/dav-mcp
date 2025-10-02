# n8n Verbindungsinformationen

## ✅ Server läuft erfolgreich!

Der MCP Server ist gestartet und funktioniert einwandfrei mit detailliertem Logging.

## 🔗 Verbindungs-URLs

### Localhost (wenn n8n auf dem gleichen Rechner läuft):
```
http://localhost:3000/sse
```

### Lokales Netzwerk (wenn n8n auf anderem Rechner):
```
http://[DEINE-IP]:3000/sse
```

**Finde deine IP mit:**
```bash
ip addr show
# oder
ifconfig
```

## 📋 n8n Konfiguration

### Schritt 1: MCP Client Tool Node hinzufügen

1. Neuer Workflow in n8n
2. **"+"** klicken
3. Nach **"MCP Client Tool"** suchen
4. Node hinzufügen

### Schritt 2: Verbindung konfigurieren

**Credentials / Connection:**
- **Name**: tsdav-caldav-local
- **SSE Endpoint**: `http://localhost:3000/sse` (oder deine IP)
- **Authentication**: `None` / Keine

**Node Settings:**
- **Tools**: "All tools from the MCP server" auswählen
- Oder spezifische Tools auswählen

### Schritt 3: Testen

**Test 1: Verbindungstest**
- Klicke auf "Test Connection" im Node
- Sollte erfolgreich sein

**Test 2: Tool ausführen**
- Manual Trigger Node → MCP Client Tool
- Tool: `list_calendars`
- Execute Workflow
- Sollte deine Kalender auflisten

## 🐛 Debugging

### Server Logs anschauen

Die Konsole zeigt jetzt detaillierte Logs:

```
📡 New SSE connection: session-xxx
   ✓ SSE headers set
   ✓ MCP Server created
   ✓ Transport created
   ✓ MCP server connected successfully!

[session-xxx] 📋 tools/list request received
[session-xxx] ✓ Returning 10 tools

[session-xxx] 🔧 tools/call request: list_calendars
[session-xxx]    Executing tool...
[session-xxx] ✓ Tool executed successfully
```

### Typische Probleme

**Problem: "Cannot connect"**

**Lösung:**
1. Server läuft? → `curl http://localhost:3000/health`
2. Firewall? → Port 3000 öffnen
3. Richtige URL? → Muss `/sse` am Ende haben
4. Netzwerk? → IP statt localhost versuchen

**Problem: "Connection timeout"**

**Lösung:**
1. Server Logs prüfen (siehe oben)
2. n8n Timeout erhöhen in Settings
3. Netzwerk-Verbindung prüfen

**Problem: "Tools nicht verfügbar"**

**Lösung:**
1. Server neu starten
2. n8n Node neu konfigurieren
3. Browser Cache leeren (F5)

## 📊 Verfügbare Tools (10 Stück)

### CalDAV (5 Tools)
1. **list_calendars** - Alle Kalender auflisten
2. **list_events** - Events aus Kalender (mit Zeitfilter)
3. **create_event** - Neues Event erstellen
4. **update_event** - Event bearbeiten
5. **delete_event** - Event löschen

### CardDAV (5 Tools)
6. **list_addressbooks** - Adressbücher auflisten
7. **list_contacts** - Kontakte auflisten
8. **create_contact** - Kontakt erstellen
9. **update_contact** - Kontakt bearbeiten
10. **delete_contact** - Kontakt löschen

## 🧪 Test-Beispiele

### Beispiel 1: Kalender auflisten

**Node:** MCP Client Tool
- **Tool**: `list_calendars`
- **Arguments**: `{}` (leer)

**Ergebnis:**
```json
[
  {
    "displayName": "Privat",
    "url": "https://dav.philflow.io/radicale_admin/...",
    "components": ["VEVENT"],
    "calendarColor": "#ca2634ff"
  }
]
```

### Beispiel 2: Event erstellen

**Node:** MCP Client Tool
- **Tool**: `create_event`
- **Arguments**:
```json
{
  "calendar_url": "https://dav.philflow.io/radicale_admin/cb829e7b-7bf8-26f0-3347-2ba1c0637c99/",
  "summary": "Test von n8n",
  "start_date": "2025-10-15T10:00:00.000Z",
  "end_date": "2025-10-15T11:00:00.000Z",
  "description": "Erstellt über n8n MCP",
  "location": "Büro"
}
```

**Ergebnis:**
```json
{
  "success": true,
  "url": "https://dav.philflow.io/.../event-123.ics",
  "etag": "..."
}
```

### Beispiel 3: Events filtern nach Datum

**Node:** MCP Client Tool
- **Tool**: `list_events`
- **Arguments**:
```json
{
  "calendar_url": "https://dav.philflow.io/radicale_admin/cb829e7b-7bf8-26f0-3347-2ba1c0637c99/",
  "time_range_start": "2025-10-01T00:00:00.000Z",
  "time_range_end": "2025-10-31T23:59:59.999Z"
}
```

## 💡 Tipps

1. **Erst `list_calendars` aufrufen** um die calendar_url zu bekommen
2. **Erst `list_addressbooks` aufrufen** um die addressbook_url zu bekommen
3. **ISO 8601 Datumsformat** verwenden: `2025-10-15T10:00:00.000Z`
4. **Server Logs beobachten** für Debugging
5. **Test Connection** Button in n8n nutzen

## 🔧 Server Management

### Server stoppen
```bash
pkill -f "node src/index.js"
```

### Server starten
```bash
npm start
```

### Server mit Auto-Reload (Development)
```bash
npm run dev
```

### Server Logs in Echtzeit
Die Konsole zeigt alle Requests und Responses.

## 📞 Support

Bei Problemen:
1. ✅ Server Logs prüfen
2. ✅ n8n Browser Console öffnen (F12)
3. ✅ `curl http://localhost:3000/health` testen
4. ✅ `curl http://localhost:3000/sse` testen

---

**Server läuft! Jetzt n8n verbinden! 🚀**
