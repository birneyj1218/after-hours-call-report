# Architecture

## Pieces

| Piece | Where | Job |
|---|---|---|
| Voice assistant | Vapi or similar (not in this repo) | Answers the after-hours line, takes the message, flags danger. Prompt example: [assistant-prompt.md](assistant-prompt.md) |
| n8n workflow | [`n8n/after-hours-call-report.json`](../n8n/after-hours-call-report.json) | Receives the end-of-call webhook, calls the LLM, CRM, SMS and email APIs, runs the morning digest |
| Core logic | [`src/`](../src/) | Normalizing, triage, summary validation, rendering, digest grouping. Plain CommonJS, no dependencies |
| Mock providers | [`mock/`](../mock/) | Fake LLM, email, SMS and CRM endpoints, plus a fake voice provider that posts sample webhooks |

The workflow's Code nodes are generated from `src/` by [`scripts/build-workflow.js`](../scripts/build-workflow.js). n8n Code nodes cannot `require()` local files, so the build script pastes the needed modules into each node with a small `require` shim. CI fails if the committed workflow and `src/` drift apart, so the code the tests cover is the code n8n runs.

## Per-call flow

```mermaid
sequenceDiagram
    participant V as Voice provider
    participant N as n8n
    participant L as LLM
    participant C as CRM
    participant S as SMS
    participant E as Email
    V->>N: POST end-of-call-report (secret header)
    N-->>V: 200 right away
    N->>N: Prepare call: normalize, drop non-reports and retries
    opt LLM_ENABLED
        N->>L: transcript + captured fields
        L-->>N: JSON summary (or an error, which is fine)
    end
    N->>N: Classify (rules, then agent field, then LLM; highest wins)<br/>validate summary, render email + SMS, store for digest
    N->>C: call record (Idempotency-Key = call id)
    alt level >= SMS_ALERT_LEVEL
        N->>S: text the owner
    end
    alt level >= EMAIL_EACH_CALL
        N->>E: full call report
    end
```

## Morning digest

A schedule trigger runs at 7:00 in the workflow's time zone. It takes every call stored since the last digest, groups them by **night** in the business's time zone (a call at 3 am Saturday belongs to Friday night; the cutover hour is configurable), sorts each night emergency-first, and sends one email. Only after that email succeeds are the calls removed from the store. If it fails, they stay and go out with the next digest.

## Triage

Triage has three inputs. The highest level wins, and nothing can lower what the rules found.

1. **Rules** ([`src/classify.js`](../src/classify.js)). Phrase patterns run over what the *caller* said, plus the problem the agent wrote down. Assistant questions ("Do you smell gas?") are not counted. A simple negation check skips "no smoke" and "I don't smell gas" without hiding "No, it's sparking". Two combination rules: no heat plus a freezing temperature or a vulnerable person; no power plus medical equipment.
2. **Voice agent's urgency field**, if the platform's end-of-call analysis provides one.
3. **LLM summary**, if enabled and if it returns valid JSON.

Rules first means the alert does not depend on the LLM being up, fast, or right. The LLM adds a readable summary and can catch things phrase rules miss (for example a caller who only answered "yes" to "Do you smell gas?").

## Trusting LLM output

- The reply must parse as JSON and pass [`src/schema.js`](../src/schema.js) (types, enums, lengths). Otherwise it is dropped and the report uses the call data.
- Fields the voice agent captured always win over LLM-extracted ones.
- An LLM-extracted name or address is used only if most of its words appear in the transcript; a phone number only if its last 7 digits were said. Anything the LLM filled in is marked with `*` in the report.
- The transcript is fenced in the prompt and the system prompt tells the model to ignore instructions inside it. That reduces prompt-injection risk; it does not remove it, which is one more reason the LLM can only raise urgency and never send anything on its own.

## State

The workflow keeps a small object in n8n workflow static data:

```json
{ "calls": [ /* digest entries, no transcripts */ ], "seen": { "<call id>": "<first seen>" }, "lastDigestAt": "<ISO time>" }
```

`seen` drops provider retries so the owner is not texted twice. Ids are forgotten after 7 days. Digest entries are removed once reported, and the list is capped at 500.

Static data is simple and needs no database, but it has limits (see the README): n8n saves it only for production runs, and two executions finishing at the same moment can overwrite each other's update.

## Failure behaviour

| What fails | What happens |
|---|---|
| LLM down, slow, or returns junk | Rules decide; summary is built from the call data; the report says so |
| CRM down | Retries 3 times, then continues; SMS and email still go out; the call is still in the digest |
| SMS fails | Retries, then continues to the email |
| Per-call email fails | Retries, then gives up; the call is still in the digest |
| Digest email fails | Retries; calls stay stored for the next digest |
| Same webhook delivered twice | Second delivery stops at *Prepare call* |
| Non-report events (status updates, live transcripts) | Stop at *Prepare call* |

## Going provider-agnostic

Only [`src/normalize.js`](../src/normalize.js) knows payload shapes. Another voice platform needs either a new branch there or a small step that maps its webhook to the generic shape:

```json
{
  "event": "call.ended",
  "call_id": "...",
  "started_at": "2026-01-17T05:05:12Z",
  "ended_at": "2026-01-17T05:07:01Z",
  "from": "+16125550181",
  "transcript": [{ "speaker": "assistant", "text": "..." }, { "speaker": "caller", "text": "..." }],
  "recording_url": "https://...",
  "fields": { "caller_name": "...", "callback_number": "...", "address": "...", "problem": "...", "urgency": "routine" }
}
```

The outbound side is just as loose: the email step posts `{ from, to, subject, html, text }` (Resend's shape; most email APIs are close), SMS is the Twilio Messages API, and the CRM gets one JSON record per call with an `external_id` for idempotency. Swapping a provider means changing a URL and maybe a body expression in one HTTP node.
