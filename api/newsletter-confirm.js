// Newsletter confirmation endpoint.
//
// GET or POST with query/body params: token, email
//
// Behaviour:
//   - If no matching row: { status: "invalid" }
//   - If already confirmed: { status: "already_confirmed" }
//   - If pending: PATCH Confirmed=true, send the welcome email, return
//     { status: "ok" }
//
// Required env vars: AIRTABLE_KEY (or VITE_AIRTABLE_KEY), EMAIL_HOST,
// EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_FROM.

const nodemailer = require("nodemailer");

const AIRTABLE_BASE = "app2FUPqq8VQSwQ64";
const SUBS_TABLE    = "tblTTCCngCteIBbbv";
const F = {
  Email:         "fldbcBeZpmy6QxGSd",
  First_Name:    "fldhQU58l8xP743p8",
  Confirmed:     "fld6zQQvNy8d03EBW",
  Confirm_Token: "fldX96dV6gvtKNx1f",
};

const airtableKey = () => process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY || "";
const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE}`;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

async function sendWelcomeEmail({ email, firstName }) {
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT, 10),
    secure: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || '"Infrastructure Intelligence by HumZones" <hello@humzones.com>',
    to: email,
    subject: "Welcome to Infrastructure Intelligence",
    html: welcomeEmailHtml({ firstName, email }),
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const src = (req.method === "POST" ? (req.body || {}) : (req.query || {}));
    const email = String(src.email || "").trim();
    const token = String(src.token || "").trim();
    if (!email || !token) {
      return res.status(400).json({ status: "invalid", error: "Missing email or token" });
    }

    const rec = await findSubscriberByEmailAndToken(email, token);
    if (!rec) return res.status(200).json({ status: "invalid" });

    const f = rec.fields || {};
    if (f[F.Confirmed]) return res.status(200).json({ status: "already_confirmed" });

    await patchSubscriber(rec.id, { [F.Confirmed]: true });
    try {
      await sendWelcomeEmail({ email, firstName: f[F.First_Name] || "" });
    } catch (e) {
      console.error("[newsletter-confirm] welcome email failed:", e && e.message);
    }
    return res.status(200).json({ status: "ok" });
  } catch (e) {
    console.error("[newsletter-confirm] failed:", e && e.message);
    return res.status(500).json({ error: "Could not confirm subscription." });
  }
};
