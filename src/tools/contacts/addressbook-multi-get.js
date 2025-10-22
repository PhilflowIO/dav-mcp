import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, addressBookMultiGetSchema } from '../../validation.js';
import { formatContactList } from '../../formatters.js';

/**
 * Batch fetch multiple specific contacts by their URLs
 */
export const addressbookMultiGet = {
  name: 'addressbook_multi_get',
  description: 'Batch fetch multiple specific contacts by their URLs. Use when you have exact contact URLs and want to retrieve their details',
  inputSchema: {
    type: 'object',
    properties: {
      addressbook_url: {
        type: 'string',
        description: 'The URL of the address book',
      },
      contact_urls: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of contact URLs to fetch',
      },
    },
    required: ['addressbook_url', 'contact_urls'],
  },
  handler: async (args) => {
    const validated = validateInput(addressBookMultiGetSchema, args);
    const client = tsdavManager.getCardDavClient();

    const vcards = await client.addressBookMultiGet({
      url: validated.addressbook_url,
      props: [{ name: 'getetag', namespace: 'DAV:' }, { name: 'address-data', namespace: 'urn:ietf:params:xml:ns:carddav' }],
      objectUrls: validated.contact_urls,
    });

    return formatContactList(vcards, { url: validated.addressbook_url });
  },
};
