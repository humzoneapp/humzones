/*
 * Match unresolved Pending_Facilities records against the IM3
 * Open Source Data Center Atlas CSV and backfill coordinates when
 * a high-confidence match is found.
 *
 * Download the CSV from https://data.msdlive.org/records/65g71-a4731
 * and pass its local path as the only positional argument.
 *
 * Usage:
 *   AIRTABLE_KEY=xxx node scripts/match-im3-coordinates.js im3-data.csv
 *
 * Auto-writes lat/lng only when name+company token similarity is
 * >= 0.70 inside the same state. Lower-confidence candidates are
 * logged for manual review and never persist coordinates.
 */

import fs from 'node:fs'

const AIRTABLE_BASE = 'app2FUPqq8VQSwQ64'
const PENDING_TBL = 'tblPB5eHmEBujI4Iq'

const F_PENDING = {
  Name:         'fldvasZvuq88CKcov',
  Company:      'fldGrOrMDrMyhTYQR',
  City:         'fldAtKp2mYqY6iCbB',
  State_Region: 'fldK5ksYKMz07RWa4',
  Latitude:     'fldl37PXyyVv5A5fr',
  Longitude:    'fld9ilqCXidpgBIPT',
}

const AUTO_THRESHOLD   = 0.70
const REVIEW_THRESHOLD = 0.40
const PROXIMITY_KM     = 50
const REVERSE_GEOCODE_DELAY = 1000

const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE}`
const airtableKey = () => process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY || ''
const UA = 'HumZones/1.0 hello@humzones.com'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const STOPWORDS = new Set([
  'data','center','centre','llc','inc','ltd','lp','corp','corporation',
  'company','co','holdings','holding','technologies','technology','tech',
  'campus','facility','project','dc','dcs','phase','building','services',
  'solutions','systems','site','the','of','and','for','at','a','an',
  'i','ii','iii','iv','v','vi','vii','viii','ix','x','north','south',
  'east','west','dba','llp',
])

const STATE_ABBR_TO_NAME = {
  al:'alabama', ak:'alaska', az:'arizona', ar:'arkansas', ca:'california',
  co:'colorado', ct:'connecticut', de:'delaware', fl:'florida', ga:'georgia',
  hi:'hawaii', id:'idaho', il:'illinois', in:'indiana', ia:'iowa',
  ks:'kansas', ky:'kentucky', la:'louisiana', me:'maine', md:'maryland',
  ma:'massachusetts', mi:'michigan', mn:'minnesota', ms:'mississippi', mo:'missouri',
  mt:'montana', ne:'nebraska', nv:'nevada', nh:'new hampshire', nj:'new jersey',
  nm:'new mexico', ny:'new york', nc:'north carolina', nd:'north dakota', oh:'ohio',
  ok:'oklahoma', or:'oregon', pa:'pennsylvania', ri:'rhode island', sc:'south carolina',
  sd:'south dakota', tn:'tennessee', tx:'texas', ut:'utah', vt:'vermont',
  va:'virginia', wa:'washington', wv:'west virginia', wi:'wisconsin', wy:'wyoming',
  dc:'district of columbia',
}

function normalizeState(s) {
  if (!s) return ''
  const low = String(s).trim().toLowerCase()
  if (STATE_ABBR_TO_NAME[low]) return STATE_ABBR_TO_NAME[low]
  return low
}

function statesMatch(a, b) {
  if (!a || !b) return false
  return normalizeState(a) === normalizeState(b)
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

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const toRad = (d) => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// Minimal RFC-ish CSV parser: handles quoted fields with embedded
// commas, newlines, and escaped quotes ("").
function parseCSV(text) {
  const rows = []
  let row = []
  let cell = ''
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ }
        else { inQ = false }
      } else {
        cell += c
      }
    } else {
      if (c === '"') {
        inQ = true
      } else if (c === ',') {
        row.push(cell); cell = ''
      } else if (c === '\n' || c === '\r') {
        if (cell !== '' || row.length) {
          row.push(cell); rows.push(row); row = []; cell = ''
        }
        if (c === '\r' && text[i + 1] === '\n') i++
      } else {
        cell += c
      }
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}

function findHeaderIndex(header, candidates) {
  for (const cand of candidates) {
    const i = header.findIndex(h => h === cand)
    if (i >= 0) return i
  }
  for (const cand of candidates) {
    const i = header.findIndex(h => h.includes(cand))
    if (i >= 0) return i
  }
  return -1
}

function loadIm3(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8')
  const rows = parseCSV(text)
  if (!rows.length) throw new Error('CSV is empty')
  const header = rows[0].map(h => String(h || '').toLowerCase().trim())

  const NAME    = findHeaderIndex(header, ['name','facility_name','facility name','data_center_name','data center name','site_name'])
  const COMP    = findHeaderIndex(header, ['operator','company','company_name','company name','owner','operator_name','operator name'])
  const CITY    = findHeaderIndex(header, ['city','locality','town'])
  const COUNTY  = findHeaderIndex(header, ['county','parish'])
  const STATE   = findHeaderIndex(header, ['state','state_region','state region','province','region'])
  const COUNTRY = findHeaderIndex(header, ['country'])
  const LAT     = findHeaderIndex(header, ['latitude','lat','y'])
  const LNG     = findHeaderIndex(header, ['longitude','lng','lon','long','x'])

  if (LAT < 0 || LNG < 0) {
    throw new Error('CSV missing latitude/longitude columns. Header: ' + header.join(','))
  }
  if (NAME < 0) {
    throw new Error('CSV missing name column. Header: ' + header.join(','))
  }

  const entries = []
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    if (!r.length || (r.length === 1 && !r[0])) continue
    const lat = parseFloat(r[LAT])
    const lng = parseFloat(r[LNG])
    if (Number.isNaN(lat) || Number.isNaN(lng)) continue
    const name = String(r[NAME] || '').trim()
    if (!name) continue
    const company = COMP >= 0 ? String(r[COMP] || '').trim() : ''
    const city    = CITY >= 0 ? String(r[CITY] || '').trim() : ''
    const county  = COUNTY >= 0 ? String(r[COUNTY] || '').trim() : ''
    const state   = STATE >= 0 ? String(r[STATE] || '').trim() : ''
    const country = COUNTRY >= 0 ? String(r[COUNTRY] || '').trim() : ''
    entries.push({
      name,
      company,
      city,
      county,
      state,
      country,
      lat,
      lng,
      nameTokens: normalizeTokens(`${name} ${company}`),
    })
  }
  return entries
}

async function airtableList(tableId, { fields, filterByFormula } = {}) {
  const key = airtableKey()
  let all = []
  let offset = null
  do {
    const url = new URL(`${AIRTABLE_API}/${tableId}`)
    url.searchParams.set('pageSize', '100')
    url.searchParams.set('returnFieldsByFieldId', 'true')
    for (const f of (fields || [])) url.searchParams.append('fields[]', f)
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

function stripCountySuffix(s) {
  if (!s) return ''
  return String(s).replace(/\s+county\s*$/i, '').trim()
}

// Reverse-geocode an IM3 lat/lng into a real city/town/village.
// Falls back to the IM3 county name (with "County" stripped) when
// Nominatim does not return a settlement-level address.
async function reverseGeocodeCity(lat, lng, fallbackCounty) {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=10&addressdetails=1`
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } })
    if (!r.ok) {
      console.log(`[reverse-geocode] HTTP ${r.status} for ${lat},${lng}`)
      return stripCountySuffix(fallbackCounty) || null
    }
    const d = await r.json()
    const addr = (d && d.address) || {}
    const city = addr.city || addr.town || addr.village || addr.municipality ||
                 addr.hamlet || addr.suburb || addr.county || ''
    if (city) return stripCountySuffix(city)
    return stripCountySuffix(fallbackCounty) || null
  } catch (err) {
    console.log(`[reverse-geocode] error for ${lat},${lng}: ${err.message}`)
    return stripCountySuffix(fallbackCounty) || null
  }
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

function findBestMatch(pending, im3) {
  const pendingTokens = normalizeTokens(`${pending.name} ${pending.company || ''}`)
  if (!pendingTokens.length) return null

  let pool = im3
  if (pending.state) {
    const filtered = im3.filter(im => statesMatch(im.state, pending.state))
    pool = filtered.length ? filtered : im3
  }

  const pendingCity = pending.city ? String(pending.city).trim().toLowerCase() : ''

  let best = null
  let bestScore = 0
  let bestCityMatch = false
  for (const c of pool) {
    let score = jaccard(pendingTokens, c.nameTokens)
    const cityMatch = pendingCity && c.city && pendingCity === c.city.toLowerCase().trim()
    if (cityMatch) score = Math.min(1, score + 0.15)
    if (score > bestScore) {
      bestScore = score
      best = c
      bestCityMatch = !!cityMatch
    }
  }
  return { match: best, score: bestScore, cityMatch: bestCityMatch, pendingTokens, poolSize: pool.length }
}

async function main() {
  if (!airtableKey()) throw new Error('AIRTABLE_KEY not set')
  const csvPath = process.argv[2]
  if (!csvPath) throw new Error('Usage: node scripts/match-im3-coordinates.js <im3-data.csv>')
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`)

  console.log(`[match-im3] loading ${csvPath}`)
  const im3 = loadIm3(csvPath)
  console.log(`[match-im3] loaded ${im3.length} IM3 entries`)

  console.log('[match-im3] fetching Pending_Facilities with blank Latitude...')
  const filter = `{${F_PENDING.Latitude}}=BLANK()`
  const records = await airtableList(PENDING_TBL, {
    fields: [F_PENDING.Name, F_PENDING.Company, F_PENDING.City, F_PENDING.State_Region, F_PENDING.Latitude],
    filterByFormula: filter,
  })
  console.log(`[match-im3] ${records.length} pending records to check`)

  let updated = 0
  let review = 0
  let none = 0
  let errors = 0

  for (const rec of records) {
    const f = rec.fields || {}
    const pending = {
      name:    f[F_PENDING.Name] || '',
      company: f[F_PENDING.Company] || '',
      city:    f[F_PENDING.City] || '',
      state:   f[F_PENDING.State_Region] || '',
    }

    if (!pending.name) { none++; continue }

    const result = findBestMatch(pending, im3)
    if (!result || !result.match) {
      console.log(`[match-im3] NO CANDIDATES ${pending.name} (state=${pending.state || 'n/a'})`)
      none++
      continue
    }

    const m = result.match
    const score = result.score
    const cityNote = result.cityMatch ? ' [city match]' : ''
    const stateOk = pending.state ? statesMatch(m.state, pending.state) : true

    if (score >= AUTO_THRESHOLD && stateOk) {
      try {
        let resolvedCity = pending.city || ''
        if (!resolvedCity) {
          await sleep(REVERSE_GEOCODE_DELAY)
          resolvedCity = await reverseGeocodeCity(m.lat, m.lng, m.county) || ''
        }
        const patchFields = {
          [F_PENDING.Latitude]:  m.lat,
          [F_PENDING.Longitude]: m.lng,
        }
        if (resolvedCity) patchFields[F_PENDING.City] = resolvedCity
        await airtablePatchOne(PENDING_TBL, rec.id, patchFields)
        updated++
        console.log(`[match-im3] MATCHED ${pending.name} -> "${m.name}" by ${m.company || '?'} in ${resolvedCity || (m.county || '?')}, ${m.state || '?'} (score ${score.toFixed(2)}${cityNote}) lat=${m.lat} lng=${m.lng}`)
      } catch (err) {
        errors++
        console.error(`[match-im3] patch failed for ${pending.name}: ${err.message}`)
      }
    } else if (score >= REVIEW_THRESHOLD) {
      review++
      const reason = stateOk ? `score ${score.toFixed(2)} below auto threshold` : 'state mismatch'
      console.log(`[match-im3] REVIEW ${pending.name} -> closest "${m.name}" by ${m.company || '?'} in ${m.city || '?'}, ${m.state || '?'} (${reason}${cityNote})`)
    } else {
      none++
      console.log(`[match-im3] NO MATCH ${pending.name} (best "${m.name}" score ${score.toFixed(2)})`)
    }
  }

  console.log('---')
  console.log(`SUMMARY: ${updated} matched, ${review} need review, ${none} no match, ${errors} errors`)
  console.log(`Thresholds: auto >= ${AUTO_THRESHOLD}, review >= ${REVIEW_THRESHOLD}`)
  console.log(`Note: PROXIMITY_KM (${PROXIMITY_KM}) is reserved for future use when pending records carry seed coordinates.`)
}

main().catch((e) => {
  console.error('FAILED:', e && e.message)
  process.exit(1)
})
