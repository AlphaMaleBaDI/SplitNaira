import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import SwaggerParser from "@apidevtools/swagger-parser";

/**
 * Issue #1461: API contract tests.
 *
 * These hit the real Express app and check the responses against the
 * generated OpenAPI document, so a route that starts returning an
 * undocumented shape (or a documented route that stops being served) fails
 * CI instead of surprising clients in production.
 */

vi.mock("@stellar/stellar-sdk", () => {
  return {
    Address: {
      fromString: vi.fn((address) => ({
        toScVal: () => ({ address }),
        toString: () => address,
      })),
    },
    BASE_FEE: "100",
    Contract: vi.fn().mockImplementation(function () {
      return { call: vi.fn().mockReturnValue({}) };
    }),
    TransactionBuilder: vi.fn().mockImplementation(function () {
      return {
        addOperation: vi.fn().mockReturnThis(),
        setTimeout: vi.fn().mockReturnThis(),
        build: vi.fn().mockReturnValue({ toXDR: () => "test_xdr" }),
      };
    }),
    nativeToScVal: vi.fn((val) => ({ val })),
    scValToNative: vi.fn((val) => val),
    rpc: {
      Server: vi.fn().mockImplementation(function () {
        return {
          getAccount: vi.fn().mockResolvedValue({
            accountId: () => "GD5T6IPRNCKFOHQ3STZ5BTEYI5V6U5U6U5U6U5U6U5U6U5U6U5U6U5U6",
            sequenceNumber: () => "1",
            sequence: "1",
          }),
          simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: [] } }),
          prepareTransaction: vi.fn().mockResolvedValue({
            toXDR: () => "test_xdr",
            sequence: "1",
            fee: "100",
          }),
        };
      }),
    },
    xdr: {
      ScVal: { scvU32: vi.fn(), scvVec: vi.fn() },
    },
  };
});

vi.mock("../services/stellar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/stellar.js")>();
  return {
    ...actual,
    loadStellarConfig: vi.fn(() => ({
      horizonUrl: "http://horizon",
      sorobanRpcUrl: "http://rpc",
      networkPassphrase: "test",
      contractId: "CBLASIRZ7CUKC7S5IS3VSNMQGKZ5FTRWLHZZXH7H4YG6ZLRFPJF5H2LR",
      simulatorAccount: "test_account",
    })),
    getStellarRpcServer: vi.fn(() => ({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: null } }),
      prepareTransaction: vi.fn().mockResolvedValue({
        toXDR: () => "test_xdr",
        sequence: "1",
        fee: "100",
      }),
      getEvents: vi.fn().mockResolvedValue({ events: [] }),
    })),
    executeWithRetry: vi.fn(async (fn) => fn()),
    getCached: vi.fn(() => undefined),
    setCached: vi.fn(),
    invalidateCache: vi.fn(),
    invalidateCacheByPrefix: vi.fn(),
    getCacheStats: vi.fn(() => ({ hits: 0, misses: 0, evictions: 0 })),
    READ_CACHE_TTL_MS: 30000,
    checkSorobanReachability: vi.fn().mockResolvedValue({
      rpc: { ok: true },
      contract: { ok: true },
    }),
  };
});

vi.mock("../services/database.js", () => ({
  getDataSource: vi.fn(() => ({
    isInitialized: true,
    query: vi.fn().mockResolvedValue([{ one: 1 }]),
  })),
  initDatabase: vi.fn().mockResolvedValue({}),
  closeDatabase: vi.fn().mockResolvedValue({}),
}));

import { app } from "../index.js";
import { generateOpenApi } from "../openapi.js";
import { clearEnvCache } from "../config/env.js";
import { markStartupComplete } from "../routes/health.js";

type JsonSchema = {
  $ref?: string;
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

type Spec = {
  paths?: Record<
    string,
    Record<string, { responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }> }>
  >;
  components?: { schemas?: Record<string, JsonSchema> };
};

function cloneSpec(spec: unknown): Spec {
  return JSON.parse(JSON.stringify(spec)) as Spec;
}

/**
 * Fields the runtime emits today that the published schema does not yet
 * enumerate. They are documented in prose (see docs/runbooks) but deliberately
 * tolerated here so the test flags *new* accidental drift, not known gaps.
 */
const KNOWN_ADDITIVE_FIELDS = new Set(["code", "version"]);

function resolveSchema(spec: Spec, schema?: JsonSchema): JsonSchema | undefined {
  if (!schema) return undefined;
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop() as string;
    return spec.components?.schemas?.[name];
  }
  return schema;
}

function documentedSchema(
  spec: Spec,
  path: string,
  method: string,
  status: string,
): JsonSchema | undefined {
  const operation = spec.paths?.[path]?.[method];
  return resolveSchema(spec, operation?.responses?.[status]?.content?.["application/json"]?.schema);
}

function documentedTopLevelKeys(
  spec: Spec,
  path: string,
  method: string,
  status: string,
): Set<string> {
  const schema = documentedSchema(spec, path, method, status);
  return new Set(Object.keys(schema?.properties ?? {}));
}

beforeAll(() => {
  process.env.DATABASE_URL = "https://example.com/postgres";
  process.env.SIMULATOR_ACCOUNT = "GD5T6IPRNCKFOHQ3STZ5BTEYI5V6U5U6U5U6U5U6U5U6U5U6U5U6U5U6";
  process.env.CONTRACT_ID = "CBLASIRZ7CUKC7S5IS3VSNMQGKZ5FTRWLHZZXH7H4YG6ZLRFPJF5H2LR";
  process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
  process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
  process.env.SOROBAN_NETWORK_PASSPHRASE = "test";
});

beforeEach(() => {
  clearEnvCache();
  markStartupComplete();
});

describe("Issue #1461: API contract against generated OpenAPI", () => {
  it("generates a valid OpenAPI 3.0 document", async () => {
    await expect(SwaggerParser.validate(cloneSpec(generateOpenApi()) as never)).resolves.toBeDefined();
  });

  it("documents the operations the API is expected to serve", () => {
    const spec = generateOpenApi() as Spec;
    const expected: Array<[string, string]> = [
      ["get", "/splits"],
      ["post", "/splits"],
      ["get", "/splits/{projectId}"],
      ["post", "/users/register"],
      ["post", "/users/login"],
      ["get", "/users/me"],
      ["patch", "/users/me"],
      ["delete", "/users/me"],
      ["get", "/transactions/history"],
      ["get", "/events"],
      ["get", "/health"],
      ["get", "/health/ready"],
    ];

    for (const [method, path] of expected) {
      expect(spec.paths?.[path]?.[method], `${method.toUpperCase()} ${path}`).toBeDefined();
    }
  });

  it("serves /api/openapi.json exactly matching the generated document", async () => {
    const spec = cloneSpec(generateOpenApi());
    const res = await request(app).get("/api/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(spec);
  });

  it("every documented operation declares at least one success response", () => {
    const spec = generateOpenApi() as Spec;

    for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
      for (const [method, operation] of Object.entries(pathItem)) {
        const statuses = Object.keys(operation.responses ?? {});
        expect(
          statuses.some((status) => status.startsWith("2")),
          `${method.toUpperCase()} ${path} has no 2xx response`,
        ).toBe(true);
      }
    }
  });

  describe("runtime responses stay inside the documented shape", () => {
    const contracts: Array<{
      method: "get";
      path: string;
      requestPath: string;
      status: string;
      required: string[];
    }> = [
      {
        method: "get",
        path: "/",
        requestPath: "/",
        status: "200",
        required: ["name", "status", "version"],
      },
      {
        method: "get",
        path: "/health/live",
        requestPath: "/health/live",
        status: "200",
        required: ["status"],
      },
      {
        method: "get",
        path: "/health/ready",
        requestPath: "/health/ready",
        status: "200",
        required: ["status", "components"],
      },
    ];

    for (const contract of contracts) {
      it(`GET ${contract.requestPath} matches its documented schema`, async () => {
        const spec = generateOpenApi() as Spec;
        const res = await request(app).get(contract.requestPath);

        expect(res.status).toBe(Number(contract.status));

        for (const key of contract.required) {
          expect(res.body).toHaveProperty(key);
        }

        const documented = documentedTopLevelKeys(spec, contract.path, contract.method, contract.status);
        expect(documented.size).toBeGreaterThan(0);

        for (const key of Object.keys(res.body)) {
          const allowed = documented.has(key) || KNOWN_ADDITIVE_FIELDS.has(key);
          expect(allowed, `GET ${contract.requestPath} returned undocumented field "${key}"`).toBe(true);
        }
      });
    }
  });

  it("serves the stable unknown-route 404 contract", async () => {
    const spec = generateOpenApi() as Spec;
    const res = await request(app).get("/this/route/is/not/documented");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "not_found",
      code: "NOT_FOUND",
      message: "The requested resource does not exist.",
      requestId: expect.any(String),
      details: {},
    });

    const errorSchema = resolveSchema(spec, spec.components?.schemas?.ApiError);
    const bodyKeys = Object.keys(res.body);
    for (const key of bodyKeys) {
      const allowed =
        Object.prototype.hasOwnProperty.call(errorSchema?.properties ?? {}, key) ||
        KNOWN_ADDITIVE_FIELDS.has(key);
      expect(allowed, `unknown-route body returned undocumented field "${key}"`).toBe(true);
    }
  });

  it("returns a documented error envelope for an invalid request", async () => {
    const res = await request(app).get("/splits/invalid-project-id!!!");

    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error).toBe("validation_error");
    expect(res.body.requestId).toBeTruthy();

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("stack");
    expect(serialized).not.toContain("at Object.");
  });

  it("rejects unsupported verbs on mutation resources without dispatching a mutation", async () => {
    const unsupported = [
      ["put", "/splits"],
      ["patch", "/splits"],
      ["delete", "/splits"],
      ["put", "/users/me"],
      ["post", "/transactions/history"],
    ] as const;

    for (const [method, path] of unsupported) {
      const res = await request(app)[method](path).send({ name: "must not be created" });
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(404);
      expect(res.body).toMatchObject({
        error: "not_found",
        code: "NOT_FOUND",
        message: "The requested resource does not exist.",
      });
      expect(JSON.stringify(res.body)).not.toContain("must not be created");
    }
  });

  it("keeps HEAD as the GET equivalent and OPTIONS as CORS preflight", async () => {
    const head = await request(app).head("/health/live");
    expect(head.status).toBe(200);
    expect(head.text ?? "").toBe("");

    const options = await request(app).options("/splits");
    expect(options.status).toBe(204);
    expect(options.headers["access-control-allow-methods"]).toBeTruthy();
  });
});
