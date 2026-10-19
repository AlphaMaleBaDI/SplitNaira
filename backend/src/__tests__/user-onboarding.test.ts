/**
 * User Onboarding — CI/CD integration tests (#515)
 *
 * Covers the full onboarding lifecycle:
 *   register → login → profile lookup → duplicate guard → validation edge cases
 *
 * Uses the same mock pattern as the existing users.test.ts so no new
 * infrastructure is required.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorHandler, notFoundHandler } from "../middleware/error.js";
import { requestIdMiddleware } from "../middleware/request-id.js";

// ── Database mock ─────────────────────────────────────────────────────────────

const findOneMock = vi.fn();
const existsMock = vi.fn();
const createMock = vi.fn();
const saveMock = vi.fn();
const commitMock = vi.fn();
const rollbackMock = vi.fn();

vi.mock("../services/database.js", () => ({
  getDataSource: () => ({
    getRepository: () => ({
      findOne: findOneMock,
      exists: existsMock,
      create: createMock,
      save: saveMock,
    }),
  }),
  withTransaction: async (
    callback: (queryRunner: {
      manager: {
        getRepository: () => {
          findOne: typeof findOneMock;
          create: typeof createMock;
          save: typeof saveMock;
        };
      };
    }) => Promise<unknown>,
  ) => {
    const repo = { findOne: findOneMock, exists: existsMock, create: createMock, save: saveMock };
    const mockQR = {
      manager: { getRepository: () => repo },
      startTransaction: commitMock,
      commitTransaction: commitMock,
      rollbackTransaction: rollbackMock,
      release: vi.fn(),
    };
    try {
      const result = await callback(mockQR);
      commitMock();
      return result;
    } catch (err) {
      rollbackMock();
      throw err;
    }
  },
}));

import { usersRouter } from "../routes/users.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const VALID_WALLET_2 = "GAFY5DYD3EEUWPHL2JHAWFOLKEI2IAQRAVW4Y3L6DLJQOXG2TAJMU7GC";
const NOW = new Date("2026-06-01T10:00:00.000Z");

function makeUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    walletAddress: VALID_WALLET,
    email: "user@example.com",
    alias: "TestUser",
    role: "user",
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use("/users", usersRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("User Onboarding — full lifecycle (#515)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMock.mockImplementation((input) => input);
    existsMock.mockResolvedValue(false);
    saveMock.mockImplementation(async (input) => makeUser(input));
  });

  // ── Registration ────────────────────────────────────────────────────────────

  describe("POST /users/register — happy path", () => {
    it("registers a new user with all fields", async () => {
      findOneMock.mockResolvedValue(null);
      const app = createApp();

      const res = await request(app).post("/users/register").send({
        walletAddress: VALID_WALLET,
        email: "user@example.com",
        alias: "TestUser",
      });

      expect(res.status).toBe(201);
      expect(res.body.walletAddress).toBe(VALID_WALLET);
      expect(res.body.email).toBe("user@example.com");
      expect(res.body.alias).toBe("TestUser");
      expect(res.body.role).toBe("customer");
      expect(res.body.isActive).toBe(true);
      expect(res.body).toHaveProperty("id");
      expect(res.body).toHaveProperty("createdAt");
      expect(res.body).toHaveProperty("updatedAt");
    });

    it("registers a user with wallet address only (optional fields omitted)", async () => {
      findOneMock.mockResolvedValue(null);
      saveMock.mockImplementation(async (input) =>
        makeUser({ ...input, email: undefined, alias: undefined }),
      );
      const app = createApp();

      const res = await request(app)
        .post("/users/register")
        .send({ walletAddress: VALID_WALLET_2 });

      expect(res.status).toBe(201);
      expect(res.body.walletAddress).toBe(VALID_WALLET_2);
    });

    it("response includes ISO 8601 timestamps", async () => {
      findOneMock.mockResolvedValue(null);
      const app = createApp();

      const res = await request(app).post("/users/register").send({
        walletAddress: VALID_WALLET,
      });

      expect(res.status).toBe(201);
      expect(() => new Date(res.body.createdAt)).not.toThrow();
      expect(() => new Date(res.body.updatedAt)).not.toThrow();
    });
  });

  describe("POST /users/register — duplicate guard", () => {
    it("rejects registration when wallet address already exists", async () => {
      existsMock.mockResolvedValue(true);
      const app = createApp();

      const res = await request(app)
        .post("/users/register")
        .send({ walletAddress: VALID_WALLET });

      expect(res.status).toBe(409);
      expect(res.body.error).toBeDefined();
    });

    it("does not open a transaction on duplicate detection", async () => {
      existsMock.mockResolvedValue(true);
      const app = createApp();

      await request(app)
        .post("/users/register")
        .send({ walletAddress: VALID_WALLET });

      expect(commitMock).not.toHaveBeenCalled();
      expect(rollbackMock).not.toHaveBeenCalled();
    });
  });

  describe("POST /users/register — input validation", () => {
    it.each([
      ["missing walletAddress", {}],
      ["invalid wallet format (too short)", { walletAddress: "GABC" }],
      ["invalid wallet format (wrong prefix)", { walletAddress: "XAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" }],
      ["invalid email format", { walletAddress: VALID_WALLET, email: "not-an-email" }],
      ["alias too long (>64 chars)", { walletAddress: VALID_WALLET, alias: "a".repeat(65) }],
    ])("returns 400 for %s", async (_label, body) => {
      const app = createApp();
      const res = await request(app).post("/users/register").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });
  });

  describe("POST /users/register — transaction safety", () => {
    it("rolls back on database save failure", async () => {
      findOneMock.mockResolvedValue(null);
      saveMock.mockRejectedValue(new Error("DB constraint violation"));
      const app = createApp();

      const res = await request(app).post("/users/register").send({
        walletAddress: VALID_WALLET,
      });

      expect(res.status).toBe(500);
      expect(rollbackMock).toHaveBeenCalled();
    });

    it("commits on successful registration", async () => {
      findOneMock.mockResolvedValue(null);
      const app = createApp();

      const res = await request(app).post("/users/register").send({
        walletAddress: VALID_WALLET,
      });

      expect(res.status).toBe(201);
      expect(commitMock).toHaveBeenCalled();
    });
  });

  // ── Login ───────────────────────────────────────────────────────────────────

  describe("POST /users/login — happy path", () => {
    it("logs in an existing user and returns profile", async () => {
      findOneMock.mockResolvedValue(makeUser());
      const app = createApp();

      const res = await request(app)
        .post("/users/login")
        .send({ walletAddress: VALID_WALLET });

      expect(res.status).toBe(200);
      expect(res.body.walletAddress).toBe(VALID_WALLET);
      expect(res.body.alias).toBe("TestUser");
      expect(res.body.role).toBe("user");
    });

    it("login response shape matches registration response shape", async () => {
      findOneMock.mockResolvedValue(makeUser());
      const app = createApp();

      const loginRes = await request(app)
        .post("/users/login")
        .send({ walletAddress: VALID_WALLET });

      expect(loginRes.body).toHaveProperty("id");
      expect(loginRes.body).toHaveProperty("walletAddress");
      expect(loginRes.body).toHaveProperty("role");
      expect(loginRes.body).toHaveProperty("isActive");
      expect(loginRes.body).toHaveProperty("createdAt");
      expect(loginRes.body).toHaveProperty("updatedAt");
    });
  });

  describe("POST /users/login — error cases", () => {
    it("returns a generic 401 when user does not exist", async () => {
      findOneMock.mockResolvedValue(null);
      const app = createApp();

      const res = await request(app)
        .post("/users/login")
        .send({ walletAddress: VALID_WALLET });

      expect(res.status).toBe(401);
    });

    it("returns 400 for invalid wallet address format", async () => {
      const app = createApp();

      const res = await request(app)
        .post("/users/login")
        .send({ walletAddress: "INVALID_ADDRESS" });

      expect(res.status).toBe(400);
    });
  });

  // ── Profile lookup ──────────────────────────────────────────────────────────

  describe("GET /users/:walletAddress — happy path", () => {
    it("returns user profile for a valid wallet address", async () => {
      findOneMock.mockResolvedValue(makeUser());
      const app = createApp();

      const res = await request(app).get(`/users/${VALID_WALLET}`);

      expect(res.status).toBe(200);
      expect(res.body.walletAddress).toBe(VALID_WALLET);
      expect(res.body.alias).toBe("TestUser");
    });

    it("returns 404 for a wallet address that has no account", async () => {
      findOneMock.mockResolvedValue(null);
      const app = createApp();

      const res = await request(app).get(`/users/${VALID_WALLET}`);

      expect(res.status).toBe(404);
    });

    it("returns 400 for a malformed wallet address in the path", async () => {
      const app = createApp();

      const res = await request(app).get("/users/NOT_A_STELLAR_ADDRESS");

      expect(res.status).toBe(400);
    });
  });

  // ── End-to-end onboarding flow ──────────────────────────────────────────────

  describe("Full onboarding flow: register → login → lookup", () => {
    it("completes the full onboarding lifecycle without errors", async () => {
      const app = createApp();

      // Step 1: Register
      findOneMock.mockResolvedValue(null);
      const registerRes = await request(app).post("/users/register").send({
        walletAddress: VALID_WALLET,
        email: "onboard@example.com",
        alias: "OnboardUser",
      });
      expect(registerRes.status).toBe(201);

      // Step 2: Login
      findOneMock.mockResolvedValue(makeUser({ alias: "OnboardUser" }));
      const loginRes = await request(app)
        .post("/users/login")
        .send({ walletAddress: VALID_WALLET });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.alias).toBe("OnboardUser");

      // Step 3: Profile lookup
      findOneMock.mockResolvedValue(makeUser({ alias: "OnboardUser" }));
      const profileRes = await request(app).get(`/users/${VALID_WALLET}`);
      expect(profileRes.status).toBe(200);
      expect(profileRes.body.walletAddress).toBe(VALID_WALLET);
    });
  });
});
