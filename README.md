# AI-First Task Manager (Custom GPT + Google Sheets + GAS)

## Overview
A minimal AI-first task manager where:
- Custom GPT is the primary UI
- Google Sheets is the system of record
- Google Apps Script exposes HTTP endpoints for CRUD
- A Cloudflare Worker proxy provides stable JSON endpoints for headless clients (avoids Google redirect/interstitial HTML)

Auth is intentionally out of scope per the assessment. Endpoints are public and contain non-sensitive test data only.

## Submission Links
- Sheet URL: (https://docs.google.com/spreadsheets/d/1YKQxE2CysNmBt8t4RBs2Pgl9VilGUK9QoxRB5nNWOtY/edit?usp=sharing)
- GAS Web App URL: (https://script.google.com/macros/s/AKfycbziYi7jenBAjMl-DqAHMP9lH1PIoUbK8YJdpFJS5AMFiz2T19lZWYYbIr2VN7LarOwJ/exec)
- Public API base (Worker): https://little-art-1623.zugictodor.workers.dev
- Custom GPT setup: see `/gpt/setup-notes.md`
- Screen recording (Due to Loom limitations I had to split the video into 2 parts): 
    - Part 1: https://www.loom.com/share/79379b4b60b74f34b4b8c8dda8fd91a4
    - Part 2: https://www.loom.com/share/4f05c2534d5f4460a7ed8b3358f58b8f

## Data Model (Tasks sheet)
Columns:
taskId, title, notes, status, priority, effortMins, tags, createdAt, updatedAt,
startAt, dueAt, snoozedUntil, lastSuggestedAt, contextDays, contextTimes, source, version

## API
- GET /health
- GET /tasks?status=&q=&limit=
- POST /tasks (idempotent via requestId)
- GET /tasks/next?now=ISO
- POST /tasks/{taskId}/complete (idempotent)
- POST /tasks/{taskId}/snooze (idempotent)
- GET /analytics/summary

## Relevance strategy (deterministic)
Eligibility:
- status must be ACTIVE
- startAt <= now (if present)
- snoozedUntil <= now (if present)
- match contextDays/contextTimes when set

Tie-breakers:
- earliest dueAt, then highest priority, then oldest createdAt

## Time/locale handling
- All relative time interpretation uses Europe/Belgrade
- All stored times are ISO 8601 with timezone offsets

## Idempotency, validation, observability
- Idempotency: requestId stored in Requests sheet; retries replay stored response
- Validation: structured JSON errors with traceId
- Logs: request start/end and key task events recorded in Logs sheet

## Production security note (out of scope for assessment)
In production I would:
- add auth (API key or HMAC at Worker layer, or OAuth)
- rate limit + IP allowlist for admin endpoints
- move from Sheets to a DB for scale and consistency
- implement per-user separation and least-privilege execution
