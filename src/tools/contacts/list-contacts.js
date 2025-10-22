import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, listContactsSchema } from '../../validation.js';
import { formatContactList } from '../../formatters.js';
import { findAddressbookOrThrow } from '../shared/helpers.js';

/**
 * List ALL contacts from an address book without filtering
 */
export const listContacts = {
  name: 'list_contacts',
  description: 'List ALL contacts from an address book without filtering. WARNING: Returns all contacts which can be thousands - use addressbook_query instead when searching for specific contacts by name, email, or organization to save tokens',
  inputSchema: {
    type: 'object',
    properties: {
      addressbook_url: {
        type: 'string',
        description: 'The URL of the address book to fetch contacts from',
      },
    },
    required: ['addressbook_url'],
  },
  handler: async (args) => {
    const validated = validateInput(listContactsSchema, args);
    const client = tsdavManager.getCardDavClient();
    const addressBooks = await client.fetchAddressBooks();
    const addressBook = findAddressbookOrThrow(addressBooks, validated.addressbook_url);

    const vcards = await client.fetchVCards({ addressBook });

    return formatContactList(vcards, addressBook);
  },
};
