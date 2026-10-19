/**
 * Contract event integration contract.
 *
 * Emitted Soroban events are consumed off-chain (backend EventListenerService,
 * history decoders, indexers, analytics), so their wire shape is an API. This
 * module extracts that shape from `contracts/events.rs` and classifies the
 * differences between two snapshots so CI can block breaking changes.
 *
 * Wire model: an event is identified by its first topic (a Symbol name).
 * Topics and data are positional ScVals; Rust field names never reach the
 * wire. Compatibility is therefore judged on position, kind and type only.
 *
 * Classification (base -> head):
 *   breaking       event removed; topic name changed; topic added, removed,
 *                  retyped or reordered; data shape changed (unit/single/tuple);
 *                  data field removed, retyped or reordered
 *   additive       new event; new trailing field appended to tuple data
 *                  (decoders must ignore extra trailing elements)
 *   informational  Rust struct or field renamed with an identical wire shape
 *
 * Pure functions only; see check-event-contract.mjs for the CLI.
 */

export const EVENT_CONTRACT_SCHEMA = "splitnaira.event-contract";

// ─────────────────────────────────────────────────────────────────────────────
// Rust source parsing
// ─────────────────────────────────────────────────────────────────────────────

function stripComments(source) {
  return source.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Splits on `sep` at nesting depth 0 for (), <>, [] and string literals. */
export function splitTopLevel(input, sep = ",") {
  const parts = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      current += ch;
      if (ch === "\\") {
        current += input[++i] ?? "";
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") inString = true;
    if ("(<[{".includes(ch)) depth += 1;
    if (")>]}".includes(ch)) depth -= 1;
    if (ch === sep && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Returns the text between the paren at `openIndex` and its match. */
function balancedParens(text, openIndex) {
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  throw new Error(`Unbalanced parentheses at offset ${openIndex}`);
}

function isTuple(expr) {
  const trimmed = expr.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return false;
  return balancedParens(trimmed, 0).length === trimmed.length - 2;
}

function parseStructs(source) {
  const structs = new Map();
  const re = /pub\s+struct\s+(\w+)\s*\{([^}]*)\}/g;
  for (const match of source.matchAll(re)) {
    const fields = new Map();
    for (const field of splitTopLevel(match[2])) {
      const fm = field.match(/^(?:pub(?:\([^)]*\))?\s+)?(\w+)\s*:\s*(.+)$/s);
      if (fm) fields.set(fm[1], fm[2].replace(/\s+/g, " ").trim());
    }
    structs.set(match[1], fields);
  }
  return structs;
}

function describeValue(expr, fields, ctx) {
  const e = expr.trim().replace(/\s+/g, " ");
  const sym = e.match(/^(?:Symbol::new\s*\(\s*\w+\s*,\s*|symbol_short!\s*\(\s*)"([^"]+)"\s*\)$/);
  if (sym) return { kind: "symbol", value: sym[1], type: "Symbol" };
  const field = e.match(/^self\.(\w+)(?:\.clone\(\))?$/);
  if (field) {
    const type = fields.get(field[1]);
    if (!type) throw new Error(`${ctx}: unknown field self.${field[1]}`);
    return { kind: "field", field: field[1], type };
  }
  throw new Error(`${ctx}: unsupported event expression \`${e}\``);
}

/**
 * Extracts every `impl Publishable for X` publish call from events.rs source.
 * Throws on any construct it cannot model, so unknown shapes fail loudly
 * instead of silently escaping the contract.
 */
export function extractEventContract(source) {
  // Test modules publish nothing on-chain; ignore everything after the first one.
  const stripped = stripComments(source);
  const testIndex = stripped.indexOf("#[cfg(test)]");
  const clean = testIndex === -1 ? stripped : stripped.slice(0, testIndex);
  const structs = parseStructs(clean);
  const events = {};
  const PUBLISH = "env.events().publish";
  const implHeaders = [...clean.matchAll(/impl\s+(?:Publishable\s+for\s+)?(\w+)\s*\{/g)];

  // Every publish call counts, whether it lives in a `Publishable` impl or an
  // inherent `impl X { pub fn publish }`, so no event escapes the contract.
  for (let callIndex = clean.indexOf(PUBLISH); callIndex !== -1; callIndex = clean.indexOf(PUBLISH, callIndex + 1)) {
    const header = implHeaders.filter((h) => h.index < callIndex).at(-1);
    if (!header) throw new Error(`publish call at offset ${callIndex} is outside any impl block`);
    const structName = header[1];
    const fields = structs.get(structName);
    if (!fields) throw new Error(`publish call in impl for unknown struct ${structName}`);

    const args = splitTopLevel(balancedParens(clean, clean.indexOf("(", callIndex + PUBLISH.length)));
    if (args.length !== 2) throw new Error(`${structName}: publish expects (topics, data)`);
    const [topicExpr, dataExpr] = args;

    const topicItems = isTuple(topicExpr) ? splitTopLevel(balancedParens(topicExpr.trim(), 0)) : [topicExpr];
    const topics = topicItems.map((t, i) => ({ position: i, ...describeValue(t, fields, `${structName} topic[${i}]`) }));
    if (topics[0]?.kind !== "symbol") throw new Error(`${structName}: topic[0] must be a Symbol name`);
    const name = topics[0].value;

    let data;
    const d = dataExpr.trim();
    if (d === "()") {
      data = { shape: "unit", fields: [] };
    } else if (isTuple(d)) {
      const items = splitTopLevel(balancedParens(d, 0));
      data = {
        shape: "tuple",
        fields: items.map((t, i) => ({ position: i, ...describeValue(t, fields, `${structName} data[${i}]`) })),
      };
    } else {
      data = { shape: "single", fields: [{ position: 0, ...describeValue(d, fields, `${structName} data`) }] };
    }

    if (events[name]) throw new Error(`Duplicate event name "${name}" (${events[name].struct}, ${structName})`);
    events[name] = { struct: structName, topics, data };
  }

  if (Object.keys(events).length === 0) throw new Error("No Publishable events found");
  return Object.fromEntries(Object.entries(events).sort(([a], [b]) => a.localeCompare(b)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Diffing
// ─────────────────────────────────────────────────────────────────────────────

const wire = (v) => (v.kind === "symbol" ? `Symbol("${v.value}")` : v.type);

/** Classifies every difference between two `events` maps. */
export function diffEventContracts(baseEvents, headEvents) {
  const changes = [];
  const add = (level, event, message) => changes.push({ level, event, message });

  for (const [name, base] of Object.entries(baseEvents)) {
    const head = headEvents[name];
    if (!head) {
      add("breaking", name, "event removed (or its topic[0] name changed)");
      continue;
    }
    if (base.struct !== head.struct) {
      add("informational", name, `Rust struct renamed ${base.struct} -> ${head.struct}`);
    }

    // Topics: every position is a filter key, so any change is breaking.
    const maxTopics = Math.max(base.topics.length, head.topics.length);
    for (let i = 0; i < maxTopics; i += 1) {
      const b = base.topics[i];
      const h = head.topics[i];
      if (!h) add("breaking", name, `topic[${i}] (${wire(b)}) removed`);
      else if (!b) add("breaking", name, `topic[${i}] (${wire(h)}) added; topic filters are positional`);
      else if (wire(b) !== wire(h)) add("breaking", name, `topic[${i}] changed ${wire(b)} -> ${wire(h)}`);
      else if (b.field !== h.field) add("informational", name, `topic[${i}] field renamed ${b.field} -> ${h.field}`);
    }

    // Data.
    if (base.data.shape !== head.data.shape) {
      add("breaking", name, `data shape changed ${base.data.shape} -> ${head.data.shape}`);
      continue;
    }
    const bf = base.data.fields;
    const hf = head.data.fields;
    for (let i = 0; i < Math.max(bf.length, hf.length); i += 1) {
      const b = bf[i];
      const h = hf[i];
      if (!h) add("breaking", name, `data[${i}] (${wire(b)}) removed`);
      else if (!b) {
        add("additive", name, `data[${i}] (${wire(h)}) appended; consumers must ignore trailing fields`);
      } else if (wire(b) !== wire(h)) add("breaking", name, `data[${i}] changed ${wire(b)} -> ${wire(h)}`);
      else if (b.field !== h.field) add("informational", name, `data[${i}] field renamed ${b.field} -> ${h.field}`);
    }
  }

  for (const name of Object.keys(headEvents)) {
    if (!baseEvents[name]) add("additive", name, "new event");
  }

  const has = (level) => changes.some((c) => c.level === level);
  const level = has("breaking") ? "breaking" : has("additive") ? "additive" : has("informational") ? "informational" : "none";
  return { level, changes };
}

// ─────────────────────────────────────────────────────────────────────────────
// Versioning
// ─────────────────────────────────────────────────────────────────────────────

export function parseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!m) throw new Error(`Invalid event contract version "${version}" (expected MAJOR.MINOR.PATCH)`);
  return m.slice(1).map(Number);
}

/** Next version for a diff level: breaking -> major, additive -> minor, informational -> patch. */
export function bumpVersion(version, level) {
  const [major, minor, patch] = parseVersion(version);
  if (level === "breaking") return `${major + 1}.0.0`;
  if (level === "additive") return `${major}.${minor + 1}.0`;
  if (level === "informational") return `${major}.${minor}.${patch + 1}`;
  return version;
}

/**
 * Verifies that `headVersion` is a large-enough bump over `baseVersion` for
 * the given diff level. Returns an error message, or null when acceptable.
 */
export function checkVersionBump(baseVersion, headVersion, level) {
  const [bMaj, bMin, bPat] = parseVersion(baseVersion);
  const [hMaj, hMin, hPat] = parseVersion(headVersion);
  const cmp = hMaj - bMaj || hMin - bMin || hPat - bPat;
  if (cmp < 0) return `version went backwards ${baseVersion} -> ${headVersion}`;
  if (level === "breaking" && hMaj <= bMaj) {
    return `breaking event changes require a MAJOR bump (${baseVersion} -> ${bMaj + 1}.0.0)`;
  }
  if (level === "additive" && cmp <= 0) return `additive event changes require at least a MINOR bump over ${baseVersion}`;
  if (level === "informational" && cmp <= 0) return `event contract changed; bump at least PATCH over ${baseVersion}`;
  return null;
}

export function buildSnapshot(events, version) {
  return {
    schema: EVENT_CONTRACT_SCHEMA,
    version,
    source: "contracts/events.rs",
    events,
  };
}
