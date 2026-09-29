# ConcurrentHashArray

A fixed-capacity hash array of key-value pairs with per-slot compare-and-swap
semantics, for single-threaded async code that needs optimistic updates without
lost updates across `await` boundaries.

## Usage

```js
import { ConcurrentHashMap, EMPTY, CAS_FAILED } from 'concurrent-hash-array';

const m = new ConcurrentHashMap(64);
m.set('user:1', { name: 'Ada' });

const entry = m.getEntry('user:1');
// ... await some async work ...
if (m.compareAndSet('user:1', entry, { name: 'Ada Lovelace' }) === true) {
  // our update won
} else {
  // someone else changed it; re-read and retry
}
```

## Why this exists

JavaScript has no true cross-thread shared mutable object heap, so classic
lock-free concurrent data structures are not directly applicable. The actual
concurrency model of JS is interleaved async continuations within one event
loop. This library provides the primitive that model needs: a per-slot
compare-and-swap that is atomic with respect to those interleavings, because
the read-compare-write runs synchronously with no `await` between the steps.

The trade-off: the array is fixed at construction. A resizable array under CAS
would require atomically swapping both the array reference and a slot, which is
a double-compare-swap JS does not offer. If you need more capacity, allocate a
new map and migrate — that migration is your concern because it requires
application-level consistency reasoning.

## Edge cases you will hit

- `get` returns the exported `EMPTY` sentinel for absent keys, not `undefined`,
  so that `undefined` is a valid stored value. Compare with `=== EMPTY`.
- `compareAndSet` expects the exact `Entry` object you observed via `getEntry`,
  compared by reference identity. `set` mutates the existing `Entry` in place,
  so a stale `Entry` reference still refers to the current slot — CAS against it
  will succeed. A real CAS failure happens when the key is absent but you
  expected an entry, or present but you expected `EMPTY`.
- `set` throws `RangeError` when the map is full. Keep the load factor below
  ~0.7; linear probing degrades under clustering.
- Deleted slots become tombstones and are recycled by later `set` calls. You do
  not need to manage this yourself.

## Exports

- `ConcurrentHashMap` — the class. Constructor takes a positive integer
  capacity.
- `EMPTY` — sentinel returned by `get` for absent keys; also passed as
  `expected` to `compareAndSet` to require absence.
- `CAS_FAILED` — sentinel returned by `compareAndSet` on mismatch.

Methods: `get(key)`, `getEntry(key)`, `set(key, value)`,
`compareAndSet(key, expected, value)`, `delete(key)`. Properties: `size`,
`capacity`.
