import { describe, test, expect } from '@jest/globals';
import { unfoldLines, parseContentLine } from '../src/tools/shared/content-lines.js';

describe('unfoldLines', () => {
  test('splits at CRLF, LF and a lone CR, and joins folded lines', () => {
    expect(unfoldLines('A:1\r\nB:2\nC:3\rD:4')).toEqual(['A:1', 'B:2', 'C:3', 'D:4']);
    expect(unfoldLines('A:1\r\n 23\r\n\t45\r\nB:2')).toEqual(['A:12345', 'B:2']);
  });
});

describe('parseContentLine', () => {
  test('name, parameters and the value after the first colon outside quotes', () => {
    const line = parseContentLine('freebusy;X-NOTE="a;b:c,d";fbtype=BUSY,FREE:20260525T100000Z/PT1H');
    expect(line.name).toBe('FREEBUSY');
    expect(line.params.get('X-NOTE')).toEqual(['a;b:c,d']);
    expect(line.params.get('FBTYPE')).toEqual(['BUSY', 'FREE']);
    expect(line.value).toBe('20260525T100000Z/PT1H');
  });

  test('a value may hold colons', () => {
    expect(parseContentLine('X-URL:https://example.com/a').value).toBe('https://example.com/a');
  });

  test('what is not a content line is null', () => {
    for (const line of ['', 'no colon', ';X=1:v', 'A;X:v', 'A;X="open:v', 'A B:v']) {
      expect(parseContentLine(line)).toBeNull();
    }
  });
});
