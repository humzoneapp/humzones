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
    const {
      firstName = "",
      lastName = "",
      email = "",
      subject = "",
      message = "",
    } = body;

    if (!firstName || !email || !subject || !message) {
      return res.status(400).json({ error: "Missing firstName, email, subject or message" });
    }

    const fullName = (firstName + " " + lastName).trim();

    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT, 10),
      secure: true,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    // 1. Notification to the HumZones inbox.
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || "HumZones <hello@humzones.com>",
      to: "hello@humzones.com",
      replyTo: email,
      subject: "HumZones Contact Form: " + subject + " from " + fullName,
      html:
        '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f1f5f9; padding: 32px 20px;">' +
          '<div style="background: #0f172a; padding: 24px; border-radius: 12px; text-align: center; margin-bottom: 20px;">' +
            '<h1 style="color: white; margin: 0; font-size: 22px;">HumZones Contact Form</h1>' +
          '</div>' +
          '<div style="background: white; padding: 28px; border-radius: 12px;">' +
            '<table style="width:100%; border-collapse: collapse; font-size: 15px; color: #334155;">' +
              '<tr><td style="padding:8px 0; font-weight:bold; width:130px; vertical-align:top;">Name</td><td style="padding:8px 0;">' + escapeHtml(fullName) + '</td></tr>' +
              '<tr><td style="padding:8px 0; font-weight:bold; vertical-align:top;">Email</td><td style="padding:8px 0;">' + escapeHtml(email) + '</td></tr>' +
              '<tr><td style="padding:8px 0; font-weight:bold; vertical-align:top;">Subject</td><td style="padding:8px 0;">' + escapeHtml(subject) + '</td></tr>' +
              '<tr><td style="padding:8px 0; font-weight:bold; vertical-align:top;">Message</td><td style="padding:8px 0; white-space:pre-wrap;">' + escapeHtml(message) + '</td></tr>' +
            '</table>' +
          '</div>' +
        '</div>',
    });

    // 2. Auto-reply to the person who submitted the form.
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || "HumZones <hello@humzones.com>",
      to: email,
      subject: "We received your message - HumZones",
      html:
        '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f1f5f9; padding: 40px 20px;">' +
          '<div style="background: #0f172a; padding: 30px; border-radius: 12px; text-align: center; margin-bottom: 24px;">' +
            '<h1 style="color: white; margin: 0; font-size: 28px;">HumZones<span style="color: #f97316;">&trade;</span></h1>' +
            '<p style="color: #94a3b8; margin: 8px 0 0 0; font-size: 14px;">Global Data Center Health &amp; Infrastructure Registry</p>' +
          '</div>' +
          '<div style="background: white; padding: 32px; border-radius: 12px; margin-bottom: 24px;">' +
            '<h2 style="color: #0f172a; margin-top: 0;">Thank you ' + escapeHtml(firstName) + '</h2>' +
            '<p style="color: #475569; font-size: 16px; line-height: 1.7;">Thank you ' + escapeHtml(firstName) + ' for contacting HumZones. We have received your message and will respond within 1 to 2 business days.</p>' +
            '<p style="color: #475569; font-size: 16px; line-height: 1.7;">In the meantime you can explore our methodology at <a href="https://humzones.com/methodology" style="color: #f97316;">humzones.com/methodology</a> or find data centers near you at <a href="https://humzones.com" style="color: #f97316;">humzones.com</a>.</p>' +
            '<p style="color: #475569; font-size: 16px; line-height: 1.7;">HumZones Technologies Inc.</p>' +
          '</div>' +
          '<div style="text-align:center;padding:20px;border-top:1px solid #e2e8f0;margin-top:30px;">' +
            '<p style="color:#94a3b8;font-size:11px;margin:0;">' +
              'You are receiving this email because you contacted us at humzones.com. ' +
              'To unsubscribe: ' +
              '<a href="https://humzones.com/unsubscribe?email=' + encodeURIComponent(email) + '" style="color:#f97316;">Unsubscribe</a>' +
            '</p>' +
            '<p style="color:#94a3b8;font-size:11px;margin:8px 0 0 0;">' +
              'HumZones Technologies Inc. | Global Data Center Health &amp; Infrastructure Registry | humzones.com' +
            '</p>' +
          '</div>' +
        '</div>',
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Contact form email error:", {
      message: error && error.message,
      code: error && error.code,
      stack: error && error.stack,
    });
    res.status(500).json({ error: (error && error.message) || "Failed to send message" });
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
