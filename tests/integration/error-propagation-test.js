#!/usr/bin/env node

/**
 * Live test: Verify errors propagate as thrown Errors to the central handler.
 *
 * The update_*_fields handlers don't catch errors internally — they let them
 * bubble up to the central error handler in server-stdio.js for consistent
 * logging and error response formatting.
 *
 * Usage: CALDAV_SERVER_URL=... CALDAV_USERNAME=... CALDAV_PASSWORD=... node tests/integration/error-propagation-test.js
 */

import { tsdavManager } from '../../src/tsdav-client.js';
import { updateTodoFields } from '../../src/tools/todos/update-todo-fields.js';
import { updateEventFields } from '../../src/tools/calendar/update-event-fields.js';
import { updateContactFields } from '../../src/tools/contacts/update-contact-fields.js';

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
let passed = 0;
let failed = 0;

function check(condition, label) {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}`);
    failed++;
  }
}

async function run() {
  console.log('\n=== Initializing ===');
  await tsdavManager.initialize({
    serverUrl: process.env.CALDAV_SERVER_URL,
    username: process.env.CALDAV_USERNAME,
    password: process.env.CALDAV_PASSWORD,
    authMethod: 'Basic',
  });
  console.log('  Connected.\n');

  // Discover real calendar/addressbook URLs from the server
  const calDavClient = tsdavManager.getCalDavClient();
  const cardDavClient = tsdavManager.getCardDavClient();

  const calendars = await calDavClient.fetchCalendars();
  const todoCalendar = calendars.find(c => c.components?.includes('VTODO'));
  const eventCalendar = calendars[0];
  const addressBooks = await cardDavClient.fetchAddressBooks();
  const addressBook = addressBooks[0];

  if (!todoCalendar) { console.error('No VTODO calendar found'); process.exit(1); }
  if (!eventCalendar) { console.error('No calendar found'); process.exit(1); }
  if (!addressBook) { console.error('No address book found'); process.exit(1); }

  const fakeTodoUrl = todoCalendar.url + 'does-not-exist-999.ics';
  const fakeEventUrl = eventCalendar.url + 'does-not-exist-999.ics';
  const fakeContactUrl = addressBook.url + 'does-not-exist-999.vcf';

  console.log('=== Error propagation tests ===\n');

  // --- 1. update_todo with non-existent todo ---
  console.log('1. update_todo_fields — non-existent todo:');
  try {
    await updateTodoFields.handler({
      todo_url: fakeTodoUrl,
      todo_etag: '"fake-etag"',
      fields: { SUMMARY: 'x' },
    });
    check(false, 'Should have thrown');
  } catch (e) {
    check(e instanceof Error, 'Threw a real Error object');
    check(e.message === 'Todo not found', `Error message: "${e.message}"`);
  }

  // --- 2. update_event with non-existent event ---
  console.log('\n2. update_event_fields — non-existent event:');
  try {
    await updateEventFields.handler({
      event_url: fakeEventUrl,
      event_etag: '"fake-etag"',
      fields: { SUMMARY: 'x' },
    });
    check(false, 'Should have thrown');
  } catch (e) {
    check(e instanceof Error, 'Threw a real Error object');
    check(e.message === 'Event not found', `Error message: "${e.message}"`);
  }

  // --- 3. update_contact with non-existent contact ---
  console.log('\n3. update_contact_fields — non-existent contact:');
  try {
    await updateContactFields.handler({
      vcard_url: fakeContactUrl,
      vcard_etag: '"fake-etag"',
      fields: { FN: 'x' },
    });
    check(false, 'Should have thrown');
  } catch (e) {
    check(e instanceof Error, 'Threw a real Error object');
    check(e.message === 'Contact not found', `Error message: "${e.message}"`);
  }

  // --- Summary ---
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40));
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(`\nFatal: ${e.message}`);
  process.exit(1);
});
