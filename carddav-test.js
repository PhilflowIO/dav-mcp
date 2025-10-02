const { DAVClient } = require('tsdav');

const client = new DAVClient({
  serverUrl: 'https://dav.philflow.io',
  credentials: {
    username: 'radicale_admin',
    password: 'oUqlTTH5FHrX2-6n12HzV-tTbpIE6Kmz',
  },
  authMethod: 'Basic',
  defaultAccountType: 'carddav',  // CardDAV für Adressbücher
});

async function testCardDAV() {
  try {
    console.log('=== CARDDAV Vollständiger Test ===\n');

    // ========================================
    // 1. LOGIN
    // ========================================
    console.log('📝 1. LOGIN (CardDAV)');
    await client.login();
    console.log('   ✓ Login erfolgreich!\n');

    // ========================================
    // 2. ADRESSBÜCHER ABRUFEN
    // ========================================
    console.log('📝 2. ADRESSBÜCHER ABRUFEN');
    const addressBooks = await client.fetchAddressBooks();
    console.log(`   ✓ ${addressBooks.length} Adressbücher gefunden:`);
    addressBooks.forEach((ab, i) => {
      console.log(`   ${i + 1}. ${ab.displayName || 'Unbenannt'}`);
      console.log(`      URL: ${ab.url}`);
    });
    console.log();

    if (addressBooks.length === 0) {
      console.log('   ⚠ Keine Adressbücher gefunden. Test abgebrochen.');
      return;
    }

    const testAddressBook = addressBooks[0];
    console.log(`   → Verwende Adressbuch "${testAddressBook.displayName || 'Unbenannt'}" für Tests\n`);

    // ========================================
    // 3. VCARDS ABRUFEN (vor dem Erstellen)
    // ========================================
    console.log('📝 3. BESTEHENDE VCARDS ABRUFEN');
    const existingVCards = await client.fetchVCards({
      addressBook: testAddressBook,
    });
    console.log(`   ✓ ${existingVCards.length} bestehende vCards gefunden`);
    if (existingVCards.length > 0) {
      console.log(`   Beispiel: ${existingVCards[0].url}`);
      console.log(`   Data (erste 150 Zeichen):`);
      console.log(`   ${existingVCards[0].data.substring(0, 150)}...`);
    }
    console.log();

    // ========================================
    // 4. NEUE VCARD ERSTELLEN
    // ========================================
    console.log('📝 4. NEUE VCARD ERSTELLEN');
    const timestamp = Date.now();
    const vCardData = `BEGIN:VCARD
VERSION:3.0
FN:Max Mustermann
N:Mustermann;Max;;;
EMAIL;TYPE=INTERNET:max.mustermann@example.com
TEL;TYPE=CELL:+49 123 456789
ORG:TSDAV Test Company
TITLE:Software Entwickler
NOTE:Dies ist ein Test-Kontakt erstellt mit tsdav
UID:test-contact-${timestamp}
REV:${new Date().toISOString()}
END:VCARD`;

    const createResponse = await client.createVCard({
      addressBook: testAddressBook,
      filename: `test-contact-${timestamp}.vcf`,
      vCardString: vCardData,
    });
    console.log(`   ✓ vCard erstellt: ${createResponse.url}`);
    console.log();

    // ========================================
    // 5. VCARDS ERNEUT ABRUFEN
    // ========================================
    console.log('📝 5. VCARDS NACH ERSTELLUNG ABRUFEN');
    const allVCards = await client.fetchVCards({
      addressBook: testAddressBook,
    });
    console.log(`   ✓ ${allVCards.length} vCards gefunden (vorher: ${existingVCards.length})`);
    console.log();

    // ========================================
    // 6. VCARD DETAILS ANZEIGEN
    // ========================================
    console.log('📝 6. VCARD DETAILS');
    if (allVCards.length > 0) {
      const lastVCard = allVCards[allVCards.length - 1];
      console.log(`   URL: ${lastVCard.url}`);
      console.log(`   ETag: ${lastVCard.etag}`);
      console.log(`   Data:`);
      console.log(`   ${lastVCard.data}`);
    }
    console.log();

    // ========================================
    // 7. VCARD AKTUALISIEREN
    // ========================================
    console.log('📝 7. VCARD AKTUALISIEREN');
    if (allVCards.length > 0) {
      const vCardToUpdate = allVCards[allVCards.length - 1];
      const updatedVCard = vCardToUpdate.data.replace(
        'Max Mustermann',
        'Max Mustermann (AKTUALISIERT)'
      );

      const updateResponse = await client.updateVCard({
        vCard: {
          url: vCardToUpdate.url,
          data: updatedVCard,
          etag: vCardToUpdate.etag,
        },
      });
      console.log(`   ✓ vCard aktualisiert`);
      console.log(`   Neuer ETag: ${updateResponse.etag || 'nicht verfügbar'}`);
    }
    console.log();

    // ========================================
    // 8. VCARD LÖSCHEN
    // ========================================
    console.log('📝 8. VCARD LÖSCHEN');
    if (allVCards.length > 0) {
      const vCardToDelete = allVCards[allVCards.length - 1];
      await client.deleteVCard({
        vCard: {
          url: vCardToDelete.url,
          etag: vCardToDelete.etag,
        },
      });
      console.log(`   ✓ vCard gelöscht: ${vCardToDelete.url}`);
    }
    console.log();

    // ========================================
    // 9. FINALE ÜBERPRÜFUNG
    // ========================================
    console.log('📝 9. FINALE ÜBERPRÜFUNG');
    const finalVCards = await client.fetchVCards({
      addressBook: testAddressBook,
    });
    console.log(`   ✓ ${finalVCards.length} vCards übrig (sollte ${existingVCards.length} sein)`);
    console.log();

    console.log('✅ === CARDDAV TESTS ERFOLGREICH ABGESCHLOSSEN ===');

  } catch (error) {
    console.error('\n❌ FEHLER:', error.message);
    console.error(error.stack);
  }
}

testCardDAV();
