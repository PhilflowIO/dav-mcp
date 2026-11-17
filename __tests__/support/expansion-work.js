import { jest } from '@jest/globals';

/**
 * Run `call` and count what its recurrence expansions did (expansionWork in
 * src/occurrences.js), with the clock stopped: then only the deterministic
 * budget (candidates) can end an expansion, and a slow runner neither fails a
 * bound nor makes a result incomplete. Wall-clock bounds measured the runner
 * (#138).
 *
 * The meter is imported on first use, not at load, so a test file's module
 * mocks are registered before src/ is loaded.
 *
 * @returns {Promise<{result: *, work: {units: number, calls: number, overridesHanded: number}}>}
 */
export async function counted(call) {
  const { expansionWork, resetExpansionWork } = await import('../../src/occurrences.js');
  const clock = jest.spyOn(performance, 'now').mockReturnValue(0);
  resetExpansionWork();
  try {
    const result = await call();
    return { result, work: { ...expansionWork } };
  } finally {
    clock.mockRestore();
  }
}
