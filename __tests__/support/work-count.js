/**
 * How much text a call scans and builds, counted instead of timed (#138): a
 * bound in milliseconds fails on a slow runner and passes a quadratic
 * regression on a fast one, a count of the work does neither.
 *
 * Counted, while `fn` runs:
 *
 * - every character a regular expression is run over: from where the search
 *   starts to the end of its match, or to the end of the string without one
 *   (a sticky expression tries one place only). Every regex use goes through
 *   RegExp.prototype.exec once it is replaced — test, match, replace, split.
 * - every character of a string Array.prototype.join builds.
 * - every character String.prototype.indexOf passes over: from where it
 *   starts to the end of its match, or to the end of the string without one.
 * - every character of a string String.prototype.slice copies.
 *
 * The rescans the vCard normalizer once made were one of these: a regex over
 * the logical line so far, a regex per remaining line for each BEGIN, a join
 * of the parameter list so far per folded line. A loop over characters
 * (charCodeAt, text[i]) is not counted; a bound on this count is a bound on
 * those rescans, not a proof that the code is linear.
 *
 * Past `budget` the count aborts the call (each further regex use throws),
 * so a quadratic regression fails in milliseconds instead of running for a
 * minute; the count it reports is then just over the budget.
 *
 * @param {() => unknown} fn
 * @param {number} budget
 * @returns {{work: number, outcome: unknown}} the count, and what fn
 *   returned or threw
 */
export function countWork(fn, budget) {
  const { exec } = RegExp.prototype;
  const { join } = Array.prototype;
  const { indexOf, slice } = String.prototype;
  let work = 0;
  const spend = (amount) => {
    work += amount;
    if (work > budget) throw new Error(`work budget of ${budget} exceeded`);
  };
  RegExp.prototype.exec = function countedExec(input) {
    const text = String(input);
    const from = this.global || this.sticky ? this.lastIndex : 0;
    const match = exec.call(this, text);
    if (this.sticky) spend(match ? match[0].length + 1 : 1);
    else spend((match ? match.index + match[0].length : text.length) - from + 1);
    return match;
  };
  Array.prototype.join = function countedJoin(...args) {
    const joined = join.apply(this, args);
    spend(joined.length);
    return joined;
  };
  String.prototype.indexOf = function countedIndexOf(search, position) {
    const at = indexOf.call(this, search, position);
    const from = Math.max(0, Math.min(this.length, Number(position) || 0));
    spend((at === -1 ? this.length : at + String(search).length) - from + 1);
    return at;
  };
  String.prototype.slice = function countedSlice(...args) {
    const sliced = slice.apply(this, args);
    spend(sliced.length);
    return sliced;
  };
  let outcome;
  try {
    outcome = fn();
  } catch (error) {
    outcome = error;
  } finally {
    RegExp.prototype.exec = exec;
    Array.prototype.join = join;
    String.prototype.indexOf = indexOf;
    String.prototype.slice = slice;
  }
  return { work, outcome };
}
