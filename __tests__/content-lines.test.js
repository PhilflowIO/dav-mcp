import { describe, test, expect } from '@jest/globals';
import { unfoldLines, logicalLines, parseContentLine } from '../src/tools/shared/content-lines.js';

describe('unfoldLines', () => {
  test('splits at CRLF and LF, and at CR only in a text without LF, and joins folded lines', () => {
    expect(unfoldLines('A:1\r\nB:2\nC:3\rD:4')).toEqual(['A:1', 'B:2', 'C:3\rD:4']);
    expect(unfoldLines('A:1\rB:2\r')).toEqual(['A:1', 'B:2']);
    expect(unfoldLines('A:1\r\n 23\r\n\t45\r\nB:2')).toEqual(['A:12345', 'B:2']);
  });
});

describe('logicalLines', () => {
  test('each line knows where it sits, folds and line ending included', () => {
    const text = 'A:1\r\n 2\r\nB:x\ry\nC:3';
    expect(logicalLines(text).map(({ line, start, end }) => [line, text.slice(start, end)]))
      .toEqual([['A:12', 'A:1\r\n 2\r\n'], ['B:x\ry', 'B:x\ry\n'], ['C:3', 'C:3']]);
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
