/*
 * SITEMAP - DO NOT SUBMIT TO GOOGLE SEARCH CONSOLE YET
 *
 * Submit only when ALL of the following are complete:
 * 1. Full site testing completed with no broken pages
 * 2. All Stripe payment links switched to live mode
 * 3. Facility database expanded to production volume
 * 4. All placeholder content replaced with real content
 *
 * WHEN READY TO SUBMIT:
 * 1. Verify sitemap: visit https://humzones.com/api/sitemap.xml
 * 2. Set up Google Search Console: https://search.google.com/search-console
 * 3. Add property humzones.com and verify via DNS TXT record
 * 4. Submit sitemap URL: https://humzones.com/api/sitemap.xml
 * 5. Use URL Inspection tool to request indexing for key pages
 * 6. Also submit to Bing: https://www.bing.com/webmasters
 */

// Dynamic XML sitemap served at /api/sitemap (and at /api/sitemap.xml and
// /sitemap.xml via the rewrites in vercel.json). Emits the canonical list of
// public URLs plus one entry per Sent Newsletter_Issues record.
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
  { loc: "https://humzones.com/",              changefreq: "daily",   priority: "1.0" },
  { loc: "https://humzones.com/get-report",    changefreq: "weekly",  priority: "0.9" },
  { loc: "https://humzones.com/business",      changefreq: "weekly",  priority: "0.9" },
  { loc: "https://humzones.com/newsletter",    changefreq: "daily",   priority: "0.8" },
  { loc: "https://humzones.com/glossary",      changefreq: "monthly", priority: "0.8" },
  { loc: "https://humzones.com/learn",         changefreq: "monthly", priority: "0.8" },
  { loc: "https://humzones.com/why-it-matters",changefreq: "monthly", priority: "0.8" },
  { loc: "https://humzones.com/submit-report", changefreq: "monthly", priority: "0.7" },
  { loc: "https://humzones.com/donate",        changefreq: "monthly", priority: "0.6" },
  { loc: "https://humzones.com/about",         changefreq: "monthly", priority: "0.5" },
  { loc: "https://humzones.com/methodology",   changefreq: "monthly", priority: "0.5" },
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
  const baseUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${ISSUES_TABLE}`;
  const all = [];
  let cursor = null;
  do {
    const u = new URL(baseUrl);
    u.searchParams.set("filterByFormula", decodeURIComponent(formula));
    u.searchParams.set("pageSize", "100");
    u.searchParams.set("returnFieldsByFieldId", "true");
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
          loc:        `https://humzones.com/newsletter/${num}`,
          changefreq: "never",
          priority:   "0.7",
          lastmod,
        };
      })
      .filter(Boolean)
      .sort((a, b) => {
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
        if (u.lastmod)    entry += '    <lastmod>'    + xmlEscape(u.lastmod)    + '</lastmod>\n';
        if (u.changefreq) entry += '    <changefreq>' + xmlEscape(u.changefreq) + '</changefreq>\n';
        if (u.priority)   entry += '    <priority>'   + xmlEscape(u.priority)   + '</priority>\n';
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
