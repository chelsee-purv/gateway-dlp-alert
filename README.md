# Gateway DLP Alert Worker

A Cloudflare Worker that receives [Gateway HTTP Logpush](https://developers.cloudflare.com/cloudflare-one/insights/logs/logpush/) batches and sends a Slack alert when Cloudflare DLP profiles match on AI platform traffic.

## How it works

```
User sends prompt to ChatGPT / Claude / Gemini / Copilot
        ↓
Cloudflare Gateway inspects traffic (Allow + DLP log policy)
        ↓
Logpush delivers Gateway HTTP logs to this Worker (~30s delay)
        ↓
Worker checks UploadMatchedDlpProfiles / DownloadMatchedDlpProfiles
        ↓
Match found → Slack alert fires with user, app, URL, DLP profile name
```

Traffic is **allowed through** — this is a monitoring/alerting pattern, not a block.

---

## Prerequisites

- Cloudflare Zero Trust account (Enterprise for `gateway_http` Logpush dataset)
- Gateway HTTP filtering and TLS decryption enabled
- DLP profiles configured in **Zero Trust > DLP > DLP profiles**
- A Slack incoming webhook URL
- `wrangler` CLI: `npm install -g wrangler`

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/chelsee-purv/gateway-dlp-alert.git
cd gateway-dlp-alert
npm install
```

### 2. Configure your domain

Edit `wrangler.jsonc` and choose either:

- **workers.dev** (default, no custom domain needed) — leave `workers_dev: true`
- **Custom domain** — comment out `workers_dev` and uncomment the `routes` block, filling in your domain

### 3. Set your Slack webhook

```bash
npx wrangler secret put SLACK_WEBHOOK_URL
# paste your webhook URL when prompted
# e.g. https://hooks.slack.com/services/T.../B.../...
```

To get a webhook URL: [api.slack.com/apps](https://api.slack.com/apps) → Create App → Incoming Webhooks → Add New Webhook.

### 4. Customise the AI platform list (optional)

Edit `src/index.ts` and update `AI_PLATFORMS` to match the hosts you want to monitor:

```typescript
const AI_PLATFORMS = [
  "chat.openai.com",
  "chatgpt.com",
  "claude.ai",
  "gemini.google.com",
  "copilot.microsoft.com",
];
```

### 5. Deploy

```bash
npx wrangler deploy
```

Note the Worker URL from the output — you will need it for the Logpush job.

---

## Gateway policy

Create an **Allow** policy in Zero Trust that attaches your DLP profiles to AI platform traffic. This is what causes `UploadMatchedDlpProfiles` to be populated in the logs.

**Zero Trust > Traffic controls > Firewall policies > HTTP > Add a policy**

| Field | Value |
|---|---|
| Name | `AI Platform DLP Monitor` |
| Traffic | Host is `chat.openai.com` OR `claude.ai` OR `gemini.google.com` OR `copilot.microsoft.com` |
| DLP Profile | Select the profiles you want to detect (PII, Financial, etc.) |
| Action | **Allow** |

---

## Logpush job

Point a Logpush job at the Worker URL.

**Zero Trust > Insights > Logs > Manage Logpush > Create a Logpush job**

| Setting | Value |
|---|---|
| Dataset | Gateway HTTP requests |
| Destination | HTTP endpoint → your Worker URL |
| Fields | `Datetime, Email, UserID, DeviceID, DeviceName, Action, URL, HTTPHost, HTTPMethod, HTTPStatusCode, ApplicationNames, PolicyID, PolicyName, SourceIP, UploadMatchedDlpProfiles, DownloadMatchedDlpProfiles, UploadMatchedDlpProfileEntries, DownloadMatchedDlpProfileEntries` |
| Frequency | Low |

Or via API:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/logpush/jobs" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "dlp-alert-gateway-http",
    "logpull_options": "fields=Datetime,Email,UserID,DeviceID,DeviceName,Action,URL,HTTPHost,HTTPMethod,HTTPStatusCode,ApplicationNames,PolicyID,PolicyName,SourceIP,UploadMatchedDlpProfiles,DownloadMatchedDlpProfiles,UploadMatchedDlpProfileEntries,DownloadMatchedDlpProfileEntries&timestamps=rfc3339",
    "destination_conf": "https://<YOUR_WORKER_URL>/",
    "dataset": "gateway_http",
    "enabled": true,
    "frequency": "low"
  }'
```

---

## Validate

Send a prompt containing a fake SSN (`078-05-1120`) to ChatGPT or Claude while enrolled on WARP. Within ~30 seconds a Slack message should appear with the user, application, URL, and matched DLP profile name.

To test the Worker directly without waiting for Logpush:

```bash
curl -X POST https://<YOUR_WORKER_URL>/ \
  -H "content-type: application/json" \
  -d '{"Datetime":"2026-01-01T00:00:00Z","Email":"user@example.com","UserID":"test","DeviceID":"device-1","DeviceName":"Test-Device","Action":"allow","URL":"https://chat.openai.com/api/conversation","HTTPHost":"chat.openai.com","HTTPMethod":"POST","HTTPStatusCode":200,"ApplicationNames":["ChatGPT"],"PolicyID":"your-policy-id","PolicyName":"AI Platform DLP Monitor","SourceIP":"1.2.3.4","UploadMatchedDlpProfiles":["AI Prompt: PII"],"DownloadMatchedDlpProfiles":[],"UploadMatchedDlpProfileEntries":["Social Security Number"],"DownloadMatchedDlpProfileEntries":[]}'
```

Expected response: `ok - alerted on 1 violation(s)` and a Slack message.

---

## Slack alert format

Each alert includes:

- **User** — identity email or user ID from Gateway
- **Application** — AI platform name
- **URL** — the specific endpoint called
- **DLP Profile Matched** — name of the Cloudflare DLP profile that fired
- **Direction** — Prompt (upload) or Response (download)
- **Time** — UTC timestamp

---

## Cost

| Component | Cost |
|---|---|
| Logpush (Gateway HTTP → Worker) | Free up to 25 GB/month, then $0.10/GB external destination |
| Worker | Free (100,000 requests/day included on Workers Free) |
| Slack webhook | Free |

For a typical 200-seat deployment, Logpush volume stays well within the free 25 GB monthly allowance.
