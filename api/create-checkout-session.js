import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body || {};
    const {
      searchAddress = "",
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

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_creation: "always",
      billing_address_collection: "auto",
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: 1499,
            product_data: {
              name: "HumZones Full Area Report",
              description:
                "Personalized data center health report for your area",
            },
          },
          quantity: 1,
        },
      ],
      success_url:
        "https://humzones.com/report-success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://humzones.com/report-landing",
      metadata: {
        searchAddress: toMetaString(searchAddress),
        facilities100km: toMetaString(facilities100km),
        highRiskCount: toMetaString(highRiskCount),
        facilitiesFound: toMetaString(facilitiesFound),
        selectedRadius: toMetaString(selectedRadius),
      },
    });

    return res.status(200).json({ url: session.url, id: session.id });
  } catch (err) {
    console.error("Stripe checkout session error:", err);
    return res
      .status(500)
      .json({ error: err.message || "Failed to create checkout session" });
  }
}
