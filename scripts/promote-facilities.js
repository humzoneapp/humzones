/*
 * DAILY PROMOTION CRON
 *
 * Runs every day at 10am UTC via GitHub Actions. Promotes
 * approved pending facilities into the live Facilities table
 * with modeled CO2, water, noise and risk fields populated.
 *
 * Required env: AIRTABLE_KEY
 */

import { modelFacility } from './model-facility.js'

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
  Review_Status:    'fldtWGxecfwKMuqnh',
  Added_To_Registry:'flddLDSFR51A6uQGG',
}

const F_FAC = {
  Name:             'fldirgBJAsorDO4Hm',
  Company:          'fld8602RjMYU6rUcy',
  Address:          'fldM1eSScQK8HD0Fh',
  City:             'fldOmKby6o64HCDZM',
  State_Region:     'fld1euUumpEZCUtZw',
  Country:          'fldIwxc1fkf0xuQCC',
  Latitude:         'fldu15qih7NkG858H',
  Longitude:        'fldurd5s8IAYSi283',
  Power_MW:         'fldfHsnHRCAo4jc8G',
  Facility_Status:  'fldtwqQiagOYC63bJ',
  Risk_Level:       'fldQSnIuVMzqy5USI',
  Source_URL:       'fldqmmexrlbWonhnh',
  Data_Source_Type: 'fld8PCtqL0Mo89BTR',
  Noise_DB:         'flddjx40OHUitHElm',
  CO2_Tons_Year:    'fld9JDojf3TsoMvma',
  Water_Gal_Day:    'fldBDOehZIQlDUHu4',
  Featured:         'flddQ5kUHOQJfpdJj',
  Cooling:          'fldz6gsZg0mFRcfqT',
}

const MAX_PROMOTIONS_PER_RUN = 20
const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE}`
const airtableKey = () => process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY || ''

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

async function main() {
  if (!airtableKey()) throw new Error('AIRTABLE_KEY not set')

  console.log(`[promote] start ${new Date().toISOString()}`)

  const filter = `AND({${F_PENDING.Review_Status}}="Approved - Add to Registry",NOT({${F_PENDING.Added_To_Registry}}))`
  const pending = await airtableList(PENDING_TBL, { maxRecords: MAX_PROMOTIONS_PER_RUN, filterByFormula: filter })
  console.log(`[promote] ${pending.length} approved pending records to promote`)

  let promoted = 0
  let errors = 0

  for (const rec of pending) {
    const f = rec.fields || {}
    const name = f[F_PENDING.Name] || rec.id
    try {
      const powerMW = f[F_PENDING.Power_MW] != null ? Number(f[F_PENDING.Power_MW]) : null
      const stateRegion = f[F_PENDING.State_Region] || ''
      const country = f[F_PENDING.Country] || 'United States'
      const company = f[F_PENDING.Company] || ''

      const model = modelFacility(powerMW, null, stateRegion, country, company)

      const liveFields = {
        [F_FAC.Name]:             name,
        [F_FAC.Company]:          company,
        [F_FAC.Address]:          f[F_PENDING.Address] || '',
        [F_FAC.City]:             f[F_PENDING.City] || '',
        [F_FAC.State_Region]:     stateRegion,
        [F_FAC.Country]:          country,
        [F_FAC.Power_MW]:         model.Power_MW,
        [F_FAC.Facility_Status]:  f[F_PENDING.Facility_Status] || 'Proposed',
        [F_FAC.Risk_Level]:       model.Risk_Level,
        [F_FAC.Source_URL]:       f[F_PENDING.Source_URL] || '',
        [F_FAC.Data_Source_Type]: model.Data_Source_Type,
        [F_FAC.Noise_DB]:         model.Noise_DB,
        [F_FAC.CO2_Tons_Year]:    model.CO2_Tons_Year,
        [F_FAC.Water_Gal_Day]:    model.Water_Gal_Day,
        [F_FAC.Featured]:         false,
      }
      if (f[F_PENDING.Latitude]  != null) liveFields[F_FAC.Latitude]  = Number(f[F_PENDING.Latitude])
      if (f[F_PENDING.Longitude] != null) liveFields[F_FAC.Longitude] = Number(f[F_PENDING.Longitude])

      await airtableCreate(FACILITIES_TBL, liveFields)
      await airtablePatch(PENDING_TBL, rec.id, { [F_PENDING.Added_To_Registry]: true })

      promoted++
      console.log(`[promote] ${name}: ${model.Power_MW}MW ${model.Risk_Level} CO2=${model.CO2_Tons_Year} Water=${model.Water_Gal_Day} Noise=${model.Noise_DB} (${model.Data_Source_Type})`)
    } catch (err) {
      errors++
      console.error(`[promote] failed for ${name}: ${err.message}`)
    }
  }

  console.log(`Promoted ${promoted} facilities to live registry (${errors} errors)`)
}

main().catch((e) => {
  console.error('FAILED:', e && e.message)
  process.exit(1)
})
