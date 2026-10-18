import type { Request, Response } from "express";
import { getDataSource } from "./database.js";
import { AuditLog } from "../entities/AuditLog.js";
import { hashIp } from "../middleware/payments-admin.js";
import { logger } from "./logger.js";

/**
 * Writes an account-security event to the audit log (#1448).
 *
 * Payloads carry ids and hashes only; callers must never pass tokens, raw
 * emails or credentials. A failure to write is logged and swallowed, like the
 * admin audit middleware: the action has already been authorized and applied,
 * and the `auth_event` log line still records it.
 */
export async function recordAuthAudit(
  req: Request,
  res: Response,
  action: string,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    const repository = getDataSource().getRepository(AuditLog);
    await repository.save(
      repository.create({
        action,
        ipHash: hashIp(req.ip),
        requestId: String(res.locals.requestId ?? ""),
        payload,
      })
    );
  } catch (error) {
    logger.error("Failed to persist auth audit log", {
      action,
      requestId: res.locals.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
