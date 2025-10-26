import { tsdavManager } from '../../tsdav-client.js';
import { validateInput } from '../../validation.js';
import { formatSuccess, formatError } from '../../formatters.js';
import { z } from 'zod';
import { updateVCardFields as tsdavUpdateVCardFields } from 'tsdav';

/**
 * Schema for field-based vCard updates
 * Supports all major vCard fields from tsdav v2.2.0
 */
const updateContactFieldsSchema = z.object({
  vcard_url: z.string().url('vCard URL must be a valid URL'),
  vcard_etag: z.string().min(1, 'vCard etag is required'),
  fields: z.object({
    full_name: z.string().optional(),     // FN (Formatted Name) - required in vCard
    family_name: z.string().optional(),   // N - Family name
    given_name: z.string().optional(),    // N - Given name
    email: z.string().optional(),         // EMAIL
    phone: z.string().optional(),         // TEL
    organization: z.string().optional(),  // ORG
    title: z.string().optional(),         // TITLE (job title)
    note: z.string().optional(),          // NOTE
    url: z.string().optional(),           // URL
  }).optional()
});

/**
 * Wrapper for tsdav's native updateVCardFields function
 * Uses the field-based update implementation from tsdav v2.2.0
 *
 * Supported fields:
 * - full_name (FN - formatted name, required)
 * - family_name, given_name (N - structured name)
 * - email (EMAIL)
 * - phone (TEL)
 * - organization (ORG)
 * - title (TITLE - job title)
 * - note (NOTE)
 * - url (URL)
 */
export const updateContactFields = {
  name: 'update_contact',
  description: 'PREFERRED: Update contact fields (name, email, phone, organization, etc.) easily without vCard formatting. Use this for simple contact updates. For advanced vCard properties, use update_contact_raw instead. Supports: full_name, email, phone, organization, title, note, url.',
  inputSchema: {
    type: 'object',
    properties: {
      vcard_url: {
        type: 'string',
        description: 'The URL of the vCard to update'
      },
      vcard_etag: {
        type: 'string',
        description: 'The etag of the vCard (required for conflict detection)'
      },
      fields: {
        type: 'object',
        description: 'Fields to update - only include fields you want to change',
        properties: {
          full_name: {
            type: 'string',
            description: 'Full formatted name (e.g., "John Doe")'
          },
          family_name: {
            type: 'string',
            description: 'Family/last name'
          },
          given_name: {
            type: 'string',
            description: 'Given/first name'
          },
          email: {
            type: 'string',
            description: 'Email address'
          },
          phone: {
            type: 'string',
            description: 'Phone number'
          },
          organization: {
            type: 'string',
            description: 'Organization/company name'
          },
          title: {
            type: 'string',
            description: 'Job title'
          },
          note: {
            type: 'string',
            description: 'Notes/comments'
          },
          url: {
            type: 'string',
            description: 'Web URL'
          }
        }
      }
    },
    required: ['vcard_url', 'vcard_etag']
  },
  handler: async (args) => {
    try {
      const validated = validateInput(updateContactFieldsSchema, args);
      const client = tsdavManager.getCardDavClient();

      // Step 1: Fetch the current vCard from server
      const addressBookUrl = validated.vcard_url.substring(0, validated.vcard_url.lastIndexOf('/') + 1);
      const currentVCards = await client.fetchVCards({
        addressBook: { url: addressBookUrl },
        objectUrls: [validated.vcard_url]
      });

      if (!currentVCards || currentVCards.length === 0) {
        throw new Error('Contact not found');
      }

      const vCardObject = currentVCards[0];

      // Step 2: Transform snake_case field names to vCard property names
      // Map our API field names to tsdav's expected vCard field names
      const tsdavFields = {};
      if (validated.fields) {
        if (validated.fields.full_name !== undefined) {
          tsdavFields.FN = validated.fields.full_name;
        }
        if (validated.fields.family_name !== undefined || validated.fields.given_name !== undefined) {
          // N field format: "Family;Given;Additional;Prefix;Suffix"
          tsdavFields.N = `${validated.fields.family_name || ''};${validated.fields.given_name || ''};;;`;
        }
        if (validated.fields.email !== undefined) {
          tsdavFields.EMAIL = validated.fields.email;
        }
        if (validated.fields.phone !== undefined) {
          tsdavFields.TEL = validated.fields.phone;
        }
        if (validated.fields.organization !== undefined) {
          tsdavFields.ORG = validated.fields.organization;
        }
        if (validated.fields.title !== undefined) {
          tsdavFields.TITLE = validated.fields.title;
        }
        if (validated.fields.note !== undefined) {
          tsdavFields.NOTE = validated.fields.note;
        }
        if (validated.fields.url !== undefined) {
          tsdavFields.URL = validated.fields.url;
        }
      }

      // Step 3: Use tsdav's native updateVCardFields function
      const result = tsdavUpdateVCardFields(vCardObject, tsdavFields);

      // Step 4: Send the updated vCard back to server
      const updateResponse = await client.updateVCard({
        vCard: {
          url: validated.vcard_url,
          data: result.data,
          etag: validated.vcard_etag
        }
      });

      return formatSuccess('Contact updated successfully', {
        etag: updateResponse.etag,
        updated_fields: Object.keys(validated.fields || {}),
        modified: result.modified,
        warnings: result.warnings
      });

    } catch (error) {
      return formatError('update_contact', error);
    }
  }
};
