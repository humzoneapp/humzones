const nodemailer = require("nodemailer");

const PLAN_LABEL = {
  starter:             "Starter",
  "starter-annual":    "Starter Annual",
  professional:        "Professional",
  "professional-annual":"Professional Annual",
  unlimited:           "Unlimited",
  "unlimited-annual":  "Unlimited Annual",
};

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
    const {
      email = "",
      firstName = "",
      plan = "",
      credits = 0,
      token = "",
    } = body;

    if (!email || !firstName || !plan || !token) {
      return res.status(400).json({ error: "Missing email, firstName, plan or token" });
    }

    const planLabel = PLAN_LABEL[plan] || plan;
    const isUnlimited = Number(credits) >= 999999;
    const creditsLabel = isUnlimited ? "unlimited" : String(credits);
    const monthlyLabel = isUnlimited ? "unlimited" : (credits + " reports");

    const loginUrl =
      "https://humzones.com/business-login" +
      "?token=" + encodeURIComponent(token) +
      "&email=" + encodeURIComponent(email);

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
      to: email,
      subject: "Welcome to HumZones " + planLabel + " - Your login link is inside",
      html:
        '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f1f5f9; padding: 40px 20px;">' +
          '<div style="background: #0f172a; padding: 30px; border-radius: 12px; text-align: center; margin-bottom: 24px;">' +
            '<h1 style="color: white; margin: 0; font-size: 28px;">HumZones<span style="color: #f97316;">&trade;</span></h1>' +
            '<p style="color: #94a3b8; margin: 8px 0 0 0; font-size: 14px;">Global Data Center Health &amp; Infrastructure Registry</p>' +
          '</div>' +
          '<div style="background: white; padding: 32px; border-radius: 12px; margin-bottom: 24px;">' +
            '<h2 style="color: #0f172a; margin-top: 0;">Welcome ' + escapeHtml(firstName) + '!</h2>' +
            '<p style="color: #475569; font-size: 16px;">Your <strong>' + escapeHtml(planLabel) + '</strong> subscription is active.</p>' +
            '<p style="color: #475569; font-size: 16px;">You have <strong>' + escapeHtml(creditsLabel) + '</strong> report credits ready to use.</p>' +
            '<div style="text-align: center; margin: 32px 0;">' +
              '<a href="' + loginUrl + '" style="background: #f97316; color: white; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px; display: inline-block;">Access My Dashboard</a>' +
            '</div>' +
            '<div style="background: #fff7ed; border: 1px solid #fdba74; border-radius: 8px; padding: 16px 18px; margin: 24px 0;">' +
              '<p style="color: #c2410c; font-size: 14px; font-weight: bold; margin: 0 0 6px 0;">Account Recovery</p>' +
              '<p style="color: #7c2d12; font-size: 13px; line-height: 1.6; margin: 0;">Your account is protected by your 4-digit PIN and security question. If you ever forget your login email visit <a href="https://humzones.com/business-recover" style="color: #c2410c; font-weight: bold;">humzones.com/business-recover</a>. You will need your PIN and the answer to your security question.</p>' +
            '</div>' +
            '<p style="color: #94a3b8; font-size: 13px;">This login link expires in 24 hours. You can always request a new one at <a href="https://humzones.com/business-login" style="color: #f97316;">humzones.com/business-login</a>.</p>' +
            '<h3 style="color: #0f172a; font-size: 16px; margin-top: 28px;">What you can do:</h3>' +
            '<ul style="color: #475569; font-size: 15px; padding-left: 20px; line-height: 1.8;">' +
              '<li>Generate ' + escapeHtml(monthlyLabel) + ' per month</li>' +
              '<li>Instant PDF download for each report</li>' +
              '<li>Credits reset automatically each month</li>' +
            '</ul>' +
            '<p style="color: #94a3b8; font-size: 13px; margin-top: 20px;">If the button does not work copy and paste this link into your browser:</p>' +
            '<p style="color: #f97316; font-size: 12px; word-break: break-all;">' + loginUrl + '</p>' +
          '</div>' +
          '<div style="text-align: center;">' +
            '<p style="color: #94a3b8; font-size: 12px;">HumZones Technologies Inc. | Global Data Center Health &amp; Infrastructure Registry | humzones.com</p>' +
          '</div>' +
        '</div>',
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Business welcome email error:", {
      message: error && error.message,
      code: error && error.code,
      stack: error && error.stack,
    });
    res.status(500).json({ error: (error && error.message) || "Failed to send welcome email" });
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
