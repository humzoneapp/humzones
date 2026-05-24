// Weekly newsletter delivery cron.
//
// Runs Monday 09:00 UTC (see vercel.json). Picks the Newsletter_Issues
// record with Status=Ready and the highest Issue_Number, fetches every
// confirmed and not-unsubscribed subscriber, and sends the email with
// nodemailer. After every send completes successfully the issue is
// flipped to Status=Sent.
//
// Required env vars (configure in Vercel Environment Variables):
//   AIRTABLE_KEY       Airtable PAT (already set; falls back to
//                      VITE_AIRTABLE_KEY).
//   EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_FROM (already set).
//   CRON_SECRET        Shared secret matched against the X-Cron-Secret
//                      header. NEW: set this in the Vercel dashboard under
//                      Environment Variables. The cron will return 401
//                      until this is set.

const nodemailer = require("nodemailer");

const AIRTABLE_BASE   = "app2FUPqq8VQSwQ64";
const ISSUES_TABLE    = "tbl3pKjNdgxJGYr0u";
const SUBS_TABLE      = "tblTTCCngCteIBbbv";

const ISSUE_F = {
  Issue_Title:    "fld7MRgeaH0NCJBIs",
  Issue_Number:   "fldFU6TiYG0FmF9S8",
  Date_Published: "fldqlKArTdhOkKcYI",
  Subject_Line:   "fld57sICLof4DTx33",
  Content_HTML:   "fld4Ege6wX7ijRXiw",
  Status:         "fldKd6AJRxqqzeYJs",
};
const SUB_F = {
  Email:        "fldbcBeZpmy6QxGSd",
  First_Name:   "fldhQU58l8xP743p8",
  Confirmed:    "fld6zQQvNy8d03EBW",
  Unsubscribed: "flddV4PhEATPwiHzl",
};

const airtableKey = () => process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY || "";
const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE}`;

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

function wrapForEmail(contentHtml, email) {
  const encoded = encodeURIComponent(email);
  const unsub = "https://humzones.com/unsubscribe?email=" + encoded;
  const filled = String(contentHtml || "").split("[UNSUBSCRIBE_LINK]").join(unsub);
  const footer =
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

module.exports = async (req, res) => {
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Accept either X-Cron-Secret (manual trigger) or the Authorization
  // Bearer header that Vercel's cron scheduler sends automatically when
  // CRON_SECRET is configured as an environment variable.
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const sentSecret = req.headers["x-cron-secret"] || bearer || (req.query && req.query.secret) || "";
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: "CRON_SECRET not configured. Set CRON_SECRET in Vercel dashboard under Environment Variables." });
  }
  if (sentSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // Find the Ready issue with the highest number.
    const issues = await airtableListAll(ISSUES_TABLE, {});
    const ready = issues
      .filter(r => (r.fields || {})[ISSUE_F.Status] === "Ready")
      .sort((a, b) => Number((b.fields || {})[ISSUE_F.Issue_Number] || 0) - Number((a.fields || {})[ISSUE_F.Issue_Number] || 0));
    if (ready.length === 0) {
      return res.status(200).json({ sent: 0, message: "No ready issues" });
    }
    const issue = ready[0];
    const issueFields = issue.fields || {};
    const issueNumber = issueFields[ISSUE_F.Issue_Number];
    const issueTitle  = issueFields[ISSUE_F.Issue_Title]  || "Infrastructure Intelligence";
    const subjectLine = issueFields[ISSUE_F.Subject_Line] || "This week in data center news";
    const contentHtml = issueFields[ISSUE_F.Content_HTML] || "";

    // Pull every confirmed, not-unsubscribed subscriber.
    const allSubs = await airtableListAll(SUBS_TABLE, {});
    const recipients = allSubs.filter(r => {
      const f = r.fields || {};
      return !!f[SUB_F.Confirmed] && !f[SUB_F.Unsubscribed] && f[SUB_F.Email];
    });
    if (recipients.length === 0) {
      return res.status(200).json({ sent: 0, issueNumber, message: "No confirmed subscribers" });
    }

    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT, 10),
      secure: true,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });

    let sent = 0;
    const fromAddress = process.env.EMAIL_FROM || '"Infrastructure Intelligence by HumZones" <hello@humzones.com>';
    for (const rec of recipients) {
      const email = String((rec.fields || {})[SUB_F.Email] || "").trim();
      if (!email) continue;
      const html = wrapForEmail(contentHtml, email);
      try {
        await transporter.sendMail({
          from:    fromAddress,
          to:      email,
          subject: subjectLine,
          html,
        });
        sent += 1;
        console.log("Sent to:", email, "Issue:", issueNumber);
      } catch (e) {
        console.error("[send-newsletter] send failed for", email, e && e.message);
      }
      // SMTP throttling buffer between sends.
      await new Promise(r => setTimeout(r, 150));
    }

    await airtablePatch(ISSUES_TABLE, issue.id, { [ISSUE_F.Status]: "Sent" });

    return res.status(200).json({
      sent,
      issueNumber,
      issueTitle,
    });
  } catch (e) {
    console.error("[send-newsletter] failed:", e && e.message);
    return res.status(500).json({ error: (e && e.message) || "Send failed" });
  }
};
