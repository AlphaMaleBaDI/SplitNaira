import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error.js";
import { LOGIN_LOCKOUT_MS } from "../services/login-attempts.js";

const { findOne, signToken } = vi.hoisted(() => ({ findOne: vi.fn(), signToken: vi.fn() }));
vi.mock("../services/database.js", () => ({
  getDataSource: () => ({ getRepository: () => ({ findOne }) }),
  withTransaction: vi.fn(),
}));
vi.mock("../services/jwt.js", () => ({ signToken }));
import { usersRouter } from "../routes/users.js";

const walletAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const user = {
  id: "user",
  walletAddress,
  isActive: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const failure = {
  error: "unauthorized",
  code: "UNAUTHORIZED",
  message: "Unable to sign in. Check your details or try again later.",
  details: {},
  requestId: expect.any(String),
};
let now = 0;
const app = express();
app.use(express.json());
app.use("/users", usersRouter);
app.use(errorHandler);
const login = () => request(app).post("/users/login").send({ walletAddress });

beforeEach(() => {
  vi.resetAllMocks();
  now += 2 * LOGIN_LOCKOUT_MS;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  signToken.mockReturnValue("test-token");
});
afterEach(() => vi.restoreAllMocks());

describe("login lockout API", () => {
  it.each([null, { ...user, isActive: false }])(
    "uses the same failure response for missing/inactive accounts",
    async (record) => {
      findOne.mockResolvedValue(record);
      const res = await login();
      expect(res.status).toBe(401);
      expect(res.body).toEqual(failure);
      expect(res.headers["retry-after"]).toBeUndefined();
      expect(signToken).not.toHaveBeenCalled();
    }
  );

  it("locks unknown identities too, denies even a now-valid account, and recovers automatically", async () => {
    findOne.mockResolvedValue(null);
    for (let i = 0; i < 5; i++) expect((await login()).body).toEqual(failure);
    findOne.mockResolvedValue(user);
    now += LOGIN_LOCKOUT_MS - 1;
    const locked = await login();
    expect(locked.status).toBe(401);
    expect(locked.body).toEqual(failure);
    expect(findOne).toHaveBeenCalledTimes(5);
    expect(signToken).not.toHaveBeenCalled();
    now += 1;
    const recovered = await login();
    expect(recovered.status).toBe(200);
    expect(recovered.body.token).toBe("test-token");
    expect(findOne).toHaveBeenLastCalledWith({
      where: { walletAddress, deletedAt: expect.anything() },
    });
  });

  it("resets failures on success", async () => {
    findOne.mockResolvedValue(null);
    for (let i = 0; i < 4; i++) await login();
    findOne.mockResolvedValue(user);
    expect((await login()).status).toBe(200);
    findOne.mockResolvedValue(null);
    for (let i = 0; i < 4; i++) await login();
    findOne.mockResolvedValue(user);
    expect((await login()).status).toBe(200);
  });

  it("does not turn database failures into account failures", async () => {
    findOne.mockRejectedValue(new Error("database unavailable"));
    for (let i = 0; i < 5; i++) expect((await login()).status).toBe(500);
    findOne.mockResolvedValue(user);
    expect((await login()).status).toBe(200);
  });

  it("does not reactivate an inactive account when the cooldown expires", async () => {
    findOne.mockResolvedValue({ ...user, isActive: false });
    for (let i = 0; i < 5; i++) await login();
    now += LOGIN_LOCKOUT_MS;
    expect((await login()).body).toEqual(failure);
    expect(findOne).toHaveBeenCalledTimes(6);
    expect(signToken).not.toHaveBeenCalled();
  });

  it("does not count token-signing failures against the wallet", async () => {
    findOne.mockResolvedValue(user);
    signToken.mockImplementation(() => {
      throw new Error("signer unavailable");
    });
    for (let i = 0; i < 5; i++) expect((await login()).status).toBe(500);
    signToken.mockReturnValue("test-token");
    expect((await login()).status).toBe(200);
  });

  it("keeps malformed input validation without querying the database", async () => {
    expect(
      (await request(app).post("/users/login").send({ walletAddress: "invalid" })).status
    ).toBe(400);
    expect(findOne).not.toHaveBeenCalled();
  });
});
