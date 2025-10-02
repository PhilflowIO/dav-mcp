/**
 * LLM-Friendly Output Formatters for tsdav-mcp
 *
 * This module provides formatters that convert raw CalDAV/CardDAV data
 * into human-readable Markdown format optimized for LLM consumption.
 */

/**
 * Parse iCal data string to extract event properties
 */
function parseICalEvent(icalData) {
  const lines = icalData.split('\n').map(l => l.trim());
  const event = {};

  for (const line of lines) {
    if (line.startsWith('SUMMARY:')) event.summary = line.replace('SUMMARY:', '');
    if (line.startsWith('DTSTART:')) event.dtstart = line.replace('DTSTART:', '');
    if (line.startsWith('DTEND:')) event.dtend = line.replace('DTEND:', '');
    if (line.startsWith('LOCATION:')) event.location = line.replace('LOCATION:', '');
    if (line.startsWith('DESCRIPTION:')) event.description = line.replace('DESCRIPTION:', '');
    if (line.startsWith('UID:')) event.uid = line.replace('UID:', '');
  }

  return event;
}

/**
 * Parse vCard data string to extract contact properties
 */
function parseVCard(vcardData) {
  const lines = vcardData.split('\n').map(l => l.trim());
  const contact = {};

  for (const line of lines) {
    if (line.startsWith('FN:')) contact.fullName = line.replace('FN:', '');
    if (line.startsWith('N:')) {
      const parts = line.replace('N:', '').split(';');
      contact.familyName = parts[0] || '';
      contact.givenName = parts[1] || '';
    }
    if (line.startsWith('EMAIL')) contact.email = line.split(':')[1] || '';
    if (line.startsWith('TEL')) contact.phone = line.split(':')[1] || '';
    if (line.startsWith('ORG:')) contact.organization = line.replace('ORG:', '');
    if (line.startsWith('NOTE:')) contact.note = line.replace('NOTE:', '');
    if (line.startsWith('UID:')) contact.uid = line.replace('UID:', '');
  }

  return contact;
}

/**
 * Format iCal datetime to human-readable format
 */
function formatDateTime(icalDate) {
  if (!icalDate) return '';

  // iCal format: 20251015T100000Z
  const year = icalDate.substring(0, 4);
  const month = icalDate.substring(4, 6);
  const day = icalDate.substring(6, 8);
  const hour = icalDate.substring(9, 11);
  const minute = icalDate.substring(11, 13);

  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:00Z`);

  const dateStr = date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const timeStr = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  return `${dateStr}, ${timeStr}`;
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

  if (parsed.organization) {
    output += `- **Organization**: ${parsed.organization}\n`;
  }

  if (parsed.email) {
    output += `- **Email**: ${parsed.email}\n`;
  }

  if (parsed.phone) {
    output += `- **Phone**: ${parsed.phone}\n`;
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
        text: 'No contacts found.'
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

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
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
    output += `### ${index + 1}. ${cal.displayName || 'Unnamed Calendar'}\n\n`;

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
