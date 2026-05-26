/*
 * Import facility-level Power_MW data from SEC EDGAR 10-K filings
 * for a curated list of public data center operators and crypto
 * miners. The same script is reusable for any state because SEC
 * filings cover the operator's entire footprint, not just one
 * region.
 *
 * For each target ticker (or hardcoded CIK for delisted companies):
 *   1. Look up CIK via company_tickers.json (cached locally)
 *   2. Fetch the most recent 10-K via the SEC submissions endpoint
 *   3. Download and cache the primary filing document
 *   4. Strip the HTML to plain text
 *   5. Send to Claude for structured extraction of per-facility
 *      {name, city, state, power_mw, capacity_type, quote}
 *   6. Verify the verbatim quote actually appears in the filing
 *      (rejects hallucinated values)
 *   7. Match each verified extraction to a Facilities row by
 *      Company + city + name token similarity
 *   8. Write Power_MW, Power_MW_Source (SEC document URL),
 *      Power_MW_Type = "SEC Filing", Power_MW_Last_Verified = today.
 *
 * The Risk_Level gating lives in recalculate-facilities.js: once
 * Power_MW_Type is "SEC Filing", that script will populate the
 * Risk_Level the next time it runs.
 *
 * Required env: ANTHROPIC_API_KEY, AIRTABLE_KEY
 *
 * Usage:
 *   AIRTABLE_KEY=xxx ANTHROPIC_API_KEY=yyy \
 *     node scripts/sec-edgar-import.js
 *
 * Flags:
 *   --dry-run         do not write to Airtable
 *   --ticker=XYZ      limit to one ticker (e.g. --ticker=RIOT)
 *   --cik=NNNN        limit to one CIK
 *   --no-extract      download filings only, skip Claude extraction
 *   --cache-dir=DIR   override cache location (default .sec-cache)
 */

import fs from 'node:fs'
import path from 'node:path'

const AIRTABLE_BASE  = 'app2FUPqq8VQSwQ64'
const FACILITIES_TBL = 'tblvojPdS6kwMxsex'
const PENDING_TBL    = 'tblPB5eHmEBujI4Iq'

const F_FAC = {
  Name:                   'fldirgBJAsorDO4Hm',
  Company:                'fld8602RjMYU6rUcy',
  City:                   'fldOmKby6o64HCDZM',
  State_Region:           'fld1euUumpEZCUtZw',
  Country:                'fldIwxc1fkf0xuQCC',
  Power_MW:               'fldfHsnHRCAo4jc8G',
  Power_MW_Source:        'flduWAPM1zmYRA4N5',
  Power_MW_Type:          'fldcdZxN13kSjApm6',
  Power_MW_Last_Verified: 'fldNt3KaUeCeYG3zi',
}

const F_PENDING = {
  Name:                   'fldvasZvuq88CKcov',
  Company:                'fldGrOrMDrMyhTYQR',
  City:                   'fldAtKp2mYqY6iCbB',
  State_Region:           'fldK5ksYKMz07RWa4',
  Country:                'fldY0BYtYi6pdwpu0',
  Power_MW:               'fld2s77YTUbCVf9kr',
  Power_MW_Source:        'fldUJliZG9fV34CYe',
  Power_MW_Type:          'fldhDyx85QgHm2QLf',
  Power_MW_Last_Verified: 'fldIOg8DCzxWlDXCc',
}

// Field-set abstraction so the same matching/writing pipeline can
// target either table without duplicating logic.
const TABLES = [
  { tableId: FACILITIES_TBL, name: 'Facilities', fields: F_FAC },
  { tableId: PENDING_TBL,    name: 'Pending',    fields: F_PENDING },
]

// Target operators. Use ticker for currently-public companies; CIK
// is required for delisted ones (CyrusOne, QTS) whose tickers no
// longer resolve via company_tickers.json. The company string must
// match what appears in the Airtable Facilities.Company column.
const TARGETS = [
  // Colocation REITs (still public)
  { ticker: 'EQIX', company: 'Equinix' },
  { ticker: 'DLR',  company: 'Digital Realty' },
  { ticker: 'IRM',  company: 'Iron Mountain' },

  // Public crypto miners
  { ticker: 'RIOT', company: 'Riot Platforms' },
  { ticker: 'MARA', company: 'MARA Holdings' },
  { ticker: 'CORZ', company: 'Core Scientific' },
  { ticker: 'IREN', company: 'IREN' },
  { ticker: 'HUT',  company: 'Hut 8 Mining' },
  { ticker: 'CIFR', company: 'Cipher Mining' },

  // De-listed but historical 10-Ks remain public on EDGAR
  { cik: '1553023', company: 'CyrusOne' },
  { cik: '1577368', company: 'QTS Realty Trust' },

  // Recently public (CoreWeave IPO 2025)
  { ticker: 'CRWV', company: 'CoreWeave' },

  // xAI is private; no SEC filings to import.
]

const UA = 'HumZones Registry hello@humzones.com'
const ANTHROPIC_MODEL = 'claude-sonnet-4-6'
const ANTHROPIC_MAX_TOKENS = 8000
const FILING_CHAR_LIMIT = 300000  // ~75k tokens, safely inside Sonnet's 200k window
const SEC_RATE_DELAY_MS = 200
const CLAUDE_RATE_DELAY_MS = 1000
const MATCH_SCORE_MIN = 0.4

const argv = process.argv.slice(2)
const DRY_RUN = argv.includes('--dry-run')
const NO_EXTRACT = argv.includes('--no-extract')
const TICKER_FILTER = (argv.find(a => a.startsWith('--ticker=')) || '').split('=')[1] || null
const CIK_FILTER = (argv.find(a => a.startsWith('--cik=')) || '').split('=')[1] || null
const CACHE_DIR = (argv.find(a => a.startsWith('--cache-dir=')) || '').split('=')[1] || '.sec-cache'

const TODAY = new Date().toISOString().slice(0, 10)

const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE}`
const airtableKey = () => process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY || ''
const anthropicKey = () => process.env.ANTHROPIC_API_KEY || ''
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const STATE_NAME_TO_ABBR = {
  alabama:'AL', alaska:'AK', arizona:'AZ', arkansas:'AR', california:'CA',
  colorado:'CO', connecticut:'CT', delaware:'DE', florida:'FL', georgia:'GA',
  hawaii:'HI', idaho:'ID', illinois:'IL', indiana:'IN', iowa:'IA',
  kansas:'KS', kentucky:'KY', louisiana:'LA', maine:'ME', maryland:'MD',
  massachusetts:'MA', michigan:'MI', minnesota:'MN', mississippi:'MS', missouri:'MO',
  montana:'MT', nebraska:'NE', nevada:'NV', 'new hampshire':'NH', 'new jersey':'NJ',
  'new mexico':'NM', 'new york':'NY', 'north carolina':'NC', 'north dakota':'ND', ohio:'OH',
  oklahoma:'OK', oregon:'OR', pennsylvania:'PA', 'rhode island':'RI', 'south carolina':'SC',
  'south dakota':'SD', tennessee:'TN', texas:'TX', utah:'UT', vermont:'VT',
  virginia:'VA', washington:'WA', 'west virginia':'WV', wisconsin:'WI', wyoming:'WY',
  'district of columbia':'DC',
}

const STOPWORDS = new Set([
  'data','center','centre','llc','inc','ltd','lp','corp','corporation',
  'company','co','holdings','holding','technologies','technology','tech',
  'campus','facility','project','dc','dcs','phase','building','services',
  'solutions','systems','site','the','of','and','for','at','a','an',
  'i','ii','iii','iv','v','vi','vii','viii','ix','x','north','south',
  'east','west','dba','llp',
])

function normalizeState(s) {
  if (!s) return ''
  const t = String(s).trim()
  if (t.length === 2) return t.toUpperCase()
  const lower = t.toLowerCase()
  return STATE_NAME_TO_ABBR[lower] || t.toUpperCase()
}

function normalizeCity(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ')
}

function normalizeTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[.,()\/&'"-]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => !STOPWORDS.has(t))
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0
  const setA = new Set(a)
  const setB = new Set(b)
  let inter = 0
  for (const x of setA) if (setB.has(x)) inter++
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 0 : inter / union
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

async function secFetch(url, { json = false } = {}) {
  await sleep(SEC_RATE_DELAY_MS)
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': json ? 'application/json' : 'text/html' } })
  if (!r.ok) {
    throw new Error(`SEC fetch ${r.status} for ${url}`)
  }
  return json ? r.json() : r.text()
}

async function loadTickerMap() {
  const cachePath = path.join(CACHE_DIR, 'company_tickers.json')
  if (fs.existsSync(cachePath)) {
    const stat = fs.statSync(cachePath)
    const ageHours = (Date.now() - stat.mtimeMs) / 3_600_000
    if (ageHours < 24) {
      return JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    }
  }
  console.log('[sec] downloading company_tickers.json')
  const data = await secFetch('https://www.sec.gov/files/company_tickers.json', { json: true })
  fs.writeFileSync(cachePath, JSON.stringify(data))
  return data
}

function lookupCIKByTicker(tickerMap, ticker) {
  const t = ticker.toUpperCase()
  for (const key of Object.keys(tickerMap)) {
    const row = tickerMap[key]
    if (row && String(row.ticker || '').toUpperCase() === t) {
      return String(row.cik_str).padStart(10, '0')
    }
  }
  return null
}

async function getLatestForm(cik, form) {
  const padded = cik.padStart(10, '0')
  const url = `https://data.sec.gov/submissions/CIK${padded}.json`
  const data = await secFetch(url, { json: true })
  const recent = (data && data.filings && data.filings.recent) || null
  if (!recent) throw new Error(`no recent filings in submissions for CIK ${cik}`)
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] === form) {
      return {
        cik: padded.replace(/^0+/, ''),
        accessionNumber: recent.accessionNumber[i],
        filingDate: recent.filingDate[i],
        primaryDocument: recent.primaryDocument[i],
      }
    }
  }
  return null
}

function buildFilingURL(cikNoPad, accessionNumber, primaryDocument) {
  const noDashes = accessionNumber.replace(/-/g, '')
  return `https://www.sec.gov/Archives/edgar/data/${cikNoPad}/${noDashes}/${primaryDocument}`
}

async function fetchAndCacheFiling(url, cacheKey) {
  const cachePath = path.join(CACHE_DIR, cacheKey)
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, 'utf8')
  }
  console.log(`[sec] fetching ${url}`)
  const html = await secFetch(url)
  fs.writeFileSync(cachePath, html)
  return html
}

function htmlToText(html) {
  let t = String(html || '')
  t = t.replace(/<!--[\s\S]*?-->/g, ' ')
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  t = t.replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
  t = t.replace(/<br\s*\/?>/gi, '\n')
  t = t.replace(/<\/td>/gi, '\t')
  t = t.replace(/<[^>]+>/g, ' ')
  t = t.replace(/&nbsp;/g, ' ')
  t = t.replace(/&amp;/g, '&')
  t = t.replace(/&lt;/g, '<')
  t = t.replace(/&gt;/g, '>')
  t = t.replace(/&quot;/g, '"')
  t = t.replace(/&#39;|&apos;/g, "'")
  t = t.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
  t = t.replace(/[ \t]+/g, ' ')
  t = t.replace(/\n{3,}/g, '\n\n')
  return t.trim()
}

function normalizeWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function quoteAppearsInFiling(quote, filingText) {
  if (!quote) return false
  const needle = normalizeWhitespace(quote)
  if (needle.length < 12) return false
  const haystack = normalizeWhitespace(filingText)
  return haystack.includes(needle)
}

// Tabular SEC data rarely linearizes into a quotable contiguous
// sentence. Fall back to a proximity check: require both the
// facility name and the MW value (as a standalone digit token) to
// appear within PROXIMITY_WINDOW chars of each other anywhere in
// the filing. Both must come from the source text, so a fabricated
// facility or fabricated number still gets rejected.
const PROXIMITY_WINDOW = 1000

function mwTokenRegex(mw) {
  const escaped = String(mw).replace(/\./g, '\\.')
  return new RegExp(`(^|[^\\d.])${escaped}([^\\d.]|$)`)
}

function nameAndMwInProximity(name, mw, filingText) {
  const haystack = normalizeWhitespace(filingText)
  const needle = normalizeWhitespace(name)
  if (!needle || needle.length < 3) return false
  const re = mwTokenRegex(mw)
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    const start = Math.max(0, idx - 200)
    const end = Math.min(haystack.length, idx + needle.length + PROXIMITY_WINDOW)
    if (re.test(haystack.slice(start, end))) return true
    idx = haystack.indexOf(needle, idx + 1)
  }
  return false
}

function verifyExtraction(ex, filingText) {
  if (quoteAppearsInFiling(ex.quote, filingText)) return { ok: true, method: 'quote' }
  if (nameAndMwInProximity(ex.name, ex.power_mw, filingText)) return { ok: true, method: 'proximity' }
  return { ok: false, method: 'none' }
}

function buildExtractionPrompt(companyName, filingText) {
  const trimmed = filingText.length > FILING_CHAR_LIMIT
    ? filingText.slice(0, FILING_CHAR_LIMIT)
    : filingText
  return [
    `You are extracting facility-level power capacity data from an SEC 10-K filing for ${companyName}.`,
    '',
    'Return a JSON array of US data center facilities operated by this company where a specific megawatt (MW) figure is explicitly disclosed for that specific facility.',
    '',
    'Each object must have:',
    '  - name: facility name as written in the filing',
    '  - city: city or municipality (US only)',
    '  - state: two-letter state code',
    '  - power_mw: numeric MW value disclosed for this specific facility',
    '  - capacity_type: one of "operating", "contracted", "nameplate", "interconnection", "unknown"',
    '  - quote: exact verbatim sentence(s) from the filing that contain the MW value (this will be programmatically verified, do not paraphrase or reformat)',
    '',
    'STRICT RULES:',
    '1. Only include facilities where a numeric MW value is explicitly tied to a specific facility by name or specific location.',
    '2. Skip aggregate company-wide totals (e.g. "1,200 MW across our portfolio").',
    '3. Skip forward-looking targets, announced-but-not-built capacity, and announced expansions.',
    '4. Skip non-US facilities.',
    '5. Skip generic statements like "up to" or "approximately X MW per site".',
    '6. The quote field must be a contiguous verbatim copy from the filing. Whitespace differences are fine; substantive paraphrasing is not.',
    '7. If no per-facility MW data is disclosed, return [].',
    '',
    'Output JSON only, no commentary or markdown fences.',
    '',
    '--- FILING TEXT BEGINS ---',
    trimmed,
    '--- FILING TEXT ENDS ---',
  ].join('\n')
}

function extractJsonArray(text) {
  if (!text) return null
  let t = String(text)
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1]
  const start = t.indexOf('[')
  const end = t.lastIndexOf(']')
  if (start < 0 || end < 0 || end <= start) return null
  try {
    return JSON.parse(t.slice(start, end + 1))
  } catch (err) {
    console.error(`[sec] JSON parse failed: ${err.message}`)
    return null
  }
}

async function callClaude(prompt) {
  await sleep(CLAUDE_RATE_DELAY_MS)
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey(),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Anthropic API failed: ${r.status} ${body}`)
  }
  const d = await r.json()
  const content = (d.content || []).map(c => c.text || '').join('\n')
  return content
}

async function airtableListAll(tableId, fieldList) {
  const key = airtableKey()
  let all = []
  let offset = null
  do {
    const url = new URL(`${AIRTABLE_API}/${tableId}`)
    url.searchParams.set('pageSize', '100')
    url.searchParams.set('returnFieldsByFieldId', 'true')
    for (const f of (fieldList || [])) url.searchParams.append('fields[]', f)
    if (offset) url.searchParams.set('offset', offset)
    const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${key}` } })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new Error(`Airtable list failed: ${r.status} ${body}`)
    }
    const d = await r.json()
    all = all.concat(d.records || [])
    offset = d.offset || null
  } while (offset)
  return all
}

async function airtablePatchOne(tableId, id, fields) {
  const key = airtableKey()
  const r = await fetch(`${AIRTABLE_API}/${tableId}/${id}?returnFieldsByFieldId=true`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Airtable patch failed: ${r.status} ${body}`)
  }
  return r.json()
}

function normalizeCompany(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/\b(inc|llc|ltd|lp|corp|corporation|company|co|holdings|holding|realty|trust|platforms|mining|technologies|technology)\b\.?/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function companiesMatch(target, candidate) {
  const a = normalizeCompany(target)
  const b = normalizeCompany(candidate)
  if (!a || !b) return false
  if (a === b) return true
  if (a.length >= 3 && b.includes(a)) return true
  if (b.length >= 3 && a.includes(b)) return true
  return false
}

function getStringField(fields, fieldId) {
  const v = fields[fieldId]
  if (v == null) return ''
  if (Array.isArray(v)) return String(v[0] || '')
  if (typeof v === 'object' && v.name) return v.name
  return String(v)
}

function buildFacilityIndex(recordsByTable, targetCompany) {
  const out = []
  for (const tableSpec of TABLES) {
    const records = recordsByTable[tableSpec.tableId] || []
    const F = tableSpec.fields
    for (const rec of records) {
      const f = rec.fields || {}
      const company = getStringField(f, F.Company)
      // Some pending records have garbage company strings ("Companies"
      // is a known CSV-header import bug). Accept those when the
      // facility name contains the target company, since name-based
      // matching plus city/state will still gate writes correctly.
      const name = getStringField(f, F.Name)
      const nameMatches = name && normalizeCompany(name).includes(normalizeCompany(targetCompany).split(' ')[0])
      if (!companiesMatch(targetCompany, company) && !nameMatches) continue
      out.push({
        id: rec.id,
        table: tableSpec,
        name,
        city: getStringField(f, F.City),
        state: getStringField(f, F.State_Region),
        country: getStringField(f, F.Country),
        power_mw: f[F.Power_MW] != null ? Number(f[F.Power_MW]) : null,
        power_source: getStringField(f, F.Power_MW_Source),
        power_type: getStringField(f, F.Power_MW_Type),
      })
    }
  }
  return out
}

function findBestFacilityMatch(extraction, facilityIndex) {
  const exCity = normalizeCity(extraction.city)
  const exState = normalizeState(extraction.state)
  const exTokens = normalizeTokens(extraction.name)

  let best = null
  let bestScore = 0
  for (const fac of facilityIndex) {
    const fCity = normalizeCity(fac.city)
    const fState = normalizeState(fac.state)
    const cityMatch = exCity && fCity && exCity === fCity
    const stateMatch = exState && fState && exState === fState
    if (exState && fState && exState !== fState) continue
    let score = jaccard(exTokens, normalizeTokens(fac.name))
    if (cityMatch) score += 0.25
    if (stateMatch) score += 0.1
    if (score > bestScore) {
      bestScore = score
      best = fac
    }
  }
  return { match: best, score: bestScore }
}

async function processTarget(target, tickerMap, recordsByTable) {
  const label = target.ticker || `CIK ${target.cik}`
  console.log(`\n=== ${target.company} (${label}) ===`)

  let cik = target.cik || null
  if (!cik && target.ticker) {
    cik = lookupCIKByTicker(tickerMap, target.ticker)
    if (!cik) {
      console.log(`[sec] no CIK found for ticker ${target.ticker}, skipping`)
      return { matched: 0, unmatched: 0, suspect: 0, skipped: 1 }
    }
  }

  let filing
  try {
    filing = await getLatestForm(cik, '10-K')
  } catch (err) {
    console.log(`[sec] submissions fetch failed for ${label}: ${err.message}`)
    return { matched: 0, unmatched: 0, suspect: 0, skipped: 1 }
  }
  if (!filing) {
    console.log(`[sec] no 10-K found for ${label}`)
    return { matched: 0, unmatched: 0, suspect: 0, skipped: 1 }
  }
  const filingUrl = buildFilingURL(filing.cik, filing.accessionNumber, filing.primaryDocument)
  console.log(`[sec] latest 10-K filed ${filing.filingDate}: ${filingUrl}`)

  const cacheKey = `${target.ticker || ('cik-' + target.cik)}-10K-${filing.accessionNumber.replace(/-/g, '')}.html`
  let html
  try {
    html = await fetchAndCacheFiling(filingUrl, cacheKey)
  } catch (err) {
    console.log(`[sec] filing fetch failed: ${err.message}`)
    return { matched: 0, unmatched: 0, suspect: 0, skipped: 1 }
  }
  console.log(`[sec] cached ${cacheKey} (${html.length} bytes)`)

  if (NO_EXTRACT) {
    return { matched: 0, unmatched: 0, suspect: 0, skipped: 0 }
  }

  const text = htmlToText(html)
  console.log(`[sec] stripped to ${text.length} chars of text`)

  const prompt = buildExtractionPrompt(target.company, text)
  let raw
  try {
    raw = await callClaude(prompt)
  } catch (err) {
    console.log(`[sec] Claude call failed: ${err.message}`)
    return { matched: 0, unmatched: 0, suspect: 0, skipped: 1 }
  }
  const extractions = extractJsonArray(raw) || []
  console.log(`[sec] Claude returned ${extractions.length} extraction(s)`)

  let matched = 0
  let unmatched = 0
  let suspect = 0
  const facIndex = buildFacilityIndex(recordsByTable, target.company)
  const facByTable = facIndex.reduce((acc, f) => {
    acc[f.table.name] = (acc[f.table.name] || 0) + 1
    return acc
  }, {})
  console.log(`[sec] ${facIndex.length} candidate rows for ${target.company} (${JSON.stringify(facByTable)})`)

  for (const ex of extractions) {
    const mw = Number(ex.power_mw)
    if (!Number.isFinite(mw) || mw <= 0) {
      console.log(`[sec] SKIP non-numeric MW for "${ex.name}"`)
      suspect++
      continue
    }
    const verdict = verifyExtraction(ex, text)
    if (!verdict.ok) {
      console.log(`[sec] SUSPECT verify failed for "${ex.name}" (${mw} MW). Quote preview: ${(ex.quote || '').slice(0, 120)}`)
      suspect++
      continue
    }
    const { match, score } = findBestFacilityMatch(ex, facIndex)
    if (!match || score < MATCH_SCORE_MIN) {
      console.log(`[sec] UNMATCHED "${ex.name}" in ${ex.city}, ${ex.state} (${mw} MW, ${ex.capacity_type}) best score ${score.toFixed(2)}`)
      unmatched++
      continue
    }

    const F = match.table.fields
    const patchFields = {
      [F.Power_MW]:               mw,
      [F.Power_MW_Source]:        filingUrl,
      [F.Power_MW_Type]:          'SEC Filing',
      [F.Power_MW_Last_Verified]: TODAY,
    }

    const prev = match.power_mw == null ? 'null' : match.power_mw
    const action = DRY_RUN ? 'WOULD WRITE' : 'WROTE'
    console.log(`[sec] ${action} [${match.table.name}] "${match.name}" (${ex.city}, ${ex.state}) Power_MW ${prev} -> ${mw} [${ex.capacity_type}] score ${score.toFixed(2)} verify=${verdict.method}`)
    if (!DRY_RUN) {
      try {
        await airtablePatchOne(match.table.tableId, match.id, patchFields)
      } catch (err) {
        console.error(`[sec] patch failed for ${match.name}: ${err.message}`)
        suspect++
        continue
      }
    }
    matched++
  }

  return { matched, unmatched, suspect, skipped: 0 }
}

async function main() {
  if (!airtableKey()) throw new Error('AIRTABLE_KEY not set')
  if (!NO_EXTRACT && !anthropicKey()) throw new Error('ANTHROPIC_API_KEY not set (or pass --no-extract)')

  ensureDir(CACHE_DIR)
  console.log(`[sec] cache dir: ${CACHE_DIR}`)
  console.log(`[sec] mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${NO_EXTRACT ? ', NO EXTRACT' : ''}`)
  console.log(`[sec] today: ${TODAY}`)

  const tickerMap = await loadTickerMap()
  console.log(`[sec] loaded ticker map (${Object.keys(tickerMap).length} entries)`)

  console.log('[sec] fetching Facilities and Pending_Facilities for company matching...')
  const [facilities, pending] = await Promise.all([
    airtableListAll(FACILITIES_TBL, [
      F_FAC.Name, F_FAC.Company, F_FAC.City, F_FAC.State_Region, F_FAC.Country,
      F_FAC.Power_MW, F_FAC.Power_MW_Source, F_FAC.Power_MW_Type,
    ]),
    airtableListAll(PENDING_TBL, [
      F_PENDING.Name, F_PENDING.Company, F_PENDING.City, F_PENDING.State_Region, F_PENDING.Country,
      F_PENDING.Power_MW, F_PENDING.Power_MW_Source, F_PENDING.Power_MW_Type,
    ]),
  ])
  console.log(`[sec] loaded ${facilities.length} Facilities, ${pending.length} Pending_Facilities`)
  const recordsByTable = {
    [FACILITIES_TBL]: facilities,
    [PENDING_TBL]:    pending,
  }

  const targets = TARGETS.filter(t => {
    if (TICKER_FILTER && t.ticker !== TICKER_FILTER) return false
    if (CIK_FILTER && t.cik !== CIK_FILTER) return false
    return true
  })
  console.log(`[sec] processing ${targets.length} target(s)`)

  let totals = { matched: 0, unmatched: 0, suspect: 0, skipped: 0 }
  for (const target of targets) {
    try {
      const r = await processTarget(target, tickerMap, recordsByTable)
      totals.matched   += r.matched
      totals.unmatched += r.unmatched
      totals.suspect   += r.suspect
      totals.skipped   += r.skipped
    } catch (err) {
      console.error(`[sec] target ${target.company} failed: ${err.message}`)
      totals.skipped++
    }
  }

  console.log('\n---')
  console.log(`SUMMARY: ${totals.matched} written, ${totals.unmatched} unmatched, ${totals.suspect} suspect/skipped, ${totals.skipped} target failures`)
  if (totals.unmatched > 0) {
    console.log('Unmatched extractions are SEC-disclosed facilities that did not match any current Facilities or Pending_Facilities row. Consider adding them to Pending_Facilities for review.')
  }
}

main().catch((e) => {
  console.error('FAILED:', e && e.message)
  process.exit(1)
})
