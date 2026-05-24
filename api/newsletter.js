// Combined newsletter endpoint.
//
// Routes by req.body.type (or req.query.type for the GET path):
//   - "subscribe": create or refresh a pending subscriber row and send the
//     confirmation email. Body: { email, firstName, source }.
//   - "confirm":   flip Confirmed=true for a pending row and send the welcome
//     email. Body or query: { token, email }.
//   - "send":      cron-protected weekly delivery. Picks the Ready issue with
//     the highest Issue_Number and sends to every confirmed, not-unsubscribed
//     subscriber. Body: { type: "send" }, plus the cron secret in the
//     X-Cron-Secret header or Authorization: Bearer header.
//
// Required env vars (already set in Vercel):
//   AIRTABLE_KEY (falls back to VITE_AIRTABLE_KEY)
//   EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_FROM
//   CRON_SECRET (only required for type=send)

const crypto     = require("crypto");
const nodemailer = require("nodemailer");

const AIRTABLE_BASE = "app2FUPqq8VQSwQ64";
const SUBS_TABLE    = "tblTTCCngCteIBbbv";
const ISSUES_TABLE  = "tbl3pKjNdgxJGYr0u";

const SUB_F = {
  Email:           "fldbcBeZpmy6QxGSd",
  First_Name:      "fldhQU58l8xP743p8",
  Date_Subscribed: "fldce7l2haje9WJG2",
  Confirmed:       "fld6zQQvNy8d03EBW",
  Confirm_Token:   "fldX96dV6gvtKNx1f",
  Unsubscribed:    "flddV4PhEATPwiHzl",
  Source:          "fldc9Nv50HRjfG1jL",
};

const ISSUE_F = {
  Issue_Title:    "fld7MRgeaH0NCJBIs",
  Issue_Number:   "fldFU6TiYG0FmF9S8",
  Date_Published: "fldqlKArTdhOkKcYI",
  Subject_Line:   "fld57sICLof4DTx33",
  Content_HTML:   "fld4Ege6wX7ijRXiw",
  Status:         "fldKd6AJRxqqzeYJs",
};

const airtableKey  = () => process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY || "";
const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE}`;
const todayIso     = () => new Date().toISOString().slice(0, 10);

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function airtableListAll(tableId, params) {
  const key = airtableKey();
  let all = [], offset = null;
  do {
    const url = new URL(`${AIRTABLE_API}/${tableId}`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("returnFieldsByFieldId", "true");
    Object.keys(params || {}).forEach(k => url.searchParams.set(k, params[k]));
    if (offset) url.searchParams.set("offset", offset);
    const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`Airtable list failed: ${r.status} ${body}`);
    }
    const d = await r.json();
    all = all.concat(d.records || []);
    offset = d.offset || null;
  } while (offset);
  return all;
}

async function findSubscriberByEmail(email) {
  const key = airtableKey();
  if (!key) throw new Error("Airtable key not configured");
  const e = String(email || "").trim().toLowerCase().replace(/'/g, "\\'");
  if (!e) return null;
  const formula = encodeURIComponent(`LOWER({Email}) = '${e}'`);
  const url = `${AIRTABLE_API}/${SUBS_TABLE}?filterByFormula=${formula}&maxRecords=1&returnFieldsByFieldId=true`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Airtable lookup failed: ${r.status} ${body}`);
  }
  const d = await r.json();
  return (d.records || [])[0] || null;
}

async function findSubscriberByEmailAndToken(email, token) {
  const key = airtableKey();
  if (!key) throw new Error("Airtable key not configured");
  const e = String(email || "").trim().toLowerCase().replace(/'/g, "\\'");
  const t = String(token || "").trim().replace(/'/g, "\\'");
  if (!e || !t) return null;
  const formula = encodeURIComponent(`AND(LOWER({Email}) = '${e}', {Confirm_Token} = '${t}')`);
  const url = `${AIRTABLE_API}/${SUBS_TABLE}?filterByFormula=${formula}&maxRecords=1&returnFieldsByFieldId=true`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Airtable lookup failed: ${r.status} ${body}`);
  }
  const d = await r.json();
  return (d.records || [])[0] || null;
}

async function createSubscriber(fields) {
  const key = airtableKey();
  const r = await fetch(`${AIRTABLE_API}/${SUBS_TABLE}?returnFieldsByFieldId=true`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body:    JSON.stringify({ fields }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Airtable create failed: ${r.status} ${body}`);
  }
  return r.json();
}

async function patchSubscriber(recordId, fields) {
  const key = airtableKey();
  const r = await fetch(`${AIRTABLE_API}/${SUBS_TABLE}/${recordId}?returnFieldsByFieldId=true`, {
    method:  "PATCH",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body:    JSON.stringify({ fields }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Airtable patch failed: ${r.status} ${body}`);
  }
  return r.json();
}

async function airtablePatch(tableId, recordId, fields) {
  const key = airtableKey();
  const r = await fetch(`${AIRTABLE_API}/${tableId}/${recordId}?returnFieldsByFieldId=true`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Airtable patch failed: ${r.status} ${body}`);
  }
  return r.json();
}

function buildTransporter() {
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT, 10),
    secure: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
}

const fromAddress = () =>
  process.env.EMAIL_FROM || '"Infrastructure Intelligence by HumZones" <hello@humzones.com>';

function confirmationEmailHtml({ firstName, email, token }) {
  const confirmUrl =
    "https://humzones.com/newsletter-confirm?token=" + token +
    "&email=" + encodeURIComponent(email);
  const greeting = firstName ? "Hi " + escapeHtml(firstName) + "," : "Hi there,";
  const unsubUrl = "https://humzones.com/unsubscribe?email=" + encodeURIComponent(email);
  return (
    '<div style="font-family:Arial,sans-serif;background:#f1f5f9;padding:24px 12px;">' +
      '<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 18px rgba(0,0,0,.08);">' +
        '<div style="background:#1e293b;padding:24px;text-align:center;">' +
          '<div style="color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:.02em;">Infrastructure Intelligence</div>' +
          '<div style="color:#f97316;font-size:12px;margin-top:4px;">by HumZones</div>' +
        '</div>' +
        '<div style="padding:32px;">' +
          '<p style="color:#475569;font-size:16px;line-height:1.6;margin:0 0 14px;">' + greeting + '</p>' +
          '<p style="color:#475569;font-size:16px;line-height:1.6;margin:0 0 14px;">Thanks for signing up for Infrastructure Intelligence, HumZones weekly briefing on data center development near communities like yours.</p>' +
          '<p style="color:#475569;font-size:16px;line-height:1.6;margin:0 0 24px;">Click below to confirm your subscription and receive your first issue this Monday:</p>' +
          '<div style="text-align:center;margin:28px 0;">' +
            '<a href="' + confirmUrl + '" style="display:inline-block;background:#f97316;color:#ffffff;font-weight:bold;font-size:15px;padding:14px 28px;border-radius:8px;text-decoration:none;">Confirm My Subscription</a>' +
          '</div>' +
          '<p style="color:#94a3b8;font-size:13px;line-height:1.6;margin:0;">This link expires in 48 hours. If you did not sign up for this you can safely ignore this email.</p>' +
        '</div>' +
        '<div style="background:#1e293b;padding:18px 24px;text-align:center;">' +
          '<p style="color:#94a3b8;font-size:12px;margin:0 0 6px;">humzones.com | hello@humzones.com</p>' +
          '<p style="color:#94a3b8;font-size:12px;margin:0;">Unsubscribe: <a href="' + unsubUrl + '" style="color:#f97316;">' + unsubUrl + '</a></p>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

function welcomeEmailHtml({ firstName, email }) {
  const greeting = firstName ? "Hi " + escapeHtml(firstName) + "," : "Hi there,";
  const unsubUrl = "https://humzones.com/unsubscribe?email=" + encodeURIComponent(email);
  return (
    '<div style="font-family:Arial,sans-serif;background:#f1f5f9;padding:24px 12px;">' +
      '<div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 18px rgba(0,0,0,.08);">' +
        '<div style="background:#1e293b;padding:24px;text-align:center;">' +
          '<div style="color:#ffffff;font-size:18px;font-weight:bold;">Infrastructure Intelligence</div>' +
          '<div style="color:#f97316;font-size:12px;margin-top:4px;">by HumZones</div>' +
        '</div>' +
        '<div style="padding:32px;">' +
          '<p style="color:#475569;font-size:16px;line-height:1.6;margin:0 0 14px;">' + greeting + '</p>' +
          '<p style="color:#475569;font-size:16px;line-height:1.6;margin:0 0 14px;">Welcome to Infrastructure Intelligence. You are now subscribed to our free weekly briefing on data center infrastructure development.</p>' +
          '<p style="color:#475569;font-size:16px;line-height:1.6;margin:0 0 10px;">Every Monday we research and translate:</p>' +
          '<ul style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 18px;padding-left:22px;">' +
            '<li style="margin-bottom:6px;">New interconnection queue filings and what they signal about planned development near residential areas</li>' +
            '<li style="margin-bottom:6px;">Data center announcements, expansions and community impact stories</li>' +
            '<li style="margin-bottom:6px;">Key statistics translated into plain language that anyone can understand</li>' +
          '</ul>' +
          '<p style="color:#475569;font-size:16px;line-height:1.6;margin:0 0 18px;">Your first issue will arrive this Monday. In the meantime you can:</p>' +
          '<div style="text-align:center;margin:18px 0;">' +
            '<a href="https://humzones.com/newsletter" style="display:inline-block;background:#f97316;color:#ffffff;font-weight:bold;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;">Read Past Issues</a>' +
          '</div>' +
          '<p style="color:#475569;font-size:15px;line-height:1.6;margin:18px 0 12px;">While you wait, do you know what data center infrastructure exists near your home? Search your address at HumZones for free:</p>' +
          '<div style="text-align:center;margin:14px 0 22px;">' +
            '<a href="https://humzones.com" style="display:inline-block;background:#f97316;color:#ffffff;font-weight:bold;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none;">Search My Address</a>' +
          '</div>' +
          '<p style="color:#475569;font-size:15px;line-height:1.6;margin:0;">If you have questions or feedback reply to this email. We read every response.</p>' +
        '</div>' +
        '<div style="background:#1e293b;padding:18px 24px;text-align:center;">' +
          '<p style="color:#94a3b8;font-size:12px;margin:0 0 6px;">humzones.com | hello@humzones.com</p>' +
          '<p style="color:#94a3b8;font-size:12px;margin:0;"><a href="' + unsubUrl + '" style="color:#f97316;">Unsubscribe</a></p>' +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

function wrapIssueForEmail(contentHtml, email) {
  const encoded = encodeURIComponent(email);
  const unsub   = "https://humzones.com/unsubscribe?email=" + encoded;
  const filled  = String(contentHtml || "").split("[UNSUBSCRIBE_LINK]").join(unsub);
  const footer  =
    '<div style="background:#f8fafc;padding:24px;text-align:center;font-family:Arial,sans-serif;">' +
      '<p style="color:#94a3b8;font-size:12px;margin:0 0 8px 0;">You are receiving Infrastructure Intelligence because you subscribed at humzones.com.</p>' +
      '<p style="color:#94a3b8;font-size:12px;margin:0;">' +
        '<a href="' + unsub + '" style="color:#f97316;">Unsubscribe</a> | ' +
        '<a href="https://humzones.com/newsletter" style="color:#f97316;">View online</a> | ' +
        'humzones.com' +
      '</p>' +
    '</div>';
  return filled + footer;
}

async function sendConfirmationEmail({ email, firstName, token }) {
  const transporter = buildTransporter();
  await transporter.sendMail({
    from:    fromAddress(),
    to:      email,
    subject: "Please confirm your Infrastructure Intelligence subscription",
    html:    confirmationEmailHtml({ firstName, email, token }),
  });
}

async function sendWelcomeEmail({ email, firstName }) {
  const transporter = buildTransporter();
  await transporter.sendMail({
    from:    fromAddress(),
    to:      email,
    subject: "Welcome to Infrastructure Intelligence",
    html:    welcomeEmailHtml({ firstName, email }),
  });
}

async function handleSubscribe(req, res) {
  const body      = req.body || {};
  const email     = String(body.email     || "").trim();
  const firstName = String(body.firstName || "").trim();
  const source    = String(body.source    || "Newsletter Page").trim();

  if (!email || !isEmail(email)) {
    return res.status(400).json({ error: "A valid email is required." });
  }

  const existing = await findSubscriberByEmail(email);
  if (existing) {
    const f = existing.fields || {};
    if (f[SUB_F.Confirmed]) {
      return res.status(200).json({ status: "already_subscribed" });
    }
    const token = crypto.randomBytes(32).toString("hex");
    await patchSubscriber(existing.id, {
      [SUB_F.Confirm_Token]: token,
      [SUB_F.First_Name]:    firstName || f[SUB_F.First_Name] || "",
      [SUB_F.Source]:        source,
    });
    try {
      await sendConfirmationEmail({ email, firstName: firstName || f[SUB_F.First_Name] || "", token });
    } catch (e) {
      console.error("[newsletter:subscribe] resend email failed:", e && e.message);
    }
    return res.status(200).json({ status: "resent" });
  }

  const token = crypto.randomBytes(32).toString("hex");
  await createSubscriber({
    [SUB_F.Email]:           email,
    [SUB_F.First_Name]:      firstName,
    [SUB_F.Date_Subscribed]: todayIso(),
    [SUB_F.Confirmed]:       false,
    [SUB_F.Confirm_Token]:   token,
    [SUB_F.Source]:          source,
  });
  try {
    await sendConfirmationEmail({ email, firstName, token });
  } catch (e) {
    console.error("[newsletter:subscribe] confirmation email failed:", e && e.message);
  }
  return res.status(200).json({ status: "ok" });
}

async function handleConfirm(req, res) {
  const src   = (req.method === "POST" ? (req.body || {}) : (req.query || {}));
  const email = String(src.email || "").trim();
  const token = String(src.token || "").trim();
  if (!email || !token) {
    return res.status(400).json({ status: "invalid", error: "Missing email or token" });
  }

  const rec = await findSubscriberByEmailAndToken(email, token);
  if (!rec) return res.status(200).json({ status: "invalid" });

  const f = rec.fields || {};
  if (f[SUB_F.Confirmed]) return res.status(200).json({ status: "already_confirmed" });

  await patchSubscriber(rec.id, { [SUB_F.Confirmed]: true });
  try {
    await sendWelcomeEmail({ email, firstName: f[SUB_F.First_Name] || "" });
  } catch (e) {
    console.error("[newsletter:confirm] welcome email failed:", e && e.message);
  }
  return res.status(200).json({ status: "ok" });
}

async function handleSend(req, res) {
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const sentSecret = req.headers["x-cron-secret"] || bearer || (req.query && req.query.secret) || "";
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: "CRON_SECRET not configured. Set CRON_SECRET in Vercel dashboard under Environment Variables." });
  }
  if (sentSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const issues = await airtableListAll(ISSUES_TABLE, {});
  const ready = issues
    .filter(r => (r.fields || {})[ISSUE_F.Status] === "Ready")
    .sort((a, b) => Number((b.fields || {})[ISSUE_F.Issue_Number] || 0) - Number((a.fields || {})[ISSUE_F.Issue_Number] || 0));
  if (ready.length === 0) {
    return res.status(200).json({ sent: 0, message: "No ready issues" });
  }
  const issue       = ready[0];
  const issueFields = issue.fields || {};
  const issueNumber = issueFields[ISSUE_F.Issue_Number];
  const issueTitle  = issueFields[ISSUE_F.Issue_Title]  || "Infrastructure Intelligence";
  const subjectLine = issueFields[ISSUE_F.Subject_Line] || "This week in data center news";
  const contentHtml = issueFields[ISSUE_F.Content_HTML] || "";

  const allSubs = await airtableListAll(SUBS_TABLE, {});
  const recipients = allSubs.filter(r => {
    const f = r.fields || {};
    return !!f[SUB_F.Confirmed] && !f[SUB_F.Unsubscribed] && f[SUB_F.Email];
  });
  if (recipients.length === 0) {
    return res.status(200).json({ sent: 0, issueNumber, message: "No confirmed subscribers" });
  }

  const transporter = buildTransporter();
  let sent = 0;
  const from = fromAddress();
  for (const rec of recipients) {
    const email = String((rec.fields || {})[SUB_F.Email] || "").trim();
    if (!email) continue;
    const html = wrapIssueForEmail(contentHtml, email);
    try {
      await transporter.sendMail({ from, to: email, subject: subjectLine, html });
      sent += 1;
      console.log("Sent to:", email, "Issue:", issueNumber);
    } catch (e) {
      console.error("[newsletter:send] send failed for", email, e && e.message);
    }
    await new Promise(r => setTimeout(r, 150));
  }

  await airtablePatch(ISSUES_TABLE, issue.id, { [ISSUE_F.Status]: "Sent" });

  return res.status(200).json({ sent, issueNumber, issueTitle });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Cron-Secret,Authorization");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const src  = (req.method === "POST" ? (req.body || {}) : (req.query || {}));
  const type = String(src.type || "").trim().toLowerCase();

  try {
    if (type === "subscribe") return await handleSubscribe(req, res);
    if (type === "confirm")   return await handleConfirm(req, res);
    if (type === "send")      return await handleSend(req, res);
    return res.status(400).json({ error: "Unknown type. Expected one of: subscribe, confirm, send." });
  } catch (e) {
    console.error("[newsletter:" + (type || "unknown") + "] failed:", e && e.message);
    return res.status(500).json({ error: (e && e.message) || "Request failed" });
  }
};
