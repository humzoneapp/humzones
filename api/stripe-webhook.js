// Stripe webhook handler. Listens for checkout.session.completed events
// from the B2B Payment Links and writes the Subscription_ID back to the
// matching Business_Accounts row in Airtable.
//
// REQUIRED ENV VARS (configure in Vercel):
//   STRIPE_SECRET_KEY      sk_test_... (or sk_live_...)
//   STRIPE_WEBHOOK_SECRET  whsec_...  (from the Stripe Dashboard endpoint)
//   AIRTABLE_KEY           Airtable PAT with write scope on Business_Accounts
//                          (falls back to VITE_AIRTABLE_KEY if AIRTABLE_KEY
//                          is not set, for parity with the frontend bundle)
//
// STRIPE DASHBOARD SETUP:
//   Developers -> Webhooks -> Add endpoint
//     URL:    https://humzones.com/api/stripe-webhook
//     Events: checkout.session.completed
//   Copy the resulting signing secret into STRIPE_WEBHOOK_SECRET.
//
// TIMING NOTE:
//   The /business-success form creates the Airtable row AFTER the user
//   pays. The webhook fires the moment checkout completes, so the row
//   often does not exist yet. When that happens we return 503 and Stripe
//   retries with exponential backoff (~10 min, then up to 3 days). The
//   row is created when the user submits the form, and the next retry
//   patches the Subscription_ID in place.

const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

const AIRTABLE_BASE         = "app2FUPqq8VQSwQ64";
const BUSINESS_TABLE        = "tblHcjycUMDiz6iur";
const FIELD_SUBSCRIPTION_ID = "fldMWdZzuips9yphK";
const AIRTABLE_API          = `https://api.airtable.com/v0/${AIRTABLE_BASE}`;

const airtableKey = () => process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY || "";

// Disable Vercel's default JSON body parser so the raw request body is
// available for Stripe signature verification.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function findBusinessRowByEmail(email) {
  const key = airtableKey();
  if (!key) throw new Error("Airtable key not configured");
  const e = String(email || "").trim().toLowerCase().replace(/'/g, "\\'");
  if (!e) return null;
  const formula = encodeURIComponent(`LOWER({Email}) = '${e}'`);
  const url = `${AIRTABLE_API}/${BUSINESS_TABLE}?filterByFormula=${formula}&maxRecords=1&returnFieldsByFieldId=true`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Airtable lookup failed: ${r.status} ${body}`);
  }
  const d = await r.json();
  return (d.records || [])[0] || null;
}

async function patchSubscriptionId(recordId, subscriptionId) {
  const key = airtableKey();
  const url = `${AIRTABLE_API}/${BUSINESS_TABLE}/${recordId}?returnFieldsByFieldId=true`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { [FIELD_SUBSCRIPTION_ID]: subscriptionId } }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Airtable PATCH failed: ${r.status} ${body}`);
  }
  return r.json();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET || "";
  if (!secret) {
    console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET not set");
    return res.status(500).json({ error: "Webhook secret not configured" });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error("[stripe-webhook] STRIPE_SECRET_KEY not set");
    return res.status(500).json({ error: "Stripe secret key not configured" });
  }

  const sig = req.headers["stripe-signature"];
  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, secret);
  } catch (e) {
    console.error("[stripe-webhook] signature verification failed:", e && e.message);
    return res.status(400).json({ error: `Webhook Error: ${e && e.message}` });
  }

  // Only one event type is wired up today. Everything else is ack'd so
  // Stripe does not retry it.
  if (event.type !== "checkout.session.completed") {
    console.log("[stripe-webhook] ignoring event:", event.type);
    return res.status(200).json({ received: true, ignored: true });
  }

  const session = event.data.object || {};
  if (session.mode !== "subscription") {
    console.log("[stripe-webhook] non-subscription session, ignoring:", session.id);
    return res.status(200).json({ received: true, ignored: true });
  }

  const subscriptionId = session.subscription || "";
  const email =
    (session.customer_details && session.customer_details.email) ||
    session.customer_email ||
    "";
  if (!subscriptionId || !email) {
    console.warn("[stripe-webhook] missing subscription or email on session:", session.id, { subscriptionId, email });
    return res.status(200).json({ received: true, skipped: "missing fields" });
  }

  try {
    const rec = await findBusinessRowByEmail(email);
    if (!rec) {
      // Row not created yet — user has paid but has not finished the
      // /business-success form. Return 503 so Stripe retries with
      // exponential backoff; once the row exists a later retry lands
      // the Subscription_ID on it.
      console.warn("[stripe-webhook] no Business_Accounts row for", email, "— requesting retry");
      return res.status(503).json({ retry: true, reason: "row-not-ready" });
    }
    await patchSubscriptionId(rec.id, subscriptionId);
    console.log("[stripe-webhook] patched Subscription_ID on", rec.id, "->", subscriptionId);
    return res.status(200).json({ received: true, patched: rec.id });
  } catch (e) {
    console.error("[stripe-webhook] processing failed:", e && e.message);
    return res.status(500).json({ error: "Internal processing failed" });
  }
};
