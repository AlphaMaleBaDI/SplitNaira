# Privacy-Safe Analytics Event Schema Specification (Issue #1535)

## Overview
This document specifies the privacy-safe analytics event schema enforced across SplitNaira's frontend and backend telemetry pipelines.

## Privacy Invariants
1. **Zero Raw PII**: Wallet addresses (`G...`, `C...`), email addresses, and IP addresses are strictly forbidden in raw analytics events.
2. **Pii Scrubbing**: `scrubTelemetryText()` sanitizes strings using pattern matching before transmission.
3. **Anonymized Identity**: User identifiers are hashed using SHA-256 with a daily rotating salt.

## Event Schema Definition

```typescript
export interface PrivacyAnalyticsEventSchema {
  eventName: string; // e.g. "split.create.started"
  category: "split.lifecycle" | "navigation" | "user.action";
  anonymizedUserId?: string; // SHA-256(wallet + daily_salt)
  properties: Record<string, string | number | boolean>;
  timestamp: number; // Epoch ms
}
```

## Validation Rules
- All string properties are scanned for raw wallet address format (`/\b[GC][A-Z2-7]{55}\b/`) and email format (`/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/`).
- Events containing unredacted PII fail validation and are dropped at the telemetry layer.
