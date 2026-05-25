// Dynamic XML sitemap served at /api/sitemap.xml.
//
// Returns a sitemap.xml with the static high-value pages plus one entry per
// Sent Newsletter_Issues record. After deploy, submit
//   https://humzones.com/sitemap.xml
// to Google Search Console so the dynamic newsletter issues get indexed.
//
// The Vercel rewrite in vercel.json sends every non-/api/ path to
// index.html, so we expose this endpoint under /api/ and let Search
// Console / robots.txt point at the underlying /api/sitemap path. If you
// want the URL to look like /sitemap.xml you can add a rewrite entry
// later: { "source": "/sitemap.xml", "destination": "/api/sitemap" }.
//
// Required env vars (already configured in Vercel):
//   AIRTABLE_KEY (falls back to VITE_AIRTABLE_KEY)

const AIRTABLE_BASE = "app2FUPqq8VQSwQ64";
const ISSUES_TABLE  = "tbl3pKjNdgxJGYr0u";
const ISSUE_F = {
  Issue_Number:   "fldFU6TiYG0FmF9S8",
  Date_Published: "fldqlKArTdhOkKcYI",
  Status:         "fldKd6AJRxqqzeYJs",
};

const airtableKey = () => process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY || "";

const STATIC_URLS = [
  { loc: "https://humzones.com/",               priority: "1.0" },
  { loc: "https://humzones.com/newsletter",     priority: "0.9" },
  { loc: "https://humzones.com/glossary",       priority: "0.8" },
  { loc: "https://humzones.com/learn",          priority: "0.8" },
  { loc: "https://humzones.com/submit-report",  priority: "0.7" },
  { loc: "https://humzones.com/donate",         priority: "0.6" },
];

function xmlEscape(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function fetchSentIssues() {
  const key = airtableKey();
  if (!key) return [];
  const formula = encodeURIComponent("{Status} = 'Sent'");
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${ISSUES_TABLE}` +
    `?filterByFormula=${formula}&pageSize=100&returnFieldsByFieldId=true`;
  const all = [];
  let cursor = null;
  do {
    const u = new URL(url);
    if (cursor) u.searchParams.set("offset", cursor);
    const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`Airtable list failed: ${r.status} ${body}`);
    }
    const d = await r.json();
    all.push(...(d.records || []));
    cursor = d.offset || null;
  } while (cursor);
  return all;
}

module.exports = async (req, res) => {
  try {
    const issues = await fetchSentIssues();
    const issueUrls = issues
      .map(r => {
        const f = r.fields || {};
        const num = f[ISSUE_F.Issue_Number];
        if (num === undefined || num === null || num === "") return null;
        const lastmod = f[ISSUE_F.Date_Published] || "";
        return {
          loc:      `https://humzones.com/newsletter/${num}`,
          priority: "0.7",
          lastmod,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
        // newest first by lastmod when both present
        if (a.lastmod && b.lastmod) return b.lastmod.localeCompare(a.lastmod);
        return 0;
      });

    const all = [...STATIC_URLS, ...issueUrls];

    const body =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      all.map(u => {
        let entry = '  <url>\n';
        entry += '    <loc>' + xmlEscape(u.loc) + '</loc>\n';
        if (u.lastmod) entry += '    <lastmod>' + xmlEscape(u.lastmod) + '</lastmod>\n';
        if (u.priority) entry += '    <priority>' + xmlEscape(u.priority) + '</priority>\n';
        entry += '  </url>';
        return entry;
      }).join('\n') +
      '\n</urlset>\n';

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=600, s-maxage=600");
    res.status(200).send(body);
  } catch (e) {
    console.error("[sitemap] failed:", e && e.message);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.status(500).send(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<error>' + xmlEscape((e && e.message) || "Sitemap generation failed") + '</error>\n'
    );
  }
};
