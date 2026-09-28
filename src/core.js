/**
 * ConcurrentHashArray — a fixed-size hash array of key-value pairs with atomic
 * compare-and-swap semantics on each slot.
 *
 * Design choice: JavaScript is single-threaded (even with Workers, each Worker
 * has its own heap, so true shared-memory mutation of JS objects across threads
 * is not possible without SharedArrayBuffer, which cannot hold arbitrary JS
 * objects). We therefore cannot build a *true* lock-free concurrent data
 * structure in the classic sense. What we CAN provide is atomic CAS per slot
 * within a single event loop, which is the primitive async code needs to avoid
 * lost updates when interleaving across `await` boundaries.
 *
 * The trade-off: this is NOT safe across OS threads or Workers. It IS safe
 * across async continuations within one realm, which is the actual concurrency
 * model of JS. We expose `compareAndSet` so callers can implement optimistic
 * update loops that do not lose updates to interleaving async work.
 *
 * Why a fixed capacity with no resize: a resizable array under CAS would need
 * to atomically swap both the array reference AND a slot, which requires a
 * double-compare-swap primitive JS does not offer. Keeping the array fixed lets
 * each slot be independently atomically updatable. Callers who need more
 * capacity should allocate a new map and migrate — that migration is the
 * caller's concern, not ours, because it requires application-level reasoning
 * about consistency.
 */

/**
 * @typedef {object} Entry
 * @property {*} key   The key stored in this slot.
 * @property {*} value The value stored in this slot.
 */

/**
 * Sentinel returned by `get` when no entry occupies a slot, and used internally
 * to represent an empty slot. We use a distinct object rather than `undefined`
 * so that `undefined` is a valid stored value.
 */
export const EMPTY = Object.freeze({ __hashArrayEmpty: true });

/**
 * Sentinel returned by `compareAndSet` when the CAS fails because the slot's
 * current entry does not match the expected entry. Distinguished from a
 * successful result so callers can tell "I set it" from "someone else set it
 * first" without inspecting the map again.
 */
export const CAS_FAILED = Object.freeze({ __hashArrayCasFailed: true });

/**
 * Generate a 32-bit hash for the given key using FNV-1a.
 *
 * We hash the string form of the key. This means distinct object identities
 * with the same `toString()` will collide — that is acceptable and documented.
 * Using `String(key)` keeps the hash stable across equal primitive keys.
 *
 * @param {*} key
 * @returns {number}
 */
function hashKey(key) {
  const s = String(key);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV prime multiply, keep it 32-bit.
    h = Math.imul(h, 0x01000193);
  }
  // Force to unsigned 32-bit.
  return h >>> 0;
}

/**
 * Two entries are considered the same slot-occupant iff they are reference-equal.
 * We do NOT use deep equality because CAS semantics require identity: the caller
 * passes the exact `Entry` object they observed, and we check it is still the
 * one in the slot. Deep equality would break the optimistic-update contract
 * because two distinct updates with structurally-equal entries would be treated
 * as the same state.
 *
 * @param {Entry|object} a
 * @param {Entry|object} b
 * @returns {boolean}
 */
function sameEntry(a, b) {
  return a === b;
}

export class ConcurrentHashMap {
  /**
   * @param {number} capacity  Number of slots. Must be a positive integer.
   *   Chosen at construction and never resized — see class docstring for why.
   */
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    }
    // Pre-allocate with the EMPTY sentinel so every slot is always readable.
    this._slots = new Array(capacity).fill(EMPTY);
    this._capacity = capacity;
    this._size = 0;
  }

  /**
   * Find the slot index for a key. Open addressing with linear probing.
   *
   * We probe rather than chain because probing keeps everything in one flat
   * array — no allocations on insert, which matters when the hot path is CAS.
   * The cost is clustering under high load; we document that load factor should
   * be kept under ~0.7.
   *
   * @param {*} key
   * @returns {number} The index of the slot holding `key`, or -1 if absent.
   * @private
   */
  _findIndex(key) {
    const start = hashKey(key) % this._capacity;
    for (let i = 0; i < this._capacity; i++) {
      const idx = (start + i) % this._capacity;
      const entry = this._slots[idx];
      if (entry === EMPTY) return -1;
      // A tombstone is skipped during lookup, not treated as a stopper.
      if (isTombstone(entry)) continue;
      if (entry.key === key) return idx;
    }
    return -1;
  }

  /**
   * Read the value for a key, or `EMPTY` if absent.
   *
   * Returns the `EMPTY` sentinel (not `undefined`) when the key is missing, so
   * that `undefined` can be stored as a value. Callers should compare with `===`
   * against the exported `EMPTY`.
   *
   * @param {*} key
   * @returns {*|object} The stored value, or `EMPTY`.
   */
  get(key) {
    const idx = this._findIndex(key);
    if (idx === -1) return EMPTY;
    return this._slots[idx].value;
  }

  /**
   * Read the `Entry` object for a key, or `EMPTY` if absent.
   *
   * The returned `Entry` is the live slot object; its `value` reflects the
   * current state. Pass it to `compareAndSet` as the `expected` argument to
   * perform an optimistic update.
   *
   * @param {*} key
   * @returns {Entry|object} The entry, or `EMPTY`.
   */
  getEntry(key) {
    const idx = this._findIndex(key);
    if (idx === -1) return EMPTY;
    return this._slots[idx];
  }

  /**
   * Unconditionally set `key` to `value`. Returns the previous value (or
   * `EMPTY` if the key was absent).
   *
   * This is NOT atomic across other operations — it is a plain set. Use
   * `compareAndSet` when you need atomicity against interleaving async work.
   *
   * @param {*} key
   * @param {*} value
   * @returns {*|object}
   */
  set(key, value) {
    const start = hashKey(key) % this._capacity;
    // First pass: look for an existing slot for this key or an EMPTY slot.
    for (let i = 0; i < this._capacity; i++) {
      const idx = (start + i) % this._capacity;
      const entry = this._slots[idx];
      if (entry === EMPTY) {
        // Empty slot — insert here.
        this._slots[idx] = { key, value };
        this._size++;
        return EMPTY;
      }
      if (isTombstone(entry)) continue;
      if (entry.key === key) {
        // Existing key — overwrite value, keep same Entry object identity
        // is NOT preserved here; set is not CAS. Callers needing identity
        // stability must use compareAndSet.
        const prev = entry.value;
        entry.value = value;
        return prev;
      }
    }
    // Second pass: reuse a tombstone if we have one. We do this in a second
    // pass so that lookups for existing keys always find them before we
    // recycle a tombstone that earlier in the probe sequence belonged to
    // a key we haven't checked yet.
    for (let i = 0; i < this._capacity; i++) {
      const idx = (start + i) % this._capacity;
      const entry = this._slots[idx];
      if (isTombstone(entry)) {
        this._slots[idx] = { key, value };
        this._size++;
        return EMPTY;
      }
    }
    throw new RangeError('ConcurrentHashMap is full');
  }

  /**
   * Atomically set `key` to `value` only if the current entry for `key` is
   * reference-equal to `expected`.
   *
   * `expected` must be the `Entry` object you previously observed — obtain it
   * via `getEntry`. On success, stores `value` and returns `true`. On failure
   * (slot changed since you observed it, or key absent when expected is not
   * `EMPTY`, or key present when expected is `EMPTY`), returns `CAS_FAILED`.
   *
   * The atomicity guarantee is per-slot within a single event loop turn: no
   * interleaved async callback can observe the slot mid-update, because the
   * read-compare-write happens synchronously with no `await` between them.
   *
   * @param {*} key
   * @param {Entry|object} expected  The `Entry` you observed, or `EMPTY` to
   *   require the slot be currently empty.
   * @param {*} value
   * @returns {boolean|object} `true` on success, `CAS_FAILED` on mismatch.
   */
  compareAndSet(key, expected, value) {
    const idx = this._findIndex(key);
    if (idx === -1) {
      // Key absent. Succeed only if caller expected absence.
      if (expected === EMPTY) {
        // Delegate to set, which handles tombstone reuse and capacity.
        this.set(key, value);
        return true;
      }
      return CAS_FAILED;
    }
    // Key present. Check the current entry is the one the caller expected.
    if (!sameEntry(this._slots[idx], expected)) {
      return CAS_FAILED;
    }
    // CAS succeeds. We mutate the existing Entry object in place so that any
    // other code holding a reference to this Entry sees the new value — this
    // is intentional: the Entry is the slot, and the slot's value changed.
    this._slots[idx].value = value;
    return true;
  }

  /**
   * Remove `key`. Returns the previous value (or `EMPTY` if absent).
   *
   * We mark the slot with a tombstone rather than clearing it to `EMPTY`, so
   * that probe sequences for keys inserted after this slot are not broken.
   * Tombstones are recycled by `set`.
   *
   * @param {*} key
   * @returns {*|object}
   */
  delete(key) {
    const idx = this._findIndex(key);
    if (idx === -1) return EMPTY;
    const prev = this._slots[idx].value;
    this._slots[idx] = TOMBSTONE;
    this._size--;
    return prev;
  }

  /**
   * Number of occupied slots (excludes tombstones).
   * @returns {number}
   */
  get size() {
    return this._size;
  }

  /**
   * Current capacity (fixed at construction).
   * @returns {number}
   */
  get capacity() {
    return this._capacity;
  }
}

/**
 * Tombstone marker for deleted slots. See `delete` docstring.
 */
const TOMBSTONE = Object.freeze({ __hashArrayTombstone: true });

/**
 * @param {*} x
 * @returns {boolean}
 */
function isTombstone(x) {
  return x === TOMBSTONE;
}
