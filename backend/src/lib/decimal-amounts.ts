/**
 * Fixed-point decimal helpers for ledger amounts (#1479).
 *
 * Financial amounts in this backend are stored as decimal *strings*:
 * `transactions.amount` and `ledger_blocks.amount` are varchar columns
 * guarded by the `CHK_transactions_amount_valid` check constraint
 * (`entities/Transaction.ts`), which accepts
 *
 *     ^(0|[1-9][0-9]{0,38})([.][0-9]{1,7})?$
 *
 * and requires the numeric value to be <= 2^127 - 1 (the Soroban `i128`
 * maximum, since amounts are mirrored on-chain).
 *
 * JavaScript `number` is an IEEE-754 double: it cannot represent many legal
 * amounts exactly (0.1 + 0.2 !== 0.3, anything above 2^53 loses integer
 * precision, and 7 decimal places on a large magnitude lose fraction digits).
 * Every helper in this module therefore operates on the string form via
 * `bigint` scaled to 1e-7 "units" (the smallest representable amount), so
 * arithmetic, comparison and allocation are exact and loss-free. Floats are
 * never used on the value path; `Number()` is only used for display-adjacent
 * sanity checks in tests that *demonstrate* the float trap.
 *
 * See docs/decimal-precision-boundaries.md for the boundary matrix.
 */

/** Scale factor: 1 unit = 1e-7 of the base asset (7 decimal places). */
export const AMOUNT_DECIMALS = 7;
export const AMOUNT_SCALE = 10n ** BigInt(AMOUNT_DECIMALS);

/** Largest numeric value accepted by the DB check constraint (Soroban i128 max). */
export const MAX_AMOUNT_VALUE = 170141183460469231731687303715884105727n;

/** Largest accepted value expressed in 1e-7 units. */
export const MAX_AMOUNT_UNITS = MAX_AMOUNT_VALUE * AMOUNT_SCALE;

/** The exact regex used by the DB check constraint, applied to the string form. */
export const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,38})(\.[0-9]{1,7})?$/;

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountError";
  }
}

/**
 * True iff `value` is a canonical decimal string the database would accept:
 * non-negative, no sign, no leading zeros, no exponent notation, at most
 * 7 decimal places, and at most 2^127 - 1 in value.
 */
export function isValidAmountString(value: string): boolean {
  if (typeof value !== "string" || !AMOUNT_PATTERN.test(value)) return false;
  return toUnitsUnchecked(value) <= MAX_AMOUNT_UNITS;
}

/** Parses a canonical amount string into 1e-7 units. Throws AmountError when invalid. */
export function toUnits(value: string): bigint {
  if (typeof value !== "string" || !AMOUNT_PATTERN.test(value)) {
    throw new AmountError(`Invalid amount string: ${JSON.stringify(value)}`);
  }
  const units = toUnitsUnchecked(value);
  if (units > MAX_AMOUNT_UNITS) {
    throw new AmountError(`Amount exceeds maximum: ${value}`);
  }
  return units;
}

/** Internal parse; caller has already validated the format. */
function toUnitsUnchecked(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  const paddedFraction = (fraction + "0".repeat(AMOUNT_DECIMALS)).slice(0, AMOUNT_DECIMALS);
  return BigInt(whole) * AMOUNT_SCALE + BigInt(paddedFraction);
}

/**
 * Renders 1e-7 units back into a canonical amount string (no trailing
 * fractional zeros, no leading zeros). The result is always accepted by
 * `isValidAmountString` when the input units are within range.
 */
export function fromUnits(units: bigint): string {
  if (units < 0n) throw new AmountError(`Negative amount units: ${units}`);
  if (units > MAX_AMOUNT_UNITS) {
    throw new AmountError(`Amount units exceed maximum: ${units}`);
  }
  const whole = units / AMOUNT_SCALE;
  const fraction = units % AMOUNT_SCALE;
  if (fraction === 0n) return whole.toString();
  const fractionString = fraction.toString().padStart(AMOUNT_DECIMALS, "0").replace(/0+$/, "");
  return `${whole}.${fractionString}`;
}

/**
 * Canonicalizes an amount string: valid input in, canonical form out.
 * Trailing fractional zeros are dropped ("1.5000000" -> "1.5", "2." is invalid).
 */
export function normalizeAmountString(value: string): string {
  return fromUnits(toUnits(value));
}

/** Exact addition. Throws AmountError if either side is invalid or the sum overflows. */
export function addAmounts(a: string, b: string): string {
  const sum = toUnits(a) + toUnits(b);
  if (sum > MAX_AMOUNT_UNITS) {
    throw new AmountError(`Amount overflow adding ${a} + ${b}`);
  }
  return fromUnits(sum);
}

/** Exact subtraction. Throws AmountError if either side is invalid or the result is negative. */
export function subtractAmounts(a: string, b: string): string {
  const difference = toUnits(a) - toUnits(b);
  if (difference < 0n) {
    throw new AmountError(`Amount underflow subtracting ${b} from ${a}`);
  }
  return fromUnits(difference);
}

/** Three-way comparison (-1, 0, 1) without float rounding. Invalid input throws. */
export function compareAmounts(a: string, b: string): -1 | 0 | 1 {
  const left = toUnits(a);
  const right = toUnits(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function isZeroAmount(value: string): boolean {
  return toUnits(value) === 0n;
}

export type RoundingMode = "floor" | "ceil" | "half-up";

/**
 * Multiplies an amount by the rational `numerator / denominator` with an
 * explicit rounding mode, staying in exact integer arithmetic.
 *
 * Used for fee/percentage-style splits where the multiplier itself is
 * exact (e.g. basis points: numerator=bp, denominator=10_000).
 */
export function multiplyAmountByRatio(
  value: string,
  numerator: bigint,
  denominator: bigint,
  rounding: RoundingMode = "half-up"
): string {
  if (denominator <= 0n) throw new AmountError("Denominator must be positive");
  if (numerator < 0n) throw new AmountError("Numerator must be non-negative");
  const scaled = toUnits(value) * numerator;
  const quotient = scaled / denominator;
  const remainder = scaled % denominator;
  let units = quotient;
  if (rounding === "ceil" && remainder > 0n) units += 1n;
  else if (rounding === "half-up" && remainder * 2n >= denominator) units += 1n;
  if (units > MAX_AMOUNT_UNITS) {
    throw new AmountError(`Amount overflow multiplying ${value} by ${numerator}/${denominator}`);
  }
  return fromUnits(units);
}

export interface ProRataShare {
  /** Caller-supplied key (recipient, roundId, ...) echoed back with the share. */
  key: string;
  /** Non-negative integer weight (e.g. split percentage in whole units). */
  weight: bigint;
}

export interface ProRataAllocation {
  key: string;
  /** Exact amount string; Σ shares is guaranteed to equal `total` exactly. */
  amount: string;
  units: bigint;
}

/**
 * Splits `total` across `shares` proportionally to their integer weights
 * using the largest-remainder method:
 *
 *   1. floor(totalUnits * weight_i / totalWeight) for every share, then
 *   2. distribute the leftover units one-by-one, largest fractional
 *      remainder first (ties broken by input order for determinism).
 *
 * Guarantees (the balancing invariant this exists for):
 *   - Σ allocation.units === toUnits(total) exactly — no dust is created
 *     or lost, for any total/weights combination;
 *   - every share is an exact multiple of 1e-7 (no float rounding);
 *   - zero-weight shares receive exactly 0;
 *   - an empty share list or an all-zero weight list with a non-zero total
 *     throws (the total could not be conserved).
 */
export function allocateProRata(total: string, shares: ProRataShare[]): ProRataAllocation[] {
  const totalUnits = toUnits(total);
  if (shares.length === 0) {
    if (totalUnits === 0n) return [];
    throw new AmountError("Cannot allocate a non-zero total across zero shares");
  }
  for (const share of shares) {
    if (typeof share.weight !== "bigint" || share.weight < 0n) {
      throw new AmountError(`Invalid weight for share ${share.key}`);
    }
  }
  const weightSum = shares.reduce((acc, s) => acc + s.weight, 0n);
  if (weightSum === 0n) {
    if (totalUnits === 0n) return shares.map((s) => ({ key: s.key, amount: "0", units: 0n }));
    throw new AmountError("Cannot allocate a non-zero total across zero total weight");
  }

  const floors = shares.map((s) => (totalUnits * s.weight) / weightSum);
  const remainders = shares.map((s, i) => totalUnits * s.weight - floors[i] * weightSum);
  let leftover = totalUnits - floors.reduce((acc, u) => acc + u, 0n);

  const order = shares
    .map((_, i) => i)
    .sort((a, b) => {
      const diff = remainders[b] - remainders[a];
      if (diff !== 0n) return diff > 0 ? 1 : -1;
      return a - b; // stable: input order wins ties
    });

  const units = [...floors];
  for (let i = 0; leftover > 0n; i = (i + 1) % order.length) {
    units[order[i]] += 1n;
    leftover -= 1n;
  }

  return shares.map((s, i) => ({ key: s.key, units: units[i], amount: fromUnits(units[i]) }));
}

/**
 * Sums amount strings exactly. Invalid entries throw AmountError; the sum
 * is range-checked against the i128 bound like every other value here.
 */
export function sumAmounts(values: string[]): string {
  let units = 0n;
  for (const value of values) {
    units += toUnits(value);
    if (units > MAX_AMOUNT_UNITS) {
      throw new AmountError(`Amount overflow while summing ${values.length} values`);
    }
  }
  return fromUnits(units);
}
