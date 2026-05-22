const nodemailer = require("nodemailer");

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
    const email = String(body.email || "").trim();
    const code  = String(body.code || "").trim();
    if (!email || !code) {
      return res.status(400).json({ error: "Missing email or code" });
    }

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
      subject: "Your HumZones verification code: " + code,
      html:
        '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f1f5f9; padding: 40px 20px;">' +
          '<div style="background: #0f172a; padding: 30px; border-radius: 12px; text-align: center; margin-bottom: 24px;">' +
            '<h1 style="color: white; margin: 0; font-size: 28px;">HumZones<span style="color: #f97316;">&trade;</span></h1>' +
            '<p style="color: #94a3b8; margin: 8px 0 0 0; font-size: 14px;">Global Data Center Health &amp; Infrastructure Registry</p>' +
          '</div>' +
          '<div style="background: white; padding: 32px; border-radius: 12px; margin-bottom: 24px; text-align: center;">' +
            '<h2 style="color: #0f172a; margin-top: 0;">Your Verification Code</h2>' +
            '<p style="color: #475569; font-size: 15px;">Use this code to access your purchased reports.</p>' +
            '<div style="font-size: 40px; font-weight: bold; letter-spacing: 8px; color: #f97316; margin: 24px 0;">' + escapeHtml(code) + '</div>' +
            '<p style="color: #475569; font-size: 15px;">Enter this code at <a href="https://humzones.com/my-report" style="color: #f97316;">humzones.com/my-report</a> to access your reports.</p>' +
            '<p style="color: #94a3b8; font-size: 13px;">This code expires in 10 minutes.</p>' +
            '<p style="color: #94a3b8; font-size: 13px;">If you did not request this code please ignore this email.</p>' +
          '</div>' +
          '<div style="text-align:center;padding:20px;border-top:1px solid #e2e8f0;margin-top:30px;">' +
            '<p style="color:#94a3b8;font-size:11px;margin:0;">' +
              'You are receiving this email because you signed up at humzones.com. ' +
              'To unsubscribe: <a href="https://humzones.com/unsubscribe?email=' + encodeURIComponent(email) + '" style="color:#f97316;">Unsubscribe</a>' +
            '</p>' +
            '<p style="color:#94a3b8;font-size:11px;margin:8px 0 0 0;">' +
              'HumZones Technologies Inc. | Global Data Center Health &amp; Infrastructure Registry | humzones.com' +
            '</p>' +
          '</div>' +
        '</div>',
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Report code email error:", {
      message: error && error.message,
      code: error && error.code,
      stack: error && error.stack,
    });
    res.status(500).json({ error: (error && error.message) || "Failed to send verification code" });
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
