#!/usr/bin/env node
/**
 * Contract event integration-contract guard.
 *
 * Usage:
 *   node contracts/scripts/check-event-contract.mjs
 *       Extract events from contracts/events.rs and compare them with the
 *       committed snapshot (contracts/interface/events.contract.json).
 *       Fails on any drift.
 *
 *   node contracts/scripts/check-event-contract.mjs --update [--allow-breaking]
 *       Rewrite the snapshot from source and bump its version
 *       (breaking -> major, additive -> minor, informational -> patch).
 *       Refuses breaking changes unless --allow-breaking is passed.
 *
 *   node contracts/scripts/check-event-contract.mjs --base <snapshot.json>
 *       Compare the committed snapshot with a base snapshot (e.g. from
 *       origin/main) and fail if the version bump is too small for the
 *       classified changes. A missing base file is treated as first adoption.
 *
 * Exit codes: 0 ok, 1 contract violation, 2 usage/environment error.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EVENT_CONTRACT_SCHEMA,
  buildSnapshot,
  bumpVersion,
  checkVersionBump,
  diffEventContracts,
  extractEventContract,
} from "./event-contract.mjs";

const contractDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const eventsPath = resolve(contractDir, "events.rs");
const snapshotPath = resolve(contractDir, "interface", "events.contract.json");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

function readSnapshot(path) {
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  if (snapshot.schema !== EVENT_CONTRACT_SCHEMA) {
    throw new Error(`${path}: expected schema "${EVENT_CONTRACT_SCHEMA}", got "${snapshot.schema}"`);
  }
  return snapshot;
}

function printChanges(diff) {
  for (const c of diff.changes) console.log(`  [${c.level}] ${c.event}: ${c.message}`);
}

function writeSnapshot(snapshot) {
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

try {
  const baseOpt = option("--base");

  if (baseOpt !== undefined) {
    if (!existsSync(baseOpt)) {
      console.log(`No base event contract at ${baseOpt}; treating as first adoption.`);
      process.exit(0);
    }
    const base = readSnapshot(baseOpt);
    const head = readSnapshot(snapshotPath);
    const diff = diffEventContracts(base.events, head.events);
    if (diff.level === "none") {
      console.log(`Event contract unchanged (v${head.version}).`);
      process.exit(0);
    }
    console.log(`Event contract changes v${base.version} -> v${head.version} (${diff.level}):`);
    printChanges(diff);
    const error = checkVersionBump(base.version, head.version, diff.level);
    if (error) fail(1, `\n✖ ${error}. See docs/contract-events.md#compatibility-policy.`);
    console.log("\n✔ Version bump matches the change level.");
    process.exit(0);
  }

  // Events published outside events.rs would bypass the contract entirely.
  const libSource = readFileSync(resolve(contractDir, "lib.rs"), "utf8");
  if (/\.events\(\)\s*\.publish\s*\(/.test(libSource)) {
    fail(1, "✖ contracts/lib.rs publishes events directly. Define them in contracts/events.rs so they are covered by the event contract.");
  }

  const extracted = extractEventContract(readFileSync(eventsPath, "utf8"));

  if (flag("--update")) {
    if (!existsSync(snapshotPath)) {
      writeSnapshot(buildSnapshot(extracted, "1.0.0"));
      console.log("Created event contract snapshot v1.0.0.");
      process.exit(0);
    }
    const current = readSnapshot(snapshotPath);
    const diff = diffEventContracts(current.events, extracted);
    if (diff.level === "none") {
      console.log(`Event contract already up to date (v${current.version}).`);
      process.exit(0);
    }
    printChanges(diff);
    if (diff.level === "breaking" && !flag("--allow-breaking")) {
      fail(1, "\n✖ Breaking event changes. Re-run with --allow-breaking after coordinating consumers (docs/contract-events.md).");
    }
    const version = bumpVersion(current.version, diff.level);
    writeSnapshot(buildSnapshot(extracted, version));
    console.log(`\nUpdated event contract v${current.version} -> v${version}.`);
    process.exit(0);
  }

  if (!existsSync(snapshotPath)) fail(2, `Missing ${snapshotPath}; run with --update to create it.`);
  const committed = readSnapshot(snapshotPath);
  const diff = diffEventContracts(committed.events, extracted);
  if (diff.level === "none") {
    console.log(`✔ contracts/events.rs matches event contract v${committed.version}.`);
    process.exit(0);
  }
  console.log(`contracts/events.rs drifted from event contract v${committed.version} (${diff.level}):`);
  printChanges(diff);
  fail(1, "\n✖ Run `npm run events:update` (add --allow-breaking for breaking changes) and commit the snapshot.");
} catch (error) {
  fail(2, `Event contract check failed: ${error instanceof Error ? error.message : String(error)}`);
}
