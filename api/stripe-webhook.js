// Stripe webhook handler for the B2B subscription flow.
//
// Listens for:
//   checkout.session.completed       Fresh signup OR reinstatement of a
//                                    previously cancelled account.
//   customer.subscription.deleted    Final cancellation (subscription
//                                    period ended after the user opted
//                                    out). Flips the row to Cancelled
//                                    and zeroes Credits_Remaining so the
//                                    Generate flow gates correctly while
//                                    leaving the dashboard / report
//                                    history accessible.
//
// REQUIRED ENV VARS (Vercel):
//   STRIPE_SECRET_KEY      sk_test_... or sk_live_...
//   STRIPE_WEBHOOK_SECRET  whsec_... from the Stripe Dashboard endpoint
//   AIRTABLE_KEY           Airtable PAT with write scope on
//                          Business_Accounts (falls back to
//                          VITE_AIRTABLE_KEY if AIRTABLE_KEY is unset).
//
// STRIPE DASHBOARD SETUP:
//   Developers -> Webhooks -> Add endpoint
//     URL: https://humzones.com/api/stripe-webhook
//     Events:
//       checkout.session.completed
//       customer.subscription.deleted
//   Copy the signing secret into STRIPE_WEBHOOK_SECRET.
//
// CLIENT_REFERENCE_ID CONVENTION:
//   The dashboard reinstatement flow sends visitors to the Payment Link
//   with client_reference_id="plan:<key>" so this handler can grant the
//   right plan on return. Fresh signups (which still go through
//   /business-success) do not set client_reference_id — they fill out
//   the post-payment form which writes the plan + credits itself, and
//   this handler only adds Subscription_ID after the row exists.
//
// TIMING:
//   On a fresh signup the Airtable row does not yet exist when the
//   webhook fires (the user finishes the form afterwards). We return
//   503 so Stripe retries with exponential backoff (~10 min, then up
//   to 3 days). The next retry after form submission lands the patch.

const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

const AIRTABLE_BASE         = "app2FUPqq8VQSwQ64";
const BUSINESS_TABLE        = "tblHcjycUMDiz6iur";
const FIELD_EMAIL              = "fldxOkzq4F6IbKkHH";
const FIELD_PLAN               = "fldjt5Ti94M1RTZQN";
const FIELD_CREDITS_REMAINING  = "fld8aey7U37nCHAoR";
const FIELD_CREDITS_MONTHLY    = "fldfQCiHwuKQdOKkY";
const FIELD_SUBSCRIPTION_ID    = "fldMWdZzuips9yphK";
const FIELD_STATUS             = "fldU2MWb01DTMONhQ";
const FIELD_RENEWAL_DATE       = "fldHKXCTypDhQglSt";
const AIRTABLE_API          = `https://api.airtable.com/v0/${AIRTABLE_BASE}`;

// Plan metadata mirrored from src/App.jsx PLAN_INFO. Keep these two
// copies in sync — credits and labels show up in the dashboard, in
// emails, and on report covers.
const PLAN_INFO = {
  "starter":               { label: "Starter",              credits: 10,  annual: false },
  "starter-annual":        { label: "Starter Annual",       credits: 10,  annual: true  },
  "professional":          { label: "Professional",         credits: 30,  annual: false },
  "professional-annual":   { label: "Professional Annual",  credits: 30,  annual: true  },
  "unlimited":             { label: "Enterprise",           credits: 200, annual: false },
  "unlimited-annual":      { label: "Enterprise Annual",    credits: 200, annual: true  },
};

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

// Compute today + N months as YYYY-MM-DD, rolling to the month's last
// day when the target month is shorter (Jan 31 + 1mo -> Feb 28/29).
function addMonthsIso(months) {
  const d = new Date();
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

// Pull "plan:<key>" out of a checkout session's client_reference_id.
// Anything else (or a missing value) returns null so the handler falls
// back to the fresh-signup path that just patches Subscription_ID.
function parsePlanKey(clientRef) {
  if (!clientRef) return null;
  const m = String(clientRef).match(/^plan:([a-z0-9-]+)/i);
  if (!m) return null;
  const key = m[1].toLowerCase();
  return PLAN_INFO[key] ? key : null;
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

async function findBusinessRowBySubscriptionId(subscriptionId) {
  const key = airtableKey();
  if (!key) throw new Error("Airtable key not configured");
  const s = String(subscriptionId || "").trim().replace(/'/g, "\\'");
  if (!s) return null;
  // Subscription_ID is referenced by display name "Subscription_ID" in
  // the formula; Airtable accepts either name or ID inside {}.
  const formula = encodeURIComponent(`{Subscription_ID} = '${s}'`);
  const url = `${AIRTABLE_API}/${BUSINESS_TABLE}?filterByFormula=${formula}&maxRecords=1&returnFieldsByFieldId=true`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Airtable lookup failed: ${r.status} ${body}`);
  }
  const d = await r.json();
  return (d.records || [])[0] || null;
}

async function patchBusinessRow(recordId, fields) {
  const key = airtableKey();
  const url = `${AIRTABLE_API}/${BUSINESS_TABLE}/${recordId}?returnFieldsByFieldId=true`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Airtable PATCH failed: ${r.status} ${body}`);
  }
  return r.json();
}

async function handleCheckoutCompleted(session) {
  if (session.mode !== "subscription") {
    console.log("[stripe-webhook] non-subscription session, ignoring:", session.id);
    return { status: 200, body: { received: true, ignored: true } };
  }

  const subscriptionId = session.subscription || "";
  const email =
    (session.customer_details && session.customer_details.email) ||
    session.customer_email ||
    "";
  if (!subscriptionId || !email) {
    console.warn("[stripe-webhook] missing subscription or email on session:", session.id, { subscriptionId, email });
    return { status: 200, body: { received: true, skipped: "missing fields" } };
  }

  const rec = await findBusinessRowByEmail(email);
  if (!rec) {
    // Fresh signup: row will be created when the user finishes the
    // /business-success form. Stripe retries with backoff until then.
    console.warn("[stripe-webhook] no Business_Accounts row for", email, "— requesting retry");
    return { status: 503, body: { retry: true, reason: "row-not-ready" } };
  }

  const planKey = parsePlanKey(session.client_reference_id);
  if (planKey) {
    // Reinstatement / plan change. Refresh plan + credits and flip
    // Status back to Active.
    const info = PLAN_INFO[planKey];
    const renewalDate = addMonthsIso(info.annual ? 12 : 1);
    await patchBusinessRow(rec.id, {
      [FIELD_PLAN]:              info.label,
      [FIELD_CREDITS_REMAINING]: info.credits,
      [FIELD_CREDITS_MONTHLY]:   info.credits,
      [FIELD_SUBSCRIPTION_ID]:   subscriptionId,
      [FIELD_STATUS]:            "Active",
      [FIELD_RENEWAL_DATE]:      renewalDate,
    });
    console.log("[stripe-webhook] reinstated", rec.id, "as", planKey, "->", subscriptionId);
    return { status: 200, body: { received: true, reinstated: rec.id, plan: planKey } };
  }

  // No plan hint — fresh signup case. The /business-success form has
  // already written Plan/credits/Status; we just stamp Subscription_ID.
  await patchBusinessRow(rec.id, { [FIELD_SUBSCRIPTION_ID]: subscriptionId });
  console.log("[stripe-webhook] patched Subscription_ID on", rec.id, "->", subscriptionId);
  return { status: 200, body: { received: true, patched: rec.id } };
}

async function handleSubscriptionDeleted(subscription) {
  const subscriptionId = subscription && subscription.id;
  if (!subscriptionId) {
    console.warn("[stripe-webhook] subscription.deleted with no id");
    return { status: 200, body: { received: true, skipped: "no id" } };
  }
  const rec = await findBusinessRowBySubscriptionId(subscriptionId);
  if (!rec) {
    console.warn("[stripe-webhook] no Business_Accounts row for subscription", subscriptionId);
    return { status: 200, body: { received: true, skipped: "no-row-for-subscription" } };
  }
  await patchBusinessRow(rec.id, {
    [FIELD_STATUS]:            "Cancelled",
    [FIELD_CREDITS_REMAINING]: 0,
  });
  console.log("[stripe-webhook] cancelled", rec.id, "for subscription", subscriptionId);
  return { status: 200, body: { received: true, cancelled: rec.id } };
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

  try {
    let result;
    if (event.type === "checkout.session.completed") {
      result = await handleCheckoutCompleted(event.data.object || {});
    } else if (event.type === "customer.subscription.deleted") {
      result = await handleSubscriptionDeleted(event.data.object || {});
    } else {
      console.log("[stripe-webhook] ignoring event:", event.type);
      result = { status: 200, body: { received: true, ignored: true } };
    }
    return res.status(result.status).json(result.body);
  } catch (e) {
    console.error("[stripe-webhook] processing failed:", e && e.message);
    return res.status(500).json({ error: "Internal processing failed" });
  }
};
