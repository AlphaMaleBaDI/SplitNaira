import jwt, { type SignOptions } from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";
const EXPIRES_IN = (process.env.JWT_EXPIRES_IN || "24h") as SignOptions["expiresIn"];

export interface WalletTokenPayload {
  walletAddress: string;
  /** Session version at issue time (#1446). Absent on tokens issued before it existed. */
  sv?: number;
}

export function signToken(walletAddress: string, sessionVersion = 0): string {
  return jwt.sign({ walletAddress, sv: sessionVersion }, SECRET, { expiresIn: EXPIRES_IN });
}

export function verifyToken(token: string): WalletTokenPayload | null {
  try {
    return jwt.verify(token, SECRET) as WalletTokenPayload;
  } catch {
    return null;
  }
}
