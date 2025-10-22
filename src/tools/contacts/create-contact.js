import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, createContactSchema, sanitizeVCardString } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';
import { findAddressbookOrThrow } from '../shared/helpers.js';

/**
 * Create a new contact (vCard)
 */
export const createContact = {
  name: 'create_contact',
  description: 'Create a new contact (vCard) with name, email, phone, organization, and other details',
  inputSchema: {
    type: 'object',
    properties: {
      addressbook_url: {
        type: 'string',
        description: 'The URL of the address book to create the contact in',
      },
      full_name: {
        type: 'string',
        description: 'Full name of the contact',
      },
      family_name: {
        type: 'string',
        description: 'Family/last name',
      },
      given_name: {
        type: 'string',
        description: 'Given/first name',
      },
      email: {
        type: 'string',
        description: 'Email address (optional)',
      },
      phone: {
        type: 'string',
        description: 'Phone number (optional)',
      },
      organization: {
        type: 'string',
        description: 'Organization/company (optional)',
      },
      note: {
        type: 'string',
        description: 'Additional notes (optional)',
      },
    },
    required: ['addressbook_url', 'full_name'],
  },
  handler: async (args) => {
    const validated = validateInput(createContactSchema, args);
    const client = tsdavManager.getCardDavClient();
    const addressBooks = await client.fetchAddressBooks();
    const addressBook = findAddressbookOrThrow(addressBooks, validated.addressbook_url);

    const uid = `contact-${Date.now()}`;
    const fullName = sanitizeVCardString(validated.full_name);
    const familyName = validated.family_name ? sanitizeVCardString(validated.family_name) : '';
    const givenName = validated.given_name ? sanitizeVCardString(validated.given_name) : '';
    const email = validated.email ? sanitizeVCardString(validated.email) : '';
    const phone = validated.phone ? sanitizeVCardString(validated.phone) : '';
    const organization = validated.organization ? sanitizeVCardString(validated.organization) : '';
    const note = validated.note ? sanitizeVCardString(validated.note) : '';

    const vCardString = `BEGIN:VCARD
VERSION:3.0
UID:${uid}
FN:${fullName}${familyName || givenName ? `\nN:${familyName};${givenName};;;` : ''}${email ? `\nEMAIL;TYPE=INTERNET:${email}` : ''}${phone ? `\nTEL;TYPE=CELL:${phone}` : ''}${organization ? `\nORG:${organization}` : ''}${note ? `\nNOTE:${note}` : ''}
REV:${new Date().toISOString()}
END:VCARD`;

    const response = await client.createVCard({
      addressBook,
      filename: `${uid}.vcf`,
      vCardString,
    });

    return formatSuccess('Contact created successfully', {
      url: response.url,
      etag: response.etag,
      fullName: validated.full_name,
    });
  },
};
