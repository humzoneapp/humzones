/*
 * WEEKLY STATUS MONITOR
 *
 * Runs every Saturday at 8am UTC. Picks up to 15 of the
 * oldest Proposed or Building facilities and asks Claude to
 * search the web for status changes. Any flagged change is
 * dropped into Pending_Facilities for human review.
 *
 * Required env: ANTHROPIC_API_KEY, AIRTABLE_KEY
 */

const AIRTABLE_BASE = 'app2FUPqq8VQSwQ64'
const FACILITIES_TBL = 'tblvojPdS6kwMxsex'
const PENDING_TBL = 'tblPB5eHmEBujI4Iq'

const F_FAC = {
  Name:            'fldirgBJAsorDO4Hm',
  Company:         'fld8602RjMYU6rUcy',
  City:            'fldOmKby6o64HCDZM',
  State_Region:    'fld1euUumpEZCUtZw',
  Facility_Status: 'fldtwqQiagOYC63bJ',
}

const F_PENDING = {
  Name:             'fldvasZvuq88CKcov',
  Company:          'fldGrOrMDrMyhTYQR',
  City:             'fldAtKp2mYqY6iCbB',
  State_Region:     'fldK5ksYKMz07RWa4',
  Facility_Status:  'fldfg9XCZ1P2a4456',
  Source_URL:       'fld5tWJxVXbHMwoOj',
  Source_Type:      'fldM8r2O13JIqUYqV',
  Date_Found:       'fldlMqLgz7NZEzxkw',
  Review_Status:    'fldtWGxecfwKMuqnh',
  Notes:            'fldosSF0UTg9fm1Xi',
  Added_To_Registry:'flddLDSFR51A6uQGG',
}

const MAX_FACILITIES = 15
const VALID_STATUSES = new Set(['Proposed','Approved','Building','Operating','Cancelled'])
const AIRTABLE_API = `https://api.airtable.com/v0/${AIRTABLE_BASE}`
const airtableKey = () => process.env.AIRTABLE_KEY || process.env.VITE_AIRTABLE_KEY || ''
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function airtableList(tableId, { fields, filterByFormula, sort, maxRecords } = {}) {
  const key = airtableKey()
  let all = []
  let offset = null
  do {
    const url = new URL(`${AIRTABLE_API}/${tableId}`)
    url.searchParams.set('pageSize', '100')
    url.searchParams.set('returnFieldsByFieldId', 'true')
    for (const f of (fields || [])) url.searchParams.append('fields[]', f)
    if (filterByFormula) url.searchParams.set('filterByFormula', filterByFormula)
    for (let i = 0; i < (sort || []).length; i++) {
      url.searchParams.set(`sort[${i}][field]`, sort[i].field)
      url.searchParams.set(`sort[${i}][direction]`, sort[i].direction || 'asc')
    }
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
      console.log('[monitor] 429 rate limited, waiting 90s and retrying...')
      await sleep(90000)
      continue
    }
    return res
  }
}

function extractJsonObject(text) {
  if (!text) return null
  let t = String(text)
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1]
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start < 0 || end < 0 || end <= start) return null
  try {
    return JSON.parse(t.slice(start, end + 1))
  } catch (err) {
    console.error(`[monitor] JSON parse failed: ${err.message}`)
    return null
  }
}

async function main() {
  if (!airtableKey()) throw new Error('AIRTABLE_KEY not set')
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set')

  console.log(`[monitor] start ${new Date().toISOString()}`)

  const filter = `OR({${F_FAC.Facility_Status}}="Proposed",{${F_FAC.Facility_Status}}="Building")`
  const facilities = await airtableList(FACILITIES_TBL, {
    fields: [F_FAC.Name, F_FAC.Company, F_FAC.City, F_FAC.State_Region, F_FAC.Facility_Status],
    filterByFormula: filter,
    sort: [{ field: 'createdTime', direction: 'asc' }],
    maxRecords: MAX_FACILITIES,
  })
  console.log(`[monitor] ${facilities.length} facilities to check`)

  let changes = 0
  let errors = 0

  for (let i = 0; i < facilities.length; i++) {
    const rec = facilities[i]
    const f = rec.fields || {}
    const name = f[F_FAC.Name] || rec.id
    const company = f[F_FAC.Company] || ''
    const city = f[F_FAC.City] || ''
    const state = f[F_FAC.State_Region] || ''
    const currentStatus = f[F_FAC.Facility_Status] || ''

    try {
      const userPrompt =
        `Search for recent news about ${name} data center by ${company} in ${city}, ${state}. ` +
        `Has its status changed? Has it opened, been cancelled, or expanded?\n` +
        `Current registry status: ${currentStatus}.\n\n` +
        'Return ONLY this JSON:\n' +
        '{\n' +
        '  "status_changed": true or false,\n' +
        '  "new_status": "Proposed" or "Approved" or "Building" or "Operating" or "Cancelled" or null,\n' +
        '  "summary": "one sentence" or null,\n' +
        '  "source_url": "URL" or null\n' +
        '}'

      const res = await callClaudeWithRetry({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
        system: 'You are a data center infrastructure researcher. Only report verifiable status changes from real public sources. Never invent. Return only valid JSON.',
        messages: [{ role: 'user', content: userPrompt }],
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`)
      }
      const data = await res.json()
      const text = (data.content || [])
        .filter(b => b && b.type === 'text')
        .map(b => b.text)
        .join('')

      const parsed = extractJsonObject(text)
      if (!parsed || !parsed.status_changed) {
        console.log(`[monitor] ${name}: no change`)
      } else {
        const newStatus = VALID_STATUSES.has(parsed.new_status) ? parsed.new_status : null
        if (!newStatus) {
          console.log(`[monitor] ${name}: change reported but new_status invalid, skipping`)
        } else if (newStatus === currentStatus) {
          console.log(`[monitor] ${name}: reported new_status matches current, skipping`)
        } else {
          await airtableCreate(PENDING_TBL, {
            [F_PENDING.Name]:             `${name} - STATUS UPDATE`,
            [F_PENDING.Company]:          company,
            [F_PENDING.City]:             city,
            [F_PENDING.State_Region]:     state,
            [F_PENDING.Facility_Status]:  newStatus,
            [F_PENDING.Source_URL]:       parsed.source_url || '',
            [F_PENDING.Source_Type]:      'News Article',
            [F_PENDING.Date_Found]:       new Date().toISOString().slice(0, 10),
            [F_PENDING.Review_Status]:    'Pending Review',
            [F_PENDING.Notes]:            parsed.summary || `Status change detected for ${name}: ${currentStatus} -> ${newStatus}.`,
            [F_PENDING.Added_To_Registry]:false,
          })
          changes++
          console.log(`[monitor] ${name}: ${currentStatus} -> ${newStatus} (flagged for review)`)
        }
      }
    } catch (err) {
      errors++
      console.error(`[monitor] check failed for ${name}: ${err.message}`)
    }

    if (i < facilities.length - 1) await sleep(3000)
  }

  console.log(`SUMMARY: checked ${facilities.length}, ${changes} status updates flagged, ${errors} errors`)
}

main().catch((e) => {
  console.error('FAILED:', e && e.message)
  process.exit(1)
})
