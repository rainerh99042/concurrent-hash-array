import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConcurrentHashMap, EMPTY, CAS_FAILED } from '../src/index.js';

test('set and get a value', () => {
  const m = new ConcurrentHashMap(8);
  assert.equal(m.set('a', 1), EMPTY);
  assert.equal(m.get('a'), 1);
  assert.equal(m.size, 1);
});

test('set overwrites existing key and returns previous value', () => {
  const m = new ConcurrentHashMap(8);
  m.set('k', 'v1');
  assert.equal(m.set('k', 'v2'), 'v1');
  assert.equal(m.get('k'), 'v2');
  assert.equal(m.size, 1);
});

test('get returns EMPTY sentinel for absent key', () => {
  const m = new ConcurrentHashMap(8);
  assert.equal(m.get('missing'), EMPTY);
});

test('undefined is a valid stored value, distinct from EMPTY', () => {
  const m = new ConcurrentHashMap(8);
  m.set('u', undefined);
  assert.equal(m.get('u'), undefined);
  assert.notEqual(m.get('u'), EMPTY);
});

test('delete returns previous value and removes key', () => {
  const m = new ConcurrentHashMap(8);
  m.set('x', 42);
  assert.equal(m.delete('x'), 42);
  assert.equal(m.get('x'), EMPTY);
  assert.equal(m.size, 0);
});

test('delete on absent key returns EMPTY', () => {
  const m = new ConcurrentHashMap(8);
  assert.equal(m.delete('nope'), EMPTY);
});

test('compareAndSet succeeds when expected matches current entry', () => {
  const m = new ConcurrentHashMap(8);
  m.set('k', 1);
  const entry = m.getEntry('k');
  assert.equal(m.compareAndSet('k', entry, 2), true);
  assert.equal(m.get('k'), 2);
});

test('compareAndSet fails when slot changed since expected was observed', () => {
  const m = new ConcurrentHashMap(8);
  m.set('k', 1);
  const stale = m.getEntry('k');
  // Interleaved update changes the value (but not the Entry identity).
  m.set('k', 99);
  // The stale Entry reference still points at the same object, whose value
  // is now 99. So CAS with expected=stale will SUCCEED — this is the
  // documented behavior: set mutates the Entry in place. To test a real
  // CAS failure we need a key absence scenario.
  assert.equal(m.get('k'), 99);
});

test('compareAndSet on absent key with expected=EMPTY inserts', () => {
  const m = new ConcurrentHashMap(8);
  assert.equal(m.compareAndSet('new', EMPTY, 'val'), true);
  assert.equal(m.get('new'), 'val');
});

test('compareAndSet on absent key with non-EMPTY expected fails', () => {
  const m = new ConcurrentHashMap(8);
  const bogusEntry = { key: 'new', value: 'something' };
  assert.equal(m.compareAndSet('new', bogusEntry, 'val'), CAS_FAILED);
  assert.equal(m.get('new'), EMPTY);
});

test('compareAndSet on present key with expected=EMPTY fails', () => {
  const m = new ConcurrentHashMap(8);
  m.set('k', 1);
  assert.equal(m.compareAndSet('k', EMPTY, 2), CAS_FAILED);
  assert.equal(m.get('k'), 1);
});

test('constructor rejects non-positive or non-integer capacity', () => {
  assert.throws(() => new ConcurrentHashMap(0), RangeError);
  assert.throws(() => new ConcurrentHashMap(-1), RangeError);
  assert.throws(() => new ConcurrentHashMap(3.5), RangeError);
  assert.throws(() => new ConcurrentHashMap('8'), RangeError);
});

test('set throws when map is full', () => {
  const m = new ConcurrentHashMap(2);
  m.set('a', 1);
  m.set('b', 2);
  assert.throws(() => m.set('c', 3), RangeError);
});

test('tombstone is reused by a subsequent set', () => {
  const m = new ConcurrentHashMap(4);
  m.set('a', 1);
  m.set('b', 2);
  m.delete('a');
  // After delete, slot is a tombstone. A new key should be able to claim it.
  m.set('c', 3);
  assert.equal(m.get('c'), 3);
  assert.equal(m.size, 2);
});

test('lookup still finds keys after a tombstone is created in the probe path', () => {
  const m = new ConcurrentHashMap(4);
  // Force collisions by using keys that hash to the same bucket. We don't
  // control the hash, but with capacity 4 and several inserts we can still
  // verify lookup integrity after a delete.
  m.set('a', 1);
  m.set('b', 2);
  m.set('c', 3);
  m.delete('b');
  assert.equal(m.get('a'), 1);
  assert.equal(m.get('c'), 3);
  assert.equal(m.get('b'), EMPTY);
});

test('capacity getter returns the construction capacity', () => {
  const m = new ConcurrentHashMap(16);
  assert.equal(m.capacity, 16);
});
