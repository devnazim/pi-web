import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTextSearchPatternInput } from './textSearch';

test('text search patterns split on commas outside glob braces and brackets', () => {
  assert.deepEqual(parseTextSearchPatternInput('*.ts, src/**'), ['*.ts', 'src/**']);
  assert.deepEqual(parseTextSearchPatternInput('*.{ts,tsx}, [a,b].js, test/**'), ['*.{ts,tsx}', '[a,b].js', 'test/**']);
  assert.deepEqual(parseTextSearchPatternInput('{{src,web},tests}/**, *.ts'), ['{{src,web},tests}/**', '*.ts']);
  assert.deepEqual(parseTextSearchPatternInput('[{].txt, []a,].txt, [!],].txt, *.ts'), ['[{].txt', '[]a,].txt', '[!],].txt', '*.ts']);
});

test('text search patterns normalize separators, whitespace, and trailing slashes', () => {
  assert.deepEqual(parseTextSearchPatternInput(' src\\**\\ , , tests/**/ '), ['src/**', 'tests/**']);
  assert.deepEqual(parseTextSearchPatternInput(''), []);
});
