/**
 * MarkdownOffice Daily Mailer
 * Cloudflare Worker — Cron Trigger → Brevo API
 *
 * Features:
 *  • Scheduled send via Cron Trigger (09:00 UTC)
 *  • Recipients loaded from D1 (fallback: RECIPIENTS_JSON env var)
 *  • 7-day content rotation stored in D1 (fallback: built-in defaults)
 *  • KV-backed idempotency lock (prevents double-sends per day)
 *  • Retry on 5xx / network errors (1 retry with 2s back-off)
 *  • D1 audit log for every send attempt
 *  • Manual HTTP trigger protected by X-Trigger-Secret header
 *  • GET /health for uptime probing
 */

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface Env {
  /** Brevo transactional email API key (secret) */
  BREVO_API_KEY: string;
  /** Random secret used to protect the POST /trigger endpoint */
  TRIGGER_SECRET: string;
  /**
   * Fallback recipient list — only used when D1 has no active rows.
   * Format: JSON string array, e.g. '["a@b.com","c@d.com"]'
   */
  RECIPIENTS_JSON?: string;
  /** D1 binding: recipients, content rotation, send audit log */
  DB: D1Database;
  /** KV binding: daily idempotency lock */
  EMAIL_KV: KVNamespace;
}

interface Recipient {
  email: string;
  name?: string;
}

interface DailyContent {
  subject: string;
  message: string;
}

interface BrevoPayload {
  sender: { name: string; email: string };
  to: Array<{ email: string; name?: string }>;
  subject: string;
  htmlContent: string;
}

interface SendResult {
  success: boolean;
  status: number;
  body: unknown;
}

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const SENDER = {
  name: "MarkdownOffice",
  email: "contact@markdownoffice.com",
} as const;

const BREVO_SMTP_URL = "https://api.brevo.com/v3/smtp/email";
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 2_000;
/** 25 hours — KV lock auto-expires well after the next cron fires */
const LOCK_TTL_SECONDS = 90_000;

// ─────────────────────────────────────────────────────────────
// Default 7-day content rotation (Sunday=0 … Saturday=6)
// Overridden by the email_content D1 table when rows are present.
// ─────────────────────────────────────────────────────────────

const DEFAULT_CONTENT: Readonly<Record<number, DailyContent>> = {
  0: {
    subject: "Sunday Preview — MarkdownOffice",
    message:
      "☀️ A new week starts tomorrow. Review your upcoming tasks and set yourself up for a strong start!",
  },
  1: {
    subject: "Monday Update — MarkdownOffice",
    message:
      "🌅 Rise and shine! Check your pending documents, set your weekly goals, and hit the ground running.",
  },
  2: {
    subject: "Tuesday Update — MarkdownOffice",
    message:
      "📋 Tuesday check-in. Keep the momentum going — your documents are ready for your attention.",
  },
  3: {
    subject: "Wednesday Update — MarkdownOffice",
    message:
      "🚀 Mid-week momentum! You're halfway there. Tackle those drafts and keep pushing forward.",
  },
  4: {
    subject: "Thursday Update — MarkdownOffice",
    message:
      "⚡ Thursday power-up. Wrap up your drafts, review pending feedback, and prep for the finish line.",
  },
  5: {
    subject: "Friday Wrap-up — MarkdownOffice",
    message:
      "🎉 Happy Friday! Tie up loose ends, ship what's ready, and celebrate this week's progress.",
  },
  6: {
    subject: "Weekend Edition — MarkdownOffice",
    message:
      "🌿 Weekend mode. A calm moment to reflect on the week's wins and recharge for what's next.",
  },
};

// ─────────────────────────────────────────────────────────────
// 1. getRecipients()
//    Primary: D1 `recipients` table
//    Fallback: RECIPIENTS_JSON env var
// ─────────────────────────────────────────────────────────────

async function getRecipients(env: Env): Promise<Recipient[]> {
  // — Primary: D1 —
  try {
    const { results } = await env.DB.prepare(
      "SELECT email, name FROM recipients WHERE active = 1 ORDER BY id"
    ).all<{ email: string; name: string | null }>();

    if (results.length > 0) {
      return results.map((r) => ({
        email: r.email,
        name: r.name ?? undefined,
      }));
    }
    console.warn("[getRecipients] D1 returned no active recipients — checking env fallback.");
  } catch (err) {
    console.warn("[getRecipients] D1 query failed — checking env fallback:", String(err));
  }

  // — Fallback: RECIPIENTS_JSON env var —
  if (env.RECIPIENTS_JSON) {
    try {
      const parsed: unknown = JSON.parse(env.RECIPIENTS_JSON);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((item) =>
          typeof item === "string" ? { email: item } : (item as Recipient)
        );
      }
    } catch (err) {
      console.error("[getRecipients] Failed to parse RECIPIENTS_JSON:", String(err));
    }
  }

  throw new Error(
    "No recipients found. Add rows to D1 `recipients` or set RECIPIENTS_JSON env var."
  );
}

// ─────────────────────────────────────────────────────────────
// 2. getDailyContent()
//    Loads today's subject + message from D1 email_content table.
//    Falls back to DEFAULT_CONTENT when D1 is unavailable or empty.
// ─────────────────────────────────────────────────────────────

async function getDailyContent(env: Env, now: Date): Promise<DailyContent> {
  const dayIndex = now.getUTCDay(); // 0 = Sunday … 6 = Saturday

  try {
    const row = await env.DB.prepare(
      "SELECT subject, message FROM email_content WHERE day_index = ?"
    )
      .bind(dayIndex)
      .first<{ subject: string; message: string }>();

    if (row) {
      return row;
    }
  } catch (err) {
    console.warn("[getDailyContent] D1 query failed — using built-in defaults:", String(err));
  }

  return (
    DEFAULT_CONTENT[dayIndex] ?? {
      subject: "Daily Update — MarkdownOffice",
      message: "Your daily update from MarkdownOffice.",
    }
  );
}

// ─────────────────────────────────────────────────────────────
// 3. buildEmailPayload()
//    Constructs the Brevo API request body with a responsive
//    HTML email template.
// ─────────────────────────────────────────────────────────────

function buildEmailPayload(
  recipients: Recipient[],
  content: DailyContent,
  now: Date
): BrevoPayload {
  const formattedDate = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  /* eslint-disable max-len */
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <meta name="x-apple-disable-message-reformatting"/>
  <title>${content.subject}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f0f0f5;color:#333;-webkit-font-smoothing:antialiased}
    .wrapper{max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.09)}
    .header{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 60%,#0f3460 100%);padding:36px 44px;text-align:center}
    .logo{font-size:28px;font-weight:800;color:#fff;letter-spacing:-.5px}
    .logo span{color:#a78bfa}
    .tagline{color:#9090c0;font-size:13px;margin-top:6px;letter-spacing:.3px}
    .body{padding:44px}
    .greeting{font-size:22px;font-weight:700;color:#1a1a2e;margin-bottom:10px}
    .date-pill{display:inline-flex;align-items:center;gap:6px;background:#f0f0ff;border:1px solid #e0e0f8;color:#4a4a8a;padding:6px 16px;border-radius:20px;font-size:12px;font-weight:600;margin-bottom:24px}
    .message{font-size:15px;color:#4a4a5a;line-height:1.75;margin-bottom:28px}
    .divider{border:none;border-top:1px solid #f0f0f0;margin:28px 0}
    .body-text{font-size:14px;color:#666;line-height:1.7;margin-bottom:28px}
    .cta{display:inline-block;background:linear-gradient(135deg,#1a1a2e,#0f3460);color:#fff!important;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:.3px}
    .footer{padding:24px 44px;background:#fafafa;border-top:1px solid #f0f0f0;text-align:center;font-size:11px;color:#aaa;line-height:2}
    .footer a{color:#999;text-decoration:underline}
    @media(max-width:600px){.body{padding:28px}.header{padding:28px}.cta{display:block;text-align:center}}
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="logo">📄 Markdown<span>Office</span></div>
      <div class="tagline">Your daily productivity companion</div>
    </div>
    <div class="body">
      <p class="greeting">Good morning! 👋</p>
      <div class="date-pill">📅 ${formattedDate}</div>
      <p class="message">${content.message}</p>
      <hr class="divider"/>
      <p class="body-text">
        Log in to your MarkdownOffice dashboard to review your documents,
        track your progress, and stay on top of everything that matters.
      </p>
      <a href="https://markdownoffice.com" class="cta">Open Dashboard →</a>
    </div>
    <div class="footer">
      You're receiving this because you subscribed to daily updates from MarkdownOffice.<br/>
      <a href="https://markdownoffice.com/unsubscribe">Unsubscribe</a>
      &nbsp;·&nbsp;
      <a href="https://markdownoffice.com/privacy">Privacy Policy</a>
      &nbsp;·&nbsp;
      <a href="https://markdownoffice.com">markdownoffice.com</a>
    </div>
  </div>
</body>
</html>`;
  /* eslint-enable max-len */

  return {
    sender: SENDER,
    // NOTE: all recipients are visible to each other in the `to` field.
    // For privacy (each recipient sees only their own address), loop over
    // recipients and call sendEmail() once per recipient instead.
    to: recipients.map((r) =>
      r.name ? { email: r.email, name: r.name } : { email: r.email }
    ),
    subject: content.subject,
    htmlContent,
  };
}

// ─────────────────────────────────────────────────────────────
// 4. sendEmail()
//    Posts to Brevo SMTP API.
//    Retries once on 5xx server errors or network failures.
//    Does NOT retry on 4xx client errors (they won't self-resolve).
// ─────────────────────────────────────────────────────────────

async function sendEmail(payload: BrevoPayload, apiKey: string): Promise<SendResult> {
  let lastResult: SendResult = {
    success: false,
    status: 0,
    body: { error: "No attempts made" },
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[sendEmail] Waiting ${RETRY_DELAY_MS}ms before retry ${attempt}/${MAX_RETRIES}…`);
      await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }

    try {
      const response = await fetch(BREVO_SMTP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": apiKey,
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      const body = await response.json().catch(() => ({}));
      lastResult = { success: response.ok, status: response.status, body };

      if (response.ok) {
        return lastResult;
      }

      // 4xx — client error: retrying won't help
      if (response.status >= 400 && response.status < 500) {
        console.error(
          `[sendEmail] Client error ${response.status} — not retrying. Body:`,
          JSON.stringify(body)
        );
        return lastResult;
      }

      // 5xx — server error: allow retry
      console.warn(
        `[sendEmail] Server error ${response.status} on attempt ${attempt + 1}. Body:`,
        JSON.stringify(body)
      );
    } catch (networkErr) {
      console.error(
        `[sendEmail] Network error on attempt ${attempt + 1}:`,
        String(networkErr)
      );
      lastResult = { success: false, status: 0, body: { error: String(networkErr) } };
    }
  }

  return lastResult;
}

// ─────────────────────────────────────────────────────────────
// 5. acquireDailyLock()
//    KV-backed idempotency guard — prevents a duplicate send if
//    the cron fires more than once on the same UTC day.
//    Fails open: if KV is unavailable, the email is allowed through.
// ─────────────────────────────────────────────────────────────

async function acquireDailyLock(env: Env, now: Date): Promise<boolean> {
  // Key format: "daily_lock:2025-06-01"
  const key = `daily_lock:${now.toISOString().split("T")[0]}`;

  try {
    const existing = await env.EMAIL_KV.get(key);

    if (existing !== null) {
      console.warn(
        `[acquireDailyLock] Lock "${key}" already held (set at ${existing}). Skipping duplicate send.`
      );
      return false; // Already sent today
    }

    // Persist lock — auto-expires in 25 hours
    await env.EMAIL_KV.put(key, now.toISOString(), {
      expirationTtl: LOCK_TTL_SECONDS,
    });

    return true; // Lock acquired, safe to proceed
  } catch (err) {
    // Fail-open: if KV is unreachable, let the email through rather than drop it
    console.warn(
      "[acquireDailyLock] KV error — proceeding without lock (fail-open):",
      String(err)
    );
    return true;
  }
}

// ─────────────────────────────────────────────────────────────
// 6. writeSendLog()
//    Persists every send attempt to D1 for observability.
// ─────────────────────────────────────────────────────────────

async function writeSendLog(
  env: Env,
  recipientCount: number,
  status: "success" | "failure",
  errorMessage?: string
): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO send_log (recipient_count, status, error_message) VALUES (?, ?, ?)"
    )
      .bind(recipientCount, status, errorMessage ?? null)
      .run();
  } catch (err) {
    // Non-fatal — log the failure but don't throw
    console.warn("[writeSendLog] Failed to write audit log to D1:", String(err));
  }
}

// ─────────────────────────────────────────────────────────────
// Orchestrator — runMailJob()
//    Wires all helpers together in the correct order.
// ─────────────────────────────────────────────────────────────

async function runMailJob(env: Env): Promise<void> {
  const now = new Date();
  const ts = now.toISOString();

  console.log(`[${ts}] ── MarkdownOffice Mailer: job starting ──`);

  // ① Idempotency check
  const locked = await acquireDailyLock(env, now);
  if (!locked) {
    console.log(`[${ts}] Rate-limit guard: already sent today. Exiting.`);
    return;
  }

  // ② Load recipients
  let recipients: Recipient[];
  try {
    recipients = await getRecipients(env);
    console.log(`[${ts}] Loaded ${recipients.length} active recipient(s).`);
  } catch (err) {
    const msg = String(err);
    console.error(`[${ts}] ❌ Could not load recipients: ${msg}`);
    await writeSendLog(env, 0, "failure", msg);
    return;
  }

  // ③ Resolve daily content
  const content = await getDailyContent(env, now);
  console.log(`[${ts}] Subject: "${content.subject}"`);

  // ④ Build Brevo payload
  const payload = buildEmailPayload(recipients, content, now);

  // ⑤ Send (with retry)
  const result = await sendEmail(payload, env.BREVO_API_KEY);

  // ⑥ Log outcome
  if (result.success) {
    console.log(
      `[${ts}] ✅ Email sent successfully to ${recipients.length} recipient(s). HTTP ${result.status}.`
    );
    await writeSendLog(env, recipients.length, "success");
  } else {
    const errBody = JSON.stringify(result.body);
    console.error(
      `[${ts}] ❌ Send failed after retries. HTTP ${result.status}. Body: ${errBody}`
    );
    await writeSendLog(env, recipients.length, "failure", errBody);
  }

  console.log(`[${ts}] ── MarkdownOffice Mailer: job complete ──`);
}

// ─────────────────────────────────────────────────────────────
// Worker entrypoint
// ─────────────────────────────────────────────────────────────

export default {
  /**
   * Cron handler — fires on the schedule defined in wrangler.toml.
   * `ctx.waitUntil` keeps the worker alive until the job finishes.
   */
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(runMailJob(env));
  },

  /**
   * HTTP handler — two endpoints:
   *
   *  GET  /health   → liveness probe (no auth required)
   *  POST /trigger  → manual send, requires X-Trigger-Secret header
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const { pathname } = new URL(request.url);

    // ── GET /health ──────────────────────────────────────────
    if (pathname === "/health" && request.method === "GET") {
      return Response.json({
        status: "ok",
        service: "markdownoffice-mailer",
        ts: new Date().toISOString(),
      });
    }

    // ── POST /trigger ────────────────────────────────────────
    if (pathname === "/trigger" && request.method === "POST") {
      const provided = request.headers.get("X-Trigger-Secret");

      if (!provided || provided !== env.TRIGGER_SECRET) {
        console.warn("[fetch] /trigger: unauthorized attempt.");
        return new Response("Unauthorized", { status: 401 });
      }

      console.log("[fetch] /trigger: manual send requested.");
      ctx.waitUntil(runMailJob(env));

      return Response.json(
        { queued: true, ts: new Date().toISOString() },
        { status: 202 }
      );
    }

    return new Response("Not Found", { status: 404 });
  },
};
