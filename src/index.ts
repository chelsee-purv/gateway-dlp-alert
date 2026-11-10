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

    await sendSlackAlert(violations, env);

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
