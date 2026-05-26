/*
 * One-shot maintenance script.
 *
 * 1. Clears Power_MW, CO2_Tons_Year, Water_Gal_Day, Noise_DB and
 *    Risk_Level on every record in the live Facilities table.
 *    After this runs, Power_MW must be backfilled from primary
 *    sources before recalculate-facilities.js can rebuild the
 *    modeled outputs.
 *
 * 2. Resets Review_Status to "Pending Review" on every
 *    Pending_Facilities record, including rows previously
 *    approved or rejected.
 *
 * Usage:
 *   AIRTABLE_KEY=xxx node scripts/clear-facilities.js
 */

const AIRTABLE_BASE  = 'app2FUPqq8VQSwQ64'
const FACILITIES_TBL = 'tblvojPdS6kwMxsex'
const PENDING_TBL    = 'tblPB5eHmEBujI4Iq'

const F_FAC = {
  Name:          'fldirgBJAsorDO4Hm',
  Power_MW:      'fldfHsnHRCAo4jc8G',
  CO2_Tons_Year: 'fld9JDojf3TsoMvma',
  Water_Gal_Day: 'fldBDOehZIQlDUHu4',
  Noise_DB:      'flddjx40OHUitHElm',
  Risk_Level:    'fldQSnIuVMzqy5USI',
}

const F_PENDING = {
  Name:          'fldvasZvuq88CKcov',
  Review_Status: 'fldtWGxecfwKMuqnh',
}

const PATCH_BATCH = 10
const PATCH_DELAY = 250

const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE}`
const airtableKey = () => process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY || ''
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function airtableListAll(tableId, fields) {
  const key = airtableKey()
  let all = []
  let offset = null
  do {
    const url = new URL(`${AIRTABLE_API}/${tableId}`)
    url.searchParams.set('pageSize', '100')
    url.searchParams.set('returnFieldsByFieldId', 'true')
    for (const f of (fields || [])) url.searchParams.append('fields[]', f)
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

async function airtablePatchBatch(tableId, records) {
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

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function clearFacilities() {
  console.log('[clear-facilities] fetching Facilities...')
  const records = await airtableListAll(FACILITIES_TBL, [F_FAC.Name])
  console.log(`[clear-facilities] ${records.length} records to clear`)

  const clearFields = {
    [F_FAC.Power_MW]:      null,
    [F_FAC.CO2_Tons_Year]: null,
    [F_FAC.Water_Gal_Day]: null,
    [F_FAC.Noise_DB]:      null,
    [F_FAC.Risk_Level]:    null,
  }

  const batches = chunk(records, PATCH_BATCH)
  let done = 0
  let errors = 0
  for (const batch of batches) {
    const payload = batch.map(r => ({ id: r.id, fields: clearFields }))
    try {
      await airtablePatchBatch(FACILITIES_TBL, payload)
      done += batch.length
      console.log(`[clear-facilities] cleared ${done}/${records.length}`)
    } catch (err) {
      errors += batch.length
      console.error(`[clear-facilities] batch failed (${batch.length} records): ${err.message}`)
    }
    await sleep(PATCH_DELAY)
  }
  console.log(`[clear-facilities] done. cleared=${done} errors=${errors}`)
}

async function resetPendingReviewStatus() {
  console.log('[reset-pending] fetching Pending_Facilities...')
  const records = await airtableListAll(PENDING_TBL, [F_PENDING.Name])
  console.log(`[reset-pending] ${records.length} records to reset`)

  const resetFields = {
    [F_PENDING.Review_Status]: 'Pending Review',
  }

  const batches = chunk(records, PATCH_BATCH)
  let done = 0
  let errors = 0
  for (const batch of batches) {
    const payload = batch.map(r => ({ id: r.id, fields: resetFields }))
    try {
      await airtablePatchBatch(PENDING_TBL, payload)
      done += batch.length
      console.log(`[reset-pending] reset ${done}/${records.length}`)
    } catch (err) {
      errors += batch.length
      console.error(`[reset-pending] batch failed (${batch.length} records): ${err.message}`)
    }
    await sleep(PATCH_DELAY)
  }
  console.log(`[reset-pending] done. reset=${done} errors=${errors}`)
}

async function main() {
  if (!airtableKey()) throw new Error('AIRTABLE_KEY not set')
  console.log(`[clear-facilities] start ${new Date().toISOString()}`)
  await clearFacilities()
  await resetPendingReviewStatus()
  console.log('[clear-facilities] all done')
}

main().catch((e) => {
  console.error('FAILED:', e && e.message)
  process.exit(1)
})
