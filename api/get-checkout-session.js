import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  const session_id = req.query.session_id || req.query.id;
  if (!session_id) {
    return res.status(400).json({ error: "Missing session_id" });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
      return res.status(402).json({ error: "Payment not completed", payment_status: session.payment_status });
    }
    return res.status(200).json({
      email:
        session.customer_details?.email ||
        session.customer_email ||
        "",
      amount_total: session.amount_total,
      currency: session.currency,
      payment_status: session.payment_status,
      metadata: session.metadata || {},
    });
  } catch (err) {
    console.error("Stripe session retrieve error:", err);
    return res.status(500).json({ error: err.message || "Failed to retrieve session" });
  }
}
