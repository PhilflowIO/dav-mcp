import { tsdavManager } from '../../tsdav-client.js';
import { validateInput } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';
import { z } from 'zod';
import { updateFields } from 'tsdav-utils';

/**
 * Schema for field-based vCard updates
 * Supports all RFC 6350 vCard properties via tsdav-utils
 * Common fields: FN, N, EMAIL, TEL, ORG, TITLE, NOTE, URL, ADR
 * Custom properties: Any X-* property
 */
const updateContactFieldsSchema = z.object({
  vcard_url: z.string().url('vCard URL must be a valid URL'),
  vcard_etag: z.string().min(1, 'vCard etag is required'),
  fields: z.record(z.string()).optional()
});

/**
 * Field-agnostic contact update tool powered by tsdav-utils
 * Supports all RFC 6350 vCard properties without validation
 *
 * Features:
 * - Any standard vCard property (FN, N, EMAIL, TEL, ORG, TITLE, ADR, etc.)
 * - Custom X-* properties for extensions
 * - Field-agnostic: no pre-defined field list required
 */
export const updateContactFields = {
  name: 'update_contact',
  description: 'PREFERRED: Update contact fields without vCard formatting. Supports: FN (full name), N (structured name), EMAIL, TEL (phone), ORG (organization), TITLE (job title), NOTE, URL, ADR (address), BDAY (birthday), and any RFC 6350 vCard property including custom X-* properties.',
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
        description: 'Fields to update - use UPPERCASE property names (e.g., FN, EMAIL, TEL). Any RFC 6350 vCard property or custom X-* property is supported.',
        additionalProperties: {
          type: 'string'
        },
        properties: {
          FN: {
            type: 'string',
            description: 'Full formatted name (e.g., "John Doe")'
          },
          N: {
            type: 'string',
            description: 'Structured name (format: "Family;Given;Additional;Prefix;Suffix")'
          },
          EMAIL: {
            type: 'string',
            description: 'Email address'
          },
          TEL: {
            type: 'string',
            description: 'Phone number'
          },
          ORG: {
            type: 'string',
            description: 'Organization/company name'
          },
          TITLE: {
            type: 'string',
            description: 'Job title'
          },
          NOTE: {
            type: 'string',
            description: 'Notes/comments'
          },
          URL: {
            type: 'string',
            description: 'Web URL'
          },
          ADR: {
            type: 'string',
            description: 'Address (format: "POBox;Extended;Street;City;Region;PostalCode;Country")'
          },
          BDAY: {
            type: 'string',
            description: 'Birthday (ISO 8601 format: 1990-01-01)'
          }
        }
      }
    },
    required: ['vcard_url', 'vcard_etag']
  },
  handler: async (args) => {
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

    // Step 2: Update fields using tsdav-utils (field-agnostic)
    // Accepts any RFC 6350 vCard property name (UPPERCASE)
    const updatedData = updateFields(vCardObject, validated.fields || {});

    // Step 3: Send the updated vCard back to server
    const updateResponse = await client.updateVCard({
      vCard: {
        url: validated.vcard_url,
        data: updatedData,
        etag: validated.vcard_etag
      }
    });

    return formatSuccess('Contact updated successfully', {
      etag: updateResponse.etag,
      updated_fields: Object.keys(validated.fields || {}),
      message: `Updated ${Object.keys(validated.fields || {}).length} field(s): ${Object.keys(validated.fields || {}).join(', ')}`
    });
  }
};
