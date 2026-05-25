/*
 * ONE-TIME IMPORT: datacenter.fyi scraper.
 *
 * Pulls facility data for all 50 US states (plus DC) into the
 * Pending_Facilities table for human review before going live.
 *
 * Respects the source with 2s delays between facility page fetches
 * and 1s between geocoding requests. Run once. Allow 30 to 60
 * minutes for all states.
 *
 * Usage:
 *   AIRTABLE_KEY=xxx node scripts/scrape-datacenter-fyi.js
 *   STATES=tx node scripts/scrape-datacenter-fyi.js
 *   STATES=tx,va node scripts/scrape-datacenter-fyi.js
 */

const AIRTABLE_BASE = 'app2FUPqq8VQSwQ64'
const FACILITIES_TBL = 'tblvojPdS6kwMxsex'
const PENDING_TBL = 'tblPB5eHmEBujI4Iq'

const F_PENDING = {
  Name:             'fldvasZvuq88CKcov',
  Company:          'fldGrOrMDrMyhTYQR',
  Address:          'fldJ0f7WMbquU1gIs',
  City:             'fldAtKp2mYqY6iCbB',
  State_Region:     'fldK5ksYKMz07RWa4',
  Country:          'fldY0BYtYi6pdwpu0',
  Latitude:         'fldl37PXyyVv5A5fr',
  Longitude:        'fld9ilqCXidpgBIPT',
  Power_MW:         'fld2s77YTUbCVf9kr',
  Facility_Status:  'fldfg9XCZ1P2a4456',
  Risk_Level:       'fldTJKLP6759Rg07p',
  Source_URL:       'fld5tWJxVXbHMwoOj',
  Source_Type:      'fldM8r2O13JIqUYqV',
  Date_Found:       'fldlMqLgz7NZEzxkw',
  Review_Status:    'fldtWGxecfwKMuqnh',
  Notes:            'fldosSF0UTg9fm1Xi',
  Added_To_Registry:'flddLDSFR51A6uQGG',
}

const F_FAC = {
  Name: 'fldirgBJAsorDO4Hm',
}

const US_STATES = [
  'al','ak','az','ar','ca','co','ct','de','fl','ga',
  'hi','id','il','in','ia','ks','ky','la','me','md',
  'ma','mi','mn','ms','mo','mt','ne','nv','nh','nj',
  'nm','ny','nc','nd','oh','ok','or','pa','ri','sc',
  'sd','tn','tx','ut','vt','va','wa','wv','wi','wy','dc'
]

const STATE_NAME = {
  al:'Alabama',ak:'Alaska',az:'Arizona',ar:'Arkansas',ca:'California',
  co:'Colorado',ct:'Connecticut',de:'Delaware',fl:'Florida',ga:'Georgia',
  hi:'Hawaii',id:'Idaho',il:'Illinois',in:'Indiana',ia:'Iowa',
  ks:'Kansas',ky:'Kentucky',la:'Louisiana',me:'Maine',md:'Maryland',
  ma:'Massachusetts',mi:'Michigan',mn:'Minnesota',ms:'Mississippi',mo:'Missouri',
  mt:'Montana',ne:'Nebraska',nv:'Nevada',nh:'New Hampshire',nj:'New Jersey',
  nm:'New Mexico',ny:'New York',nc:'North Carolina',nd:'North Dakota',oh:'Ohio',
  ok:'Oklahoma',or:'Oregon',pa:'Pennsylvania',ri:'Rhode Island',sc:'South Carolina',
  sd:'South Dakota',tn:'Tennessee',tx:'Texas',ut:'Utah',vt:'Vermont',
  va:'Virginia',wa:'Washington',wv:'West Virginia',wi:'Wisconsin',wy:'Wyoming',
  dc:'District of Columbia',
}

const statesToScrape = process.env.STATES
  ? process.env.STATES.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  : US_STATES

const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE}`
const airtableKey = () => process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY || ''
const UA = 'HumZones/1.0 hello@humzones.com'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const STATUS_MAP = {
  'operational': 'Operating',
  'operating':   'Operating',
  'live':        'Operating',
  'construction':'Building',
  'building':    'Building',
  'under construction':'Building',
  'proposed':    'Proposed',
  'announced':   'Proposed',
  'planned':     'Proposed',
  'permitted':   'Approved',
  'approved':    'Approved',
  'unknown':     'Proposed',
  'cancelled':   'SKIP',
  'canceled':    'SKIP',
}

function classifyRisk(mw) {
  if (mw == null) return 'MODERATE'
  if (mw >= 50)  return 'HIGH'
  if (mw >= 15)  return 'MODERATE'
  return 'LOW'
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .trim()
}

function stripTags(s) {
  return decodeHtml(String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '))
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

async function airtableCreate(tableId, fields) {
  const key = airtableKey()
  const r = await fetch(`${AIRTABLE_API}/${tableId}?returnFieldsByFieldId=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Airtable create failed: ${r.status} ${body}`)
  }
  return r.json()
}

async function fetchHTML(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } })
  if (!r.ok) throw new Error(`fetch ${url} failed: ${r.status}`)
  return await r.text()
}

async function nominatim(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } })
    if (!r.ok) return null
    const d = await r.json()
    if (!Array.isArray(d) || !d.length) {
      console.log(`[geocode] No results for: ${query}`)
      return null
    }
    return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) }
  } catch (err) {
    console.log(`[geocode] error for "${query}": ${err.message}`)
    return null
  }
}

// Geocode with fallback: try city+state first, then fall back to
// state alone (gives approximate center of the state) so we always
// have at least a coarse coordinate.
async function geocode(city, stateName) {
  if (!stateName) return null

  if (city) {
    const q = `${city}, ${stateName}, USA`
    const res = await nominatim(q)
    if (res) {
      console.log(`[geocode] matched city+state: ${q}`)
      return res
    }
    await sleep(1000)
  }

  const stateQ = `${stateName}, USA`
  const res = await nominatim(stateQ)
  if (res) {
    console.log(`[geocode] matched state only: ${stateQ}${city ? ` (no result for "${city}, ${stateName}")` : ''}`)
    return res
  }
  return null
}

// Pull facility rows from a state page. The page is a Next.js app so a
// resilient strategy is to find every /facility/<slug> link and grab
// the surrounding row text.
function parseStateRows(html) {
  const rows = []
  const seen = new Set()
  const linkRe = /<a[^>]+href="\/facility\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = linkRe.exec(html)) !== null) {
    const slug = m[1]
    if (seen.has(slug)) continue
    seen.add(slug)
    const name = stripTags(m[2])
    if (!name) continue
    const start = Math.max(0, m.index - 1200)
    const end = Math.min(html.length, m.index + m[0].length + 1200)
    const ctx = stripTags(html.slice(start, end))

    let mw = null
    const mwMatch = ctx.match(/(\d+(?:\.\d+)?)\s*MW\b/i)
    if (mwMatch) mw = parseFloat(mwMatch[1])

    let status = 'Unknown'
    const statusKeys = Object.keys(STATUS_MAP)
    for (const k of statusKeys) {
      const re = new RegExp(`\\b${k.replace(/ /g, '\\s+')}\\b`, 'i')
      if (re.test(ctx)) { status = k; break }
    }

    let company = ''
    const compMatch = ctx.match(/by\s+([A-Z][A-Za-z0-9 .&'\-]{1,60})/)
    if (compMatch) company = compMatch[1].trim()

    rows.push({ slug, name, mw, statusRaw: status, company })
  }
  return rows
}

// Pull city / address / company from a facility detail page.
function parseFacilityDetail(html) {
  const out = {}
  const cityMatch = html.match(/City[^<]{0,40}<[^>]+>\s*([^<]+?)\s*</i)
  if (cityMatch) out.city = decodeHtml(cityMatch[1])

  const addressMatch = html.match(/Address[^<]{0,40}<[^>]+>\s*([^<]+?)\s*</i)
  if (addressMatch) out.address = decodeHtml(addressMatch[1])

  const operatorMatch = html.match(/(?:Operator|Developer|Owner|Company)[^<]{0,40}<[^>]+>\s*([^<]+?)\s*</i)
  if (operatorMatch) out.company = decodeHtml(operatorMatch[1])

  if (!out.city) {
    const inMatch = html.match(/located in[^<]{0,160}<[^>]+>?\s*([A-Z][A-Za-z .'\-]{2,40}),/i)
    if (inMatch) out.city = inMatch[1].trim()
  }
  return out
}

async function processState(stateCode, existingNames) {
  const stateName = STATE_NAME[stateCode] || stateCode.toUpperCase()
  console.log(`[${stateCode}] fetching state page ${stateName}`)

  let html
  try {
    html = await fetchHTML(`https://www.datacenter.fyi/state/${stateCode}`)
  } catch (err) {
    console.error(`[${stateCode}] state fetch failed: ${err.message}`)
    return { found: 0, saved: 0, skipped: 0, errors: 1 }
  }

  const rows = parseStateRows(html)
  console.log(`[${stateCode}] found ${rows.length} facility rows`)

  let saved = 0
  let skipped = 0
  let errors = 0

  for (const row of rows) {
    const mappedStatus = STATUS_MAP[row.statusRaw.toLowerCase()] || 'Proposed'
    if (mappedStatus === 'SKIP') {
      skipped++
      continue
    }

    const lowerName = row.name.toLowerCase()
    if (existingNames.has(lowerName)) {
      skipped++
      continue
    }

    const detailNeeded = row.mw != null || mappedStatus === 'Proposed' || mappedStatus === 'Building' || mappedStatus === 'Approved'
    let city = ''
    let address = ''
    let company = row.company || ''
    let sourceURL = `https://www.datacenter.fyi/facility/${row.slug}`

    if (detailNeeded) {
      await sleep(2000)
      try {
        const detailHtml = await fetchHTML(sourceURL)
        const det = parseFacilityDetail(detailHtml)
        if (det.city) city = det.city
        if (det.address) address = det.address
        if (det.company && !company) company = det.company
      } catch (err) {
        console.error(`[${stateCode}] detail fetch failed for ${row.name}: ${err.message}`)
      }
    }

    let lat = null
    let lng = null
    await sleep(1000)
    const geo = await geocode(city, stateName)
    if (geo) { lat = geo.lat; lng = geo.lng }

    try {
      const fields = {
        [F_PENDING.Name]:             row.name,
        [F_PENDING.Company]:          company || 'Unknown',
        [F_PENDING.City]:             city,
        [F_PENDING.Address]:          address,
        [F_PENDING.State_Region]:     stateName,
        [F_PENDING.Country]:          'United States',
        [F_PENDING.Power_MW]:         row.mw,
        [F_PENDING.Facility_Status]:  mappedStatus,
        [F_PENDING.Risk_Level]:       classifyRisk(row.mw),
        [F_PENDING.Source_URL]:       sourceURL,
        [F_PENDING.Source_Type]:      'Web Search',
        [F_PENDING.Date_Found]:       new Date().toISOString().slice(0, 10),
        [F_PENDING.Review_Status]:    'Pending Review',
        [F_PENDING.Notes]:            `Imported from datacenter.fyi. Source: ${sourceURL}`,
        [F_PENDING.Added_To_Registry]:false,
      }
      if (lat != null) fields[F_PENDING.Latitude] = lat
      if (lng != null) fields[F_PENDING.Longitude] = lng

      await airtableCreate(PENDING_TBL, fields)
      existingNames.add(lowerName)
      saved++
      console.log(`[${stateCode}] saved ${row.name} (${row.mw ?? '?'}MW, ${mappedStatus})`)
    } catch (err) {
      errors++
      console.error(`[${stateCode}] save failed for ${row.name}: ${err.message}`)
    }
  }

  console.log(`[${stateCode}] done: ${saved} saved, ${skipped} skipped, ${errors} errors`)
  return { found: rows.length, saved, skipped, errors }
}

async function main() {
  if (!airtableKey()) throw new Error('AIRTABLE_KEY not set')

  console.log(`[scrape] start ${new Date().toISOString()}`)
  console.log(`[scrape] states: ${statesToScrape.join(',')}`)

  console.log('[scrape] loading existing names...')
  const [liveRecs, pendingRecs] = await Promise.all([
    airtableListAll(FACILITIES_TBL, [F_FAC.Name]),
    airtableListAll(PENDING_TBL,    [F_PENDING.Name]),
  ])
  const existingNames = new Set()
  for (const r of liveRecs) {
    const n = (r.fields || {})[F_FAC.Name]
    if (n) existingNames.add(String(n).toLowerCase())
  }
  for (const r of pendingRecs) {
    const n = (r.fields || {})[F_PENDING.Name]
    if (n) existingNames.add(String(n).toLowerCase())
  }
  console.log(`[scrape] ${existingNames.size} existing facility names loaded`)

  let totalFound = 0, totalSaved = 0, totalSkipped = 0, totalErrors = 0

  for (let i = 0; i < statesToScrape.length; i++) {
    const s = statesToScrape[i]
    const res = await processState(s, existingNames)
    totalFound += res.found
    totalSaved += res.saved
    totalSkipped += res.skipped
    totalErrors += res.errors
    if (i < statesToScrape.length - 1) await sleep(3000)
  }

  console.log('---')
  console.log(`SUMMARY: ${totalFound} found, ${totalSaved} saved, ${totalSkipped} skipped, ${totalErrors} errors`)
}

main().catch((e) => {
  console.error('FAILED:', e && e.message)
  process.exit(1)
})
