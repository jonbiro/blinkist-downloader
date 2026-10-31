import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMaxBooks } from '../lib/run-options.js';

test('default limit is safe; unlimited requires explicit zero', () => {
  assert.equal(parseMaxBooks(undefined), 1);
  assert.equal(parseMaxBooks('1'), 1);
  assert.equal(parseMaxBooks('12'), 12);
  assert.equal(parseMaxBooks('0'), 0);
});

test('invalid or mistyped limit cannot silently become an unlimited run', () => {
  for (const value of ['', 'foo', 'all', '-1', 'Infinity', 'NaN', '1.5', '0x10', '01', '1e3']) {
    assert.throws(() => parseMaxBooks(value), /Invalid MAX_BOOKS/);
  }
  assert.throws(() => parseMaxBooks('99999999999999999999'), /too large/);
});
