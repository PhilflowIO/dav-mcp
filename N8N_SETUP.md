# n8n Setup Guide für tsdav MCP Server

Diese Anleitung zeigt dir Schritt-für-Schritt, wie du den tsdav MCP Server mit n8n verbindest.

## 📋 Voraussetzungen

- ✅ tsdav MCP Server läuft (`npm start`)
- ✅ n8n ist installiert und läuft
- ✅ n8n Version >= 1.70.0 (für MCP Support)

## 🔧 Schritt 1: MCP Server starten

```bash
cd /home/dave/Dokumente/projects/tsdav_mcp
npm start
```

**Überprüfen:**
```bash
curl http://localhost:3000/health
```

Erwartete Antwort:
```json
{
  "status": "healthy",
  "server": "tsdav-mcp-server",
  "version": "1.0.0",
  "timestamp": "2025-10-01T10:00:00.000Z"
}
```

## 🎯 Schritt 2: n8n Workflow erstellen

### 2.1 Neuen Workflow anlegen

1. Öffne n8n: `http://localhost:5678` (oder deine n8n URL)
2. Klicke auf "New Workflow"
3. Gib dem Workflow einen Namen: "CalDAV Test"

### 2.2 MCP Client Tool Node hinzufügen

1. Klicke auf das **+** Symbol
2. Suche nach **"MCP Client Tool"**
3. Wähle den Node aus

> **Hinweis:** Falls der Node nicht verfügbar ist, musst du eventuell die Environment Variable setzen:
> ```bash
> export N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true
> ```

### 2.3 MCP Client konfigurieren

**Connection Settings:**

| Feld | Wert |
|------|------|
| **Name** | tsdav-caldav |
| **SSE Endpoint** | `http://localhost:3000/sse` |
| **Authentication Method** | Bearer |
| **Bearer Token** | `secure-token-123456` |

**Tool Selection:**
- Wähle: "All tools from the MCP server"

**Klicke auf "Test"** - sollte erfolgreich sein!

## 🧪 Schritt 3: Ersten Test durchführen

### Test 1: Kalender auflisten

1. **Füge einen "Manual Trigger" Node hinzu**
2. **Füge einen "Code" Node hinzu** (optional für Datenverarbeitung)
3. **Verbinde die Nodes:** Manual Trigger → MCP Client Tool

**MCP Client Tool Konfiguration:**
- **Tool Name**: `list_calendars`
- **Parameters**: `{}` (leer)

**Workflow ausführen:**
- Klicke auf "Execute Workflow"
- Klicke auf "Run"

**Erwartete Ausgabe:**
```json
[
  {
    "displayName": "Privat",
    "url": "https://dav.philflow.io/radicale_admin/cb829e7b.../",
    "components": ["VEVENT"],
    "calendarColor": "#ca2634ff"
  }
]
```

### Test 2: Event erstellen

**Füge einen zweiten MCP Client Tool Node hinzu:**

**Konfiguration:**
- **Tool Name**: `create_event`
- **Parameters**:
```json
{
  "calendar_url": "https://dav.philflow.io/radicale_admin/cb829e7b-7bf8-26f0-3347-2ba1c0637c99/",
  "summary": "n8n Test Event",
  "start_date": "2025-10-15T14:00:00.000Z",
  "end_date": "2025-10-15T15:00:00.000Z",
  "description": "Erstellt über n8n MCP",
  "location": "Online"
}
```

**Workflow ausführen:**
- Event sollte erstellt werden
- Du bekommst URL und etag zurück

**Überprüfen:**
- Öffne deinen Kalender
- Das Event sollte sichtbar sein!

## 🤖 Schritt 4: Mit AI Agent verwenden

### 4.1 AI Agent Node hinzufügen

1. **Füge "AI Agent" Node hinzu**
2. **Wähle ein AI Model** (z.B. OpenAI, Anthropic, etc.)
3. **Konfiguriere das Model**

### 4.2 MCP Tools als Agent Tools verbinden

1. **Im AI Agent Node:**
   - Gehe zu "Tools"
   - Füge den "MCP Client Tool" hinzu
   - Wähle alle Tools aus

### 4.3 AI Agent testen

**Workflow Setup:**
```
Manual Trigger → AI Agent (mit MCP Tools)
```

**Beispiel Prompts:**

```
"Liste alle meine Kalender auf"
```

```
"Erstelle ein Meeting morgen um 10 Uhr mit dem Titel 'Stand-up' für 30 Minuten"
```

```
"Zeige mir alle Events diese Woche"
```

```
"Erstelle einen Kontakt für Max Mustermann mit Email max@example.com"
```

Der AI Agent wird automatisch die richtigen MCP Tools aufrufen!

## 🌐 Schritt 5: n8n Cloud Integration (Optional)

Falls dein n8n in der Cloud läuft, brauchst du einen öffentlichen Endpoint.

### Option A: ngrok (Schnell für Tests)

```bash
# ngrok installieren
npm install -g ngrok

# ngrok starten
ngrok http 3000
```

**Ausgabe:**
```
Forwarding https://abc123.ngrok.io -> http://localhost:3000
```

**In n8n verwenden:**
- SSE Endpoint: `https://abc123.ngrok.io/sse`

### Option B: Production Deployment

1. **Deploy auf einem VPS/Cloud Server**
2. **Reverse Proxy mit Nginx/Caddy**
3. **HTTPS mit Let's Encrypt**
4. **Domain verwenden:** `https://mcp.example.com/sse`

Beispiel Nginx Config:
```nginx
server {
    listen 443 ssl;
    server_name mcp.example.com;

    ssl_certificate /etc/letsencrypt/live/mcp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.example.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;

        # SSE spezifisch
        proxy_set_header X-Accel-Buffering no;
        proxy_buffering off;
    }
}
```

## 📊 Schritt 6: Erweiterte Workflows

### Workflow 1: Automatische Event-Erstellung aus Emails

```
Email Trigger → AI Agent (mit MCP) → Create Event
```

Der AI Agent analysiert die Email und erstellt automatisch Events.

### Workflow 2: Tägliche Event-Zusammenfassung

```
Schedule Trigger (täglich 8:00) → List Events (heute) → Format → Email senden
```

### Workflow 3: Kontakt-Synchronisation

```
Webhook Trigger → Create/Update Contact → Response
```

### Workflow 4: Kalender-Backup

```
Schedule Trigger (wöchentlich) → List Events → Save to Database/File
```

## 🐛 Troubleshooting

### Problem: "Connection failed"

**Lösung:**
1. Server läuft? → `curl http://localhost:3000/health`
2. Port erreichbar? → Firewall prüfen
3. URL korrekt? → Muss `/sse` am Ende haben

### Problem: "Unauthorized"

**Lösung:**
1. Bearer Token in `.env` gesetzt?
2. Token in n8n korrekt eingetragen?
3. Keine Leerzeichen im Token?

### Problem: "Tool not found"

**Lösung:**
1. Server neu starten
2. n8n Cache leeren (F5 im Browser)
3. Node neu konfigurieren

### Problem: "Invalid calendar URL"

**Lösung:**
1. Erst `list_calendars` ausführen
2. Komplette URL kopieren
3. URL muss mit `/` enden

## 💡 Best Practices

### 1. Error Handling

Füge "Error Trigger" Nodes hinzu um Fehler zu behandeln:

```
On Error → Log to File/Database → Send Notification
```

### 2. Logging

Verwende "Set" Nodes um Zwischenergebnisse zu speichern.

### 3. Credentials Management

- Speichere Bearer Token als n8n Credential
- Verwende Environment Variables

### 4. Rate Limiting

Implementiere Delays bei vielen Requests:
- Füge "Wait" Nodes hinzu
- Vermeide zu viele parallele Requests

## 📚 Beispiel-Workflows

### Minimal Workflow (Kalender auflisten)

```json
{
  "nodes": [
    {
      "name": "Manual Trigger",
      "type": "n8n-nodes-base.manualTrigger"
    },
    {
      "name": "List Calendars",
      "type": "n8n-nodes-langchain.toolMcp",
      "parameters": {
        "tool": "list_calendars"
      }
    }
  ]
}
```

## 🎓 Nächste Schritte

1. ✅ Teste alle 10 Tools einzeln
2. ✅ Erstelle einen AI Agent Workflow
3. ✅ Baue einen automatisierten Workflow
4. ✅ Deploy in Production (optional)
5. ✅ Teile deine Workflows mit der Community!

## 📞 Support

Bei Fragen:
1. Prüfe die Logs: Server Terminal
2. Prüfe n8n Workflow Logs
3. Teste mit `curl` ob Server erreichbar ist
4. Erstelle ein GitHub Issue

---

**Viel Erfolg! 🚀**
