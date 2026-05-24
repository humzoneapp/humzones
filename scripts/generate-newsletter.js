// Standalone Node.js generator for Infrastructure Intelligence.
//
// Runs in GitHub Actions (not Vercel), so there is no 60-second function
// timeout. Asks Claude for a plain-text outline of the next issue,
// parses it into structured sections, and builds the email HTML locally
// with a fixed wrapper. Saves the result to Airtable Newsletter_Issues
// with Status=Draft. A human flips Status to Ready in Airtable, then
// the send step in the workflow POSTs to /api/newsletter with
// {"type":"send"} to deliver it.
//
// Why plain-text in / HTML out:
//   - The wrapper is fixed at ~5-15KB, so Gmail never clips the email
//     regardless of model verbosity.
//   - Removes an entire class of bugs around the model emitting preamble
//     text or markdown fences before the HTML.
//
// Required env vars:
//   ANTHROPIC_API_KEY
//   AIRTABLE_KEY (falls back to VITE_AIRTABLE_KEY for parity with Vercel)
//   NEWSLETTER_TYPE: 'filings' (default) or 'news'

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

const NEWSLETTER_TYPE = process.env.NEWSLETTER_TYPE || 'filings';

const TYPE_CONFIG = {
  filings: {
    titlePrefix:       'What Filed This Week',
    storiesLabel:      'What Filed This Week',
    storiesHeader:     'WHAT FILED THIS WEEK',
    includesNumbers:   true,
    includesSpotlight: false,
    searchQuery:       'data center interconnection queue utility permit planning board filing 2026',
    systemFocus:       'Focus ONLY on interconnection queue filings, utility permit applications and planning board decisions. No general data center news.',
    templateBody:
      "EDITOR NOTE\n" +
      "[2 sentences about why this week's filings matter for residents]\n\n" +
      "WHAT FILED THIS WEEK\n" +
      "[Story 1 headline]\n" +
      "[2-3 sentences. Source: URL]\n\n" +
      "[Story 2 headline]\n" +
      "[2-3 sentences. Source: URL]\n\n" +
      "BY THE NUMBERS\n" +
      "- [stat 1 in plain language]\n" +
      "- [stat 2 in plain language]\n" +
      "- [stat 3 in plain language]\n\n" +
      "WHAT TO WATCH\n" +
      "- [item 1]\n" +
      "- [item 2]\n",
  },
  news: {
    titlePrefix:       'Facilities in the News',
    storiesLabel:      'Facilities in the News',
    storiesHeader:     'FACILITIES IN THE NEWS',
    includesNumbers:   false,
    includesSpotlight: true,
    searchQuery:       'data center announcement expansion community opposition residents news 2026',
    systemFocus:       'Focus ONLY on data center facility announcements, expansions and community impact stories. No filing or regulatory content.',
    templateBody:
      "EDITOR NOTE\n" +
      "[2 sentences about why this week's developments matter for residents]\n\n" +
      "FACILITIES IN THE NEWS\n" +
      "[Story 1 headline]\n" +
      "[2-3 sentences. Source: URL]\n\n" +
      "[Story 2 headline]\n" +
      "[2-3 sentences. Source: URL]\n\n" +
      "COMMUNITY SPOTLIGHT\n" +
      "[2 sentences about resident actions, community meetings, or awareness efforts]\n\n" +
      "WHAT TO WATCH\n" +
      "- [item 1]\n" +
      "- [item 2]\n",
  },
};

function stripDashes(s) {
  return String(s || "")
    .replace(/\u2014/g, '-')        // em dash
    .replace(/\u2013/g, '-')        // en dash
    .replace(/&mdash;/g, '-')
    .replace(/&ndash;/g, '-')
    .replace(/&#8212;/g, '-')
    .replace(/&#8211;/g, '-');
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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
      console.log('[generate-newsletter] Rate limited, waiting 90s before retry...')
      await new Promise(r => setTimeout(r, 90000))
      continue
    }
    return res
  }
}

// Parse Claude's plain-text outline into structured sections.
function parseNewsletterText(text, cfg) {
  const knownHeaders = new Set([
    'EDITOR NOTE',
    'WHAT FILED THIS WEEK',
    'FACILITIES IN THE NEWS',
    'BY THE NUMBERS',
    'COMMUNITY SPOTLIGHT',
    'WHAT TO WATCH',
  ]);

  const lines = text.split('\n');

  // Pull SUBJECT: and TITLE: from anywhere in the text.
  let subject = '';
  let title = '';
  for (const line of lines) {
    const m1 = line.match(/^\s*SUBJECT:\s*(.+)$/i);
    if (m1 && !subject) subject = m1[1].trim();
    const m2 = line.match(/^\s*TITLE:\s*(.+)$/i);
    if (m2 && !title) title = m2[1].trim();
  }

  // Walk the lines, splitting into sections at each known header.
  const sections = {};
  let currentHeader = null;
  let buffer = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (knownHeaders.has(trimmed)) {
      if (currentHeader) sections[currentHeader] = buffer;
      currentHeader = trimmed;
      buffer = [];
    } else if (currentHeader) {
      buffer.push(line);
    }
  }
  if (currentHeader) sections[currentHeader] = buffer;

  function paragraph(ls) {
    return (ls || []).map(l => l.trim()).filter(Boolean).join(' ');
  }

  function bullets(ls) {
    const clean = (ls || []).map(l => l.trim()).filter(Boolean);
    const bulleted = clean.filter(l => /^[-*•]\s+/.test(l));
    const picked = bulleted.length ? bulleted : clean;
    return picked.map(l => l.replace(/^[-*•]\s+/, ''));
  }

  function stories(ls) {
    const blocks = [];
    let block = [];
    for (const line of (ls || [])) {
      if (line.trim() === '') {
        if (block.length) { blocks.push(block); block = []; }
      } else {
        block.push(line.trim());
      }
    }
    if (block.length) blocks.push(block);
    return blocks.map(b => {
      const headline = b[0] || '';
      const rest = b.slice(1).join(' ');
      let body = rest;
      let source = '';
      const srcMatch = rest.match(/Source:\s*(.+?)\s*$/i);
      if (srcMatch) {
        source = srcMatch[1].trim();
        body = rest.replace(/\s*Source:\s*.+?\s*$/i, '').trim();
      }
      return { headline, body, source };
    });
  }

  return {
    subject,
    title,
    editorNote:         paragraph(sections['EDITOR NOTE']),
    stories:            stories(sections[cfg.storiesHeader]),
    byTheNumbers:       bullets(sections['BY THE NUMBERS']),
    communitySpotlight: paragraph(sections['COMMUNITY SPOTLIGHT']),
    whatToWatch:        bullets(sections['WHAT TO WATCH']),
  };
}

// Build the final HTML using a fixed wrapper. Inline styles apply only
// on the wrapper elements, keeping the output ~5-15KB instead of the
// variable model-emitted HTML we used to get.
function buildNewsletterHTML(parsed, issueNumber, date, cfg) {
  const labelStyle = 'color:#f97316;font-size:11px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;';
  const headStyle  = 'color:#1e293b;font-size:16px;margin:16px 0 8px;';
  const bodyStyle  = 'color:#475569;font-size:15px;line-height:1.6;';
  const srcStyle   = 'color:#94a3b8;font-size:12px;';
  const ruleStyle  = 'border:none;border-top:1px solid #e2e8f0;margin:24px 0;';
  const listStyle  = bodyStyle + 'padding-left:20px;';

  const sectionLabel = (text) => `<div style="${labelStyle}">${escapeHtml(text)}</div>`;

  const blocks = [];

  if (parsed.editorNote) {
    blocks.push(
      sectionLabel("Editor's Note") +
      `<p style="${bodyStyle}">${escapeHtml(parsed.editorNote)}</p>`
    );
  }

  if (parsed.stories.length) {
    const items = parsed.stories.map(s => {
      const headline = `<h3 style="${headStyle}">${escapeHtml(s.headline)}</h3>`;
      const body     = s.body   ? `<p style="${bodyStyle}">${escapeHtml(s.body)}</p>` : '';
      const source   = s.source ? `<p style="${srcStyle}">Source: ${escapeHtml(s.source)}</p>` : '';
      return headline + body + source;
    }).join('');
    blocks.push(sectionLabel(cfg.storiesLabel) + items);
  }

  if (cfg.includesNumbers && parsed.byTheNumbers.length) {
    const items = parsed.byTheNumbers.map(n => `<li>${escapeHtml(n)}</li>`).join('');
    blocks.push(sectionLabel("By the Numbers") + `<ul style="${listStyle}">${items}</ul>`);
  }

  if (cfg.includesSpotlight && parsed.communitySpotlight) {
    blocks.push(
      sectionLabel("Community Spotlight") +
      `<p style="${bodyStyle}">${escapeHtml(parsed.communitySpotlight)}</p>`
    );
  }

  if (parsed.whatToWatch.length) {
    const items = parsed.whatToWatch.map(w => `<li>${escapeHtml(w)}</li>`).join('');
    blocks.push(sectionLabel("What to Watch") + `<ul style="${listStyle}">${items}</ul>`);
  }

  const inner = blocks.join(`<hr style="${ruleStyle}">`);

  return (
    '<div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif;">' +
      '<div style="background:#1e293b;padding:24px;text-align:center;">' +
        '<div style="color:#ffffff;font-size:22px;font-weight:bold;">Infrastructure Intelligence</div>' +
        `<div style="color:#f97316;font-size:13px;margin-top:4px;">Issue #${issueNumber} | ${escapeHtml(date)}</div>` +
      '</div>' +
      `<div style="padding:24px;">${inner}</div>` +
    '</div>'
  );
}

async function main() {
  if (!airtableKey()) throw new Error("AIRTABLE_KEY (or VITE_AIRTABLE_KEY) not set");
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const cfg = TYPE_CONFIG[NEWSLETTER_TYPE];
  if (!cfg) {
    throw new Error("Unknown NEWSLETTER_TYPE: " + NEWSLETTER_TYPE + ". Expected 'filings' or 'news'.");
  }

  console.log('[generate-newsletter] start', new Date().toISOString());
  console.log('[generate-newsletter] type:', NEWSLETTER_TYPE);

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

  // STEP 2: Draft the issue as a plain-text outline.
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
    "FOCUS: " + cfg.systemFocus + "\n\n" +
    "CRITICAL: Never use em dashes (--) or en dashes (-) anywhere in the " +
    "output. Use a plain hyphen (-) or rewrite the sentence instead.\n\n" +
    "OUTPUT FORMAT: Respond ONLY with the plain-text outline below. No HTML, " +
    "no markdown code fences, no preamble, no thinking aloud. Start your " +
    "response with the SUBJECT: line and end with the last bullet of WHAT TO " +
    "WATCH. Do not include anything else.";

  const userPrompt =
    "Search the web using these terms: '" + cfg.searchQuery + "'. Find fresh " +
    "stories from this week. Then write the next Infrastructure Intelligence " +
    "issue in this EXACT plain-text format:\n\n" +
    "SUBJECT: [subject line under 48 chars]\n" +
    "TITLE: [6-8 word title]\n\n" +
    cfg.templateBody +
    "\nRules:\n" +
    "- Replace each [bracketed placeholder] with real content.\n" +
    "- Keep each story body to 2-3 sentences.\n" +
    "- Include the source URL at the end of each story body as 'Source: <URL>'.\n" +
    "- Output NOTHING before SUBJECT: and NOTHING after the last bullet line.";

  console.log('[generate-newsletter] waiting 10s before API call to avoid rate limits...');
  await new Promise(r => setTimeout(r, 10000));
  console.log('[generate-newsletter] calling Anthropic API', new Date().toISOString());

  const draftRes = await callWithRetry({
    model: "claude-sonnet-4-6",
    max_tokens: 1200,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  if (!draftRes.ok) {
    const text = await draftRes.text().catch(() => "");
    throw new Error(`Anthropic API failed: ${draftRes.status} ${text}`);
  }
  const data = await draftRes.json();
  console.log('[generate-newsletter] Anthropic response received', new Date().toISOString());

  // Concat every text block from the response, then strip any narration
  // the model emitted before the actual outline. This is the plain-text
  // analogue of the old "strip text before first <" HTML guard.
  const allTextBlocks = (data.content || [])
    .filter(b => b && b.type === 'text')
    .map(b => b.text)
    .join('');

  let outline = allTextBlocks;

  // Strip markdown code fences if Claude wrapped the outline anyway.
  const fenceMatch = outline.match(/```[a-zA-Z]*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    outline = fenceMatch[1];
  }

  // Strip everything before the first SUBJECT: or EDITOR NOTE marker.
  let firstMarker = outline.search(/SUBJECT:/i);
  if (firstMarker < 0) firstMarker = outline.search(/EDITOR NOTE/i);
  if (firstMarker > 0) {
    const stripped = outline.substring(0, firstMarker).trim();
    if (stripped) {
      console.log('[generate-newsletter] Stripping', firstMarker,
        'chars of pre-content text:', stripped.substring(0, 200));
    }
    outline = outline.substring(firstMarker);
  }

  outline = outline.trim();
  if (!outline) {
    throw new Error("Empty draft from Anthropic");
  }
  if (!/SUBJECT:|EDITOR NOTE/i.test(outline)) {
    throw new Error("No valid newsletter outline found in response. Got: " +
      outline.substring(0, 200));
  }

  // STEP 3: Parse the outline and clean every text field.
  const parsed = parseNewsletterText(outline, cfg);
  const clean = {
    subject:            stripDashes(parsed.subject),
    title:              stripDashes(parsed.title),
    editorNote:         stripDashes(parsed.editorNote),
    stories:            parsed.stories.map(s => ({
                          headline: stripDashes(s.headline),
                          body:     stripDashes(s.body),
                          source:   stripDashes(s.source),
                        })),
    byTheNumbers:       parsed.byTheNumbers.map(stripDashes),
    communitySpotlight: stripDashes(parsed.communitySpotlight),
    whatToWatch:        parsed.whatToWatch.map(stripDashes),
  };

  // STEP 4: Build the final HTML email using the fixed wrapper.
  const cleanHTML = buildNewsletterHTML(clean, nextNumber, todayIso(), cfg);

  // STEP 5: Title and subject come straight from the outline. Fall back
  // to defaults if the model omitted them.
  let issueTitle  = clean.title  || ("Infrastructure Intelligence Issue " + nextNumber);
  let subjectLine = (clean.subject || "This week in data center news").slice(0, 100);
  issueTitle  = stripDashes(cfg.titlePrefix + " - " + issueTitle);
  subjectLine = stripDashes(subjectLine);

  // STEP 6: Save as Draft. The send step picks up only issues that an
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
    htmlBytes: Buffer.byteLength(cleanHTML, 'utf8'),
  }));
}

main().catch((e) => {
  console.error('FAILED:', e && e.message);
  process.exit(1);
});
