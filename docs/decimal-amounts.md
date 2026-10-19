# Decimal Precision Boundaries (#1479)

> **Issue:** #1479
> **Area:** Backend financial amounts
> **Module:** `backend/src/lib/decimal-amounts.ts`
> **Tests:** `backend/src/lib/decimal-amounts.test.ts`

## Purpose

Financial amounts in this backend are stored as decimal **strings**:
`transactions.amount` and `ledger_blocks.amount` are varchar columns guarded
by the `CHK_transactions_amount_valid` check constraint
(`entities/Transaction.ts`):

```
^(0|[1-9][0-9]{0,38})([.][0-9]{1,7})?$
amount::numeric <= 170141183460469231731687303715884105727  (i128::MAX)
```

So the legal amount space is: an unsigned integer part of at most 39 digits,
an optional fractional part of 1–7 digits, no leading zeros, no exponent
notation, and a value that fits in a signed 128-bit integer (max
`2^127 - 1 = 170141183460469231731687303715884105727`, i.e. at most 39 digits
with the leading digit ≤ 1).

JavaScript's `Number` cannot represent these values exactly (IEEE-754 doubles
lose precision above 2^53−1 and cannot even represent the upper half of the
i128 range at all). Every amount calculation in this codebase must therefore
go through **exact integer-unit arithmetic**, never `parseFloat`, `Number()`,
or `BigInt`-free `toFixed` math.

## The module

`backend/src/lib/decimal-amounts.ts` provides a small, dependency-free,
exact-arithmetic API over amounts expressed as strings:

| Function | Behavior |
| --- | --- |
| `toUnits(amount)` | Canonical decimal string → scaled integer string (7 dp) |
| `fromUnits(units)` | Scaled integer string → canonical decimal string |
| `normalizeAmountString(amount)` | Canonical form: trims trailing fractional zeros, `""`/`"0"` → `"0"` |
| `isValidAmountString(amount)` | Full grammar + i128 range check (mirrors the DB constraint) |
| `addAmounts(a, b)` / `subtractAmounts(a, b)` / `sumAmounts(list)` | Exact `BigInt` math on scaled units, overflow-checked against ±i128 |
| `multiplyAmountByRatio(amount, numerator, denominator)` | Exact ratio multiply with **round-half-up** at the 7-dp boundary |
| `allocateProRata(total, weights)` | Largest-remainder allocation: output units always sum *exactly* to the input |
| `compareAmounts(a, b)` | `-1 \| 0 \| 1` via units, no float conversion |
| `isZeroAmount(a)` | `compareAmounts(a, "0") === 0` |

Every arithmetic result is re-validated: the scaled value must fit in i128
and the output must re-parse as a legal amount string, otherwise an
`AmountError` is thrown. There is deliberately **no** silent clamping or
rounding of overflow — an out-of-range result is a bug, not a value.

Constants: `MAX_AMOUNT_VALUE` (i128::MAX as a string, matching
`TRANSACTION_AMOUNT_CHECK`), `MAX_AMOUNT_UNITS`, `AMOUNT_DECIMAL_PLACES = 7`.

## Boundary coverage (the tests)

`decimal-amounts.test.ts` asserts the exact edges:

- **Minimum:** `"0"` and the smallest positive amount `"0.0000001"` (1 unit
  at 7 dp) survive round-trips; `subtractAmounts("0.0000001", "0.0000001")`
  is exactly `"0"`.
- **Maximum:** `MAX_AMOUNT_VALUE` (`170141183460469231731687303715884105727`)
  round-trips; one more unit overflows and throws `AmountError`.
- **Just-out-of-range:** `170141183460469231731687303715884105728`
  (i128::MAX + 1), a 40-digit integer, and a 39-digit integer > i128::MAX
  are all rejected by `isValidAmountString`.
- **Rounding:** `multiplyAmountByRatio` rounds half-up exactly at the 7-dp
  boundary (`…5` at dp 8 rounds up), and never rounds away below it.
- **Allocation:** `allocateProRata` sums exactly to the total for cases where
  the division has remainders (including `1 / 3`-style splits), for zero
  weights (rejected), and for totals at the i128 boundary.
- **Rejection:** leading zeros (`"01"`), empty string, `".5"`, `"1."`,
  exponent notation (`"1e7"`), negative signs, 8-dp fractions, and
  whitespace are all invalid.

## Usage rules

1. Parsing user/API input: `isValidAmountString` first, then `toUnits`.
2. Adding/subtracting amounts: `addAmounts`/`subtractAmounts` — never
   `parseFloat`.
3. Splitting a total: `allocateProRata` guarantees the parts sum back to the
   whole (no lost kobo).
4. Rates/fees: `multiplyAmountByRatio` with explicit numerator/denominator.

## Running

```bash
cd backend && npx vitest run src/lib/decimal-amounts.test.ts
```
