/*
 * ONE-TIME BACKFILL
 *
 * Walks Pending_Facilities for records with no Latitude and tries
 * to geocode them via Nominatim using the same city+state-with-
 * state-only-fallback strategy as the scraper. Processes up to 50
 * records per run to stay polite with Nominatim.
 *
 * Usage:
 *   AIRTABLE_KEY=xxx node scripts/fix-missing-coordinates.js
 */

const AIRTABLE_BASE = 'app2FUPqq8VQSwQ64'
const PENDING_TBL = 'tblPB5eHmEBujI4Iq'

const F_PENDING = {
  Name:         'fldvasZvuq88CKcov',
  City:         'fldAtKp2mYqY6iCbB',
  State_Region: 'fldK5ksYKMz07RWa4',
  Latitude:     'fldl37PXyyVv5A5fr',
  Longitude:    'fld9ilqCXidpgBIPT',
}

const MAX_PER_RUN = 50
const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE}`
const airtableKey = () => process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY || ''
const UA = 'HumZones/1.0 hello@humzones.com'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

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

async function airtablePatch(tableId, id, fields) {
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

// Returns { lat, lng, source } where source is 'city' for city+state
// matches and 'state' when only the state-level fallback matched.
// Caller decides whether to persist state-level results.
async function geocode(city, stateName) {
  if (!stateName) return null

  if (city) {
    const q = `${city}, ${stateName}, USA`
    const res = await nominatim(q)
    if (res) {
      console.log(`[geocode] matched city+state: ${q}`)
      return { lat: res.lat, lng: res.lng, source: 'city' }
    }
    await sleep(1000)
  }

  const stateQ = `${stateName}, USA`
  const res = await nominatim(stateQ)
  if (res) {
    return { lat: res.lat, lng: res.lng, source: 'state' }
  }
  return null
}

async function main() {
  if (!airtableKey()) throw new Error('AIRTABLE_KEY not set')

  console.log(`[fix-coords] start ${new Date().toISOString()}`)

  const filter = `{${F_PENDING.Latitude}}=BLANK()`
  const records = await airtableList(PENDING_TBL, {
    fields: [F_PENDING.Name, F_PENDING.City, F_PENDING.State_Region, F_PENDING.Latitude],
    filterByFormula: filter,
    maxRecords: MAX_PER_RUN,
  })
  console.log(`[fix-coords] ${records.length} records with missing Latitude (capped at ${MAX_PER_RUN})`)

  let updated = 0
  let unresolved = 0
  let errors = 0

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    const f = rec.fields || {}
    const name = f[F_PENDING.Name] || rec.id
    const city = f[F_PENDING.City] || ''
    const state = f[F_PENDING.State_Region] || ''

    if (!state) {
      console.log(`[fix-coords] ${name}: no State_Region, cannot geocode`)
      unresolved++
      continue
    }

    await sleep(1000)
    const geo = await geocode(city, state)
    if (!geo) {
      unresolved++
      continue
    }
    if (geo.source !== 'city') {
      console.log(`[fix-coords] Skipping ${name} - only state-level coords available`)
      unresolved++
      continue
    }

    try {
      await airtablePatch(PENDING_TBL, rec.id, {
        [F_PENDING.Latitude]:  geo.lat,
        [F_PENDING.Longitude]: geo.lng,
      })
      updated++
      console.log(`[fix-coords] Updated ${name}: lat=${geo.lat} lng=${geo.lng}`)
    } catch (err) {
      errors++
      console.error(`[fix-coords] patch failed for ${name}: ${err.message}`)
    }
  }

  console.log(`SUMMARY: ${updated} updated, ${unresolved} unresolved, ${errors} errors`)
}

main().catch((e) => {
  console.error('FAILED:', e && e.message)
  process.exit(1)
})
