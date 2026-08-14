import { describe, test, expect } from '@jest/globals';
import { z } from 'zod';
import ICAL from 'ical.js';
import { updateFields } from 'tsdav-utils';
import { davFieldMapSchema, validateInput } from '../src/validation.js';

const schema = z.object({ fields: davFieldMapSchema });
const parse = (fields) => validateInput(schema, { fields });

const VEVENT = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:field-map@example.com
DTSTAMP:20260101T000000Z
DTSTART:20260525T100000Z
DTEND:20260525T110000Z
SUMMARY:Original
END:VEVENT
END:VCALENDAR`;

describe('davFieldMapSchema', () => {
  test('accepts bare property names', () => {
    expect(parse({ SUMMARY: 'New title', LOCATION: 'Room 1' }).fields)
      .toEqual({ SUMMARY: 'New title', LOCATION: 'Room 1' });
  });

  test('accepts custom X-* properties', () => {
    expect(parse({ 'X-ZOOM-LINK': 'https://example.com/j/1' }).fields)
      .toEqual({ 'X-ZOOM-LINK': 'https://example.com/j/1' });
  });

  test('is optional', () => {
    expect(validateInput(schema, {}).fields).toBeUndefined();
  });

  test('rejects a key containing a colon', () => {
    expect(() => parse({ 'SUMMARY:X\r\nDESCRIPTION': 'v' }))
      .toThrow(/is not a bare property name/);
  });

  test('rejects a key containing a line break', () => {
    expect(() => parse({ 'X-A\r\nDESCRIPTION': 'v' }))
      .toThrow(/is not a bare property name/);
  });

  test('rejects a key carrying a property parameter', () => {
    // updatePropertyWithValue keys on the property name alone, so this would
    // append a second DTSTART rather than replace the existing one.
    expect(() => parse({ 'DTSTART;VALUE=DATE': '20260525' }))
      .toThrow(/parameters such as ";VALUE=DATE" are not supported/);
  });

  test('rejects a value containing a newline', () => {
    expect(() => parse({ 'X-NOTE': 'hi\nDESCRIPTION:injected' }))
      .toThrow(/must not contain line breaks/);
  });

  test('rejects a value containing a bare carriage return', () => {
    expect(() => parse({ 'X-NOTE': 'hi\rDESCRIPTION:injected' }))
      .toThrow(/must not contain line breaks/);
  });

  test('names the offending field in the error', () => {
    expect(() => parse({ SUMMARY: 'fine', 'X-BAD': 'a\nb' }))
      .toThrow(/X-BAD/);
  });
});

describe('injection payloads no longer reach updateFields', () => {
  const emit = (fields) => updateFields({ data: VEVENT }, parse(fields).fields);

  test('accepted fields still update the event', () => {
    const out = emit({ SUMMARY: 'New title', STATUS: 'CANCELLED' });
    const vevent = new ICAL.Component(ICAL.parse(out)).getFirstSubcomponent('vevent');
    expect(vevent.getFirstPropertyValue('summary')).toBe('New title');
    expect(vevent.getFirstPropertyValue('status')).toBe('CANCELLED');
    expect(vevent.getAllProperties('summary')).toHaveLength(1);
  });

  test('a second VEVENT cannot be injected through a value', () => {
    expect(() => emit({
      'X-NOTE': 'hi\nEND:VEVENT\nBEGIN:VEVENT\nUID:evil@example.com\nSUMMARY:Ghost',
    })).toThrow(/must not contain line breaks/);
  });

  test('a VALARM cannot be attached through a value', () => {
    expect(() => emit({
      'X-NOTE': 'v\nBEGIN:VALARM\nACTION:EMAIL\nATTENDEE:mailto:attacker@example.com\nTRIGGER:-PT15M\nEND:VALARM',
    })).toThrow(/must not contain line breaks/);
  });

  test('a property cannot be injected through a key', () => {
    expect(() => emit({ 'X-A\r\nDESCRIPTION:injected\r\nX-B': 'v' }))
      .toThrow(/is not a bare property name/);
  });

  test('a parameterised key cannot produce a duplicate DTSTART', () => {
    expect(() => emit({ 'DTSTART;VALUE=DATE': '20260525' }))
      .toThrow(/not a bare property name/);
  });
});
