import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, addressBookMultiGetSchema } from '../../validation.js';
import { formatContactList, withMissingObjects } from '../../formatters.js';
import { multiGetObjects } from '../shared/multiget.js';

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

    const { found, missing } = await multiGetObjects(client, {
      kind: 'addressbook',
      collectionUrl: validated.addressbook_url,
      objectUrls: validated.contact_urls,
    });

    return withMissingObjects(formatContactList(found, { url: validated.addressbook_url }), missing);
  },
};
