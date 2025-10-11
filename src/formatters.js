/**
 * LLM-Friendly Output Formatters for tsdav-mcp
 *
 * This module provides formatters that convert raw CalDAV/CardDAV data
 * into human-readable Markdown format optimized for LLM consumption.
 *
 * Uses RFC-compliant parsing:
 * - ical.js for RFC 5545 (iCalendar) compliance
 * - ical.js for RFC 6350 (vCard) compliance (supports v3.0 and v4.0)
 */

import ICAL from 'ical.js';

/**
 * Parse iCal data string to extract event properties (RFC 5545 compliant)
 */
function parseICalEvent(icalData) {
  try {
    const jcalData = ICAL.parse(icalData);
    const comp = new ICAL.Component(jcalData);
    const vevent = comp.getFirstSubcomponent('vevent');

    if (!vevent) {
      return {};
    }

    const event = new ICAL.Event(vevent);

    return {
      summary: event.summary || '',
      description: event.description || '',
      location: event.location || '',
      uid: event.uid || '',
      dtstart: event.startDate,
      dtend: event.endDate,
      isRecurring: event.isRecurring(),
      rrule: event.isRecurring() ? vevent.getFirstPropertyValue('rrule') : null,
      organizer: vevent.getFirstPropertyValue('organizer'),
      attendees: vevent.getAllProperties('attendee').map(att => ({
        email: att.getFirstValue(),
        role: att.getParameter('role'),
        partstat: att.getParameter('partstat'),
        cn: att.getParameter('cn'),
      })),
      alarms: vevent.getAllSubcomponents('valarm').map(valarm => ({
        action: valarm.getFirstPropertyValue('action'),
        trigger: valarm.getFirstPropertyValue('trigger'),
        description: valarm.getFirstPropertyValue('description'),
      })),
    };
  } catch (error) {
    console.error('Error parsing iCal event:', error);
    return {};
  }
}

/**
 * Parse vCard data string to extract contact properties (RFC 6350 compliant)
 */
function parseVCard(vcardData) {
  try {
    const jcard = ICAL.parse(vcardData);
    const vcard = new ICAL.Component(jcard);

    const contact = {
      fullName: vcard.getFirstPropertyValue('fn') || '',
      uid: vcard.getFirstPropertyValue('uid') || '',
    };

    // Parse structured name (N property)
    const n = vcard.getFirstProperty('n');
    if (n) {
      const nameValue = n.getFirstValue();
      contact.familyName = nameValue[0] || '';
      contact.givenName = nameValue[1] || '';
      contact.additionalNames = nameValue[2] || '';
      contact.honorificPrefixes = nameValue[3] || '';
      contact.honorificSuffixes = nameValue[4] || '';
    }

    // Parse all emails
    const emails = vcard.getAllProperties('email');
    if (emails && emails.length > 0) {
      contact.emails = emails.map(e => ({
        value: e.getFirstValue(),
        type: e.getParameter('type') ? [e.getParameter('type')] : [],
      }));
    }

    // Parse all phone numbers
    const tels = vcard.getAllProperties('tel');
    if (tels && tels.length > 0) {
      contact.phones = tels.map(t => ({
        value: t.getFirstValue(),
        type: t.getParameter('type') ? [t.getParameter('type')] : [],
      }));
    }

    // Parse all addresses
    const adrs = vcard.getAllProperties('adr');
    if (adrs && adrs.length > 0) {
      contact.addresses = adrs.map(a => {
        const adrValue = a.getFirstValue();
        return {
          poBox: adrValue[0] || '',
          extendedAddress: adrValue[1] || '',
          streetAddress: adrValue[2] || '',
          locality: adrValue[3] || '',
          region: adrValue[4] || '',
          postalCode: adrValue[5] || '',
          country: adrValue[6] || '',
          type: a.getParameter('type') ? [a.getParameter('type')] : [],
        };
      });
    }

    // Parse organization
    const org = vcard.getFirstProperty('org');
    if (org) {
      const orgValue = org.getFirstValue();
      contact.organization = Array.isArray(orgValue) ? orgValue.join(', ') : orgValue;
    }

    // Parse note
    const note = vcard.getFirstPropertyValue('note');
    if (note) {
      contact.note = note;
    }

    return contact;
  } catch (error) {
    console.error('Error parsing vCard:', error);
    return {};
  }
}

/**
 * Format ICAL.Time to human-readable format with proper timezone support
 */
function formatDateTime(icalTime) {
  if (!icalTime) return '';

  try {
    // Convert ICAL.Time to JavaScript Date
    const jsDate = icalTime.toJSDate();

    const dateStr = jsDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: icalTime.timezone === 'UTC' ? 'UTC' : undefined,
    });

    const timeStr = jsDate.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: icalTime.timezone === 'UTC' ? 'UTC' : undefined,
    });

    return `${dateStr}, ${timeStr}`;
  } catch (error) {
    console.error('Error formatting datetime:', error);
    return '';
  }
}

/**
 * Format a single calendar event to Markdown
 */
export function formatEvent(event, calendarName = 'Unknown Calendar') {
  const parsed = parseICalEvent(event.data);

  const startDate = formatDateTime(parsed.dtstart);
  const endDate = formatDateTime(parsed.dtend);

  let output = `## ${parsed.summary || 'Untitled Event'}\n\n`;
  output += `- **When**: ${startDate}`;

  if (endDate && endDate !== startDate) {
    output += ` to ${endDate}`;
  }
  output += '\n';

  if (parsed.location) {
    output += `- **Where**: ${parsed.location}\n`;
  }

  if (parsed.description) {
    output += `- **Description**: ${parsed.description}\n`;
  }

  // Show recurrence info if event is recurring
  if (parsed.isRecurring && parsed.rrule) {
    output += `- **Recurring**: ${parsed.rrule.toString()}\n`;
  }

  // Show organizer if present
  if (parsed.organizer) {
    const organizerEmail = parsed.organizer.replace('mailto:', '');
    output += `- **Organizer**: ${organizerEmail}\n`;
  }

  // Show attendees if present
  if (parsed.attendees && parsed.attendees.length > 0) {
    output += `- **Attendees**: ${parsed.attendees.length} person(s)\n`;
    parsed.attendees.forEach(att => {
      const email = att.email ? att.email.replace('mailto:', '') : '';
      const name = att.cn || email;
      const status = att.partstat ? ` (${att.partstat})` : '';
      output += `  - ${name}${status}\n`;
    });
  }

  // Show alarms if present
  if (parsed.alarms && parsed.alarms.length > 0) {
    output += `- **Reminders**: ${parsed.alarms.length} alarm(s)\n`;
    parsed.alarms.forEach(alarm => {
      output += `  - ${alarm.action}: ${alarm.trigger ? alarm.trigger.toString() : 'Unknown trigger'}\n`;
    });
  }

  output += `- **Calendar**: ${calendarName}\n`;
  output += `- **URL**: ${event.url}\n`;

  return output;
}

/**
 * Format a list of calendar events to LLM-friendly Markdown
 */
export function formatEventList(events, calendarName = 'Unknown Calendar') {
  if (!events || events.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No events found.'
      }]
    };
  }

  let output = `Found events: **${events.length}**\n\n`;

  events.forEach((event, index) => {
    output += `### ${index + 1}. `;
    output += formatEvent(event, calendarName).replace(/^## /, '') + '\n';
  });

  output += `---\n<details>\n<summary>Raw Data (JSON)</summary>\n\n\`\`\`json\n`;
  output += JSON.stringify(events.map(e => ({
    url: e.url,
    etag: e.etag,
    data: e.data
  })), null, 2);
  output += '\n```\n</details>';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

/**
 * Format a single contact to Markdown
 */
export function formatContact(contact, addressBookName = 'Unknown Address Book') {
  const parsed = parseVCard(contact.data);

  let output = `## ${parsed.fullName || 'Unnamed Contact'}\n\n`;

  // Show structured name if available
  if (parsed.givenName || parsed.familyName) {
    const nameParts = [];
    if (parsed.honorificPrefixes) nameParts.push(parsed.honorificPrefixes);
    if (parsed.givenName) nameParts.push(parsed.givenName);
    if (parsed.additionalNames) nameParts.push(parsed.additionalNames);
    if (parsed.familyName) nameParts.push(parsed.familyName);
    if (parsed.honorificSuffixes) nameParts.push(parsed.honorificSuffixes);
    if (nameParts.length > 0) {
      output += `- **Full Name**: ${nameParts.join(' ')}\n`;
    }
  }

  if (parsed.organization) {
    output += `- **Organization**: ${parsed.organization}\n`;
  }

  // Show all emails
  if (parsed.emails && parsed.emails.length > 0) {
    if (parsed.emails.length === 1) {
      const emailType = parsed.emails[0].type.length > 0 ? ` (${parsed.emails[0].type.join(', ')})` : '';
      output += `- **Email**: ${parsed.emails[0].value}${emailType}\n`;
    } else {
      output += `- **Emails**: ${parsed.emails.length} email(s)\n`;
      parsed.emails.forEach(email => {
        const emailType = email.type.length > 0 ? ` (${email.type.join(', ')})` : '';
        output += `  - ${email.value}${emailType}\n`;
      });
    }
  }

  // Show all phones
  if (parsed.phones && parsed.phones.length > 0) {
    if (parsed.phones.length === 1) {
      const phoneType = parsed.phones[0].type.length > 0 ? ` (${parsed.phones[0].type.join(', ')})` : '';
      output += `- **Phone**: ${parsed.phones[0].value}${phoneType}\n`;
    } else {
      output += `- **Phones**: ${parsed.phones.length} phone(s)\n`;
      parsed.phones.forEach(phone => {
        const phoneType = phone.type.length > 0 ? ` (${phone.type.join(', ')})` : '';
        output += `  - ${phone.value}${phoneType}\n`;
      });
    }
  }

  // Show all addresses
  if (parsed.addresses && parsed.addresses.length > 0) {
    output += `- **Addresses**: ${parsed.addresses.length} address(es)\n`;
    parsed.addresses.forEach(addr => {
      const addrParts = [];
      if (addr.streetAddress) addrParts.push(addr.streetAddress);
      if (addr.locality) addrParts.push(addr.locality);
      if (addr.region) addrParts.push(addr.region);
      if (addr.postalCode) addrParts.push(addr.postalCode);
      if (addr.country) addrParts.push(addr.country);
      const addrType = addr.type.length > 0 ? ` (${addr.type.join(', ')})` : '';
      if (addrParts.length > 0) {
        output += `  - ${addrParts.join(', ')}${addrType}\n`;
      }
    });
  }

  if (parsed.note) {
    output += `- **Note**: ${parsed.note}\n`;
  }

  output += `- **Address Book**: ${addressBookName}\n`;
  output += `- **URL**: ${contact.url}\n`;

  return output;
}

/**
 * Format a list of contacts to LLM-friendly Markdown
 */
export function formatContactList(contacts, addressBookName = 'Unknown Address Book') {
  if (!contacts || contacts.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No contacts found in ${addressBookName}.

💡 **Next steps**:
- Try broader search: use addressbook_query with partial name
- List all contacts: use list_contacts to see available names  
- Create new contact: use create_contact if contact doesn't exist yet

📝 **Available address books**: Use list_addressbooks to see all address books`
      }]
    };
  }

  let output = `Found contacts: **${contacts.length}**\n\n`;

  contacts.forEach((contact, index) => {
    output += `### ${index + 1}. `;
    output += formatContact(contact, addressBookName).replace(/^## /, '') + '\n';
  });

  output += `---\n<details>\n<summary>Raw Data (JSON)</summary>\n\n\`\`\`json\n`;
  output += JSON.stringify(contacts.map(c => ({
    url: c.url,
    etag: c.etag,
    data: c.data
  })), null, 2);
  output += '\n```\n</details>';

  // Add next action hints
  output += `\n💡 **What you can do next**:
- Update contact: use update_contact with URL and ETAG from above
- Delete contact: use delete_contact with URL and ETAG from above
- Get full details: Contact data already complete above`;

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

/**
 * Helper: Extract string value from property (handles both string and object)
 * tsdav sometimes returns { _text: "value" } instead of "value"
 */
function extractPropertyValue(prop) {
  if (!prop) return '';
  if (typeof prop === 'string') return prop;
  if (typeof prop === 'object') {
    return prop._text || prop.value || String(prop);
  }
  return String(prop);
}

/**
 * Format calendar list to LLM-friendly Markdown
 */
export function formatCalendarList(calendars) {
  if (!calendars || calendars.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No calendars found.'
      }]
    };
  }

  let output = `Available calendars: **${calendars.length}**\n\n`;

  calendars.forEach((cal, index) => {
    const displayName = extractPropertyValue(cal.displayName) || 'Unnamed Calendar';
    output += `### ${index + 1}. ${displayName}\n\n`;

    if (cal.description) {
      output += `- **Description**: ${cal.description}\n`;
    }

    if (cal.components) {
      output += `- **Components**: ${cal.components.join(', ')}\n`;
    }

    if (cal.calendarColor) {
      output += `- **Color**: ${cal.calendarColor}\n`;
    }

    output += `- **URL**: ${cal.url}\n\n`;
  });

  output += `---\n<details>\n<summary>Raw Data (JSON)</summary>\n\n\`\`\`json\n`;
  output += JSON.stringify(calendars.map(cal => ({
    displayName: cal.displayName,
    url: cal.url,
    components: cal.components,
    calendarColor: cal.calendarColor,
    description: cal.description,
  })), null, 2);
  output += '\n```\n</details>';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

/**
 * Format address book list to LLM-friendly Markdown
 */
export function formatAddressBookList(addressBooks) {
  if (!addressBooks || addressBooks.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No address books found.'
      }]
    };
  }

  let output = `Available address books: **${addressBooks.length}**\n\n`;

  addressBooks.forEach((ab, index) => {
    output += `### ${index + 1}. ${ab.displayName || 'Unnamed Address Book'}\n\n`;

    if (ab.description) {
      output += `- **Description**: ${ab.description}\n`;
    }

    output += `- **URL**: ${ab.url}\n\n`;
  });

  output += `---\n<details>\n<summary>Raw Data (JSON)</summary>\n\n\`\`\`json\n`;
  output += JSON.stringify(addressBooks.map(ab => ({
    displayName: ab.displayName,
    url: ab.url,
    description: ab.description,
  })), null, 2);
  output += '\n```\n</details>';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

/**
 * Format success message for create/update/delete operations
 */
export function formatSuccess(operation, details = {}) {
  let output = `✅ **${operation} successful**\n\n`;

  if (details.url) {
    output += `- **URL**: ${details.url}\n`;
  }

  if (details.etag) {
    output += `- **ETag**: ${details.etag}\n`;
  }

  if (details.message) {
    output += `- **Message**: ${details.message}\n`;
  }

  output += `\n---\n<details>\n<summary>Rohdaten (JSON)</summary>\n\n\`\`\`json\n`;
  output += JSON.stringify({ success: true, ...details }, null, 2);
  output += '\n```\n</details>';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

export function formatCalendarUpdateSuccess(calendar, updatedFields) {
  let output = `✅ **Calendar updated successfully**\n\n`;

  const displayName = extractPropertyValue(calendar.displayName) || 'Unnamed Calendar';
  output += `- **Calendar**: ${displayName}\n`;
  output += `- **URL**: ${calendar.url}\n`;

  if (updatedFields && Object.keys(updatedFields).length > 0) {
    output += `\n**Updated fields:**\n`;
    if (updatedFields.display_name) {
      output += `- Display name: ${updatedFields.display_name}\n`;
    }
    if (updatedFields.description) {
      output += `- Description: ${updatedFields.description}\n`;
    }
    if (updatedFields.color) {
      output += `- Color: ${updatedFields.color}\n`;
    }
    if (updatedFields.timezone) {
      output += `- Timezone: ${updatedFields.timezone}\n`;
    }
  }

  output += `\n---\n<details>\n<summary>Raw Data (JSON)</summary>\n\n\`\`\`json\n`;
  output += JSON.stringify({ success: true, calendar, updatedFields }, null, 2);
  output += '\n```\n</details>';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

export function formatCalendarDeleteSuccess(calendarUrl) {
  let output = `✅ **Calendar deleted successfully**\n\n`;

  output += `⚠️ **Warning**: The calendar and all its events have been permanently deleted.\n\n`;
  output += `- **Deleted URL**: ${calendarUrl}\n`;

  output += `\n---\n<details>\n<summary>Raw Data (JSON)</summary>\n\n\`\`\`json\n`;
  output += JSON.stringify({ success: true, deleted: true, url: calendarUrl }, null, 2);
  output += '\n```\n</details>';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

/**
 * Parse VTODO (task) from iCal data
 */
function parseVTodo(icalData) {
  try {
    const jcalData = ICAL.parse(icalData);
    const comp = new ICAL.Component(jcalData);
    const vtodo = comp.getFirstSubcomponent('vtodo');

    if (!vtodo) {
      return {};
    }

    return {
      uid: vtodo.getFirstPropertyValue('uid') || '',
      summary: vtodo.getFirstPropertyValue('summary') || '',
      description: vtodo.getFirstPropertyValue('description') || '',
      status: vtodo.getFirstPropertyValue('status') || 'NEEDS-ACTION',
      priority: vtodo.getFirstPropertyValue('priority') || 0,
      percentComplete: vtodo.getFirstPropertyValue('percent-complete') || 0,
      due: vtodo.getFirstPropertyValue('due'),
      completed: vtodo.getFirstPropertyValue('completed'),
      dtstart: vtodo.getFirstPropertyValue('dtstart'),
    };
  } catch (error) {
    console.error('Error parsing VTODO:', error);
    return {};
  }
}

/**
 * Get emoji for todo status
 */
function getStatusEmoji(status) {
  const statusMap = {
    'NEEDS-ACTION': '📋',
    'IN-PROCESS': '🔄',
    'COMPLETED': '✅',
    'CANCELLED': '❌',
  };
  return statusMap[status] || '📋';
}

/**
 * Format priority (0-9 where 0=undefined, 1=highest, 9=lowest)
 */
function formatPriority(priority) {
  if (priority === 0 || priority === undefined) return 'None';
  if (priority >= 1 && priority <= 3) return `🔴 High (${priority})`;
  if (priority >= 4 && priority <= 6) return `🟡 Medium (${priority})`;
  return `🟢 Low (${priority})`;
}

/**
 * Format a single todo to Markdown
 */
export function formatTodo(todo, calendarName = 'Unknown Calendar') {
  const parsed = parseVTodo(todo.data);
  const statusEmoji = getStatusEmoji(parsed.status);

  let output = `## ${statusEmoji} ${parsed.summary || 'Untitled Task'}\n\n`;

  output += `- **Status**: ${parsed.status}\n`;

  if (parsed.due) {
    output += `- **Due**: ${formatDateTime(parsed.due)}\n`;
  }

  if (parsed.priority && parsed.priority !== 0) {
    output += `- **Priority**: ${formatPriority(parsed.priority)}\n`;
  }

  if (parsed.percentComplete > 0) {
    output += `- **Progress**: ${parsed.percentComplete}%\n`;
  }

  if (parsed.description) {
    output += `- **Description**: ${parsed.description}\n`;
  }

  if (parsed.dtstart) {
    output += `- **Start**: ${formatDateTime(parsed.dtstart)}\n`;
  }

  if (parsed.completed) {
    output += `- **Completed**: ${formatDateTime(parsed.completed)}\n`;
  }

  output += `- **Calendar**: ${calendarName}\n`;
  output += `- **URL**: ${todo.url}\n`;
  output += `- **ETag**: ${todo.etag} *(required for updates)*\n`;

  return output;
}

/**
 * Format a list of todos to LLM-friendly Markdown
 */
export function formatTodoList(todos, calendarName = 'Unknown Calendar') {
  if (!todos || todos.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No todos found.'
      }]
    };
  }

  let output = `Found todos: **${todos.length}**\n\n`;

  todos.forEach((todo, index) => {
    output += `### ${index + 1}. `;
    output += formatTodo(todo, calendarName).replace(/^## /, '') + '\n';
  });

  output += `---\n<details>\n<summary>Raw Data (JSON)</summary>\n\n\`\`\`json\n`;
  output += JSON.stringify(todos.map(t => ({
    url: t.url,
    etag: t.etag,
    data: t.data
  })), null, 2);
  output += '\n```\n</details>';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

/**
 * Format error message in a user-friendly way
 */
export function formatError(error, context = '') {
  let output = `❌ **Error${context ? ` in ${context}` : ''}**\n\n`;

  // Provide actionable error messages
  const errorMsg = error.message || String(error);

  if (errorMsg.includes('not found')) {
    output += `The specified resource was not found.\n\n`;
    output += `**Possible solutions:**\n`;
    output += `- Check the URL\n`;
    output += `- Ensure the resource exists\n`;
    output += `- Refresh the resource list\n`;
  } else if (errorMsg.includes('auth') || errorMsg.includes('401')) {
    output += `Authentication failed.\n\n`;
    output += `**Possible solutions:**\n`;
    output += `- Check username and password\n`;
    output += `- Ensure the server is reachable\n`;
    output += `- Verify server settings in .env file\n`;
  } else if (errorMsg.includes('etag') || errorMsg.includes('412')) {
    output += `The resource was modified in the meantime.\n\n`;
    output += `**Possible solutions:**\n`;
    output += `- Reload the current version of the resource\n`;
    output += `- Use the current ETag\n`;
  } else {
    output += `${errorMsg}\n`;
  }

  output += `\n---\n<details>\n<summary>Technical Details</summary>\n\n\`\`\`\n`;
  output += error.stack || errorMsg;
  output += '\n```\n</details>';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}
