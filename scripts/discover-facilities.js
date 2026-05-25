/*
 * WEEKLY AUTOMATED DISCOVERY
 *
 * Runs every Sunday via GitHub Actions. Asks Claude with web search
 * for newly announced data center facilities and adds them to
 * Pending_Facilities for human review.
 *
 * Required env: ANTHROPIC_API_KEY, AIRTABLE_KEY
 */

const AIRTABLE_BASE = 'app2FUPqq8VQSwQ64'
const FACILITIES_TBL = 'tblvojPdS6kwMxsex'
const PENDING_TBL = 'tblPB5eHmEBujI4Iq'

const F_PENDING = {
  Name:             'fldvasZvuq88CKcov',
  Company:          'fldGrOrMDrMyhTYQR',
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

const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE}`
const airtableKey = () => process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY || ''
const UA = 'HumZones/1.0 hello@humzones.com'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const STATUS_VALUES = new Set(['Proposed','Approved','Building','Operating'])
const VALID_STATUSES = ['Proposed','Approved','Building','Operating']

function classifyRisk(mw) {
  if (mw == null) return 'MODERATE'
  if (mw >= 50)  return 'HIGH'
  if (mw >= 15)  return 'MODERATE'
  return 'LOW'
}

async function airtableListAll(tableId, fieldList, filterByFormula) {
  const key = airtableKey()
  let all = []
  let offset = null
  do {
    const url = new URL(`${AIRTABLE_API}/${tableId}`)
    url.searchParams.set('pageSize', '100')
    url.searchParams.set('returnFieldsByFieldId', 'true')
    for (const f of (fieldList || [])) url.searchParams.append('fields[]', f)
    if (filterByFormula) url.searchParams.set('filterByFormula', filterByFormula)
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

async function geocode(city, stateOrCountry) {
  if (!city) return null
  const q = encodeURIComponent(`${city}, ${stateOrCountry || ''}`.trim())
  const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } })
    if (!r.ok) return null
    const d = await r.json()
    if (!Array.isArray(d) || !d.length) return null
    return { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) }
  } catch (_) {
    return null
  }
}

async function callClaudeWithRetry(payload) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    })
    if (res.status === 429 && attempt === 1) {
      console.log('[discover] 429 rate limited, waiting 90s and retrying...')
      await sleep(90000)
      continue
    }
    return res
  }
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
    console.error(`[discover] JSON parse failed: ${err.message}`)
    return null
  }
}

async function main() {
  if (!airtableKey()) throw new Error('AIRTABLE_KEY not set')
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set')

  console.log(`[discover] start ${new Date().toISOString()}`)

  const [liveRecs, pendingRecs] = await Promise.all([
    airtableListAll(FACILITIES_TBL, [F_FAC.Name]),
    airtableListAll(PENDING_TBL,    [F_PENDING.Name, F_PENDING.Source_URL, F_PENDING.Date_Found]),
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

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const usedURLs = new Set()
  for (const r of pendingRecs) {
    const f = r.fields || {}
    const url = f[F_PENDING.Source_URL]
    const dateFound = f[F_PENDING.Date_Found]
    if (url && (!dateFound || dateFound >= cutoff)) usedURLs.add(url)
  }

  console.log(`[discover] ${existingNames.size} known facility names, ${usedURLs.size} recently used URLs`)

  const usedURLsArr = Array.from(usedURLs).slice(0, 80)
  const systemPrompt = 'You are a data center infrastructure researcher. Find newly announced data center facilities from public sources. Only report real facilities with verifiable source URLs. Never invent or hallucinate. Return only valid JSON.'
  const userPrompt =
    'Search for data center facilities announced, approved, permitted or under construction in the past 30 days that are not yet widely tracked. Focus on interconnection queue filings, planning board approvals, and construction announcements.\n' +
    `Avoid these already-used URLs: ${JSON.stringify(usedURLsArr)}\n\n` +
    'Return ONLY a JSON array, no other text:\n' +
    '[{\n' +
    '  "name": string,\n' +
    '  "company": string,\n' +
    '  "city": string,\n' +
    '  "state": string (2-letter code or full name),\n' +
    '  "country": string (default USA),\n' +
    '  "power_mw": number or null,\n' +
    '  "status": "Proposed" or "Approved" or "Building" or "Operating",\n' +
    '  "source_url": string (real URL),\n' +
    '  "notes": string (1-2 sentences why this matters for residents)\n' +
    '}]\n' +
    'Find 3-6 real facilities. Return fewer rather than inventing.'

  console.log('[discover] calling Claude with web_search')
  const res = await callClaudeWithRetry({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Anthropic API failed: ${res.status} ${body}`)
  }
  const data = await res.json()
  const text = (data.content || [])
    .filter(b => b && b.type === 'text')
    .map(b => b.text)
    .join('')

  const candidates = extractJsonArray(text)
  if (!Array.isArray(candidates)) {
    console.error('[discover] could not parse JSON array from response. Raw text:')
    console.error(text.slice(0, 1000))
    throw new Error('No facilities array returned')
  }
  console.log(`[discover] received ${candidates.length} candidates`)

  let saved = 0
  let skipped = 0
  let errors = 0

  for (const c of candidates) {
    try {
      if (!c || !c.source_url || !c.name) { skipped++; continue }
      if (usedURLs.has(c.source_url)) { skipped++; continue }
      if (existingNames.has(String(c.name).toLowerCase())) { skipped++; continue }
      if (c.power_mw != null && Number(c.power_mw) < 5) { skipped++; continue }

      let status = STATUS_VALUES.has(c.status) ? c.status : 'Proposed'

      let lat = null, lng = null
      if (c.city) {
        await sleep(1000)
        const geo = await geocode(c.city, c.state || c.country || '')
        if (geo) { lat = geo.lat; lng = geo.lng }
      }

      const fields = {
        [F_PENDING.Name]:             c.name,
        [F_PENDING.Company]:          c.company || 'Unknown',
        [F_PENDING.City]:             c.city || '',
        [F_PENDING.State_Region]:     c.state || '',
        [F_PENDING.Country]:          c.country || 'USA',
        [F_PENDING.Power_MW]:         c.power_mw != null ? Number(c.power_mw) : null,
        [F_PENDING.Facility_Status]:  status,
        [F_PENDING.Risk_Level]:       classifyRisk(c.power_mw != null ? Number(c.power_mw) : null),
        [F_PENDING.Source_URL]:       c.source_url,
        [F_PENDING.Source_Type]:      'Web Search',
        [F_PENDING.Date_Found]:       new Date().toISOString().slice(0, 10),
        [F_PENDING.Review_Status]:    'Pending Review',
        [F_PENDING.Notes]:            c.notes || '',
        [F_PENDING.Added_To_Registry]:false,
      }
      if (lat != null) fields[F_PENDING.Latitude] = lat
      if (lng != null) fields[F_PENDING.Longitude] = lng

      await airtableCreate(PENDING_TBL, fields)
      existingNames.add(String(c.name).toLowerCase())
      usedURLs.add(c.source_url)
      saved++
      console.log(`[discover] saved ${c.name} (${c.power_mw ?? '?'}MW, ${status})`)
    } catch (err) {
      errors++
      console.error(`[discover] save failed for ${c && c.name}: ${err.message}`)
    }
  }

  console.log(`SUMMARY: ${candidates.length} candidates, ${saved} saved, ${skipped} skipped, ${errors} errors`)
}

main().catch((e) => {
  console.error('FAILED:', e && e.message)
  process.exit(1)
})
