import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, addressBookQuerySchema } from '../../validation.js';
import { formatContactList } from '../../formatters.js';
import { limitResults, DEFAULT_RESULT_LIMIT } from '../shared/helpers.js';
import { parseObjects, textValues, contactNames, organizations, containsText, textKey } from '../shared/query-objects.js';

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
      limit: {
        type: 'number',
        description: 'Maximum number of contacts to return (default 20, max 500). You get them alphabetically by name, and the response states how many matched in total.',
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

    // Client-side filtering on parsed values; see query-objects.js
    let parsed = parseObjects(allVCards, 'vcard');

    if (validated.name_filter) {
      parsed = parsed.filter(({ main }) => containsText(contactNames(main), validated.name_filter));
    }

    if (validated.email_filter) {
      // a contact with several addresses matches on any of them
      parsed = parsed.filter(({ main }) => containsText(textValues(main, 'email'), validated.email_filter));
    }

    if (validated.organization_filter) {
      // ORG is structured (name;unit;...); matched as the contact display shows it
      parsed = parsed.filter(({ main }) =>
        containsText(organizations(main), validated.organization_filter));
    }

    const addressBookName = addressbooksToSearch.length === 1
      ? addressbooksToSearch[0]
      : `All Address Books (${addressbooksToSearch.length})`;

    const { items, total } = limitResults(
      parsed,
      validated.limit ?? DEFAULT_RESULT_LIMIT,
      (p) => textKey(p, 'fn')
    );

    return formatContactList(items.map(({ object }) => object), addressBookName, total);
  },
};
