import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, updateContactSchema } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';

/**
 * Update an existing contact with raw vCard data
 */
export const updateContactRaw = {
  name: 'update_contact_raw',
  description: 'ADVANCED: Update contact with raw vCard data. Requires manual vCard formatting - use update_contact instead for simple field updates (name, email, phone). Only use this if you have complete pre-formatted vCard data or need to update advanced vCard properties.',
  inputSchema: {
    type: 'object',
    properties: {
      vcard_url: {
        type: 'string',
        description: 'The URL of the vCard to update',
      },
      vcard_etag: {
        type: 'string',
        description: 'The etag of the vCard',
      },
      updated_vcard_data: {
        type: 'string',
        description: 'The complete updated vCard data',
      },
    },
    required: ['vcard_url', 'vcard_etag', 'updated_vcard_data'],
  },
  handler: async (args) => {
    const validated = validateInput(updateContactSchema, args);
    const client = tsdavManager.getCardDavClient();

    const response = await client.updateVCard({
      vCard: {
        url: validated.vcard_url,
        data: validated.updated_vcard_data,
        etag: validated.vcard_etag,
      },
    });

    return formatSuccess('Contact updated successfully', {
      etag: response.etag,
    });
  },
};
