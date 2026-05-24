// Standalone Node.js generator for Infrastructure Intelligence.
//
// Runs in GitHub Actions (not Vercel), so there is no 60-second function
// timeout. Calls the Anthropic API with web search, drafts the next issue
// HTML, and saves it to Airtable Newsletter_Issues with Status=Draft. A
// human flips Status to Ready in Airtable, then the Monday 09:00 UTC send
// step in the workflow POSTs to /api/newsletter with {"type":"send"} to
// deliver it.
//
// Required env vars:
//   ANTHROPIC_API_KEY
//   AIRTABLE_KEY (falls back to VITE_AIRTABLE_KEY for parity with Vercel)
//
// Uses Node's built-in fetch (Node 18+). No external dependencies.

const AIRTABLE_BASE = "app2FUPqq8VQSwQ64";
const ISSUES_TABLE  = "tbl3pKjNdgxJGYr0u";
const F = {
  Issue_Title:    "fld7MRgeaH0NCJBIs",
  Issue_Number:   "fldFU6TiYG0FmF9S8",
  Date_Published: "fldqlKArTdhOkKcYI",
  Subject_Line:   "fld57sICLof4DTx33",
  Content_HTML:   "fld4Ege6wX7ijRXiw",
  Status:         "fldKd6AJRxqqzeYJs",
};

const airtableKey  = () => process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY || "";
const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE}`;
const todayIso     = () => new Date().toISOString().slice(0, 10);

async function airtableListAll(tableId, params) {
  const key = airtableKey();
  let all = [], offset = null;
  do {
    const url = new URL(`${AIRTABLE_API}/${tableId}`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("returnFieldsByFieldId", "true");
    Object.keys(params || {}).forEach(k => url.searchParams.set(k, params[k]));
    if (offset) url.searchParams.set("offset", offset);
    const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`Airtable list failed: ${r.status} ${body}`);
    }
    const d = await r.json();
    all = all.concat(d.records || []);
    offset = d.offset || null;
  } while (offset);
  return all;
}

async function airtableCreate(tableId, fields) {
  const key = airtableKey();
  const r = await fetch(`${AIRTABLE_API}/${tableId}?returnFieldsByFieldId=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Airtable create failed: ${r.status} ${body}`);
  }
  return r.json();
}

function extractHeadlines(html) {
  if (!html) return [];
  const out = [];
  const headingRe = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/gi;
  let m;
  while ((m = headingRe.exec(html)) !== null) {
    const text = String(m[1] || "").replace(/<[^>]+>/g, "").trim();
    if (text) out.push(text);
  }
  const strongRe = /<(strong|b)[^>]*>([\s\S]*?)<\/(strong|b)>/gi;
  while ((m = strongRe.exec(html)) !== null) {
    const text = String(m[2] || "").replace(/<[^>]+>/g, "").trim();
    if (text && text.length < 140) out.push(text);
  }
  return Array.from(new Set(out)).slice(0, 30);
}

async function callAnthropic(body) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key":         process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type":      "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Anthropic API failed: ${r.status} ${text}`);
  }
  return r.json();
}

async function callWithRetry(payload) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'interleaved-thinking-2025-05-14'
      },
      body: JSON.stringify(payload)
    })
    if (res.status === 429 && attempt === 1) {
      console.log('[generate-newsletter] Rate limited, waiting 60s before retry...')
      await new Promise(r => setTimeout(r, 60000))
      continue
    }
    return res
  }
}

function joinResponseText(resp) {
  const parts = (resp && resp.content) || [];
  return parts
    .filter(p => p && p.type === "text" && typeof p.text === "string")
    .map(p => p.text)
    .join("\n")
    .trim();
}

async function main() {
  if (!airtableKey()) throw new Error("AIRTABLE_KEY (or VITE_AIRTABLE_KEY) not set");
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  console.log('[generate-newsletter] start', new Date().toISOString());

  // STEP 1: Pull previous issue headlines to seed the dedup hint.
  const existing = await airtableListAll(ISSUES_TABLE, {});
  const sent = existing
    .filter(r => (r.fields || {})[F.Status] === "Sent")
    .sort((a, b) => Number((b.fields || {})[F.Issue_Number] || 0) - Number((a.fields || {})[F.Issue_Number] || 0));
  const maxNumber = existing.reduce(
    (max, r) => Math.max(max, Number((r.fields || {})[F.Issue_Number] || 0)),
    0
  );
  const nextNumber = maxNumber + 1;
  const previousHtml = sent.length > 0 ? ((sent[0].fields || {})[F.Content_HTML] || "") : "";
  const headlines = extractHeadlines(previousHtml);
  const previousStories = headlines.length > 0
    ? headlines.join(" | ")
    : "No previous issues yet.";

  // STEP 2: Draft the issue HTML with web search enabled.
  const systemPrompt =
    "You are the editor of Infrastructure Intelligence, a weekly newsletter " +
    "published by HumZones (humzones.com) that translates data center and AI " +
    "infrastructure news into plain language for concerned residents and community " +
    "advocates.\n\n" +
    "STRICT CONTENT RULES, follow these without exception:\n" +
    "1. Cover ONLY topics directly related to: data centers, AI infrastructure, " +
    "data center power consumption, interconnection queue filings, utility " +
    "permits for data centers, data center cooling and water use, data center " +
    "noise complaints, data center zoning and planning decisions, hyperscale " +
    "facility announcements, colocation facility news, data center community " +
    "impact, AI compute infrastructure, data center energy grids.\n" +
    "2. Do NOT cover general AI news, cryptocurrency, general energy news, " +
    "politics, or any topic not directly tied to physical data center " +
    "infrastructure and its community impact.\n" +
    "3. Do NOT repeat or rewrite stories covered in previous issues. The previous " +
    "issue contained these headlines: " + previousStories + ". Find fresh stories only.\n" +
    "4. Every claim must be sourced from a real URL you found via web search. " +
    "Do not invent or hallucinate facts.\n" +
    "5. Translate all technical terms into plain language. Never assume readers " +
    "know what MW, PJM, interconnection queue, or colocation means. Explain " +
    "briefly inline.\n" +
    "6. Tone: factual, calm, authoritative, compassionate toward residents. " +
    "Not anti-data-center but believes communities deserve clear information. " +
    "Never make health claims.\n" +
    "7. Write every number in human scale. Example: instead of 500MW write " +
    "500MW, enough electricity to power approximately 375,000 average homes " +
    "continuously.\n\n" +
    "IMPORTANT: If you cannot find enough real data center news this week to fill " +
    "a section, write fewer items rather than padding with off-topic content or " +
    "invented stories. Quality over quantity.\n\n" +
    "CRITICAL: Never use em dashes (--) or en dashes (-) anywhere in the " +
    "output. Use a plain hyphen (-) or rewrite the sentence instead. " +
    "This is a hard requirement.";

  const userPrompt =
    "Search for the latest data center infrastructure news from this week " +
    "including interconnection queue filings, hyperscale announcements, " +
    "planning board decisions, and community impact stories. Then write " +
    "the complete Infrastructure Intelligence newsletter issue in the HTML " +
    "format specified.\n\n" +
    "EDITOR'S NOTE (2 to 3 sentences): Why this week's developments matter for " +
    "residents. Personal and direct.\n\n" +
    "WHAT FILED THIS WEEK: 2 to 4 items from interconnection queues, utility permit " +
    "filings or planning board applications found via web search. For each item: " +
    "location, what was filed, what it means for nearby residents in plain " +
    "language, and the source URL in parentheses. If fewer than 2 real filings " +
    "were found this week write only what you found. Do not pad.\n\n" +
    "FACILITIES IN THE NEWS: 2 to 4 news items from the past 7 days. For each: " +
    "company or facility name, what happened, community impact in plain language, " +
    "source URL in parentheses. Data center topics only. No general AI news.\n\n" +
    "BY THE NUMBERS: Exactly 3 statistics from this week's news. Format: " +
    "'[Number in plain language], [what it means for a person].' Example: " +
    "'500MW, enough electricity to continuously power 375,000 average homes, " +
    "directed to a single new facility in Loudoun County.'\n\n" +
    "COMMUNITY SPOTLIGHT: 2 to 3 sentences about resident actions, community " +
    "meetings, planning board hearings or awareness efforts related to data center " +
    "development this week. If no specific news was found write a brief note about " +
    "the growing resident awareness movement with a link to " +
    "humzones.com/submit-report.\n\n" +
    "WHAT TO WATCH: 2 to 3 specific things to monitor next week based on this week's " +
    "developments. Be specific. Name the company, county or filing if possible.\n\n" +
    "Format the entire newsletter as clean HTML suitable for email. Use ONLY " +
    "inline styles. Max-width 600px. No external CSS. No images. Mobile-friendly.\n\n" +
    "Color scheme inline:\n" +
    "- Background: #ffffff\n" +
    "- Headings: color:#1e293b; font-family:Arial,sans-serif; font-weight:bold\n" +
    "- Section labels: color:#f97316; font-size:11px; font-weight:bold; " +
    "text-transform:uppercase; letter-spacing:1px\n" +
    "- Body text: color:#475569; font-family:Arial,sans-serif; font-size:15px; " +
    "line-height:1.6\n" +
    "- Horizontal rules between sections: border:none; " +
    "border-top:1px solid #e2e8f0; margin:24px 0\n" +
    "- Source URLs: color:#94a3b8; font-size:12px\n" +
    "- Dark navy header at top: background:#1e293b; padding:24px; text-align:center\n" +
    "- Header text 'Infrastructure Intelligence': color:#ffffff; font-size:20px; " +
    "font-weight:bold; font-family:Arial,sans-serif\n" +
    "- Header subtext 'Issue #" + nextNumber + " | " + todayIso() + "': " +
    "color:#f97316; font-size:13px\n\n" +
    "Start the HTML with the dark navy header. End with a light grey footer " +
    "containing 'Infrastructure Intelligence by HumZones | humzones.com' and " +
    "an unsubscribe placeholder: [UNSUBSCRIBE_LINK]";

  console.log('[generate-newsletter] calling Anthropic API', new Date().toISOString());
  const draftRes = await callWithRetry({
    model: "claude-sonnet-4-6",
    max_tokens: 2500,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  if (!draftRes.ok) {
    const text = await draftRes.text().catch(() => "");
    throw new Error(`Anthropic API failed: ${draftRes.status} ${text}`);
  }
  const draftResp = await draftRes.json();
  console.log('[generate-newsletter] Anthropic response received', new Date().toISOString());

  const draftHtmlRaw = joinResponseText(draftResp);
  const draftHtml = draftHtmlRaw
    .replace(/^```html\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  if (!draftHtml) {
    throw new Error("Empty draft from Anthropic");
  }

  const cleanHTML = draftHtml
    .replace(/\u2014/g, '-')   // em dash to hyphen
    .replace(/\u2013/g, '-')   // en dash to hyphen
    .replace(/&mdash;/g, '-')  // HTML entity em dash
    .replace(/&ndash;/g, '-')  // HTML entity en dash
    .replace(/&#8212;/g, '-')  // numeric entity em dash
    .replace(/&#8211;/g, '-'); // numeric entity en dash

  // STEP 3: Generate the issue title and subject line.
  const titleResp = await callAnthropic({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system: "You write compelling email subject lines and newsletter titles.",
    messages: [{
      role: "user",
      content:
        "Based on this newsletter content, write:\n" +
        "1. Issue_Title: A compelling 6 to 8 word title capturing the most important " +
        "story this week. No clickbait. Factual and specific.\n" +
        "2. Subject_Line: An email subject line under 48 characters that will get " +
        "opened. Can reference a specific number or location from the issue.\n\n" +
        "Return ONLY a JSON object with exactly two keys: title and subject.\n" +
        "No markdown, no explanation, just the JSON.\n\n" +
        "Newsletter content: " + cleanHTML.slice(0, 1000),
    }],
  });
  const titleText = joinResponseText(titleResp);
  let issueTitle  = "Infrastructure Intelligence Issue " + nextNumber;
  let subjectLine = "This week in data center news";
  try {
    const jsonStart = titleText.indexOf("{");
    const jsonEnd   = titleText.lastIndexOf("}");
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const parsed = JSON.parse(titleText.slice(jsonStart, jsonEnd + 1));
      if (parsed && typeof parsed.title === "string" && parsed.title.trim()) {
        issueTitle = parsed.title.trim();
      }
      if (parsed && typeof parsed.subject === "string" && parsed.subject.trim()) {
        subjectLine = parsed.subject.trim().slice(0, 100);
      }
    }
  } catch (e) {
    console.warn("[generate-newsletter] could not parse title JSON, using fallbacks:", e && e.message);
  }

  issueTitle = issueTitle
    .replace(/\u2014/g, '-')
    .replace(/\u2013/g, '-')
    .replace(/&mdash;/g, '-')
    .replace(/&ndash;/g, '-')
    .replace(/&#8212;/g, '-')
    .replace(/&#8211;/g, '-');
  subjectLine = subjectLine
    .replace(/\u2014/g, '-')
    .replace(/\u2013/g, '-')
    .replace(/&mdash;/g, '-')
    .replace(/&ndash;/g, '-')
    .replace(/&#8212;/g, '-')
    .replace(/&#8211;/g, '-');

  // STEP 4: Save as Draft. The send step picks up only issues that an
  // editor has flipped to Status=Ready in Airtable.
  console.log('[generate-newsletter] saving to Airtable', new Date().toISOString());
  const created = await airtableCreate(ISSUES_TABLE, {
    [F.Issue_Title]:    issueTitle,
    [F.Issue_Number]:   nextNumber,
    [F.Date_Published]: todayIso(),
    [F.Subject_Line]:   subjectLine,
    [F.Content_HTML]:   cleanHTML,
    [F.Status]:         "Draft",
  });

  console.log('[generate-newsletter] done', new Date().toISOString());
  console.log('SUCCESS: Issue saved to Airtable as Draft', JSON.stringify({
    id: created && created.id,
    issueNumber: nextNumber,
    issueTitle,
    subjectLine,
  }));
}

main().catch((e) => {
  console.error('FAILED:', e && e.message);
  process.exit(1);
});
