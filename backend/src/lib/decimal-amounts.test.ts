import { describe, expect, it } from "vitest";
import {
  addAmounts,
  allocateProRata,
  AmountError,
  compareAmounts,
  fromUnits,
  isZeroAmount,
  MAX_AMOUNT_UNITS,
  MAX_AMOUNT_VALUE,
  multiplyAmountByRatio,
  normalizeAmountString,
  subtractAmounts,
  sumAmounts,
  toUnits,
  isValidAmountString,
} from "./decimal-amounts";

/**
 * Decimal precision boundary tests (#1479).
 *
 * Covers: smallest and maximum legal amounts, rounding boundaries, and
 * serialization round-trips — all without floating-point loss. The DB check
 * constraint (CHK_transactions_amount_valid) accepts
 * ^(0|[1-9][0-9]{0,38})([.][0-9]{1,7})?$ with numeric value <= 2^127 - 1;
 * these tests hold the in-process helpers to exactly the same contract so a
 * value that would be rejected by Postgres is rejected before we ever build
 * a query, and a value that is accepted survives round-trips unchanged.
 */

const MIN_AMOUNT = "0.0000001"; // 1 unit — smallest positive amount
const MAX_AMOUNT = "170141183460469231731687303715884105727"; // 2^127 - 1

describe("isValidAmountString — boundary matrix", () => {
  const valid = [
    "0",
    MIN_AMOUNT,
    "0.0000010", // trailing zero in fraction is fine (not canonical, but valid)
    "1",
    "1.5",
    "1234567.1234567", // full 7 decimal places
    MAX_AMOUNT,
  ];
  for (const value of valid) {
    it(`accepts ${JSON.stringify(value)}`, () => {
      expect(isValidAmountString(value)).toBe(true);
    });
  }

  const invalid = [
    "",
    "-1",
    "-0.5",
    "+1",
    "1.12345678", // 8 decimal places — one past the boundary
    "0.00000001", // 8 decimal places below one unit
    "abc",
    "1e6",
    "NaN",
    " 1",
    "1 ",
    "01", // leading zero
    "1.", // dangling separator
    ".5", // no whole part
    "1,000",
    `${MAX_AMOUNT}0`, // one order of magnitude past the maximum
    "170141183460469231731687303715884105728", // maximum + 1
    "1000000000000000000000000000000000000000", // 40 digits — pattern caps whole part at 39
  ];
  for (const value of invalid) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      expect(isValidAmountString(value)).toBe(false);
    });
  }
});

describe("toUnits / fromUnits — exact unit conversion", () => {
  it("maps the smallest positive amount to exactly 1 unit", () => {
    expect(toUnits(MIN_AMOUNT)).toBe(1n);
  });

  it("maps zero to 0n and back", () => {
    expect(toUnits("0")).toBe(0n);
    expect(fromUnits(0n)).toBe("0");
  });

  it("maps the maximum amount to the maximum units", () => {
    expect(toUnits(MAX_AMOUNT)).toBe(MAX_AMOUNT_VALUE * 10n ** 7n);
    expect(toUnits(MAX_AMOUNT)).toBe(MAX_AMOUNT_UNITS);
    expect(fromUnits(MAX_AMOUNT_UNITS)).toBe(MAX_AMOUNT);
  });

  it("round-trips maximum + 1 unit as a throw, not silent truncation", () => {
    expect(() => fromUnits(MAX_AMOUNT_UNITS + 1n)).toThrow(AmountError);
  });

  it("round-trips values across the 2^53 float boundary without loss", () => {
    // 9007199254740993 is 2^53 + 1: Number() cannot represent it exactly.
    const value = "9007199254740993.0000001";
    expect(Number(value).toString()).not.toBe(value); // demonstrates the float trap
    expect(fromUnits(toUnits(value))).toBe(value);
  });

  it("round-trips a large-magnitude, full-precision amount exactly", () => {
    const value = "123456789012345678.1234567";
    expect(fromUnits(toUnits(value))).toBe(value);
  });

  it("rejects negative units instead of wrapping", () => {
    expect(() => fromUnits(-1n)).toThrow(AmountError);
  });
});

describe("normalizeAmountString — canonical serialization", () => {
  it("strips trailing fractional zeros", () => {
    expect(normalizeAmountString("1.5000000")).toBe("1.5");
    expect(normalizeAmountString("0.1000000")).toBe("0.1");
  });

  it("leaves canonical values untouched", () => {
    expect(normalizeAmountString("0")).toBe("0");
    expect(normalizeAmountString(MIN_AMOUNT)).toBe(MIN_AMOUNT);
  });

  it("throws on non-canonical patterns the DB would reject", () => {
    expect(() => normalizeAmountString("01")).toThrow(AmountError);
    expect(() => normalizeAmountString(".5")).toThrow(AmountError);
    expect(() => normalizeAmountString("1.12345678")).toThrow(AmountError);
  });
});

describe("arithmetic — no floating-point loss", () => {
  it("0.1 + 0.2 === 0.3 exactly (the classic float counterexample)", () => {
    expect(Number(0.1) + Number(0.2)).not.toBe(0.3); // floats fail this
    expect(addAmounts("0.1", "0.2")).toBe("0.3");
  });

  it("adds full-precision amounts exactly at the 7-decimal boundary", () => {
    expect(addAmounts("0.0000001", "0.0000001")).toBe("0.0000002");
    expect(addAmounts("999999.9999999", "0.0000001")).toBe("1000000");
  });

  it("throws on overflow rather than exceeding the i128 bound", () => {
    expect(() => addAmounts(MAX_AMOUNT, MIN_AMOUNT)).toThrow(/overflow/i);
  });

  it("subtracts exactly and rejects underflow", () => {
    expect(subtractAmounts("1", MIN_AMOUNT)).toBe("0.9999999");
    expect(subtractAmounts("0.0000001", "0.0000001")).toBe("0");
    expect(() => subtractAmounts(MIN_AMOUNT, "0.0000002")).toThrow(/underflow/i);
  });

  it("compares amounts exactly, including float-equal-looking pairs", () => {
    expect(compareAmounts("0.3", "0.3000000")).toBe(0);
    expect(compareAmounts("0.3000001", "0.3")).toBe(1);
    expect(compareAmounts("0.2999999", "0.3")).toBe(-1);
    expect(compareAmounts(MAX_AMOUNT, "0")).toBe(1);
  });

  it("detects zero exactly", () => {
    expect(isZeroAmount("0")).toBe(true);
    expect(isZeroAmount("0.0000000")).toBe(true);
    expect(isZeroAmount(MIN_AMOUNT)).toBe(false);
  });

  it("sums lists exactly and rejects overflow mid-sum", () => {
    expect(sumAmounts(["0.1", "0.2", "0.3", "0.4"])).toBe("1");
    expect(sumAmounts([])).toBe("0");
    expect(() => sumAmounts([MAX_AMOUNT, MIN_AMOUNT])).toThrow(/overflow/i);
  });
});

describe("multiplyAmountByRatio — rounding boundaries", () => {
  it("rounds half-up at the exact midpoint of a unit", () => {
    // 1 * 0.5 = 0.5 units -> half-up rounds to 1 unit = 0.0000001
    expect(multiplyAmountByRatio("0.0000001", 5n, 10n, "half-up")).toBe("0.0000001");
    // just under the midpoint floors
    expect(multiplyAmountByRatio("0.0000001", 4999n, 10000n, "half-up")).toBe("0");
    expect(multiplyAmountByRatio("0.0000001", 5001n, 10000n, "half-up")).toBe("0.0000001");
  });

  it("floor and ceil diverge only on non-exact products", () => {
    expect(multiplyAmountByRatio("1.0000001", 1n, 2n, "floor")).toBe("0.5");
    expect(multiplyAmountByRatio("1.0000001", 1n, 2n, "ceil")).toBe("0.5000001");
    expect(multiplyAmountByRatio("1", 1n, 2n, "ceil")).toBe("0.5"); // exact: no bump
  });

  it("applies basis-point fees without float drift", () => {
    // 2.5% of 1234567.1234567 = 30864.1780864175 -> half-up to 7dp
    expect(multiplyAmountByRatio("1234567.1234567", 250n, 10000n, "half-up")).toBe(
      "30864.1780864"
    );
  });

  it("rejects invalid ratios", () => {
    expect(() => multiplyAmountByRatio("1", 1n, 0n, "half-up")).toThrow(AmountError);
    expect(() => multiplyAmountByRatio("1", -1n, 2n, "half-up")).toThrow(AmountError);
  });
});

describe("allocateProRata — conservation at the boundaries", () => {
  it("conserves the total exactly when division is uneven (classic 100 / 3)", () => {
    const shares = [
      { key: "a", weight: 1n },
      { key: "b", weight: 1n },
      { key: "c", weight: 1n },
    ];
    const allocation = allocateProRata("100", shares);
    const total = sumAmounts(allocation.map((s) => s.amount));
    expect(total).toBe("100");
    // floor of 100/3 each, one leftover cent on the first-largest remainder
    expect(allocation.map((s) => s.amount)).toEqual([
      "33.3333334",
      "33.3333333",
      "33.3333333",
    ]);
  });

  it("conserves a minimum-size total across many shares", () => {
    const shares = [
      { key: "a", weight: 1n },
      { key: "b", weight: 1n },
    ];
    const allocation = allocateProRata(MIN_AMOUNT, shares);
    expect(sumAmounts(allocation.map((s) => s.amount))).toBe(MIN_AMOUNT);
    expect(allocation.map((s) => s.amount).sort()).toEqual(["0", MIN_AMOUNT]);
  });

  it("conserves the maximum-size total across weighted shares", () => {
    const shares = [
      { key: "owner", weight: 40n },
      { key: "worker", weight: 60n },
    ];
    const allocation = allocateProRata(MAX_AMOUNT, shares);
    expect(sumAmounts(allocation.map((s) => s.amount))).toBe(MAX_AMOUNT);
    for (const s of allocation) expect(isValidAmountString(s.amount)).toBe(true);
  });

  it("gives zero-weight shares exactly zero", () => {
    const allocation = allocateProRata("10", [
      { key: "a", weight: 3n },
      { key: "b", weight: 0n },
      { key: "c", weight: 2n },
    ]);
    expect(allocation.find((s) => s.key === "b")?.amount).toBe("0");
    expect(sumAmounts(allocation.map((s) => s.amount))).toBe("10");
  });

  it("handles a zero total without inventing dust", () => {
    const allocation = allocateProRata("0", [
      { key: "a", weight: 1n },
      { key: "b", weight: 2n },
    ]);
    expect(allocation.map((s) => s.amount)).toEqual(["0", "0"]);
  });

  it("throws instead of silently dropping a non-zero total", () => {
    expect(() => allocateProRata("10", [])).toThrow(AmountError);
    expect(() =>
      allocateProRata("10", [
        { key: "a", weight: 0n },
        { key: "b", weight: 0n },
      ])
    ).toThrow(AmountError);
    // ...but a zero total with zero weights is a legitimate no-op.
    expect(allocateProRata("0", [{ key: "a", weight: 0n }])).toEqual([
      { key: "a", units: 0n, amount: "0" },
    ]);
  });

  it("is deterministic: ties break by input order", () => {
    const shares = [
      { key: "first", weight: 1n },
      { key: "second", weight: 1n },
    ];
    const a = allocateProRata("0.0000001", shares);
    const b = allocateProRata("0.0000001", shares);
    expect(a).toEqual(b);
    expect(a[0].amount).toBe(MIN_AMOUNT);
    expect(a[1].amount).toBe("0");
  });

  it("rejects negative weights", () => {
    expect(() =>
      allocateProRata("10", [
        { key: "a", weight: -1n },
        { key: "b", weight: 2n },
      ])
    ).toThrow(AmountError);
  });
});

describe("serialization — JSON round-trips preserve strings", () => {
  it("keeps amounts exact through JSON.stringify/parse (strings, not numbers)", () => {
    const value = "123456789012345678.1234567";
    const wire = JSON.stringify({ amount: value });
    const parsed = JSON.parse(wire) as { amount: string };
    expect(typeof parsed.amount).toBe("string");
    expect(fromUnits(toUnits(parsed.amount))).toBe(value);
  });

  it("documents why numeric serialization must never be used for amounts", () => {
    const value = "9007199254740993.0000001";
    const asNumber = Number(value);
    expect(String(asNumber)).not.toBe(value); // float64 loses both integer AND fraction
    // The string path has no such failure mode:
    expect(fromUnits(toUnits(value))).toBe(value);
  });
});
