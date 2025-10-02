# tsdav MCP Server

MCP (Model Context Protocol) SSE Server für tsdav - CalDAV/CardDAV Integration für n8n und andere AI-Systeme.

## 🚀 Features

- **CalDAV Integration**: Vollständige Kalender- und Event-Verwaltung
- **CardDAV Integration**: Vollständige Adressbuch- und Kontaktverwaltung
- **MCP SSE Protocol**: Kompatibel mit n8n, Claude Desktop und anderen MCP-Clients
- **10 Tools**: Alle wichtigen CRUD-Operationen für Kalender und Kontakte
- **Bearer Auth**: Optional für sichere Verbindungen
- **Multi-Session**: Unterstützt mehrere gleichzeitige Client-Verbindungen

## 📋 Verfügbare Tools

### CalDAV Tools

1. **list_calendars** - Liste aller Kalender
2. **list_events** - Liste aller Events (mit optionalem Zeitbereich-Filter)
3. **create_event** - Neues Event erstellen
4. **update_event** - Event aktualisieren
5. **delete_event** - Event löschen

### CardDAV Tools

6. **list_addressbooks** - Liste aller Adressbücher
7. **list_contacts** - Liste aller Kontakte
8. **create_contact** - Neuen Kontakt erstellen
9. **update_contact** - Kontakt aktualisieren
10. **delete_contact** - Kontakt löschen

## 🛠️ Installation

```bash
# Dependencies installieren
npm install

# .env Datei konfigurieren
cp .env.example .env
nano .env

# Server starten
npm start

# Development mit Auto-Reload
npm run dev
```

## ⚙️ Konfiguration

Bearbeite die `.env` Datei:

```env
# CalDAV/CardDAV Server
CALDAV_SERVER_URL=https://dav.philflow.io
CALDAV_USERNAME=radicale_admin
CALDAV_PASSWORD=your-password-here

# MCP Server
PORT=3000
MCP_SERVER_NAME=tsdav-mcp-server
MCP_SERVER_VERSION=1.0.0

# Authentication (optional)
BEARER_TOKEN=your-secure-token-here
```

## 🔗 n8n Integration

### Schritt 1: MCP Server starten

```bash
npm start
```

Der Server läuft auf: `http://localhost:3000`

### Schritt 2: n8n MCP Client Node konfigurieren

1. **Füge den "MCP Client Tool" Node zu deinem Workflow hinzu**

2. **Konfiguriere die Verbindung:**
   - **SSE Endpoint**: `http://localhost:3000/sse`
   - **Authentication Method**: `Bearer` (optional)
   - **Bearer Token**: `secure-token-123456` (aus .env)

3. **Wähle die Tools aus:**
   - Option 1: "All tools from the MCP server"
   - Option 2: Spezifische Tools auswählen

### Schritt 3: Tools verwenden

#### Beispiel 1: Kalender auflisten

```javascript
// Tool: list_calendars
// Input: {} (keine Parameter)
// Output: Liste aller Kalender mit URLs, Namen, Farben
```

#### Beispiel 2: Event erstellen

```javascript
// Tool: create_event
// Input:
{
  "calendar_url": "https://dav.philflow.io/radicale_admin/cb829e7b-7bf8-26f0-3347-2ba1c0637c99/",
  "summary": "Team Meeting",
  "start_date": "2025-10-15T10:00:00.000Z",
  "end_date": "2025-10-15T11:00:00.000Z",
  "description": "Monatliches Team Meeting",
  "location": "Konferenzraum A"
}
```

#### Beispiel 3: Events mit Zeitbereich abrufen

```javascript
// Tool: list_events
// Input:
{
  "calendar_url": "https://dav.philflow.io/radicale_admin/cb829e7b-7bf8-26f0-3347-2ba1c0637c99/",
  "time_range_start": "2025-10-01T00:00:00.000Z",
  "time_range_end": "2025-10-31T23:59:59.999Z"
}
```

#### Beispiel 4: Kontakt erstellen

```javascript
// Tool: create_contact
// Input:
{
  "addressbook_url": "https://dav.philflow.io/radicale_admin/d89da3f2-e36d-e4d9-4969-d5e19a0f12a0/",
  "full_name": "John Doe",
  "family_name": "Doe",
  "given_name": "John",
  "email": "john.doe@example.com",
  "phone": "+49 123 456789",
  "organization": "Acme Corp"
}
```

### Schritt 4: Mit AI Agent verwenden

1. **Füge einen "AI Agent" Node hinzu**
2. **Verbinde den MCP Client Tool Node mit dem AI Agent**
3. **Der AI Agent kann jetzt natürlichsprachlich mit deinem Kalender interagieren:**

Beispiel-Prompts:
- "Liste alle meine Kalender auf"
- "Erstelle ein Meeting morgen um 14 Uhr"
- "Zeige mir alle Events im Oktober"
- "Erstelle einen neuen Kontakt für Max Mustermann"

## 🌐 Remote-Zugriff (für n8n Cloud)

Wenn dein n8n in der Cloud läuft, musst du den MCP Server öffentlich erreichbar machen:

### Option 1: ngrok (schnell für Tests)

```bash
# ngrok installieren und starten
ngrok http 3000
```

Verwende die ngrok URL in n8n: `https://xyz.ngrok.io/sse`

### Option 2: Reverse Proxy (Production)

Nginx/Caddy/Traefik Konfiguration mit HTTPS und Domain.

### Option 3: Deploy auf VPS/Cloud

- Docker Container
- PM2 für Process Management
- HTTPS mit Let's Encrypt

## 🔒 Sicherheit

### Bearer Token Authentication

In `.env` setzen:
```env
BEARER_TOKEN=your-very-secure-random-token-here
```

In n8n:
- Authentication Method: `Bearer`
- Token: `your-very-secure-random-token-here`

### Best Practices

1. **Niemals** Credentials in Code committen
2. **Immer** `.env` in `.gitignore`
3. **HTTPS** verwenden für Production
4. **Starke Tokens** generieren (min. 32 Zeichen)
5. **Firewall** konfigurieren (nur notwendige Ports öffnen)

## 🧪 Testen

### Health Check

```bash
curl http://localhost:3000/health
```

### Server Info

```bash
curl http://localhost:3000/
```

### SSE Connection testen

```bash
curl -H "Authorization: Bearer secure-token-123456" \
     -H "Accept: text/event-stream" \
     http://localhost:3000/sse
```

## 📊 Monitoring

Der Server loggt automatisch:
- Neue SSE Verbindungen
- Client IPs
- User-Agents
- Fehler und Exceptions

## 🐛 Troubleshooting

### Server startet nicht

```bash
# Port bereits belegt?
lsof -i :3000

# Credentials korrekt?
cat .env
```

### n8n kann nicht verbinden

1. Server läuft? → `curl http://localhost:3000/health`
2. Port erreichbar? → Firewall prüfen
3. Bearer Token korrekt? → `.env` prüfen
4. URL korrekt? → `http://localhost:3000/sse` (nicht `/messages`)

### Tools funktionieren nicht

1. tsdav Login erfolgreich? → Server Logs prüfen
2. Kalender/Adressbuch existiert? → URLs prüfen
3. Credentials korrekt? → `.env` prüfen

## 📚 Weitere Ressourcen

- [tsdav Dokumentation](https://tsdav.vercel.app/docs/intro)
- [MCP Spezifikation](https://modelcontextprotocol.io/specification/2025-03-26)
- [n8n MCP Client Docs](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/)

## 📄 Lizenz

MIT

## 🤝 Contributing

Pull Requests sind willkommen!

## 💬 Support

Bei Fragen oder Problemen, bitte ein GitHub Issue erstellen.

---

**Made with ❤️ using tsdav and MCP**
