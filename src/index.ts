/**
 * DLP Alert Worker
 *
 * Receives Gateway HTTP Logpush batches (NDJSON), checks for DLP profile
 * matches on AI platform traffic, and sends an email alert via MailChannels.
 *
 * Gateway HTTP log field reference (confirmed from API schema):
 *   UploadMatchedDlpProfiles   - array[string] profiles matched on upload/prompt
 *   DownloadMatchedDlpProfiles - array[string] profiles matched on download/response
 *   UploadMatchedDlpProfileEntries   - array[string] specific entries matched
 *   DownloadMatchedDlpProfileEntries - array[string] specific entries matched
 *   PolicyID   - UUID of the gateway policy applied
 *   PolicyName - name of the gateway policy applied
 */

export interface Env {
  SLACK_WEBHOOK_URL: string;
  EMAIL_ALERT_TO: string;     // comma-separated recipient addresses
  EMAIL_ALERT_FROM: string;   // sender address (must be authorized via MailChannels DNS)
  EMAIL_ALERT_FROM_NAME: string;
}

interface GatewayHTTPLog {
  Datetime: string;
  Email: string;
  UserID: string;
  DeviceID: string;
  DeviceName: string;
  Action: string;
  URL: string;
  HTTPHost: string;
  HTTPMethod: string;
  HTTPStatusCode: number;
  ApplicationNames: string[];
  PolicyID: string;
  PolicyName: string;
  SourceIP: string;
  UploadMatchedDlpProfiles: string[];
  DownloadMatchedDlpProfiles: string[];
  UploadMatchedDlpProfileEntries: string[];
  DownloadMatchedDlpProfileEntries: string[];
}

const AI_PLATFORMS = [
  "chat.openai.com",
  "chatgpt.com",
  "claude.ai",
  "gemini.google.com",
  "copilot.microsoft.com",
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Logpush sends gzip-compressed NDJSON -- decompress before parsing
    let bodyText: string;
    const encoding = request.headers.get("content-encoding");
    if (encoding === "gzip") {
      const decompressed = request.body!.pipeThrough(new DecompressionStream("gzip"));
      bodyText = await new Response(decompressed).text();
    } else {
      bodyText = await request.text();
    }
    const lines = bodyText.trim().split("\n").filter(Boolean);

    const violations: GatewayHTTPLog[] = [];

    for (const line of lines) {
      let log: GatewayHTTPLog;
      try {
        log = JSON.parse(line);
      } catch {
        continue;
      }

      const host = log.HTTPHost || log.URL || "";
      const isAIPlatform = AI_PLATFORMS.some((h) => host.includes(h));
      const uploadMatches = log.UploadMatchedDlpProfiles?.length > 0;
      const downloadMatches = log.DownloadMatchedDlpProfiles?.length > 0;
      const hasDLPMatch = uploadMatches || downloadMatches;



      if (isAIPlatform && hasDLPMatch) {
        violations.push(log);
      }
    }

    if (violations.length === 0) {
      return new Response("ok - no violations", { status: 200 });
    }

    // Send Slack and email alerts in parallel
    await Promise.allSettled([
      sendSlackAlert(violations, env),
      sendEmailAlert(violations, env),
    ]);

    return new Response(`ok - alerted on ${violations.length} violation(s)`, {
      status: 200,
    });
  },
};

async function sendSlackAlert(
  violations: GatewayHTTPLog[],
  env: Env
): Promise<void> {
  const blocks: object[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🚨 DLP Alert: ${violations.length} sensitive data violation(s) on AI platforms`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Cloudflare Gateway flagged sensitive data in AI platform traffic. Traffic was *allowed through* per policy. <https://one.dash.cloudflare.com/|View in Zero Trust → Logs → Gateway → HTTP>`,
      },
    },
    { type: "divider" },
  ];

  for (const v of violations) {
    const user = v.Email || v.UserID || "Unknown user";
    const app = v.ApplicationNames?.[0] || v.HTTPHost || new URL(v.URL).hostname;
    const uploadProfiles = v.UploadMatchedDlpProfiles?.join(", ") || "";
    const downloadProfiles = v.DownloadMatchedDlpProfiles?.join(", ") || "";
    const profiles = [uploadProfiles, downloadProfiles].filter(Boolean).join(", ") || "Unknown";
    const direction = v.UploadMatchedDlpProfiles?.length > 0 ? "Prompt (upload)" : "Response (download)";
    const time = new Date(v.Datetime).toUTCString();

    blocks.push({
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*User*\n${user}` },
        { type: "mrkdwn", text: `*Application*\n${app}` },
        { type: "mrkdwn", text: `*DLP Profile Matched*\n:red_circle: ${profiles}` },
        { type: "mrkdwn", text: `*Direction*\n${direction}` },
        { type: "mrkdwn", text: `*URL*\n${v.URL}` },
        { type: "mrkdwn", text: `*Time*\n${time}` },
      ],
    });
    blocks.push({ type: "divider" });
  }

  const response = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ blocks }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("Slack webhook error:", response.status, err);
  }
}

// ── Email Alert via MailChannels ──────────────────────────────────────

async function sendEmailAlert(
  violations: GatewayHTTPLog[],
  env: Env
): Promise<void> {
  const recipients = (env.EMAIL_ALERT_TO || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  if (recipients.length === 0) {
    console.warn("No EMAIL_ALERT_TO configured — skipping email alert");
    return;
  }

  const fromAddress = env.EMAIL_ALERT_FROM || "dlp-alerts@example.com";
  const fromName = env.EMAIL_ALERT_FROM_NAME || "Cloudflare DLP Alert";

  // Build HTML body
  const rows = violations
    .map((v) => {
      const user = v.Email || v.UserID || "Unknown";
      const app =
        v.ApplicationNames?.[0] || v.HTTPHost || tryHostname(v.URL);
      const uploadProfiles = v.UploadMatchedDlpProfiles?.join(", ") || "";
      const downloadProfiles = v.DownloadMatchedDlpProfiles?.join(", ") || "";
      const profiles =
        [uploadProfiles, downloadProfiles].filter(Boolean).join(", ") ||
        "Unknown";
      const direction =
        v.UploadMatchedDlpProfiles?.length > 0
          ? "Prompt (upload)"
          : "Response (download)";
      const time = new Date(v.Datetime).toUTCString();

      return `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee;">${esc(user)}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;">${esc(app)}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;">${esc(profiles)}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;">${esc(direction)}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;word-break:break-all;max-width:250px;">${esc(v.URL)}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;">${esc(time)}</td>
      </tr>`;
    })
    .join("\n");

  const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;color:#333;max-width:900px;margin:0 auto;">
  <h2 style="color:#d63031;">DLP Alert: ${violations.length} sensitive data violation(s) on AI platforms</h2>
  <p>Cloudflare Gateway flagged sensitive data in AI platform traffic.
     Review details below and investigate in
     <a href="https://one.dash.cloudflare.com/">Zero Trust &rarr; Logs &rarr; Gateway &rarr; HTTP</a>.</p>

  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <thead>
      <tr style="background:#f9f9f9;text-align:left;">
        <th style="padding:8px;">User</th>
        <th style="padding:8px;">Application</th>
        <th style="padding:8px;">DLP Profile</th>
        <th style="padding:8px;">Direction</th>
        <th style="padding:8px;">URL</th>
        <th style="padding:8px;">Time (UTC)</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <p style="margin-top:24px;font-size:12px;color:#888;">
    This is an automated alert from the Cloudflare DLP Alert Worker.
  </p>
</body>
</html>`;

  const textBody = violations
    .map((v) => {
      const user = v.Email || v.UserID || "Unknown";
      const profiles = [
        ...(v.UploadMatchedDlpProfiles || []),
        ...(v.DownloadMatchedDlpProfiles || []),
      ].join(", ") || "Unknown";
      return `User: ${user}\nApp: ${v.HTTPHost}\nDLP Profile: ${profiles}\nURL: ${v.URL}\nTime: ${new Date(v.Datetime).toUTCString()}\n`;
    })
    .join("\n---\n");

  const response = await fetch("https://api.mailchannels.net/tx/v1/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [
        {
          to: recipients.map((email) => ({ email })),
        },
      ],
      from: {
        email: fromAddress,
        name: fromName,
      },
      subject: `DLP Alert: ${violations.length} sensitive data violation(s) detected`,
      content: [
        { type: "text/plain", value: textBody },
        { type: "text/html", value: htmlBody },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("MailChannels error:", response.status, errText);
  } else {
    console.log(
      `Email alert sent to ${recipients.join(", ")} (${violations.length} violations)`
    );
  }
}

function esc(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tryHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url || "Unknown";
  }
}
