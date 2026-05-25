/*
 * ONE-TIME CLEANUP
 *
 * Clears Pending_Facilities lat/lng for records that were given a
 * Texas state centroid by the earlier geocoder. State centroids are
 * worse than no coordinate because they drop the facility in the
 * wrong place on the map.
 *
 * Match criteria (a record is bad if EITHER is true):
 *   1. Spec range: lat 32.0-33.5 AND lng -99.0 to -96.5
 *   2. Observed Nominatim Texas centroid: lat 31.2638905 lng -98.5456116
 *      (matched within +/- 0.01 degrees)
 *
 * Usage:
 *   AIRTABLE_KEY=xxx node scripts/clear-bad-coordinates.js
 */

const AIRTABLE_BASE = 'app2FUPqq8VQSwQ64'
const PENDING_TBL = 'tblPB5eHmEBujI4Iq'

const F_PENDING = {
  Name:      'fldvasZvuq88CKcov',
  Latitude:  'fldl37PXyyVv5A5fr',
  Longitude: 'fld9ilqCXidpgBIPT',
}

const BATCH_SIZE  = 50
const PATCH_LIMIT = 10
const BATCH_DELAY = 300

const TX_CENTROID_LAT = 31.2638905
const TX_CENTROID_LNG = -98.5456116
const CENTROID_TOL    = 0.01

const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE}`
const airtableKey = () => process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY || ''
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function isBadCoord(lat, lng) {
  if (lat == null || lng == null) return false
  if (lat >= 32.0 && lat <= 33.5 && lng >= -99.0 && lng <= -96.5) return true
  if (Math.abs(lat - TX_CENTROID_LAT) < CENTROID_TOL &&
      Math.abs(lng - TX_CENTROID_LNG) < CENTROID_TOL) return true
  return false
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
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

async function main() {
  if (!airtableKey()) throw new Error('AIRTABLE_KEY not set')

  console.log(`[clear-coords] start ${new Date().toISOString()}`)

  const all = await airtableListAll(PENDING_TBL, [F_PENDING.Name, F_PENDING.Latitude, F_PENDING.Longitude])
  console.log(`[clear-coords] fetched ${all.length} Pending_Facilities records`)

  const bad = []
  for (const rec of all) {
    const f = rec.fields || {}
    const lat = f[F_PENDING.Latitude]
    const lng = f[F_PENDING.Longitude]
    if (isBadCoord(lat, lng)) {
      bad.push({ id: rec.id, name: f[F_PENDING.Name] || rec.id, lat, lng })
    }
  }
  console.log(`[clear-coords] ${bad.length} records match bad-centroid criteria`)

  for (const b of bad) {
    console.log(`[clear-coords] Cleared bad state-centroid coords from ${b.name}`)
  }

  const updates = bad.map(b => ({
    id: b.id,
    fields: {
      [F_PENDING.Latitude]:  null,
      [F_PENDING.Longitude]: null,
    },
  }))

  let cleared = 0
  let errors = 0
  const batches = chunk(updates, BATCH_SIZE)
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    const patchGroups = chunk(batch, PATCH_LIMIT)
    for (const group of patchGroups) {
      try {
        await airtablePatch(PENDING_TBL, group)
        cleared += group.length
      } catch (err) {
        errors += group.length
        console.error(`[clear-coords] patch failed for ${group.length} records: ${err.message}`)
      }
    }
    console.log(`[clear-coords] batch ${i + 1}/${batches.length} done (${cleared} cleared, ${errors} errors)`)
    if (i < batches.length - 1) await sleep(BATCH_DELAY)
  }

  console.log(`COMPLETE: ${cleared} records cleared, ${errors} errors`)
}

main().catch((e) => {
  console.error('FAILED:', e && e.message)
  process.exit(1)
})
