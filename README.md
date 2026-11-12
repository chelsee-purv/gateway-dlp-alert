# DLP Alert Worker

A Cloudflare Worker that monitors AI platform traffic (ChatGPT, Claude, Gemini, Copilot) for sensitive data and sends an **email alert** (and optionally a **Slack alert**) when Cloudflare DLP detects a match.

Traffic is **allowed through** -- this is a monitoring/alerting tool, not a blocker.

```
User sends prompt to ChatGPT / Claude / Gemini / Copilot
        |
Cloudflare Gateway inspects traffic (DLP profiles scan for sensitive data)
        |
Logpush delivers Gateway HTTP logs to this Worker (~30 sec delay)
        |
Worker checks for DLP matches
        |
Match found --> email alert sent to your team
```

---

## What You Need Before Starting

- A Cloudflare account with **Zero Trust Enterprise** (required for Gateway HTTP Logpush)
- **Gateway HTTP filtering** and **TLS decryption** already enabled
- **DLP profiles** already configured (Zero Trust > DLP > DLP Profiles)
- The **WARP client** deployed on user devices
- **Node.js** installed on your computer ([download here](https://nodejs.org/))

---

## Setup (6 Steps)

### Step 1: Install the Wrangler CLI

Open a terminal and run:

```bash
npm install -g wrangler
```

Then log in to your Cloudflare account:

```bash
wrangler login
```

A browser window will open. Log in and authorize Wrangler.

---

### Step 2: Clone this repo and install dependencies

```bash
git clone https://github.com/chelsee-purv/gateway-dlp-alert.git
cd gateway-dlp-alert
npm install
```

---

### Step 3: Fill in your settings

Open the file **`wrangler.jsonc`** in any text editor. You will see three values marked with `<...>` that you need to replace:

```jsonc
"EMAIL_ALERT_TO": "<YOUR_RECIPIENT_EMAIL>",
"EMAIL_ALERT_FROM": "dlp-alerts@<YOUR_DOMAIN>",
```

Replace them with your actual values. For example:

```jsonc
"EMAIL_ALERT_TO": "security-team@yourcompany.com",
"EMAIL_ALERT_FROM": "dlp-alerts@yourcompany.com",
```

| Setting | What to put | Example |
|---------|-------------|---------|
| `EMAIL_ALERT_TO` | The email address(es) that should receive DLP alerts. Comma-separate multiple addresses. | `admin@yourcompany.com` or `admin@yourcompany.com,security@yourcompany.com` |
| `EMAIL_ALERT_FROM` | The "From" address on alert emails. Must use a domain you own. | `dlp-alerts@yourcompany.com` |
| `EMAIL_ALERT_FROM_NAME` | Display name in the "From" field. You can leave the default. | `Cloudflare DLP Alert` |

**Save the file.**

**Then add this DNS record** so email delivery is authorized. This record must be added on the domain you used in `EMAIL_ALERT_FROM`. **Your domain does not need to be on Cloudflare** -- add the record wherever your DNS is hosted (GoDaddy, Route 53, Google Domains, etc.):

| Type | Name | Content |
|------|------|---------|
| TXT | `_mailchannels.yourcompany.com` | `v=mc1 cfid=dlp-alert-worker.YOUR-SUBDOMAIN.workers.dev` |

> **Note:** The Worker itself runs on a free `workers.dev` URL -- you do not need a custom domain in Cloudflare. The DNS record above is only for authorizing email sending and goes on whatever DNS provider hosts your domain.

> You will get your exact `workers.dev` subdomain after deploying in Step 4. You can find it in **Workers & Pages > Overview** in the Cloudflare dashboard. It looks like `dlp-alert-worker.abc123.workers.dev`. Come back and add this DNS record after deploying if you don't know it yet.

---

### Step 4: Deploy the Worker

```bash
npx wrangler deploy
```

The output will show your Worker URL. It will look something like:

```
Published dlp-alert-worker (0.5 sec)
  https://dlp-alert-worker.abc123.workers.dev
```

**Copy this URL** -- you need it for Step 5.

> If you haven't added the DNS record from Step 3 yet, do it now using the subdomain shown in the output.

---

### Step 5: Create a Gateway HTTP Policy (if you don't have one already)

This policy tells Gateway to scan ChatGPT traffic with your DLP profiles. Without this, there is nothing to alert on.

1. Go to [Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Traffic controls** > **Firewall policies** > **HTTP**
3. Click **Add a policy**
4. Configure:

| Field | Value |
|-------|-------|
| **Policy name** | `ChatGPT DLP Monitor` |
| **Selector** | Application |
| **Operator** | in |
| **Value** | Select **ChatGPT** from the dropdown |
| **Action** | **Allow** |

5. Scroll down to **Configure policy settings** > **DLP profiles** and select the profiles you want to detect (e.g., PII, Financial Data, Source Code)
6. Click **Save**

> To monitor additional AI platforms, add more applications to the same policy (Claude, Gemini, Copilot, etc.) using the **Or** logic in the traffic selector.

---

### Step 6: Create the Logpush Job

This tells Cloudflare to send Gateway HTTP logs to your Worker.

1. Go to [Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Logs** > **Logpush**
3. Click **Create a Logpush job**
4. Configure:

| Setting | Value |
|---------|-------|
| **Dataset** | Gateway HTTP |
| **Destination** | HTTP destination |
| **Endpoint URL** | Paste the Worker URL from Step 4 (e.g., `https://dlp-alert-worker.abc123.workers.dev`) |

5. On the field selection screen, make sure these fields are included:
   - `Datetime`, `Email`, `UserID`, `DeviceID`, `DeviceName`, `Action`, `URL`, `HTTPHost`, `HTTPMethod`, `HTTPStatusCode`, `ApplicationNames`, `PolicyID`, `PolicyName`, `SourceIP`, `UploadMatchedDlpProfiles`, `DownloadMatchedDlpProfiles`, `UploadMatchedDlpProfileEntries`, `DownloadMatchedDlpProfileEntries`
6. Click **Save**

---

## Test It

1. On a device with the WARP client connected, go to [chat.openai.com](https://chat.openai.com) or [claude.ai](https://claude.ai)
2. Send a prompt containing a fake SSN: `My social security number is 078-05-1120`
3. Within ~30 seconds, you should receive an email alert at the address you configured in `EMAIL_ALERT_TO`

**If you want to test the Worker directly** (without waiting for a real DLP event), run this from a terminal:

```bash
curl -X POST https://YOUR-WORKER-URL/ \
  -H "content-type: application/json" \
  -d '{"Datetime":"2026-01-01T00:00:00Z","Email":"testuser@yourcompany.com","UserID":"test","DeviceID":"device-1","DeviceName":"Test-Laptop","Action":"allow","URL":"https://chat.openai.com/api/conversation","HTTPHost":"chat.openai.com","HTTPMethod":"POST","HTTPStatusCode":200,"ApplicationNames":["ChatGPT"],"PolicyID":"test-policy","PolicyName":"AI Platform DLP Monitor","SourceIP":"1.2.3.4","UploadMatchedDlpProfiles":["PII Detection"],"DownloadMatchedDlpProfiles":[],"UploadMatchedDlpProfileEntries":["Social Security Number"],"DownloadMatchedDlpProfileEntries":[]}'
```

You should see `ok - alerted on 1 violation(s)` and get an email.

---

## Optional: Add Slack Alerts Too

If you also want alerts in Slack:

1. Create a Slack webhook: [api.slack.com/apps](https://api.slack.com/apps) > Create App > Incoming Webhooks > Add New Webhook
2. Run:

```bash
npx wrangler secret put SLACK_WEBHOOK_URL
# paste the webhook URL when prompted
```

3. Redeploy:

```bash
npx wrangler deploy
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No email received after testing | Check the DNS TXT record from Step 3 is correct. The `cfid=` value must match your Worker's `workers.dev` subdomain exactly. |
| `ok - no violations` response | The test payload didn't match an AI platform host, or the DLP fields were empty. Make sure `HTTPHost` is one of the AI platforms and `UploadMatchedDlpProfiles` is not empty in the payload. |
| Logpush job creation fails | The Worker must accept POST requests. Verify it deployed successfully with `npx wrangler tail` and try again. |
| Emails going to spam | Add SPF and DKIM records for your sending domain. See [MailChannels docs](https://support.mailchannels.com/hc/en-us/articles/7122849237389). |
| Want to see Worker logs | Run `npx wrangler tail` in a terminal -- it will stream live logs from your deployed Worker. |

---

## Cost

| Component | Cost |
|-----------|------|
| Logpush (Gateway HTTP) | Included with Zero Trust Enterprise |
| Worker | Free tier covers 100,000 requests/day |
| Email (MailChannels) | Free from Workers |
| Slack webhook | Free |

---

## Files in This Repo

| File | What it does |
|------|-------------|
| `wrangler.jsonc` | Worker configuration -- **this is where you fill in your settings** |
| `src/index.ts` | The Worker code (receives logs, checks for DLP matches, sends alerts) |
| `package.json` | Node.js dependencies |
| `tsconfig.json` | TypeScript configuration |
