/**
 * Tiny promise chain so async callbacks can run one at a time.
 * Later callers still receive their own rejection if `fn` throws.
 */
export function createMutex() {
  let tail = Promise.resolve();
  return function withLock(fn) {
    const run = tail.then(() => fn());
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}
