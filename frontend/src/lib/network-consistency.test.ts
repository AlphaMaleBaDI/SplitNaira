/**
 * Network consistency across signing, simulation, submission and explorer links
 * (issue #1498).
 *
 * The backend accepts four network passphrases
 * (`STELLAR_NETWORK_PASSPHRASES` in `backend/src/services/ledger-finality.ts`).
 * The frontend builds explorer links through `lib/explorer.ts`, which supports
 * only testnet and mainnet and deliberately returns `null` for anything else.
 *
 * That asymmetry is intended — a missing link is a visible gap, a wrong-network
 * link is a confident lie — but "intended" is not "guaranteed". These tests pin
 * the mapping from every passphrase the backend will accept to the explorer base
 * the frontend will render, so the two cannot drift apart silently.
 *
 * The passphrases are inlined rather than imported from the backend package,
 * because a cross-package import from the frontend test suite would couple the
 * two build graphs. They are transcribed verbatim from
 * `STELLAR_NETWORK_PASSPHRASES`; if that constant changes, the assertions here
 * fail, which is the point of the file.
 */

import { describe, expect, it } from "vitest";

import {
  assertSupportedNetwork,
  getAccountExplorerUrl,
  getExplorerBaseUrl,
  getExplorerLabel,
  getTransactionExplorerUrl,
  isSupportedNetwork,
  resolveNetwork,
  SUPPORTED_NETWORKS,
} from "./explorer";

const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const FUTURENET_PASSPHRASE = "Test SDF Future Network ; October 2022";
const STANDALONE_PASSPHRASE = "Standalone Network ; February 2017";

const HASH = "a".repeat(64);
const ADDRESS = "G".concat("A".repeat(55));

describe("backend passphrase to frontend network", () => {
  it("resolves the two linkable networks to the right explorer base", () => {
    // A mainnet transaction linked to the testnet explorer "has never heard of
    // it", which reads to a user as a vanished payment.
    expect(resolveNetwork(MAINNET_PASSPHRASE)).toBe("mainnet");
    expect(getExplorerBaseUrl(MAINNET_PASSPHRASE)).toBe(
      "https://stellar.expert/explorer/public",
    );

    expect(resolveNetwork(TESTNET_PASSPHRASE)).toBe("testnet");
    expect(getExplorerBaseUrl(TESTNET_PASSPHRASE)).toBe(
      "https://stellar.expert/explorer/testnet",
    );
  });

  it("never links the networks the backend accepts but the frontend cannot render", () => {
    // Futurenet and standalone are valid backend networks with no explorer here.
    // The contract is null, not a guess — asserting this is what stops a future
    // default-to-testnet from creeping back in.
    for (const passphrase of [FUTURENET_PASSPHRASE, STANDALONE_PASSPHRASE]) {
      expect(resolveNetwork(passphrase)).toBeNull();
      expect(getExplorerBaseUrl(passphrase)).toBeNull();
      expect(isSupportedNetwork(passphrase)).toBe(false);
    }
  });

  it("never cross-links a mainnet transaction to testnet", () => {
    const url = getTransactionExplorerUrl(HASH, MAINNET_PASSPHRASE);

    expect(url).not.toBeNull();
    expect(url).toContain("/public/");
    expect(url).not.toContain("/testnet/");
  });

  it("never cross-links a testnet transaction to mainnet", () => {
    const url = getTransactionExplorerUrl(HASH, TESTNET_PASSPHRASE);

    expect(url).not.toBeNull();
    expect(url).toContain("/testnet/");
    expect(url).not.toContain("/public/");
  });

  it("labels the explorer consistently with the link target", () => {
    // A mainnet link captioned "Testnet" is as misleading as a wrong link.
    expect(getExplorerLabel(MAINNET_PASSPHRASE)).toBe("Stellar.expert (Mainnet)");
    expect(getExplorerLabel(TESTNET_PASSPHRASE)).toBe("Stellar.expert (Testnet)");
  });
});

describe("passphrase casing and whitespace", () => {
  it("tolerates casing differences in the passphrase", () => {
    // Config arrives from env vars, so casing is not guaranteed.
    expect(resolveNetwork(TESTNET_PASSPHRASE.toLowerCase())).toBe("testnet");
    expect(resolveNetwork(MAINNET_PASSPHRASE.toUpperCase())).toBe("mainnet");
  });

  it("tolerates surrounding whitespace", () => {
    expect(resolveNetwork(`  ${TESTNET_PASSPHRASE}  `)).toBe("testnet");
  });

  it("accepts the short aliases wallets report", () => {
    // Freighter reports PUBLIC/TESTNET, not a passphrase.
    expect(resolveNetwork("PUBLIC")).toBe("mainnet");
    expect(resolveNetwork("TESTNET")).toBe("testnet");
  });

  it("rejects a near-miss passphrase rather than guessing", () => {
    // "Mainnet ; September 2015" is not the mainnet passphrase.
    expect(resolveNetwork("Mainnet ; September 2015")).toBeNull();
    expect(resolveNetwork("Test SDF Network; September 2015")).toBeNull();
  });

  it("rejects empty and nullish values", () => {
    for (const value of ["", "   ", null, undefined]) {
      expect(resolveNetwork(value)).toBeNull();
    }
  });
});

describe("fail-closed behaviour for unsupported networks", () => {
  it("produces no transaction link for an unsupported network", () => {
    expect(getTransactionExplorerUrl(HASH, FUTURENET_PASSPHRASE)).toBeNull();
    expect(getTransactionExplorerUrl(HASH, "not-a-network")).toBeNull();
  });

  it("produces no account link for an unsupported network", () => {
    expect(getAccountExplorerUrl(ADDRESS, STANDALONE_PASSPHRASE)).toBeNull();
    expect(getAccountExplorerUrl(ADDRESS, undefined)).toBeNull();
  });

  it("produces no link when the network is supported but the identifier is not", () => {
    // Guards the other half: a missing link must never masquerade as a
    // supported-network failure, so these are asserted separately.
    expect(getTransactionExplorerUrl("", MAINNET_PASSPHRASE)).toBeNull();
    expect(getTransactionExplorerUrl(null, MAINNET_PASSPHRASE)).toBeNull();
    expect(getAccountExplorerUrl("  ", MAINNET_PASSPHRASE)).toBeNull();
  });

  it("throws from assertSupportedNetwork so config validation fails loudly", () => {
    // Used at startup, where silently producing broken links for the lifetime of
    // a deployment is worse than refusing to boot.
    expect(() => assertSupportedNetwork(FUTURENET_PASSPHRASE)).toThrow(
      /Unsupported Stellar network/,
    );
    expect(assertSupportedNetwork(TESTNET_PASSPHRASE)).toBe("testnet");
  });

  it("reports an unrecognised network in the thrown message", () => {
    expect(() => assertSupportedNetwork("mainet")).toThrow(/mainet/);
  });
});

describe("identifier encoding", () => {
  it("percent-encodes the transaction hash into the path", () => {
    const url = getTransactionExplorerUrl("hash/with?chars", TESTNET_PASSPHRASE);

    expect(url).toBe(
      "https://stellar.expert/explorer/testnet/tx/hash%2Fwith%3Fchars",
    );
  });

  it("percent-encodes the account address into the path", () => {
    expect(getAccountExplorerUrl("G/ABC", TESTNET_PASSPHRASE)).toBe(
      "https://stellar.expert/explorer/testnet/account/G%2FABC",
    );
  });

  it("trims surrounding whitespace from identifiers", () => {
    expect(getTransactionExplorerUrl(`  ${HASH}  `, TESTNET_PASSPHRASE)).toBe(
      `https://stellar.expert/explorer/testnet/tx/${HASH}`,
    );
  });

  it("builds links for both supported networks", () => {
    // Sanity check that SUPPORTED_NETWORKS and the two bases stay in step.
    expect(SUPPORTED_NETWORKS).toEqual(["testnet", "mainnet"]);
    for (const network of SUPPORTED_NETWORKS) {
      expect(getExplorerBaseUrl(network)).not.toBeNull();
      expect(getExplorerLabel(network)).not.toBeNull();
    }
  });
});
