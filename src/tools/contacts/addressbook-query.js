import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, addressBookQuerySchema } from '../../validation.js';
import { formatContactList } from '../../formatters.js';
import { findAddressbookOrThrow } from '../shared/helpers.js';

/**
 * Search and filter contacts efficiently
 */
export const addressbookQuery = {
  name: 'addressbook_query',
  description: 'PREFERRED: Search and filter contacts efficiently by name (full/given/family), email, or organization. Use this instead of list_contacts when user asks "find contacts with X" or "show me contacts at Y company" to avoid loading thousands of contacts. Much more token-efficient than list_contacts',
  inputSchema: {
    type: 'object',
    properties: {
      addressbook_url: {
        type: 'string',
        description: 'The URL of the address book to query',
      },
      name_filter: {
        type: 'string',
        description: 'Optional: Filter by name (case-insensitive substring match against FN, given name, or family name). Use when user asks "find contact John" or "show me people named Smith"',
      },
      email_filter: {
        type: 'string',
        description: 'Optional: Filter by email address (case-insensitive substring match). Use when user asks "find contact with email X" or "show me Gmail contacts"',
      },
      organization_filter: {
        type: 'string',
        description: 'Optional: Filter by organization/company (case-insensitive substring match). Use when user asks "find contacts at company X" or "show me people at Google"',
      },
    },
    required: ['addressbook_url'],
  },
  handler: async (args) => {
    const validated = validateInput(addressBookQuerySchema, args);
    const client = tsdavManager.getCardDavClient();
    const addressBooks = await client.fetchAddressBooks();
    const addressBook = findAddressbookOrThrow(addressBooks, validated.addressbook_url);

    const vcards = await client.fetchVCards({ addressBook });

    let filteredContacts = vcards;

    if (validated.name_filter) {
      const nameLower = validated.name_filter.toLowerCase();
      filteredContacts = filteredContacts.filter(vcard => {
        const fn = vcard.data?.match(/FN:(.+)/)?.[1] || '';
        const n = vcard.data?.match(/N:(.+)/)?.[1] || '';
        return fn.toLowerCase().includes(nameLower) || n.toLowerCase().includes(nameLower);
      });
    }

    if (validated.email_filter) {
      const emailLower = validated.email_filter.toLowerCase();
      filteredContacts = filteredContacts.filter(vcard => {
        const email = vcard.data?.match(/EMAIL[^:]*:(.+)/)?.[1] || '';
        return email.toLowerCase().includes(emailLower);
      });
    }

    if (validated.organization_filter) {
      const orgLower = validated.organization_filter.toLowerCase();
      filteredContacts = filteredContacts.filter(vcard => {
        const org = vcard.data?.match(/ORG:(.+)/)?.[1] || '';
        return org.toLowerCase().includes(orgLower);
      });
    }

    return formatContactList(filteredContacts, addressBook);
  },
};
