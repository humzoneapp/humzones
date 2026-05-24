// Newsletter subscribe endpoint.
//
// POST body: { email, firstName, source }
//
// Behaviour:
//   1. Validate email.
//   2. Look up the subscriber in Newsletter_Subscribers by lowercased email.
//      - If found and Confirmed=true: return { status: "already_subscribed" }.
//      - If found and Confirmed=false: regenerate token, PATCH, resend
//        confirmation, return { status: "resent" }.
//      - Otherwise create the row and send confirmation, return { status: "ok" }.
//   3. Confirmation email contains a link to humzones.com/newsletter-confirm
//      carrying ?token=...&email=... which the frontend POSTs to
//      /api/newsletter-confirm to flip Confirmed=true.
//
// Required env vars (already set in Vercel):
//   AIRTABLE_KEY (falls back to VITE_AIRTABLE_KEY for parity with the frontend)
//   EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_FROM

const crypto      = require("crypto");
const nodemailer  = require("nodemailer");

const AIRTABLE_BASE = "app2FUPqq8VQSwQ64";
const SUBS_TABLE    = "tblTTCCngCteIBbbv";
const F = {
  Email:            "fldbcBeZpmy6QxGSd",
  First_Name:       "fldhQU58l8xP743p8",
  Date_Subscribed:  "fldce7l2haje9WJG2",
  Confirmed:        "fld6zQQvNy8d03EBW",
  Confirm_Token:    "fldX96dV6gvtKNx1f",
  Unsubscribed:     "flddV4PhEATPwiHzl",
  Source:           "fldc9Nv50HRjfG1jL",
};

const airtableKey = () => process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY || "";
const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE}`;

const todayIso = () => new Date().toISOString().slice(0, 10);

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

async function sendConfirmationEmail({ email, firstName, token }) {
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT, 10),
    secure: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || '"Infrastructure Intelligence by HumZones" <hello@humzones.com>',
    to: email,
    subject: "Please confirm your Infrastructure Intelligence subscription",
    html: confirmationEmailHtml({ firstName, email, token }),
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body || {};
    const email     = String(body.email     || "").trim();
    const firstName = String(body.firstName || "").trim();
    const source    = String(body.source    || "Newsletter Page").trim();

    if (!email || !isEmail(email)) {
      return res.status(400).json({ error: "A valid email is required." });
    }

    const existing = await findSubscriberByEmail(email);
    if (existing) {
      const f = existing.fields || {};
      if (f[F.Confirmed]) {
        return res.status(200).json({ status: "already_subscribed" });
      }
      // Regenerate token and resend the confirmation email.
      const token = crypto.randomBytes(32).toString("hex");
      await patchSubscriber(existing.id, {
        [F.Confirm_Token]: token,
        [F.First_Name]:    firstName || f[F.First_Name] || "",
        [F.Source]:        source,
      });
      try {
        await sendConfirmationEmail({ email, firstName: firstName || f[F.First_Name] || "", token });
      } catch (e) {
        console.error("[newsletter-subscribe] resend email failed:", e && e.message);
      }
      return res.status(200).json({ status: "resent" });
    }

    const token = crypto.randomBytes(32).toString("hex");
    await createSubscriber({
      [F.Email]:           email,
      [F.First_Name]:      firstName,
      [F.Date_Subscribed]: todayIso(),
      [F.Confirmed]:       false,
      [F.Confirm_Token]:   token,
      [F.Source]:          source,
    });
    try {
      await sendConfirmationEmail({ email, firstName, token });
    } catch (e) {
      console.error("[newsletter-subscribe] confirmation email failed:", e && e.message);
    }
    return res.status(200).json({ status: "ok" });
  } catch (e) {
    console.error("[newsletter-subscribe] failed:", e && e.message);
    return res.status(500).json({ error: "Could not save subscription. Please try again." });
  }
};
