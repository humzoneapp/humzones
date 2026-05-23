// Monthly archive job for Business_Reports. Runs from a Vercel cron (see
// vercel.json) at midnight UTC on the 1st of every month, but can also be
// hit on demand via GET/POST. Pages through every Business_Reports row,
// gathers the IDs whose Date_Generated is older than 12 months, and bulk
// deletes them 10 at a time, which is the Airtable limit per request.
const BASE  = "app2FUPqq8VQSwQ64";
const TABLE = "tblFPqxXwxgcuTZhM"; // Business_Reports
const DATE_FIELD_ID = "fldJkngB5XzHQzvYu"; // Date_Generated

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const AIRTABLE_KEY = process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY;
  if (!AIRTABLE_KEY) {
    return res.status(500).json({ error: "Server missing Airtable key" });
  }
  const headers = {
    Authorization: "Bearer " + AIRTABLE_KEY,
    "Content-Type": "application/json",
  };

  try {
    // Anything strictly before this date is older than 12 months and gets
    // archived. We store dates as YYYY-MM-DD strings, so a plain string
    // compare via Airtable's IS_BEFORE works.
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 12);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    const formula = encodeURIComponent(
      "IS_BEFORE({Date_Generated}, '" + cutoffIso + "')"
    );

    // Page through every matching record and collect record IDs.
    const ids = [];
    let offset = null;
    do {
      const url =
        "https://api.airtable.com/v0/" + BASE + "/" + TABLE +
        "?filterByFormula=" + formula +
        "&pageSize=100" +
        "&fields[]=" + encodeURIComponent(DATE_FIELD_ID) +
        "&returnFieldsByFieldId=true" +
        (offset ? "&offset=" + encodeURIComponent(offset) : "");
      const r = await fetch(url, { headers });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        console.error("[archive-old-reports] list failed:", r.status, err);
        return res.status(500).json({ error: "List failed: " + r.status });
      }
      const data = await r.json();
      for (const rec of (data.records || [])) ids.push(rec.id);
      offset = data.offset || null;
    } while (offset);

    console.log("[archive-old-reports] cutoff " + cutoffIso + " matched " + ids.length + " record(s)");

    // Bulk delete 10 at a time. Airtable's bulk delete takes record IDs as
    // repeated `records[]=` query params, not a JSON body, so we build the
    // URL accordingly.
    let deleted = 0;
    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10);
      const qs = batch.map(id => "records[]=" + encodeURIComponent(id)).join("&");
      const url = "https://api.airtable.com/v0/" + BASE + "/" + TABLE + "?" + qs;
      const r = await fetch(url, { method: "DELETE", headers });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        console.error("[archive-old-reports] batch delete failed:", r.status, err);
        return res.status(500).json({
          error: "Batch delete failed at offset " + i + ": " + r.status,
          deleted,
        });
      }
      const data = await r.json().catch(() => ({}));
      deleted += (data.records || []).length || batch.length;
      console.log("[archive-old-reports] deleted batch " + (i / 10 + 1) + " (" + batch.length + " records)");
    }

    console.log("[archive-old-reports] done, deleted " + deleted + " record(s) older than " + cutoffIso);
    return res.status(200).json({ success: true, deleted, cutoff: cutoffIso });
  } catch (error) {
    console.error("[archive-old-reports] threw:", {
      message: error && error.message,
      code:    error && error.code,
      stack:   error && error.stack,
    });
    return res.status(500).json({ error: (error && error.message) || "Archive failed" });
  }
};
