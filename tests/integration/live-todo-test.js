#!/usr/bin/env node

/**
 * Live integration test: Todo CRUD via MCP handlers against Nextcloud
 *
 * Tests the full lifecycle: create → update_fields → update_raw → delete
 * using the actual handler functions (not raw tsdav calls).
 *
 * Usage: CALDAV_SERVER_URL=... CALDAV_USERNAME=... CALDAV_PASSWORD=... node tests/integration/live-todo-test.js
 */

import { tsdavManager } from '../../src/tsdav-client.js';
import { createTodo } from '../../src/tools/todos/create-todo.js';
import { updateTodoFields } from '../../src/tools/todos/update-todo-fields.js';
import { updateTodoRaw } from '../../src/tools/todos/update-todo-raw.js';
import { deleteTodo } from '../../src/tools/todos/delete-todo.js';

const PASS = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.log(`  ${FAIL} ${label}`);
    failed++;
  }
}

/**
 * Extract URL and ETag from formatSuccess markdown response.
 * Format: "- **URL**: ...\n- **ETag**: ..."
 */
function parseResponse(result) {
  const text = result.content?.[0]?.text || '';
  const url = text.match(/\*\*URL\*\*:\s*(\S+)/)?.[1];
  const etag = text.match(/\*\*ETag\*\*:\s*(\S+)/)?.[1];
  return { text, url, etag };
}

async function run() {
  // --- Init ---
  console.log('\n=== Initializing tsdav client ===');
  await tsdavManager.initialize({
    serverUrl: process.env.CALDAV_SERVER_URL,
    username: process.env.CALDAV_USERNAME,
    password: process.env.CALDAV_PASSWORD,
    authMethod: 'Basic',
  });
  console.log('  Connected.\n');

  // Find a calendar that supports VTODOs
  const client = tsdavManager.getCalDavClient();
  const calendars = await client.fetchCalendars();
  const todoCalendar = calendars.find(c => c.components?.includes('VTODO'));
  const calendarUrl = todoCalendar?.url;
  if (!calendarUrl) {
    console.error('No calendar with VTODO support found!');
    process.exit(1);
  }
  console.log(`  Using calendar: ${todoCalendar.displayName} (${calendarUrl})\n`);

  // Helper: re-fetch todo to get current etag
  async function fetchEtag(url) {
    const calUrl = url.substring(0, url.lastIndexOf('/') + 1);
    const todos = await client.fetchTodos({
      calendar: { url: calUrl },
      objectUrls: [url],
    });
    return todos[0]?.etag;
  }

  let todoUrl, todoEtag;

  // === 1. create_todo ===
  console.log('=== 1. create_todo ===');
  try {
    const result = await createTodo.handler({
      calendar_url: calendarUrl,
      summary: 'Integration Test Todo',
      description: 'Created by live-todo-test.js',
      status: 'NEEDS-ACTION',
      priority: 3,
    });

    const { text, url } = parseResponse(result);
    assert(text.includes('successful'), 'Returns success message');
    todoUrl = url;
    assert(!!todoUrl, `Got todo URL: ${todoUrl}`);

    // Fetch the created todo to get its etag (create doesn't return etag)
    const todos = await client.fetchTodos({
      calendar: { url: calendarUrl },
      objectUrls: [todoUrl],
    });
    todoEtag = todos[0]?.etag;
    assert(!!todoEtag, `Fetched todo etag: ${todoEtag}`);
  } catch (e) {
    console.log(`  ${FAIL} create_todo threw: ${e.message}`);
    failed += 3;
    process.exit(1);
  }

  // === 2. update_todo (fields) ===
  console.log('\n=== 2. update_todo (fields) ===');
  try {
    const result = await updateTodoFields.handler({
      todo_url: todoUrl,
      todo_etag: todoEtag,
      fields: {
        SUMMARY: 'Integration Test Todo (UPDATED)',
        STATUS: 'IN-PROCESS',
        'PERCENT-COMPLETE': '50',
      },
    });

    const { text } = parseResponse(result);
    assert(text.includes('successful'), 'Returns success message');

    // Re-fetch to get updated etag
    const newEtag = await fetchEtag(todoUrl);
    assert(!!newEtag, `Got new etag: ${newEtag}`);
    assert(newEtag !== todoEtag, 'Etag changed after update');
    todoEtag = newEtag;
  } catch (e) {
    console.log(`  ${FAIL} update_todo (fields) threw: ${e.message}`);
    failed += 3;
  }

  // === 3. update_todo_raw ===
  console.log('\n=== 3. update_todo_raw ===');
  try {
    // Fetch current data first
    const calUrl = todoUrl.substring(0, todoUrl.lastIndexOf('/') + 1);
    const todos = await client.fetchTodos({
      calendar: { url: calUrl },
      objectUrls: [todoUrl],
    });
    assert(todos.length > 0, 'Fetched current todo data');

    // Modify the raw iCal
    let icalData = todos[0].data;
    icalData = icalData.replace(/SUMMARY:.*/, 'SUMMARY:Integration Test Todo (RAW UPDATE)');

    const result = await updateTodoRaw.handler({
      todo_url: todoUrl,
      todo_etag: todoEtag,
      updated_ical_data: icalData,
    });

    const { text } = parseResponse(result);
    assert(text.includes('successful'), 'Returns success message');

    // Re-fetch to get updated etag
    const newEtag = await fetchEtag(todoUrl);
    assert(!!newEtag, `Got new etag: ${newEtag}`);
    todoEtag = newEtag;
  } catch (e) {
    console.log(`  ${FAIL} update_todo_raw threw: ${e.message}`);
    failed += 2;
  }

  // === 4. delete_todo ===
  console.log('\n=== 4. delete_todo ===');
  try {
    const result = await deleteTodo.handler({
      todo_url: todoUrl,
      todo_etag: todoEtag,
    });

    const { text } = parseResponse(result);
    assert(text.includes('successful'), 'Returns success message');

    // Verify deletion — fetching should return empty
    const calUrl = todoUrl.substring(0, todoUrl.lastIndexOf('/') + 1);
    const remaining = await client.fetchTodos({
      calendar: { url: calUrl },
      objectUrls: [todoUrl],
    });
    assert(remaining.length === 0, 'Todo no longer exists on server');
  } catch (e) {
    console.log(`  ${FAIL} delete_todo threw: ${e.message}`);
    failed += 2;
  }

  // === Summary ===
  console.log(`\n${'='.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40));
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(`\nFatal: ${e.message}`);
  process.exit(1);
});
