const { modelFacility } = require('./model-facility')

const AIRTABLE_BASE  = 'app2FUPqq8VQSwQ64'
const FACILITIES_TBL = 'tblvojPdS6kwMxsex'

const F = {
  Name:             'fldirgBJAsorDO4Hm',
  Power_MW:         'fldfHsnHRCAo4jc8G',
  Cooling:          'fldz6gsZg0mFRcfqT',
  State_Region:     'fld1euUumpEZCUtZw',
  Country:          'fldIwxc1fkf0xuQCC',
  Company:          'fld8602RjMYU6rUcy',
  Noise_DB:         'flddjx40OHUitHElm',
  CO2_Tons_Year:    'fld9JDojf3TsoMvma',
  Water_Gal_Day:    'fldBDOehZIQlDUHu4',
  Risk_Level:       'fldQSnIuVMzqy5USI',
  EMF_Fence_High:   'fldgJqJATVnhbgqDC',
  EMF_100m:         'fldQKDZ4VgwpRUfWa',
  Data_Source_Type: 'fld8PCtqL0Mo89BTR',
}

const BATCH_SIZE   = 50
const PATCH_LIMIT  = 10
const BATCH_DELAY  = 300

const airtableKey = () => process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY || ''
const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE}`
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const DRY_RUN = process.argv.includes('--dry-run')

async function airtableListAll(tableId) {
  const key = airtableKey()
  let all = []
  let offset = null
  do {
    const url = new URL(`${AIRTABLE_API}/${tableId}`)
    url.searchParams.set('pageSize', '100')
    url.searchParams.set('returnFieldsByFieldId', 'true')
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

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function getCompanyName(fields) {
  const raw = fields[F.Company]
  if (!raw) return null
  if (Array.isArray(raw)) {
    const first = raw[0]
    if (first && typeof first === 'object' && first.name) return first.name
    return typeof first === 'string' ? first : null
  }
  if (typeof raw === 'object' && raw.name) return raw.name
  return typeof raw === 'string' ? raw : null
}

function getStringField(fields, fieldId) {
  const v = fields[fieldId]
  if (v == null) return null
  if (Array.isArray(v)) return v[0] || null
  if (typeof v === 'object' && v.name) return v.name
  return v
}

async function main() {
  if (!airtableKey()) throw new Error('AIRTABLE_KEY (or VITE_AIRTABLE_KEY) not set')

  console.log(`[recalculate-facilities] start ${new Date().toISOString()}`)
  console.log(`[recalculate-facilities] mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE WRITE'}`)

  const records = await airtableListAll(FACILITIES_TBL)
  console.log(`[recalculate-facilities] fetched ${records.length} facilities`)

  const updates = []
  let skipped = 0

  for (const rec of records) {
    const fields = rec.fields || {}
    const name = fields[F.Name] || rec.id

    const powerMW = fields[F.Power_MW] || null
    const cooling = getStringField(fields, F.Cooling)
    const stateRegion = getStringField(fields, F.State_Region)
    const country = getStringField(fields, F.Country)
    const companyName = getCompanyName(fields)

    if (!powerMW && !companyName) {
      console.log(`[skip] ${name}: no Power_MW and no Company reference`)
      skipped++
      continue
    }

    const model = modelFacility(powerMW, cooling, stateRegion, country, companyName)

    const oldCO2   = fields[F.CO2_Tons_Year] ?? 'null'
    const oldWater = fields[F.Water_Gal_Day] ?? 'null'
    const oldNoise = fields[F.Noise_DB] ?? 'null'
    const oldRisk  = fields[F.Risk_Level] ?? 'null'

    console.log(
      `[${name}]: CO2 ${oldCO2}->${model.CO2_Tons_Year}, ` +
      `Water ${oldWater}->${model.Water_Gal_Day}, ` +
      `Noise ${oldNoise}->${model.Noise_DB}, ` +
      `Risk ${oldRisk}->${model.Risk_Level}`
    )

    updates.push({
      id: rec.id,
      fields: {
        [F.Noise_DB]:         model.Noise_DB,
        [F.CO2_Tons_Year]:    model.CO2_Tons_Year,
        [F.Water_Gal_Day]:    model.Water_Gal_Day,
        [F.Risk_Level]:       model.Risk_Level,
        [F.Data_Source_Type]: model.Data_Source_Type,
        [F.EMF_Fence_High]:   null,
        [F.EMF_100m]:         null,
      },
    })
  }

  console.log(`[recalculate-facilities] prepared ${updates.length} updates, ${skipped} skipped`)

  let written = 0
  let errors = 0

  if (DRY_RUN) {
    console.log('[recalculate-facilities] DRY RUN: skipping Airtable writes')
  } else {
    const batches = chunk(updates, BATCH_SIZE)
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]
      const patchGroups = chunk(batch, PATCH_LIMIT)
      for (const group of patchGroups) {
        try {
          await airtablePatch(FACILITIES_TBL, group)
          written += group.length
        } catch (err) {
          errors += group.length
          console.error(`[error] patch failed for ${group.length} records: ${err.message}`)
        }
      }
      console.log(`[recalculate-facilities] batch ${i + 1}/${batches.length} done (${written} written, ${errors} errors)`)
      if (i < batches.length - 1) await sleep(BATCH_DELAY)
    }
  }

  const updatedCount = DRY_RUN ? updates.length : written
  console.log(`COMPLETE: Updated ${updatedCount} records, skipped ${skipped}, ${errors} errors`)
  console.log('EMF fields cleared on all records')
}

main().catch((e) => {
  console.error('FAILED:', e && e.message)
  process.exit(1)
})
