import { tsdavManager } from '../../tsdav-client.js';
import { formatAddressBookList } from '../../formatters.js';

/**
 * List all available address books from the CardDAV server
 */
export const listAddressbooks = {
  name: 'list_addressbooks',
  description: 'List all available address books from the CardDAV server. Use this to get address book URLs needed for other contact operations',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    const client = tsdavManager.getCardDavClient();
    const addressBooks = await client.fetchAddressBooks();

    return formatAddressBookList(addressBooks);
  },
};
