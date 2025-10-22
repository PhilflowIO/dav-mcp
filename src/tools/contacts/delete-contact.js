import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, deleteContactSchema } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';

/**
 * Delete a contact (vCard) permanently
 */
export const deleteContact = {
  name: 'delete_contact',
  description: 'Delete a contact (vCard) permanently. Requires contact URL and etag',
  inputSchema: {
    type: 'object',
    properties: {
      vcard_url: {
        type: 'string',
        description: 'The URL of the vCard to delete',
      },
      vcard_etag: {
        type: 'string',
        description: 'The etag of the vCard',
      },
    },
    required: ['vcard_url', 'vcard_etag'],
  },
  handler: async (args) => {
    const validated = validateInput(deleteContactSchema, args);
    const client = tsdavManager.getCardDavClient();

    await client.deleteVCard({
      vCard: {
        url: validated.vcard_url,
        etag: validated.vcard_etag,
      },
    });

    return formatSuccess('Contact deleted successfully');
  },
};
