import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, addressBookQuerySchema } from '../../validation.js';
import { formatContactList } from '../../formatters.js';

/**
 * Search and filter contacts efficiently
 */
export const addressbookQuery = {
  name: 'addressbook_query',
  description: '⭐ PREFERRED: Search and filter contacts efficiently (name, email, organization). Use for "find contacts with...", "search for email...", "contacts at company..." queries. Use instead of list_contacts when ANY filter is specified. Omit addressbook_url to search across ALL addressbooks automatically.',
  inputSchema: {
    type: 'object',
    properties: {
      addressbook_url: {
        type: 'string',
        description: 'Optional: Specific addressbook URL. Omit to search ALL addressbooks (recommended for "find contact X" queries). Only provide if user explicitly names an addressbook.',
      },
      name_filter: {
        type: 'string',
        description: 'Search contact names (full/given/family name). Example: "John Smith" or "Smith". At least one filter (name, email, or org) is required.',
      },
      email_filter: {
        type: 'string',
        description: 'Search contact email addresses. Use for queries like "Gmail contacts" → "@gmail.com", "work emails" → "@company.com", or specific addresses. At least one filter (name, email, or org) is required.',
      },
      organization_filter: {
        type: 'string',
        description: 'Search contact organizations/companies. Example: "Google" or "Acme Corp". At least one filter (name, email, or org) is required.',
      },
    },
    required: [],
  },
  handler: async (args) => {
    const validated = validateInput(addressBookQuerySchema, args);
    const client = tsdavManager.getCardDavClient();
    const addressBooks = await client.fetchAddressBooks();

    // Resolve which addressbooks to search (all or specific)
    const addressbooksToSearch = validated.addressbook_url
      ? addressBooks.filter(ab => ab.url === validated.addressbook_url)
      : addressBooks;

    // Collect all vcards from all selected addressbooks
    let allVCards = [];
    for (const addressBook of addressbooksToSearch) {
      const vcards = await client.fetchVCards({ addressBook });
      // Add addressbook context for display
      vcards.forEach(vcard => {
        vcard._addressbookName = addressBook.displayName || addressBook.url;
      });
      allVCards = allVCards.concat(vcards);
    }

    let filteredContacts = allVCards;

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

    // Format and return results (pass first addressbook for context, or null if multiple)
    const singleAddressbook = addressbooksToSearch.length === 1 ? addressbooksToSearch[0] : null;
    return formatContactList(filteredContacts, singleAddressbook);
  },
};
