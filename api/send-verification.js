const nodemailer = require("nodemailer");
const crypto = require("crypto");

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
      facilityName = "",
      reportText = "",
      address = "",
      symptoms = "",
    } = body;

    if (!email || !reportText) {
      return res.status(400).json({ error: "Missing email or report text" });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const verifyUrl =
      "https://humzones.com/verify-report" +
      "?token="    + token +
      "&email="    + encodeURIComponent(email) +
      "&facility=" + encodeURIComponent(facilityName) +
      "&report="   + encodeURIComponent(reportText) +
      "&address="  + encodeURIComponent(address) +
      "&symptoms=" + encodeURIComponent(symptoms);

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
      from: process.env.EMAIL_FROM,
      to: email,
      subject: "Please verify your HumZones resident report",
      html:
        '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f1f5f9; padding: 40px 20px;">' +
          '<div style="background: #1e293b; padding: 30px; border-radius: 12px; text-align: center; margin-bottom: 24px;">' +
            '<h1 style="color: white; margin: 0; font-size: 28px;">HumZones<span style="color: #f97316;">&trade;</span></h1>' +
            '<p style="color: #94a3b8; margin: 8px 0 0 0; font-size: 14px;">Global Data Center Health Registry</p>' +
          '</div>' +
          '<div style="background: white; padding: 32px; border-radius: 12px; margin-bottom: 24px;">' +
            '<h2 style="color: #1e293b; margin-top: 0;">Verify Your Resident Report</h2>' +
            '<p style="color: #475569;">Thank you for submitting your resident report about <strong>' + escapeHtml(facilityName) + '</strong>. Your experience matters and helps others in your community.</p>' +
            '<p style="color: #475569;">To publish your report please click the button below to verify your email address. This confirms your report is from a real resident.</p>' +
            '<div style="text-align: center; margin: 32px 0;">' +
              '<a href="' + verifyUrl + '" style="background: #f97316; color: white; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px; display: inline-block;">Verify My Report</a>' +
            '</div>' +
            '<p style="color: #94a3b8; font-size: 13px;">This link expires in 24 hours. If you did not submit this report please ignore this email.</p>' +
            '<p style="color: #94a3b8; font-size: 13px;">If the button does not work copy and paste this link into your browser:</p>' +
            '<p style="color: #f97316; font-size: 12px; word-break: break-all;">' + verifyUrl + '</p>' +
          '</div>' +
          '<div style="text-align: center;">' +
            '<p style="color: #94a3b8; font-size: 12px;">HumZones Technologies Inc. | Global Data Center Health Registry | humzones.com</p>' +
          '</div>' +
        '</div>',
    });

    res.status(200).json({ success: true, message: "Verification email sent" });
  } catch (error) {
    console.error("Email error:", {
      message: error && error.message,
      code: error && error.code,
      stack: error && error.stack,
    });
    res.status(500).json({ error: (error && error.message) || "Failed to send verification email" });
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
