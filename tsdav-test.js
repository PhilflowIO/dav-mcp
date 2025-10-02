const { DAVClient } = require('tsdav');

const client = new DAVClient({
  serverUrl: 'https://dav.philflow.io',  // HTTPS statt HTTP!
  credentials: {
    username: 'radicale_admin',
    password: 'oUqlTTH5FHrX2-6n12HzV-tTbpIE6Kmz',
  },
  authMethod: 'Basic',
  defaultAccountType: 'caldav',
});

(async () => {
  try {
    await client.login();
    console.log('✓ Login erfolgreich!');

    const calendars = await client.fetchCalendars();
    console.log(`\n✓ ${calendars.length} Kalender gefunden:\n`);

    calendars.forEach(cal => {
      console.log(`📅 ${cal.displayName}`);
      console.log(`   URL: ${cal.url}`);
      console.log(`   Farbe: ${cal.calendarColor}`);
      console.log(`   Komponenten: ${cal.components.join(', ')}\n`);
    });

  } catch (error) {
    console.error('❌ Fehler:', error.message);
  }
})();