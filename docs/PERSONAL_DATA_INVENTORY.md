# Personal Data Inventory & Purpose Map (Issue #1532)

## Overview
This document maps all personal data elements processed by SplitNaira across the backend, database, and telemetry pipelines, establishing processing purposes, legal bases under GDPR/NDPR, retention policies, and data scrubbing controls.

## Personal Data Inventory

| Category | Data Field | Source | Purpose of Processing | Legal Basis | Retention Period | Scrubbing / Anonymization |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Authentication** | `email` | User Signup / Auth | User account identification, password resets, notification delivery | Contract Fulfillment / Consent | Account Lifetime + 30 days after deletion | Hashed in logs; stored encrypted at rest |
| **Wallet Identity** | `walletAddress` | Stellar Wallet | Transaction routing, smart contract split execution, on-chain verification | Contract Fulfillment | Permanent (on-chain record) | Scrubbed from Sentry telemetry when `SENTRY_SCRUB_WALLET_ADDRESSES=true` |
| **Network & Logs** | `ip` (IP Address) | HTTP Request | Anti-bot rate limiting, fraud prevention, security auditing | Legitimate Interest | 30 days | Redacted/hashed in long-term application logs |
| **Collaboration** | `inviterWalletAddress` | Invite Flow | Co-grantee / split partner attribution | Consent | Split Lifetime | Purged upon split deletion |
| **Session** | `jwtToken` | Auth Header | Session authentication & route protection | Contract Fulfillment | 7 days (JWT expiry) | Never logged; stored client-side in memory |

## Compliance & Security Controls
1. **Sentry Telemetry Sanitization**: Wallet addresses and authorization tokens are automatically stripped from error payloads.
2. **Database Encryption**: Sensitive fields (e.g. email tokens, API keys) are hashed or encrypted using AES-256-GCM.
3. **Right to Erasure (NDPR/GDPR)**: Users requesting account deletion trigger an automated cascade purging profile metadata, email associations, and active sessions.
