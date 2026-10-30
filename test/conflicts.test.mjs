import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateResolutions } from '../src/conflict-review.mjs';

test('conflict decisions cover every path including deletion and competing additions', () => {
  const conflicts = [{ path: 'removed.txt', base: 'base', ours: null, theirs: 'edited' },
    { path: 'new.txt', base: null, ours: 'one', theirs: 'two' }];
  assert.deepEqual(validateResolutions(conflicts, { 'removed.txt': null, 'new.txt': 'both' }),
    { 'removed.txt': null, 'new.txt': 'both' });
  assert.throws(() => validateResolutions(conflicts, { 'removed.txt': null }), /exactly/);
  assert.throws(() => validateResolutions(conflicts,
    { 'removed.txt': null, 'new.txt': 'both', 'unrelated.txt': 'no' }), /exactly/);
});

test('conflict decisions reject unresolved markers and oversized content', () => {
  const conflicts = [{ path: 'answer.txt' }];
  for (const value of ['<<<<<<< branch\nanswer', '=======\nanswer', '>>>>>>> other',
    '||||||| base', 'x'.repeat(100001), 42]) {
    assert.throws(() => validateResolutions(conflicts, { 'answer.txt': value }), /Invalid/);
  }
  assert.throws(() => validateResolutions(conflicts, []), /exactly/);
});
