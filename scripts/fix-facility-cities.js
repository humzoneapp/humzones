/*
 * Re-scrapes datacenter.fyi facility detail pages to get accurate
 * city and address data, then geocodes using real city names.
 *
 * Usage:
 *   AIRTABLE_KEY=xxx node scripts/fix-facility-cities.js
 *
 * Processes 30 records per run to respect Nominatim rate limits.
 * Re-run until all records have coordinates or are marked as
 * unresolvable.
 *
 * On every run it also clears garbage City values (length < 4 or
 * all-uppercase fragments like "LAS", "SON", "NEY") so the records
 * become eligible for clean re-scraping.
 */

const AIRTABLE_BASE = 'app2FUPqq8VQSwQ64'
const PENDING_TBL = 'tblPB5eHmEBujI4Iq'

const F_PENDING = {
  Name:         'fldvasZvuq88CKcov',
  Address:      'fldJ0f7WMbquU1gIs',
  City:         'fldAtKp2mYqY6iCbB',
  State_Region: 'fldK5ksYKMz07RWa4',
  Country:      'fldY0BYtYi6pdwpu0',
  Latitude:     'fldl37PXyyVv5A5fr',
  Longitude:    'fld9ilqCXidpgBIPT',
  Source_URL:   'fld5tWJxVXbHMwoOj',
}

const MAX_PER_RUN     = 30
const PATCH_LIMIT     = 10
const PATCH_BATCH_GAP = 300
const FETCH_DELAY     = 2000
const GEOCODE_DELAY   = 1000

const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE}`
const airtableKey = () => process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY || ''
const UA = 'HumZones/1.0 hello@humzones.com'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const INVALID_CITY_TOKENS = new Set([
  'TX','TEXAS','USA','US','N/A','UNKNOWN','NONE','NULL','DATA','CENTER',
])

// Virginia data center hubs that contaminate datacenter.fyi detail
// pages via nav and related-content links. Reject these as the
// "city" for any non-Virginia record.
const CITY_BLOCKLIST = [
  'ashburn',
  'reston',
  'sterling',
  'manassas',
  'herndon',
  'chantilly',
]

function isBlockedCity(city, stateName) {
  if (!city) return false
  const stateLow = (stateName || '').toLowerCase()
  if (stateLow === 'virginia' || stateLow === 'va') return false
  return CITY_BLOCKLIST.includes(String(city).trim().toLowerCase())
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function isCityFragment(city) {
  if (!city) return false
  const trimmed = String(city).trim()
  if (trimmed.length < 4) return true
  if (/^[A-Z\s]+$/.test(trimmed)) return true
  return false
}

function isValidCity(city) {
  if (!city) return false
  const trimmed = String(city).trim()
  if (trimmed.length < 3) return false
  if (/\d/.test(trimmed)) return false
  if (INVALID_CITY_TOKENS.has(trimmed.toUpperCase())) return false
  if (/^[A-Z\s]+$/.test(trimmed) && trimmed.length < 6) return false
  return true
}

async function airtableList(tableId, { fields, filterByFormula, maxRecords } = {}) {
  const key = airtableKey()
  let all = []
  let offset = null
  do {
    const url = new URL(`${AIRTABLE_API}/${tableId}`)
    url.searchParams.set('pageSize', '100')
    url.searchParams.set('returnFieldsByFieldId', 'true')
    for (const f of (fields || [])) url.searchParams.append('fields[]', f)
    if (filterByFormula) url.searchParams.set('filterByFormula', filterByFormula)
    if (maxRecords) url.searchParams.set('maxRecords', String(maxRecords))
    if (offset) url.searchParams.set('offset', offset)
    const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${key}` } })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new Error(`Airtable list failed: ${r.status} ${body}`)
    }
    const d = await r.json()
    all = all.concat(d.records || [])
    offset = d.offset || null
    if (maxRecords && all.length >= maxRecords) break
  } while (offset)
  return all
}

async function airtablePatch(tableId, records) {
  const key = airtableKey()
  const r = await fetch(`${AIRTABLE_API}/${tableId}?returnFieldsByFieldId=true`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`Airtable patch failed: ${r.status} ${body}`)
  }
  return r.json()
}

async function patchInGroups(tableId, updates) {
  const groups = chunk(updates, PATCH_LIMIT)
  let ok = 0
  let bad = 0
  for (const g of groups) {
    try {
      await airtablePatch(tableId, g)
      ok += g.length
    } catch (err) {
      bad += g.length
      console.error(`[fix-cities] patch failed for ${g.length} records: ${err.message}`)
    }
    if (groups.length > 1) await sleep(PATCH_BATCH_GAP)
  }
  return { ok, bad }
}

async function fetchDetailHtml(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } })
  if (!r.ok) throw new Error(`detail fetch ${url} failed: ${r.status}`)
  return await r.text()
}

function deepFind(obj, keyLower, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const v = deepFind(item, keyLower, depth + 1)
      if (v) return v
    }
    return null
  }
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === keyLower && typeof obj[k] === 'string' && obj[k].trim()) {
      return obj[k].trim()
    }
  }
  for (const k of Object.keys(obj)) {
    const v = deepFind(obj[k], keyLower, depth + 1)
    if (v) return v
  }
  return null
}

function extractFromNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return { city: null, address: null }
  let data
  try {
    data = JSON.parse(m[1])
  } catch (err) {
    return { city: null, address: null }
  }
  const props = (data && data.props && data.props.pageProps) || {}
  return {
    city:    deepFind(props, 'city'),
    address: deepFind(props, 'address'),
  }
}

function extractCityFromHtmlPattern(html, stateName) {
  if (!stateName) return null
  const stateRe = stateName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`([A-Z][a-zA-Z .'-]{2,40}),\\s*(?:${stateRe}|[A-Z]{2})\\b`)
  const m = html.match(re)
  if (m) return m[1].trim()
  const broad = html.match(/([A-Z][a-zA-Z .'-]{2,40}),\s*[A-Z]{2}\b/)
  if (broad) return broad[1].trim()
  return null
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

async function geocodeCity(city, stateName) {
  if (!city || !stateName) return null
  const q = `${city}, ${stateName}, USA`
  const res = await nominatim(q)
  if (res) {
    console.log(`[geocode] matched city+state: ${q}`)
    return { lat: res.lat, lng: res.lng, source: 'city' }
  }
  return null
}

async function clearBadCityFragments() {
  console.log('[fix-cities] Step 1: scanning for bad City fragments to clear...')
  const all = await airtableList(PENDING_TBL, {
    fields: [F_PENDING.Name, F_PENDING.City],
    filterByFormula: `NOT({${F_PENDING.City}}=BLANK())`,
  })
  const bad = []
  for (const rec of all) {
    const f = rec.fields || {}
    const city = f[F_PENDING.City]
    if (isCityFragment(city)) {
      bad.push({ id: rec.id, name: f[F_PENDING.Name] || rec.id, city })
    }
  }
  console.log(`[fix-cities] ${bad.length} records have City fragments to clear`)
  if (!bad.length) return

  for (const b of bad) {
    console.log(`[fix-cities] Clearing fragment "${b.city}" from ${b.name}`)
  }
  const updates = bad.map(b => ({
    id: b.id,
    fields: { [F_PENDING.City]: null },
  }))
  const { ok, bad: badCount } = await patchInGroups(PENDING_TBL, updates)
  console.log(`[fix-cities] Cleared ${ok} fragments (${badCount} errors)`)
}

async function main() {
  if (!airtableKey()) throw new Error('AIRTABLE_KEY not set')
  console.log(`[fix-cities] start ${new Date().toISOString()}`)

  await clearBadCityFragments()

  console.log(`[fix-cities] Step 2: fetching up to ${MAX_PER_RUN} records to re-scrape...`)
  const filter = `AND(NOT({${F_PENDING.Source_URL}}=BLANK()), {${F_PENDING.Latitude}}=BLANK())`
  const records = await airtableList(PENDING_TBL, {
    fields: [F_PENDING.Name, F_PENDING.City, F_PENDING.State_Region, F_PENDING.Source_URL, F_PENDING.Latitude],
    filterByFormula: filter,
    maxRecords: MAX_PER_RUN,
  })
  console.log(`[fix-cities] ${records.length} records to process`)

  let updated = 0
  let unresolved = 0
  let errors = 0

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    const f = rec.fields || {}
    const name = f[F_PENDING.Name] || rec.id
    const sourceUrl = f[F_PENDING.Source_URL]
    const state = f[F_PENDING.State_Region] || ''

    if (!sourceUrl || !sourceUrl.includes('datacenter.fyi')) {
      console.log(`[fix-cities] Skipping ${name} - source is not datacenter.fyi`)
      unresolved++
      continue
    }

    try {
      await sleep(FETCH_DELAY)
      const html = await fetchDetailHtml(sourceUrl)

      const nd = extractFromNextData(html)
      let city = nd.city
      let address = nd.address
      if (!city) city = extractCityFromHtmlPattern(html, state)

      if (city && isBlockedCity(city, state)) {
        console.log(`[fix-cities] Blocked contaminated city: ${city}`)
        city = null
      }

      if (!isValidCity(city)) {
        console.log(`[fix-cities] Could not resolve city for ${name}`)
        unresolved++
        continue
      }

      const cleanCity = String(city).trim()

      await sleep(GEOCODE_DELAY)
      const geo = await geocodeCity(cleanCity, state)

      const patchFields = { [F_PENDING.City]: cleanCity }
      if (address && typeof address === 'string' && address.trim()) {
        patchFields[F_PENDING.Address] = address.trim()
      }
      if (geo && geo.source === 'city') {
        patchFields[F_PENDING.Latitude]  = geo.lat
        patchFields[F_PENDING.Longitude] = geo.lng
      }

      await airtablePatch(PENDING_TBL, [{ id: rec.id, fields: patchFields }])

      if (geo && geo.source === 'city') {
        updated++
        console.log(`[fix-cities] Updated ${name}: city=${cleanCity} lat=${geo.lat} lng=${geo.lng}`)
      } else {
        unresolved++
        console.log(`[fix-cities] City "${cleanCity}" saved for ${name} but geocoding failed`)
      }
    } catch (err) {
      errors++
      console.error(`[fix-cities] failed for ${name}: ${err.message}`)
    }
  }

  console.log(`[fix-cities] Updated: ${updated}`)
  console.log(`[fix-cities] Unresolved: ${unresolved}`)
  console.log(`[fix-cities] Errors: ${errors}`)
  console.log('Re-run to process more records.')
}

main().catch((e) => {
  console.error('FAILED:', e && e.message)
  process.exit(1)
})
