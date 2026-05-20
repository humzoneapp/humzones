// Vercel Node.js serverless function. CommonJS so it loads regardless of the
// top-level "type": "module" setting in package.json. Vercel routes both
// .js and .cjs files in /api/ at the same /api/<basename> URL.
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  // CORS: same-origin requests do not need these, but adding them keeps the
  // endpoint usable from preview deploys and local dev under a different
  // origin, and avoids any browser refusing the response.
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Fail fast and loud if the env var is missing so Vercel logs show a
    // clear cause rather than a cryptic Stripe error.
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error("Stripe error: STRIPE_SECRET_KEY env var is missing on this deployment");
      return res.status(500).json({ error: "Server is missing STRIPE_SECRET_KEY. Set it in Vercel project settings." });
    }

    const body = req.body || {};
    const {
      searchAddress = "",
      searchLat = "",
      searchLng = "",
      facilities100km = "",
      highRiskCount = "",
      facilitiesFound = "",
      selectedRadius = "",
    } = body;

    const toMetaString = (v) => {
      if (v === null || v === undefined) return "";
      const s = String(v);
      return s.length > 450 ? s.slice(0, 450) : s;
    };

    // Append search context onto the success URL so /report-success can
    // personalize the PDF even when Safari/ITP wipes localStorage across the
    // Stripe redirect. Stripe replaces {CHECKOUT_SESSION_ID} server-side;
    // everything else is URL-encoded so commas/spaces survive the round trip.
    const addrTrimmed = String(searchAddress || "").slice(0, 200);
    const successParams = [
      "session_id={CHECKOUT_SESSION_ID}",
      "lat=" + encodeURIComponent(String(searchLat || "")),
      "lng=" + encodeURIComponent(String(searchLng || "")),
      "address=" + encodeURIComponent(addrTrimmed),
      "r100=" + encodeURIComponent(String(facilities100km || "")),
      "high=" + encodeURIComponent(String(highRiskCount || "")),
      "found=" + encodeURIComponent(String(facilitiesFound || "")),
      "radius=" + encodeURIComponent(String(selectedRadius || "")),
    ].join("&");

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      // Let Stripe pick every payment method enabled on the account, including
      // cards, Apple Pay, Google Pay and Link. payment_method_types and
      // automatic_payment_methods are mutually exclusive on Checkout Sessions.
      automatic_payment_methods: { enabled: true },
      customer_creation: "always",
      billing_address_collection: "auto",
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: 1499,
            product_data: {
              name: "HumZones Full Area Report",
              description: "Personalized data center health report for your area",
            },
          },
          quantity: 1,
        },
      ],
      success_url: "https://humzones.com/report-success?" + successParams,
      cancel_url: "https://humzones.com/report-landing",
      metadata: {
        searchAddress: toMetaString(searchAddress),
        searchLat: toMetaString(searchLat),
        searchLng: toMetaString(searchLng),
        facilities100km: toMetaString(facilities100km),
        highRiskCount: toMetaString(highRiskCount),
        facilitiesFound: toMetaString(facilitiesFound),
        selectedRadius: toMetaString(selectedRadius),
      },
    });

    return res.status(200).json({ url: session.url, id: session.id });
  } catch (error) {
    // Log the full error to Vercel function logs (message, type, code, raw
    // body, stack) so it is actually recoverable from the dashboard.
    console.error("Stripe error:", {
      message: error && error.message,
      type: error && error.type,
      code: error && error.code,
      statusCode: error && error.statusCode,
      raw: error && error.raw,
      stack: error && error.stack,
    });
    return res.status(500).json({
      error: (error && error.message) || "Failed to create checkout session",
    });
  }
};
