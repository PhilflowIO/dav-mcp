import { createDAVClient } from 'tsdav';
import dotenv from 'dotenv';
import ICAL from 'ical.js';

dotenv.config();

/**
 * Test Data Generator for MCP Integration Tests
 *
 * Creates realistic test data in CalDAV/CardDAV server:
 * - Calendars with events (past, present, future)
 * - Address books with contacts
 * - Todos/tasks with various statuses and priorities
 *
 * This ensures integration tests have real data to work with,
 * not "nonexistent" searches that always return empty results.
 */
class TestDataGenerator {
  constructor(config = {}) {
    this.config = {
      serverUrl: config.serverUrl || process.env.CALDAV_SERVER_URL,
      username: config.username || process.env.CALDAV_USERNAME,
      password: config.password || process.env.CALDAV_PASSWORD,
      ...config
    };

    this.client = null;
    this.testCalendarUrl = null;
    this.testAddressBookUrl = null;
  }

  /**
   * Initialize DAV client
   */
  async initialize() {
    console.log('Initializing CalDAV/CardDAV client...');
    console.log(`Server: ${this.config.serverUrl}`);
    console.log(`Username: ${this.config.username}`);

    this.client = await createDAVClient({
      serverUrl: this.config.serverUrl,
      credentials: {
        username: this.config.username,
        password: this.config.password,
      },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });

    // Note: createDAVClient already authenticates, no separate login() needed
    console.log('✅ Successfully connected to DAV server\n');
  }

  /**
   * Create test calendar
   */
  async createTestCalendar() {
    console.log('Creating test calendar...');

    try {
      const calendars = await this.client.fetchCalendars();
      const existingTest = calendars.find(c => c.displayName === 'MCP Test Calendar');

      if (existingTest) {
        console.log('  Test calendar already exists, using existing one');
        this.testCalendarUrl = existingTest.url;
        return;
      }

      // Build calendar home URL manually (client.account.homeUrl is undefined after cleanup!)
      const calendarHomeUrl = `${this.config.serverUrl}/${this.config.username}/`;
      const newCalendarUrl = `${calendarHomeUrl}mcp-test-calendar/`;

      console.log(`  Creating calendar at: ${newCalendarUrl}`);

      // Create new calendar
      await this.client.makeCalendar({
        url: newCalendarUrl,
        props: {
          displayName: 'MCP Test Calendar',
          description: 'Test calendar for MCP integration tests',
        },
      });

      this.testCalendarUrl = newCalendarUrl;
      console.log(`✅ Test calendar created: ${this.testCalendarUrl}\n`);
    } catch (error) {
      console.error('❌ Failed to create test calendar:', error.message);
      throw error; // Don't silently fail - we need this to work!
    }
  }

  /**
   * Generate test events
   */
  async generateTestEvents() {
    console.log('Generating test events...');

    const events = [
      // Past events
      {
        summary: 'Budget Review Meeting',
        description: 'Quarterly budget review with finance team',
        location: 'Conference Room A',
        dtstart: '2025-10-01T14:00:00Z',
        dtend: '2025-10-01T15:30:00Z',
        categories: 'work,finance'
      },
      {
        summary: 'Dentist Appointment',
        description: 'Regular checkup',
        location: 'Dr. Smith Dental Clinic',
        dtstart: '2025-10-03T10:00:00Z',
        dtend: '2025-10-03T11:00:00Z',
        categories: 'personal,health'
      },

      // Today's events (2025-10-10 = Friday)
      {
        summary: 'Team Standup',
        description: 'Daily team sync',
        location: 'Zoom',
        dtstart: '2025-10-10T09:00:00Z',
        dtend: '2025-10-10T09:30:00Z',
        categories: 'work,meeting'
      },
      {
        summary: 'Lunch with John',
        description: 'Catch up lunch',
        location: 'Downtown Cafe',
        dtstart: '2025-10-10T12:00:00Z', // TODAY = Friday (matches "Friday lunch" query)
        dtend: '2025-10-10T13:00:00Z',
        categories: 'personal'
      },
      {
        summary: 'Project Review with Sarah',
        description: 'Review quarterly project progress',
        location: 'Conference Room B',
        dtstart: '2025-10-10T13:00:00Z', // 13:00 UTC = 15:00 Berlin = 3pm local
        dtend: '2025-10-10T14:00:00Z',   // 14:00 UTC = 16:00 Berlin = 4pm local
        categories: 'work,project'
      },

      // This week
      {
        summary: 'Budget Planning Session',
        description: 'Plan next quarter budget allocations',
        location: 'Board Room',
        dtstart: '2025-10-09T14:00:00Z',
        dtend: '2025-10-09T16:00:00Z',
        categories: 'work,finance'
      },
      {
        summary: 'Weekly Team Meeting',
        description: 'Regular weekly sync',
        location: 'Zoom',
        dtstart: '2025-10-13T10:00:00Z',
        dtend: '2025-10-13T11:00:00Z',
        categories: 'work,meeting'
        // Note: RRULE removed - Radicale rejects recurring events silently
      },

      // Next week
      {
        summary: 'Meeting with John Smith',
        description: 'Discuss new project proposal',
        location: 'Office',
        dtstart: '2025-10-15T11:00:00Z',
        dtend: '2025-10-15T12:00:00Z',
        categories: 'work'
      },
      {
        summary: 'Conference Room Meeting',
        description: 'Team workshop',
        location: 'Conference Room',
        dtstart: '2025-10-16T13:00:00Z',
        dtend: '2025-10-16T15:00:00Z',
        categories: 'work'
      },

      // Future events
      {
        summary: 'Quarterly Review',
        description: 'Quarterly earnings review presentation',
        location: 'Board Room',
        dtstart: '2025-10-25T14:00:00Z',
        dtend: '2025-10-25T16:00:00Z',
        categories: 'work,important'
      }
    ];

    console.log(`  📋 Total events to create: ${events.length}`);
    let created = 0;
    let eventNum = 0;
    for (const event of events) {
      eventNum++;
      console.log(`  🔄 [${eventNum}/${events.length}] Creating: ${event.summary}...`);
      try {
        const ical = this.buildEventIcal(event);
        await this.client.createCalendarObject({
          calendar: { url: this.testCalendarUrl },
          filename: `${event.summary.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.ics`,
          iCalString: ical,
        });
        created++;
        console.log(`  ✅ [${eventNum}/${events.length}] Created: ${event.summary}`);
      } catch (error) {
        console.log(`  ❌ [${eventNum}/${events.length}] Failed to create ${event.summary}: ${error.message}`);
      }
    }

    console.log(`✅ Created ${created}/${events.length} test events\n`);
  }

  /**
   * Generate test contacts
   */
  async generateTestContacts() {
    console.log('Generating test contacts...');

    // First, get address books
    try {
      const addressBooks = await this.client.fetchAddressBooks();
      if (addressBooks.length === 0) {
        console.log('  ⚠️  No address books found, skipping contacts');
        return;
      }

      this.testAddressBookUrl = addressBooks[0].url;
      console.log(`  Using address book: ${this.testAddressBookUrl}`);
    } catch (error) {
      console.log('  ⚠️  Failed to fetch address books, skipping contacts');
      return;
    }

    const contacts = [
      {
        fn: 'John Doe',
        email: 'john@example.com',
        tel: '555-0100',
        org: 'Acme Corp',
        title: 'Software Engineer'
      },
      {
        fn: 'Sarah Johnson',
        email: 'sarah@example.com',
        tel: '555-0101',
        org: 'TechStart Inc',
        title: 'Product Manager'
      },
      {
        fn: 'Michael Smith',
        email: 'michael@company.com',
        tel: '555-0102',
        org: 'Acme Corp',
        title: 'Senior Developer'
      },
      {
        fn: 'Alice Brown',
        email: 'alice@company.com',
        tel: '555-0103',
        org: 'Google',
        title: 'Engineer',
        note: 'VIP contact'
      },
      {
        fn: 'Tom Wilson',
        email: 'tom@example.com',
        tel: '555-0104',
        org: 'StartupXYZ',
        title: 'CTO'
      },
      {
        fn: 'Lisa Wang',
        email: 'lisa@company.com',
        tel: '555-0105',
        org: 'TechCorp',
        title: 'Designer',
        adr: {
          street: '123 Main St',
          city: 'San Francisco',
          region: 'CA',
          code: '94102',
          country: 'USA'
        }
      },
      {
        fn: 'Jane Smith',
        email: 'jane@example.com',
        tel: '555-9876',
        org: 'TechCorp',
        title: 'Marketing Director'
      },
      {
        fn: 'Robert Davis',
        email: 'robert@example.com',
        tel: '555-0199',
        org: 'Google',
        title: 'Staff Engineer'
      }
    ];

    let created = 0;
    for (const contact of contacts) {
      try {
        const vcard = this.buildVcard(contact);
        await this.client.createVCard({
          addressBook: { url: this.testAddressBookUrl },
          filename: `${contact.fn.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.vcf`,
          vCardString: vcard,
        });
        created++;
        console.log(`  ✅ Created: ${contact.fn}`);
      } catch (error) {
        console.log(`  ⚠️  Failed to create ${contact.fn}: ${error.message}`);
      }
    }

    console.log(`✅ Created ${created}/${contacts.length} test contacts\n`);
  }

  /**
   * Generate test todos
   */
  async generateTestTodos() {
    console.log('Generating test todos...');

    const todos = [
      {
        summary: 'Buy groceries',
        description: 'Milk, eggs, bread, vegetables',
        status: 'NEEDS-ACTION',
        priority: 5,
        due: '2025-10-08T23:59:59Z'
      },
      {
        summary: 'Call dentist',
        description: 'Schedule 6-month checkup',
        status: 'NEEDS-ACTION',
        priority: 3,
        due: '2025-10-10T17:00:00Z'
      },
      {
        summary: 'Finish report',
        description: 'Complete quarterly sales report',
        status: 'IN-PROCESS',
        priority: 1,
        due: '2025-10-11T23:59:59Z',
        percentComplete: 60
      },
      {
        summary: 'Review code',
        description: 'Review PR #123 from team',
        status: 'NEEDS-ACTION',
        priority: 2,
        due: '2025-10-09T12:00:00Z'
      },
      {
        summary: 'Clean garage',
        description: 'Weekend chore',
        status: 'NEEDS-ACTION',
        priority: 7,
        due: '2025-10-12T18:00:00Z'
      },
      {
        summary: 'Prepare presentation',
        description: 'Quarterly results presentation for board meeting',
        status: 'IN-PROCESS',
        priority: 1,
        due: '2025-10-14T09:00:00Z',
        percentComplete: 40
      },
      {
        summary: 'Write blog post',
        description: 'Technical blog about new features',
        status: 'IN-PROCESS',
        priority: 5,
        due: '2025-10-20T23:59:59Z',
        percentComplete: 50
      },
      {
        summary: 'Project Alpha planning',
        description: 'Initial planning for new project',
        status: 'NEEDS-ACTION',
        priority: 2,
        due: '2025-10-15T16:00:00Z'
      },
      {
        summary: 'Update documentation',
        description: 'Update API documentation',
        status: 'COMPLETED',
        priority: 4,
        due: '2025-10-05T23:59:59Z',
        percentComplete: 100,
        completed: '2025-10-05T14:30:00Z'
      },
      {
        summary: 'Old overdue task',
        description: 'This task is overdue',
        status: 'NEEDS-ACTION',
        priority: 8,
        due: '2025-10-01T23:59:59Z'
      }
    ];

    let created = 0;
    for (const todo of todos) {
      try {
        const ical = this.buildTodoIcal(todo);
        await this.client.createCalendarObject({
          calendar: { url: this.testCalendarUrl },
          filename: `${todo.summary.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.ics`,
          iCalString: ical,
        });
        created++;
        console.log(`  ✅ Created: ${todo.summary} (${todo.status}, P${todo.priority})`);
      } catch (error) {
        console.log(`  ⚠️  Failed to create ${todo.summary}: ${error.message}`);
      }
    }

    console.log(`✅ Created ${created}/${todos.length} test todos\n`);
  }

  /**
   * Build iCalendar string for event
   */
  buildEventIcal(event) {
    const comp = new ICAL.Component(['vcalendar', [], []]);
    comp.updatePropertyWithValue('version', '2.0');
    comp.updatePropertyWithValue('prodid', '-//tsdav-mcp-server-test//NONSGML v1.2.1//EN');

    const vevent = new ICAL.Component('vevent');
    vevent.updatePropertyWithValue('uid', `${Date.now()}-${Math.random().toString(36).substr(2, 9)}@test`);
    vevent.updatePropertyWithValue('dtstamp', ICAL.Time.now());
    vevent.updatePropertyWithValue('dtstart', ICAL.Time.fromDateTimeString(event.dtstart));
    vevent.updatePropertyWithValue('dtend', ICAL.Time.fromDateTimeString(event.dtend));
    vevent.updatePropertyWithValue('summary', event.summary);

    if (event.description) vevent.updatePropertyWithValue('description', event.description);
    if (event.location) vevent.updatePropertyWithValue('location', event.location);
    if (event.categories) vevent.updatePropertyWithValue('categories', event.categories);
    if (event.rrule) vevent.updatePropertyWithValue('rrule', event.rrule);

    comp.addSubcomponent(vevent);
    return comp.toString();
  }

  /**
   * Build iCalendar string for todo
   */
  buildTodoIcal(todo) {
    const comp = new ICAL.Component(['vcalendar', [], []]);
    comp.updatePropertyWithValue('version', '2.0');
    comp.updatePropertyWithValue('prodid', '-//tsdav-mcp-server-test//NONSGML v1.2.1//EN');

    const vtodo = new ICAL.Component('vtodo');
    vtodo.updatePropertyWithValue('uid', `${Date.now()}-${Math.random().toString(36).substr(2, 9)}@test`);
    vtodo.updatePropertyWithValue('dtstamp', ICAL.Time.now());
    vtodo.updatePropertyWithValue('summary', todo.summary);

    if (todo.description) vtodo.updatePropertyWithValue('description', todo.description);
    if (todo.status) vtodo.updatePropertyWithValue('status', todo.status);
    if (todo.priority !== undefined) vtodo.updatePropertyWithValue('priority', todo.priority);
    if (todo.due) vtodo.updatePropertyWithValue('due', ICAL.Time.fromDateTimeString(todo.due));
    if (todo.percentComplete !== undefined) vtodo.updatePropertyWithValue('percent-complete', todo.percentComplete);
    if (todo.completed) {
      vtodo.updatePropertyWithValue('completed', ICAL.Time.fromDateTimeString(todo.completed));
    }

    comp.addSubcomponent(vtodo);
    return comp.toString();
  }

  /**
   * Build vCard string
   */
  buildVcard(contact) {
    let vcard = 'BEGIN:VCARD\n';
    vcard += 'VERSION:3.0\n';
    vcard += `FN:${contact.fn}\n`;

    // Add structured name (N: field) for better search compatibility
    // Format: "Family;Given;Additional;Prefix;Suffix"
    const nameParts = contact.fn.split(' ');
    if (nameParts.length >= 2) {
      const familyName = nameParts[nameParts.length - 1]; // Last part = family name
      const givenName = nameParts.slice(0, -1).join(' '); // Rest = given name
      vcard += `N:${familyName};${givenName};;;\n`;
    } else {
      // Single name - treat as given name
      vcard += `N:;${contact.fn};;;\n`;
    }

    if (contact.email) vcard += `EMAIL:${contact.email}\n`;
    if (contact.tel) vcard += `TEL:${contact.tel}\n`;
    if (contact.org) vcard += `ORG:${contact.org}\n`;
    if (contact.title) vcard += `TITLE:${contact.title}\n`;
    if (contact.note) vcard += `NOTE:${contact.note}\n`;

    if (contact.adr) {
      vcard += `ADR:;;${contact.adr.street};${contact.adr.city};${contact.adr.region};${contact.adr.code};${contact.adr.country}\n`;
    }

    vcard += 'END:VCARD\n';
    return vcard;
  }

  /**
   * Run full test data setup
   */
  async run() {
    console.log('='.repeat(80));
    console.log('MCP TEST DATA GENERATOR');
    console.log('='.repeat(80));
    console.log();

    try {
      await this.initialize();
      await this.createTestCalendar();
      await this.generateTestEvents();
      await this.generateTestContacts();
      await this.generateTestTodos();

      console.log('='.repeat(80));
      console.log('✅ TEST DATA SETUP COMPLETE');
      console.log('='.repeat(80));
      console.log();
      console.log('Test calendar URL:', this.testCalendarUrl);
      if (this.testAddressBookUrl) {
        console.log('Test address book URL:', this.testAddressBookUrl);
      }
      console.log();
      console.log('You can now run integration tests with real data!');
      console.log('='.repeat(80));

    } catch (error) {
      console.error('\n❌ Test data setup failed:', error);
      throw error;
    }
  }

  /**
   * Clean up test data - Delete all test calendars, events, contacts, todos
   * 🚨 SAFETY: Only works on philflow.me domains (test servers)
   */
  async cleanup() {
    console.log('Cleaning up test data...');

    // 🚨 SAFETY CHECK: Only allow cleanup on philflow.me test servers
    if (!this.config.serverUrl.includes('philflow.me')) {
      console.error('❌ SAFETY CHECK FAILED!');
      console.error(`❌ Cleanup is ONLY allowed on philflow.me test servers`);
      console.error(`❌ Current server: ${this.config.serverUrl}`);
      console.error('❌ Refusing to delete data - this could be production data!');
      throw new Error('Cleanup blocked: Not a philflow.me test server');
    }

    console.log(`✅ Safety check passed: ${this.config.serverUrl} is a philflow.me test server`);

    try {
      // Delete ALL calendars (which automatically deletes all events, todos inside them)
      const calendars = await this.client.fetchCalendars();
      console.log(`  Found ${calendars.length} calendars to delete`);

      for (const calendar of calendars) {
        // Use raw HTTP DELETE (not tsdav client - it might be cached/broken)
        const response = await fetch(calendar.url, {
          method: 'DELETE',
          headers: {
            'Authorization': `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString('base64')}`,
            'Content-Type': 'text/calendar; charset=utf-8',
          },
        });

        if (response.ok || response.status === 204 || response.status === 404) {
          console.log(`  ✅ Deleted calendar: ${calendar.displayName} (${response.status})`);
        } else {
          const errorText = await response.text();
          console.log(`  ❌ Failed to delete ${calendar.displayName}: ${response.status} ${response.statusText}`);
          console.log(`     Response: ${errorText.substring(0, 200)}`);
        }
      }

      // Delete all contacts
      try {
        const addressBooks = await this.client.fetchAddressBooks();
        for (const addressBook of addressBooks) {
          const contacts = await this.client.fetchVCards({ addressBook });
          for (const contact of contacts) {
            try {
              await this.client.deleteVCard({ vCard: contact });
              console.log(`  ✅ Deleted contact: ${contact.url}`);
            } catch (error) {
              console.log(`  ⚠️  Failed to delete contact: ${error.message}`);
            }
          }
        }
      } catch (error) {
        console.log(`  ⚠️  Failed to delete contacts: ${error.message}`);
      }

      console.log('✅ Test data cleanup complete\n');
    } catch (error) {
      console.error('❌ Cleanup failed:', error.message);
      throw error;
    }
  }
}

// CLI interface
if (import.meta.url === `file://${process.argv[1]}`) {
  const generator = new TestDataGenerator();

  generator.run()
    .then(() => {
      console.log('Done!');
      process.exit(0);
    })
    .catch(error => {
      console.error('Failed:', error);
      process.exit(1);
    });
}

export default TestDataGenerator;
