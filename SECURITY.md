# Security

## Reporting a problem
Please report security issues privately through GitHub's "Report a vulnerability" (Security tab) rather than a public issue.

## How secrets are handled
- No secrets live in this repository. `.env.example` holds placeholders only; `.env` is git-ignored.
- API keys for the LLM, CRM, email and SMS providers, and the voice webhook secret, are n8n credentials referenced in `n8n/after-hours-call-report.json` by name only. The workflow reads URLs and settings from environment variables, never keys.
- Every push and pull request runs [gitleaks](https://github.com/gitleaks/gitleaks) over the full history and the working tree, plus `scripts/check-secrets.sh` (private IP ranges, personal email domains, real-looking keys, phone numbers outside 555-01xx). Run `npm run check:secrets` and `gitleaks git .` locally before pushing.

## Deployment notes
- Protect the webhook twice: a long random path and a secret header checked by n8n Header Auth. Expose only that path through a TLS reverse proxy; the compose file binds n8n to 127.0.0.1.
- Give the CRM integration its own API user that can create records and nothing else.
- Transcripts are untrusted input. Reports escape every value, and the LLM can only raise urgency; it cannot send messages or lower an alert.
- Call data is personal data. Keep `saveDataSuccessExecution: none`, prune failed executions, and set retention on your CRM, email and voice provider.
