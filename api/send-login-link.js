const nodemailer = require("nodemailer");
const crypto = require("crypto");

const BASE = "app2FUPqq8VQSwQ64";
const TABLE = "tblHcjycUMDiz6iur"; // Business_Accounts
const EMAIL_FIELD       = "fldxOkzq4F6IbKkHH";
const FIRST_NAME_FIELD  = "fldHTSwebBvMcTRr3";
const TOKEN_FIELD       = "fldWIBRNN4MFc30B3";
const TOKEN_EXPIRY      = "fldlRsSLLbrURuVb1";

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
    const email = String(body.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Missing email" });

    const AIRTABLE_KEY = process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY;
    if (!AIRTABLE_KEY) {
      return res.status(500).json({ error: "Server missing Airtable key" });
    }
    const headers = {
      Authorization: "Bearer " + AIRTABLE_KEY,
      "Content-Type": "application/json",
    };

    // Look up the business account by email. returnFieldsByFieldId so we
    // can read fields by ID (the names may be anything in Airtable).
    const filter = encodeURIComponent("LOWER({Email}) = '" + email.replace(/'/g, "\\'") + "'");
    const listUrl =
      "https://api.airtable.com/v0/" + BASE + "/" + TABLE +
      "?filterByFormula=" + filter +
      "&maxRecords=1&returnFieldsByFieldId=true";
    const lookupRes = await fetch(listUrl, { headers });
    if (!lookupRes.ok) {
      const err = await lookupRes.json().catch(() => ({}));
      console.error("Airtable lookup failed:", err);
      return res.status(500).json({ error: "Account lookup failed" });
    }
    const lookup = await lookupRes.json();
    const record = (lookup.records || [])[0];
    if (!record) {
      return res.status(404).json({ error: "No account found with this email" });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiryIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const patchUrl =
      "https://api.airtable.com/v0/" + BASE + "/" + TABLE + "/" + record.id +
      "?returnFieldsByFieldId=true";
    const patchRes = await fetch(patchUrl, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        fields: {
          [TOKEN_FIELD]: token,
          [TOKEN_EXPIRY]: expiryIso,
        },
      }),
    });
    if (!patchRes.ok) {
      const err = await patchRes.json().catch(() => ({}));
      console.error("Airtable token update failed:", err);
      return res.status(500).json({ error: "Could not save token" });
    }

    const firstName = String(record.fields[FIRST_NAME_FIELD] || "").trim();
    const accountEmail = String(record.fields[EMAIL_FIELD] || email);

    const loginUrl =
      "https://humzones.com/business-login" +
      "?token=" + encodeURIComponent(token) +
      "&email=" + encodeURIComponent(accountEmail);

    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT, 10),
      secure: true,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || "HumZones <hello@humzones.com>",
      to: accountEmail,
      subject: "Your HumZones login link",
      html:
        '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f1f5f9; padding: 40px 20px;">' +
          '<div style="background: #0f172a; padding: 30px; border-radius: 12px; text-align: center; margin-bottom: 24px;">' +
            '<h1 style="color: white; margin: 0; font-size: 28px;">HumZones<span style="color: #f97316;">&trade;</span></h1>' +
            '<p style="color: #94a3b8; margin: 8px 0 0 0; font-size: 14px;">Global Data Center Health Registry</p>' +
          '</div>' +
          '<div style="background: white; padding: 32px; border-radius: 12px; margin-bottom: 24px;">' +
            '<h2 style="color: #0f172a; margin-top: 0;">' + (firstName ? ('Hi ' + escapeHtml(firstName) + ',') : 'Hi,') + '</h2>' +
            '<p style="color: #475569; font-size: 16px;">Click the button below to sign in to your HumZones business dashboard.</p>' +
            '<div style="text-align: center; margin: 32px 0;">' +
              '<a href="' + loginUrl + '" style="background: #f97316; color: white; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px; display: inline-block;">Sign In to My Dashboard</a>' +
            '</div>' +
            '<p style="color: #94a3b8; font-size: 13px;">This link expires in 24 hours. If you did not request this email you can safely ignore it.</p>' +
            '<p style="color: #94a3b8; font-size: 13px; margin-top: 20px;">If the button does not work copy and paste this link into your browser:</p>' +
            '<p style="color: #f97316; font-size: 12px; word-break: break-all;">' + loginUrl + '</p>' +
          '</div>' +
          '<div style="text-align: center;">' +
            '<p style="color: #94a3b8; font-size: 12px;">HumZones Technologies Inc. | Global Data Center Health Registry | humzones.com</p>' +
          '</div>' +
        '</div>',
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Login link error:", {
      message: error && error.message,
      code: error && error.code,
      stack: error && error.stack,
    });
    res.status(500).json({ error: (error && error.message) || "Failed to send login link" });
  }
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
