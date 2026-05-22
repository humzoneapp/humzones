// Serverless proxy for the HumZones Assistant chatbot. The browser posts the
// conversation here and this function calls the Anthropic Claude API, keeping
// the API key server-side. Set ANTHROPIC_API_KEY in the Vercel environment.

const SYSTEM_PROMPT = `You are the HumZones Assistant, a helpful AI embedded on humzones.com, the Global Data Center Health & Infrastructure Registry. You help visitors understand data centers, infrastructure exposure, and how to use HumZones.

ABOUT HUMZONES:
HumZones tracks over 1,000 data center facilities worldwide. We compile publicly available information and model environmental estimates including power draw, noise levels, EMF exposure ranges, CO2 emissions and water consumption. All figures are modeled estimates not certified measurements.

EXPOSURE CATEGORIES:
- HIGH EXPOSURE: facilities with 50MW or more power draw or within 500m of residential areas
- MODERATE EXPOSURE: facilities 15-50MW or within 500-1000m of residential areas
- LOW EXPOSURE: facilities under 15MW in rural or industrial areas beyond 1000m from residences

KEY PAGES:
- Find data centers near any address: humzones.com/get-report
- Purchase a personalized area report: $14.99 at humzones.com/get-report
- Business plans for professionals: humzones.com/business (Starter $99/month, Professional $249/month, Unlimited $599/month)
- Submit a resident report: humzones.com/submit-report
- Retrieve past reports: humzones.com/my-report
- Methodology: humzones.com/methodology
- Legal disclaimer: humzones.com/disclaimer
- Contact: humzones.com/contact

IMPORTANT GUIDELINES:
- Always be helpful, friendly and conversational
- Never make specific health claims or say data centers cause illness or harm
- Always refer to figures as modeled estimates not measurements
- Use the term infrastructure exposure category not risk level
- If asked about a specific location encourage them to search at humzones.com/get-report
- If asked about purchasing guide them to humzones.com/get-report for individual reports or humzones.com/business for business plans
- If asked medical questions always recommend consulting a qualified medical professional
- Keep responses concise and conversational, 2 to 4 sentences maximum unless more detail is needed
- Never use em dashes in responses
- If you do not know something say so honestly and suggest they contact hello@humzones.com`;

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
    const incoming = Array.isArray(body.messages) ? body.messages : [];

    // Keep only valid user/assistant turns, cap at the last 10, and make sure
    // the history begins with a user message as the Anthropic API requires.
    let messages = incoming
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .map(m => ({ role: m.role, content: String(m.content).slice(0, 4000) }))
      .slice(-10);
    while (messages.length && messages[0].role !== "user") messages = messages.slice(1);

    if (messages.length === 0) {
      return res.status(400).json({ error: "No messages provided" });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error("ANTHROPIC_API_KEY is not configured");
      return res.status(503).json({ error: "The assistant is not configured yet. Please contact hello@humzones.com." });
    }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("Anthropic API error:", r.status, JSON.stringify(data));
      return res.status(502).json({ error: "The assistant could not respond right now. Please try again in a moment." });
    }

    const reply = Array.isArray(data.content)
      ? data.content.filter(b => b && b.type === "text").map(b => b.text).join("").trim()
      : "";

    res.status(200).json({ reply: reply || "Sorry, I did not catch that. Could you rephrase your question?" });
  } catch (error) {
    console.error("Chat handler error:", error && error.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
