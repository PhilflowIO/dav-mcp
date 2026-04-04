import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, deleteContactSchema } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';

/**
 * Delete a contact (vCard) permanently
 */
export const deleteContact = {
  name: 'delete_contact',
  description: 'Permanently delete a contact (vCard) from the address book. WARNING: This action cannot be undone — the contact is removed from the server immediately. Use only when the user explicitly requests deletion. Obtain the vCard URL and etag from list_contacts or addressbook_query first. The etag ensures no conflicting changes occurred since the contact was last retrieved.',
  inputSchema: {
    type: 'object',
    properties: {
      vcard_url: {
        type: 'string',
        description: 'Full URL of the vCard to delete. Obtain from list_contacts or addressbook_query response.',
      },
      vcard_etag: {
        type: 'string',
        description: 'ETag of the vCard for conflict detection. Obtain from the same response as the vCard URL. Ensures no changes were made since retrieval.',
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
