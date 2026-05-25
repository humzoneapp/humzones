const EGRID_FACTORS = {
  VA: 0.386, MD: 0.386, PA: 0.386, NJ: 0.386, DE: 0.386,
  DC: 0.386, WV: 0.386, OH: 0.397, IN: 0.535, IL: 0.397,
  MI: 0.397, WI: 0.397, KY: 0.535, NC: 0.320, SC: 0.257,
  GA: 0.306, FL: 0.381, AL: 0.306, MS: 0.381, TN: 0.306,
  TX: 0.421, OK: 0.535, AR: 0.381, LA: 0.381, KS: 0.535,
  MO: 0.535, NE: 0.535, IA: 0.535, MN: 0.397, SD: 0.535,
  ND: 0.535, MT: 0.181, WY: 0.535, CO: 0.535, NM: 0.535,
  AZ: 0.386, UT: 0.535, NV: 0.386, CA: 0.210, OR: 0.106,
  WA: 0.106, ID: 0.106, AK: 0.535, HI: 0.535, NY: 0.244,
  CT: 0.244, MA: 0.244, VT: 0.244, NH: 0.244, ME: 0.244,
  RI: 0.244, DEFAULT: 0.386
}

const INTERNATIONAL_FACTORS = {
  'United Kingdom': 0.233,
  'Germany': 0.385,
  'France': 0.052,
  'Netherlands': 0.372,
  'Ireland': 0.295,
  'Singapore': 0.408,
  'Australia': 0.500,
  'Canada': 0.130,
  'Japan': 0.471,
  'China': 0.581,
  'India': 0.708,
  'Brazil': 0.074,
  'DEFAULT_INTERNATIONAL': 0.400
}

const HYPERSCALE_COMPANIES = ['amazon', 'aws', 'google', 'microsoft',
  'azure', 'meta', 'facebook', 'apple']
const COLO_COMPANIES = ['equinix', 'digital realty', 'cyrusone',
  'databank', 'flexential', 'aligned', 'compass', 'vantage', 'qts',
  'ironmountain', 'coresite', 'ntt', 'switch']

function getDefaultMW(companyName) {
  if (!companyName) return 20
  const lower = companyName.toLowerCase()
  if (HYPERSCALE_COMPANIES.some(h => lower.includes(h))) return 100
  if (COLO_COMPANIES.some(c => lower.includes(c))) return 36
  return 20
}

function getEGridFactor(stateCode, country) {
  if (stateCode) {
    const code = stateCode.toUpperCase().trim()
    // Handle full state names by converting to abbreviation
    const STATE_MAP = {
      'VIRGINIA': 'VA', 'MARYLAND': 'MD', 'PENNSYLVANIA': 'PA',
      'NEW JERSEY': 'NJ', 'DELAWARE': 'DE', 'WEST VIRGINIA': 'WV',
      'OHIO': 'OH', 'INDIANA': 'IN', 'ILLINOIS': 'IL',
      'MICHIGAN': 'MI', 'WISCONSIN': 'WI', 'KENTUCKY': 'KY',
      'NORTH CAROLINA': 'NC', 'SOUTH CAROLINA': 'SC', 'GEORGIA': 'GA',
      'FLORIDA': 'FL', 'ALABAMA': 'AL', 'MISSISSIPPI': 'MS',
      'TENNESSEE': 'TN', 'TEXAS': 'TX', 'OKLAHOMA': 'OK',
      'ARKANSAS': 'AR', 'LOUISIANA': 'LA', 'KANSAS': 'KS',
      'MISSOURI': 'MO', 'NEBRASKA': 'NE', 'IOWA': 'IA',
      'MINNESOTA': 'MN', 'SOUTH DAKOTA': 'SD', 'NORTH DAKOTA': 'ND',
      'MONTANA': 'MT', 'WYOMING': 'WY', 'COLORADO': 'CO',
      'NEW MEXICO': 'NM', 'ARIZONA': 'AZ', 'UTAH': 'UT',
      'NEVADA': 'NV', 'CALIFORNIA': 'CA', 'OREGON': 'OR',
      'WASHINGTON': 'WA', 'IDAHO': 'ID', 'ALASKA': 'AK',
      'HAWAII': 'HI', 'NEW YORK': 'NY', 'CONNECTICUT': 'CT',
      'MASSACHUSETTS': 'MA', 'VERMONT': 'VT', 'NEW HAMPSHIRE': 'NH',
      'MAINE': 'ME', 'RHODE ISLAND': 'RI', 'DISTRICT OF COLUMBIA': 'DC'
    }
    const abbrev = STATE_MAP[code] || code
    if (EGRID_FACTORS[abbrev]) return EGRID_FACTORS[abbrev]
  }
  if (country && country !== 'United States' && country !== 'USA') {
    return INTERNATIONAL_FACTORS[country] ||
           INTERNATIONAL_FACTORS['DEFAULT_INTERNATIONAL']
  }
  return EGRID_FACTORS.DEFAULT
}

function modelFacility(powerMW, coolingType, stateCode, country, companyName) {
  const mw = powerMW || getDefaultMW(companyName)
  const powerWasEstimated = !powerMW
  const isEvaporative = coolingType &&
    coolingType.toLowerCase().includes('evaporat')

  // CO2 tons per year (EPA eGRID / IEA)
  const eGridFactor = getEGridFactor(stateCode, country)
  const co2TonsYear = Math.round(mw * 8760 * eGridFactor)

  // Water gallons per day (ASHRAE WUE ratios)
  const wueGalPerMWh = isEvaporative ? 476 : 132
  const waterGalDay = Math.round(mw * 24 * wueGalPerMWh)

  // Noise dB at facility perimeter
  let noiseDB
  if (mw >= 100) noiseDB = 68
  else if (mw >= 50) noiseDB = 66
  else if (mw >= 25) noiseDB = 64
  else if (mw >= 10) noiseDB = 62
  else noiseDB = 58
  if (isEvaporative) noiseDB = Math.min(72, noiseDB + 2)

  // Risk level
  let riskLevel
  if (mw >= 50) riskLevel = 'HIGH'
  else if (mw >= 15) riskLevel = 'MODERATE'
  else riskLevel = 'LOW'

  // Data source label
  const dataSourceType = powerWasEstimated ? 'Modeled' : 'Mixed'

  return {
    Power_MW: mw,
    powerWasEstimated,
    Noise_DB: noiseDB,
    CO2_Tons_Year: co2TonsYear,
    Water_Gal_Day: waterGalDay,
    Risk_Level: riskLevel,
    Data_Source_Type: dataSourceType,
    // EMF fields intentionally not calculated
    // EMF depends on transformer specs, voltage and conductor geometry
    // which are not available in public permit documents
    // Show "Data not available" on site for all facilities
  }
}

export { modelFacility, getDefaultMW, getEGridFactor,
         EGRID_FACTORS, INTERNATIONAL_FACTORS }
