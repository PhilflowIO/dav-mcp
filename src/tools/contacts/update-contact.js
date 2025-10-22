import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, updateContactSchema } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';

/**
 * Update an existing contact (vCard)
 */
export const updateContact = {
  name: 'update_contact',
  description: 'Update an existing contact (vCard). Requires contact URL, etag, and complete updated vCard data',
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
