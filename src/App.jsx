// Build marker: 2026-05-19, force fresh Vercel deployment.
import { useState, useEffect, useRef, useCallback } from "react";

// ─── AIRTABLE CONNECTION ───────────────────────────────────────────────────────
const BASE   = "app2FUPqq8VQSwQ64";
const KEY    = import.meta.env.VITE_AIRTABLE_KEY;
const APIURL = `https://api.airtable.com/v0/${BASE}`;
const HDR    = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

// ─── ROTATING FACILITY PHOTOS ─────────────────────────────────────────────────
// Assigned deterministically per facility (by Airtable record ID) so a given
// facility always shows the same photo. Overridden by Photo_URL when present.
const FACILITY_PHOTOS = [
  "https://images.unsplash.com/photo-1584169417032-d34e8d805e8b?w=800&q=80",
  "https://images.unsplash.com/photo-1580106815433-a5b1d1d53d85?w=800&q=80",
  "https://images.unsplash.com/photo-1683322499436-f4383dd59f5a?w=800&q=80",
  "https://images.unsplash.com/photo-1695668548342-c0c1ad479aee?w=800&q=80",
  "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=800&q=80"
];

const delay = ms => new Promise(res => setTimeout(res, ms));

// Fetch every record from a table. Airtable returns at most 100 records per
// response and includes an `offset` cursor when more pages remain; we loop
// until no cursor comes back. A page that fails transiently (rate limit,
// server error, network blip) is retried so a single failure can never
// silently truncate the result set. If a page ultimately fails, the whole
// call throws rather than returning a partial set.
async function apiFetch(table, params = {}) {
  let all = [], offset = null;
  do {
    const url = new URL(`${APIURL}/${table}`);
    Object.entries(params).forEach(([k,v]) => {
      if (Array.isArray(v)) v.forEach(item => url.searchParams.append(k, item));
      else url.searchParams.set(k, v);
    });
    if (offset) url.searchParams.set("offset", offset);
    url.searchParams.set("pageSize", "100"); // 100 = Airtable maximum

    let d = null;
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await fetch(url.toString(), { headers: HDR });
      } catch {
        if (attempt < 3) { await delay(500 * (attempt + 1)); continue; }
        throw new Error(`apiFetch(${table}): network error after retries`);
      }
      if (r.ok) { d = await r.json(); break; }
      // Rate limits (429) and server errors (5xx) are transient: retry.
      if ((r.status === 429 || r.status >= 500) && attempt < 3) {
        await delay(500 * (attempt + 1));
        continue;
      }
      throw new Error(`apiFetch(${table}): Airtable responded ${r.status}`);
    }

    all = [...all, ...(d.records || [])];
    offset = d.offset || null; // present only while more pages remain
  } while (offset);
  return all.map(r => ({ id: r.id, ...r.fields }));
}

// Lightweight field set for the initial Facilities load: just what the
// dropdowns and facility stat cards need. Heavy/rarely-used fields
// (Address, Nearby, etc.) are lazy-loaded per facility on selection.
const FACILITY_LIST_FIELDS = [
  "Name","Company","Country","State_Region","City","Facility_Status",
  "Risk_Level","Power_MW","Noise_DB","CO2_Tons_Year","Water_Gal_Day",
  "EMF_Fence_High","EMF_100m","Latitude","Longitude","Opened","Photo_URL",
];

// Fetch a single full record by ID (all fields), for the detail view.
async function fetchRecord(table, id) {
  try {
    const r = await fetch(`${APIURL}/${table}/${id}`, { headers: HDR });
    if (!r.ok) return null;
    const d = await r.json();
    return { id: d.id, ...d.fields };
  } catch { return null; }
}

// apiFetch with a short-lived localStorage cache, so repeat visitors skip
// the network round trip while listings still stay current. Falls through
// to a fresh fetch if the cache is missing, stale, corrupt, or unavailable.
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function cachedFetch(table, params = {}) {
  // v4: cache key bumped to immediately discard any stale cached sets;
  // short TTL (see CACHE_TTL) keeps listings current without further bumps.
  const cacheKey = `hz_cache_v4_${table}`;
  let cached = null;
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.data)) {
        cached = parsed;
        if (Date.now() - parsed.ts < CACHE_TTL) {
          console.log(`[HumZones] ${table}: served ${parsed.data.length} records from localStorage cache "${cacheKey}" (age ${Math.round((Date.now()-parsed.ts)/1000)}s). Clear this key for a fresh fetch.`);
          return parsed.data;
        }
      }
    }
  } catch { /* corrupt or unavailable cache: ignore and fetch fresh */ }

  try {
    // apiFetch only resolves when every page was retrieved, so a partial
    // result can never be cached as if it were complete.
    const data = await apiFetch(table, params);
    console.log(`[HumZones] ${table}: fetched ${data.length} records fresh from Airtable`);
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data }));
    } catch { /* quota exceeded or unavailable: skip caching */ }
    return data;
  } catch (err) {
    // Fresh fetch failed: fall back to stale cache rather than nothing.
    if (cached) return cached.data;
    throw err;
  }
}

async function postReport(fields) {
  if (fields._hp) return false; // honeypot
  try {
    const r = await fetch(`${APIURL}/Reports`, {
      method: "POST",
      headers: HDR,
      body: JSON.stringify({ fields }),
    });
    if(!r.ok) {
      const err = await r.json().catch(()=>({error:"unknown"}));
      console.error("Airtable error:", JSON.stringify(err));
    }
    return r.ok;
  } catch(e) {
    console.error("Network error:", e);
    return false;
  }
}

// POST a row to the Emails capture table. Used by the Near Me email gate.
// Quietly returns false on failure so the caller can still unlock optimistically.
async function postEmail(fields) {
  try {
    const r = await fetch(`${APIURL}/Emails`, {
      method: "POST",
      headers: HDR,
      body: JSON.stringify({ fields }),
    });
    if(!r.ok){
      const err = await r.json().catch(()=>({error:"unknown"}));
      console.error("Email capture error:", JSON.stringify(err));
    }
    return r.ok;
  } catch(e){
    console.error("Email capture network error:", e);
    return false;
  }
}

// ─── OPENSTREETMAP STATIC MAP ─────────────────────────────────────────────────
// Uses OSM tile server to create a map image centered on facility coordinates
const getOSMMapUrl = (lat, lng, name) => {
  if (!lat || !lng) return null;
  // Use staticmap.openstreetmap.de for static map images
  const zoom = 15;
  const width = 800;
  const height = 350;
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lng}&zoom=${zoom}&size=${width}x${height}&markers=${lat},${lng},red-pushpin`;
};

// Fallback: OpenTopoMap (more detail for industrial areas)
const getOSMFallback = (lat, lng) => {
  if (!lat || !lng) return null;
  const zoom = 15;
  return `https://maps.geoapify.com/v1/staticmap?style=osm-bright&width=800&height=350&center=lonlat:${lng},${lat}&zoom=${zoom}&marker=lonlat:${lng},${lat};color:%23ef4444;size:medium`;
};

// Google Maps URL using coordinates (more accurate than address)
const getGoogleMapsUrl = (lat, lng, address, name) => {
  if (lat && lng) {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  }
  const q = encodeURIComponent(address || name || "data center");
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
};

// Haversine distance in kilometres between two lat/lng points.
const distanceKm = (lat1, lon1, lat2, lon2) => {
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

// Colour the "X km away" badge by how close a facility is.
const distColor = km => km < 1 ? "#ef4444" : km < 5 ? "#f97316" : km < 25 ? "#eab308" : "#3b82f6";

// Build a human-readable location string
const buildLocationString = (dc) => {
  const parts = [];
  if (dc.Address && dc.Address.length > 5) parts.push(dc.Address);
  else {
    if (dc.City) parts.push(dc.City);
    if (dc.State_Region) parts.push(dc.State_Region);
    if (dc.Country) parts.push(dc.Country);
  }
  return parts.join(", ");
};

// ─── ICONS ────────────────────────────────────────────────────────────────────
const Icon = ({ name, size = 24, color = "currentColor" }) => {
  const s = { width: size, height: size, display: "inline-block", flexShrink: 0, verticalAlign: "middle" };
  const p = { fill: "none", stroke: color, strokeWidth: 2.2, strokeLinecap: "round", strokeLinejoin: "round" };
  const icons = {
    globe:     <svg style={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" {...p}/><path d="M2 12h20M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20" {...p}/></svg>,
    pin:       <svg style={s} viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0z" {...p}/><circle cx="12" cy="10" r="3" {...p}/></svg>,
    close:     <svg style={s} viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12" {...p}/></svg>,
    chevDown:  <svg style={s} viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" {...p}/></svg>,
    chevUp:    <svg style={s} viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6" {...p}/></svg>,
    alert:     <svg style={s} viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" {...p}/><line x1="12" y1="9" x2="12" y2="13" {...p}/><circle cx="12" cy="17" r=".5" fill={color} stroke={color} strokeWidth="1"/></svg>,
    sound:     <svg style={s} viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" {...p}/><path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14" {...p}/></svg>,
    head:      <svg style={s} viewBox="0 0 24 24"><circle cx="12" cy="9" r="6" {...p}/><path d="M12 15v6M9 21h6M10 8l1 2M14 8l-1 2" {...p}/></svg>,
    dizzy:     <svg style={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" {...p}/><path d="M8 8l2 2m4-2l-2 2M8 16l2-2m4 2l-2-2" {...p}/></svg>,
    nausea:    <svg style={s} viewBox="0 0 24 24"><circle cx="12" cy="10" r="7" {...p}/><path d="M9 13s1 2 3 2 3-2 3-2M12 17v3M10 19h4" {...p}/></svg>,
    sleep:     <svg style={s} viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" {...p}/><path d="M8 11h4l-3 4h4" {...p}/></svg>,
    anxiety:   <svg style={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" {...p}/><path d="M12 8v4" {...p}/><circle cx="12" cy="16" r=".6" fill={color} stroke="none"/></svg>,
    ear:       <svg style={s} viewBox="0 0 24 24"><path d="M6 8a6 6 0 0112 0c0 4-3 5-3 9a3 3 0 11-6 0" {...p}/><circle cx="12" cy="13" r="1.5" {...p}/></svg>,
    smoke:     <svg style={s} viewBox="0 0 24 24"><path d="M4 16h16M4 12h16M8 8c0-2 2-2 2-4M14 8c0-2 2-2 2-4" {...p}/></svg>,
    cancer:    <svg style={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" {...p}/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12" {...p}/></svg>,
    heart:     <svg style={s} viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" {...p}/></svg>,
    lung:      <svg style={s} viewBox="0 0 24 24"><path d="M12 3v11M12 8c-2 0-5 1.5-5 5s1 5 4 5 1-5 1-7V8zM12 8c2 0 5 1.5 5 5s-1 5-4 5-1-5-1-7V8z" {...p}/></svg>,
    brain:     <svg style={s} viewBox="0 0 24 24"><path d="M12 5c-3.5 0-6 2.5-6 6 0 1.5.5 3 1.5 4L6 20h4l.5-2h3l.5 2h4l-1.5-5c1-1 1.5-2.5 1.5-4 0-3.5-2.5-6-6-6z" {...p}/></svg>,
    baby:      <svg style={s} viewBox="0 0 24 24"><circle cx="12" cy="7" r="4" {...p}/><path d="M8 11C5 12 3 15 3 18h18c0-3-2-6-5-7" {...p}/></svg>,
    moon:      <svg style={s} viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" {...p}/></svg>,
    dna:       <svg style={s} viewBox="0 0 24 24"><path d="M4 4c4 4 12 4 16 8s-4 12-8 12M20 4c-4 4-12 4-16 8s4 12 8 12M6.5 7.5h11M6.5 16.5h11" {...p}/></svg>,
    kids:      <svg style={s} viewBox="0 0 24 24"><circle cx="9" cy="6" r="3" {...p}/><path d="M6 21v-2a4 4 0 014-4h.5" {...p}/><circle cx="17" cy="10" r="2.5" {...p}/><path d="M14.5 21v-1.5a3.5 3.5 0 017 0V21" {...p}/></svg>,
    question:  <svg style={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" {...p}/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" {...p}/><circle cx="12" cy="17" r=".6" fill={color} stroke="none"/></svg>,
    number:    <svg style={s} viewBox="0 0 24 24"><path d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18" {...p}/></svg>,
    action:    <svg style={s} viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" {...p}/></svg>,
    community: <svg style={s} viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" {...p}/><circle cx="9" cy="7" r="4" {...p}/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" {...p}/></svg>,
    check:     <svg style={s} viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12" {...p}/></svg>,
    external:  <svg style={s} viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" {...p}/></svg>,
    power:     <svg style={s} viewBox="0 0 24 24"><path d="M18.36 6.64a9 9 0 11-12.73 0M12 2v10" {...p}/></svg>,
    water:     <svg style={s} viewBox="0 0 24 24"><path d="M12 2.69l5.66 5.66a8 8 0 11-11.31 0L12 2.69z" {...p}/></svg>,
    noise:     <svg style={s} viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" {...p}/><path d="M15.54 8.46a5 5 0 010 7.07" {...p}/></svg>,
    emf:       <svg style={s} viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" {...p}/></svg>,
    co2:       <svg style={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" {...p}/><path d="M12 8v8M8 12h8" {...p}/></svg>,
    star:      <svg style={s} viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" {...p}/></svg>,
    doc:       <svg style={s} viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" {...p}/><polyline points="14 2 14 8 20 8" {...p}/><line x1="16" y1="13" x2="8" y2="13" {...p}/><line x1="16" y1="17" x2="8" y2="17" {...p}/></svg>,
    megaphone: <svg style={s} viewBox="0 0 24 24"><path d="M3 11l19-9-9 19-2-8-8-2z" {...p}/></svg>,
    monitor:   <svg style={s} viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" {...p}/><path d="M8 21h8M12 17v4" {...p}/></svg>,
    group:     <svg style={s} viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" {...p}/><circle cx="9" cy="7" r="4" {...p}/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" {...p}/></svg>,
    shield:    <svg style={s} viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" {...p}/></svg>,
    navigate:  <svg style={s} viewBox="0 0 24 24"><polygon points="3 11 22 2 13 21 11 13 3 11" {...p}/></svg>,
    map:       <svg style={s} viewBox="0 0 24 24"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" {...p}/><line x1="8" y1="2" x2="8" y2="18" {...p}/><line x1="16" y1="6" x2="16" y2="22" {...p}/></svg>,
    satellite: <svg style={s} viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" {...p}/><path d="M12 1v4M12 19v4M1 12h4M19 12h4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" {...p}/></svg>,
  };
  return icons[name] || icons.alert;
};

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const STATUS = {
  OPERATING: { label:"Operating",          color:"#ef4444" },
  BUILDING:  { label:"Under Construction", color:"#f97316" },
  PROPOSED:  { label:"Proposed",           color:"#3b82f6" },
  APPROVED:  { label:"Approved",           color:"#8b5cf6" },
};
const RISK_C = { HIGH:"#ef4444", MODERATE:"#f97316", "LOW-MODERATE":"#3b82f6" };

const SYMPTOMS = {
  HIGH:[
    {icon:"sound",  t:"The Constant Hum",         s:5, d:"A low drone like a refrigerator that never turns off, felt in the chest, through walls, through floors. Reported audible up to 4 miles in quiet areas. Worst between 2 and 4am when all other ambient noise disappears. Unlike high-frequency noise which walls block effectively, low-frequency sound below 200Hz passes through concrete, brick, and insulation with almost no reduction. Many residents describe eventually being unable to sleep in their own bedroom and moving to other parts of the house, only to find the vibration there too."},
    {icon:"head",   t:"Chronic Headaches",         s:5, d:"The single most commonly reported symptom across every documented data center community complaint, from Loudoun County Virginia to Granbury Texas to rural Australia. Residents consistently describe a specific pattern: headaches that begin within an hour of being home, that improve noticeably when they leave the area for a day or more, and that return when they come back. This leave-and-return pattern is a strong indicator of environmental cause rather than other factors. Over-the-counter pain medication becomes a daily necessity for many."},
    {icon:"dizzy",  t:"Dizziness and Vertigo",     s:4, d:"Infrasound, vibration below the conscious threshold of hearing, physically disrupts the vestibular system in the inner ear that controls balance. You do not need to hear a sound for it to affect you. In Granbury TX, where residents sued NextEra Energy over a solar and battery facility, vertigo was severe enough that some residents could not drive safely. The effect is most pronounced during peak operational periods and load testing when power draw and associated vibration spikes."},
    {icon:"nausea", t:"Nausea",                    s:4, d:"A National Library of Medicine study demonstrated that infrasound exposure above 100 dB can affect cardiac function and trigger nausea within one hour of exposure. Residents near large facilities describe waves of nausea that correlate with generator tests and load-testing events. Children are particularly susceptible and often cannot articulate what they are feeling, instead becoming irritable, refusing food, or complaining of stomach aches that their parents eventually connect to facility operations after keeping detailed logs."},
    {icon:"sleep",  t:"Sleep Completely Disrupted", s:5, d:"Sleep disruption is the mechanism through which most other health effects compound and worsen. Low-frequency noise prevents the brain from entering deep slow-wave sleep even at sound levels far below what would be consciously bothersome. Residents report lying awake for hours, waking at 2am unable to return to sleep, and accumulating a sleep debt over months and years that affects every aspect of their health. Children who need 10 or more hours for healthy brain development are particularly harmed. Multiple residents in documented cases reported that their children's school performance declined measurably after a nearby facility became operational."},
    {icon:"anxiety",t:"Anxiety and Panic Attacks", s:4, d:"The body's nervous system responds to persistent low-frequency vibration as a threat signal even when the conscious mind cannot identify the source. Fight-or-flight activation becomes chronic. Cortisol and adrenaline remain elevated. Residents describe a persistent background anxiety that has no psychological explanation, that feels physical rather than mental, and that disappeared or dramatically reduced when they stayed away from their home for extended periods. One Prince William County Virginia resident described it as feeling like something terrible was about to happen at all times. This kind of chronic stress independently increases cardiovascular disease risk."},
    {icon:"ear",    t:"Tinnitus and Hearing Damage",s:3, d:"Tinnitus, a permanent ringing or buzzing in the ears, has been reported by residents near multiple facilities. In Granbury Texas, the lawsuit specifically named permanent tinnitus and hearing damage in both adults and children as injuries caused by a nearby industrial facility. Children's auditory systems are still developing and are more vulnerable to noise-induced damage. The insidious aspect of noise-induced hearing damage is that it is cumulative, painless, and irreversible. By the time residents notice it, damage has already occurred."},
    {icon:"smoke",  t:"Diesel Exhaust and Air Quality",s:4, d:"Backup diesel generators at large data centers are tested monthly for 30 to 90 minutes, releasing diesel particulate matter classified by the WHO as a Group 1 carcinogen, the same category as asbestos and tobacco smoke. During these tests, residents within half a mile commonly report visible black or grey smoke and a strong diesel smell. Children playing outside, people gardening, and anyone with open windows during these events receive an uncontrolled exposure to a substance with no established safe level. Residents should request the facility's generator test schedule in writing and keep windows and doors closed on test days."},
  ],
  MODERATE:[
    {icon:"sound",  t:"Persistent Background Hum", s:3, d:"A continuous low-frequency sound present day and night, most noticeable after 10pm when other ambient noise drops. Many residents describe it as more of a felt vibration or pressure than a heard sound, particularly in rooms closest to the facility. Over weeks and months this becomes a source of significant psychological stress even for those who initially dismissed it, because there is no relief from it even inside the home."},
    {icon:"head",   t:"Intermittent Headaches",    s:3, d:"Headaches that correlate with generator test cycles and operational peaks. Residents at this distance often notice the pattern only after weeks of tracking, because the frequency does not immediately suggest an environmental source. Keeping a symptom log with timestamps allows you to identify correlations with known facility events."},
    {icon:"sleep",  t:"Disrupted Sleep Quality",   s:3, d:"Even when residents do not fully wake, low-frequency noise at moderate levels disrupts sleep architecture, reducing the time spent in deep restorative sleep. The result is waking feeling unrefreshed despite spending adequate hours in bed, a pattern that compounds over months and affects mood, immunity, cognitive function, and cardiovascular health."},
    {icon:"smoke",  t:"Diesel Exhaust During Tests",s:2, d:"Monthly generator tests still expose you to diesel PM2.5, a classified carcinogen, for 30 to 90 minutes each episode. Wind direction determines how much reaches you on any given test day. Residents at this distance should track wind patterns and keep windows closed when wind is blowing from the facility direction on the days tests typically occur."},
    {icon:"anxiety",t:"Background Stress and Irritability",s:2, d:"Chronic low-level noise exposure activates the stress response at levels below conscious awareness. Residents at moderate distance often report increased irritability, difficulty concentrating, and a vague sense of unease that they initially attribute to other causes. If these symptoms improve significantly during extended time away from home, environmental noise is likely a contributing factor."},
  ],
  "LOW-MODERATE":[
    {icon:"sound",  t:"Mild Low-Frequency Noise",  s:2, d:"Present around the clock but less immediately intrusive than at closer distances. Low-frequency sound components travel significantly further than standard decibel measurements suggest because they diffract around obstacles and penetrate structures more effectively than higher frequencies. Quiet nights, open terrain, and certain atmospheric conditions can carry this sound further than expected."},
    {icon:"smoke",  t:"Diesel Exhaust During Tests",s:2, d:"Monthly generator tests produce diesel exhaust for 30 to 90 minutes regardless of your distance. The WHO Group 1 carcinogen classification for diesel PM2.5 applies at any exposure level because no safe threshold has been established. Keep windows closed on test days, particularly if wind is blowing from the direction of the facility."},
    {icon:"sleep",  t:"Occasional Sleep Disturbance",s:1, d:"Some residents at this distance report occasional sleep disruption coinciding with generator tests or peak load events that cause facility noise to temporarily increase. Noting whether sleep disturbances correlate with known operational events helps determine whether the facility is a contributing factor."},
  ],
};

const LONGTERM = [
  {icon:"cancer",c:"#ef4444",t:"Cancer Risk",
   sh:"Diesel exhaust is a WHO Group 1 carcinogen. Power-frequency EMF is classified possibly carcinogenic for childhood leukemia.",
   lo:"Two entirely separate biological pathways elevate cancer risk for residents near large data centers. The first is diesel particulate matter from backup generator tests. The WHO's International Agency for Research on Cancer placed diesel exhaust in Group 1, its highest carcinogen category, the same as asbestos, benzene, and tobacco smoke. There is no established safe exposure threshold. A 2025 peer-reviewed study projected that data center diesel emissions could cause over 1,000 premature deaths annually in the United States by 2030. The second pathway is power-frequency electromagnetic fields from the high-voltage substations and transmission infrastructure that every large data center requires. In 2002, the IARC classified these fields as Group 2B, possibly carcinogenic, based primarily on epidemiological studies showing elevated childhood leukemia rates in homes with chronic exposure above 3 to 4 milligauss. To understand how low that threshold is: the legal limit in the United States is 2,000 milligauss, which is 500 times higher than where studies found elevated cancer risk. This is not a fringe concern. It is a formally classified carcinogen classification from the world's leading cancer research body, applied at exposure levels routinely found near data center infrastructure.",
   stat:"Around 1,300 projected premature US deaths annually from data center air pollution by 2030",src:"arXiv 2412.06288, 2025",url:"https://arxiv.org/abs/2412.06288"},
  {icon:"heart", c:"#f97316",t:"Heart Disease and Stroke",
   sh:"Chronic noise elevates blood pressure and stress hormones. Diesel PM2.5 inflames arterial walls. Both are independent cardiovascular risk factors.",
   lo:"The cardiovascular evidence is among the most robust in environmental health research. Chronic exposure to environmental noise at levels found near large industrial facilities independently raises blood pressure, elevates cortisol and adrenaline, increases heart rate variability, and over years measurably increases the risk of heart attack and stroke. This is not mediated by stress or lifestyle. It is a direct physiological response to the auditory and sub-auditory stimulation that the nervous system cannot habituate to, because it never fully stops. Diesel PM2.5 adds a separate and compounding pathway: fine particulate matter small enough to cross the lung-blood barrier lodges in arterial walls and triggers inflammatory responses that accelerate atherosclerosis, the arterial hardening that underlies most heart attacks. A 2025 ScienceDirect analysis of industrial pollution data found that communities near large diesel-generator-dependent facilities showed measurably higher rates of cardiovascular hospitalization compared to matched populations without such exposure.",
   stat:"Long-term industrial noise exposure independently linked to hypertension, heart attack, and stroke",src:"ScienceDirect, 2025",url:"https://www.sciencedirect.com"},
  {icon:"lung",  c:"#eab308",t:"Lungs, Breathing, and Asthma",
   sh:"Diesel PM2.5 crosses directly from your lungs into your bloodstream. No safe exposure level has ever been established.",
   lo:"Particulate matter smaller than 2.5 microns, called PM2.5, is fine enough to bypass the upper respiratory system's filtering mechanisms and reach the deepest parts of the lungs, where it crosses directly into the bloodstream. The landmark Harvard Six Cities Study, one of the most influential air quality studies ever conducted, found a linear relationship between PM2.5 exposure and mortality with no lower threshold where risk disappeared. Every increment of exposure carries proportional risk. For people who already have asthma, COPD, or reduced lung function, diesel PM2.5 is particularly dangerous as a trigger and as a cause of accelerated disease progression. A 2025 modelling study projected that data centers in the United States could cause over 600,000 asthma episodes per year by 2030 as the sector's diesel generator dependency grows alongside its power requirements.",
   stat:"600,000 projected asthma episodes per year from US data centers by 2030",src:"arXiv 2412.06288, 2025",url:"https://arxiv.org/abs/2412.06288"},
  {icon:"brain", c:"#8b5cf6",t:"Mental Health and Cognitive Function",
   sh:"Chronic noise, lost sleep, and feeling powerless are a documented recipe for anxiety, depression, and cognitive decline.",
   lo:"The mental health burden on residents near data centers is both direct and indirect. Directly, chronic exposure to low-frequency noise and infrasound independently causes irritability, anxiety, difficulty concentrating, and depression through physiological mechanisms that do not require psychological stress. The nervous system responds to persistent low-level vibration as a background threat signal, keeping the stress response mildly activated around the clock. Indirectly, the compounding effects of chronic sleep deprivation, the frustration of reporting symptoms that officials dismiss, the fear for children's health, and the financial trap of owning a home near a facility that has made it difficult to sell or leave creates a documented and severe psychological burden. Residents in Prince William County Virginia, where data center density is among the highest in the world, have formed support groups specifically to address the mental health crisis among affected residents.",
   stat:"Chronic industrial noise independently linked to anxiety, depression, and cognitive impairment",src:"US News, April 2026",url:"https://www.usnews.com"},
  {icon:"baby",  c:"#3b82f6",t:"Reproductive Health and Pregnancy",
   sh:"ELF-EMF exposure has been linked to miscarriage risk. Diesel PM2.5 is associated with premature birth and low birth weight.",
   lo:"The reproductive health evidence is serious enough that several researchers have called for precautionary EMF exposure limits specifically for pregnant women near high-voltage infrastructure. Multiple peer-reviewed studies, including work published in the journal Epidemiology, have found elevated miscarriage rates in women with higher ELF-EMF exposure during pregnancy. The biological mechanism under investigation involves effects on melatonin production and cell division processes during early fetal development. Separately, maternal exposure to diesel PM2.5 during pregnancy is associated with premature birth, low birth weight, and impaired fetal lung development, all of which carry lifelong health consequences. Women who are pregnant or planning to become pregnant and who live near large data center infrastructure are encouraged to discuss these exposures specifically with their obstetrician or midwife and to request that the conversation be documented in their prenatal records.",
   stat:"ELF-EMF exposure during pregnancy linked to elevated miscarriage risk in multiple peer-reviewed studies",src:"BioInitiative Report",url:"https://www.bioinitiative.org"},
  {icon:"moon",  c:"#10b981",t:"Sleep Deprivation and Long-Term Brain Health",
   sh:"Chronic sleep loss from industrial noise is not just uncomfortable. It is a documented cause of serious long-term health consequences.",
   lo:"Sleep is not optional for human health. During sleep, the brain clears metabolic waste products through the glymphatic system, consolidates memories, regulates hormones, repairs cellular damage, and resets the cardiovascular system. Chronic sleep deprivation caused by environmental noise disrupts every one of these processes. The long-term consequences include significantly elevated risk of type 2 diabetes, obesity, cardiovascular disease, dementia, and depression. Research published in the journal Nature found that even modest chronic sleep restriction produces cumulative cognitive deficits equivalent to two to three days of total sleep deprivation. For residents near large data centers who report years of disrupted sleep, the cumulative cognitive and health burden is substantial and likely underrecognized because it develops gradually. A US National Library of Medicine study specifically documented that infrasound above 100 dB can affect cardiac function within one hour of exposure, demonstrating that sub-audible vibration has measurable physiological effects that extend well beyond the auditory system.",
   stat:"Chronic sleep deprivation independently linked to dementia, diabetes, cardiovascular disease, and shortened lifespan",src:"US National Library of Medicine",url:"https://pubmed.ncbi.nlm.nih.gov"},
];

const KIDS = [
  {icon:"dna",   t:"Childhood Leukemia Risk",    sev:"SERIOUS",         c:"#ef4444",
   d:"The WHO's International Agency for Research on Cancer formally classified power-frequency electromagnetic fields as possibly carcinogenic specifically because of epidemiological studies linking chronic childhood residential exposure to elevated leukemia rates. The exposure level where elevated risk was found in these studies was just 3 to 4 milligauss. To understand the regulatory gap: the legal limit in the United States is 2,000 milligauss, which is 500 times higher than where cancer risk was found in children. Children's rapidly dividing cells during development are far more sensitive to electromagnetic disruption than adult cells. Childhood leukemia is not common, but the documented association with an exposure that is entirely preventable through proper facility setbacks makes this one of the most serious concerns for families living near data center infrastructure."},
  {icon:"lung",  t:"Asthma, Lungs, and Breathing",sev:"DOCUMENTED",     c:"#f97316",
   d:"Children breathe more air per pound of body weight than adults, which means they receive a proportionally higher dose of any pollutant in the air they share. Diesel particulate matter from monthly generator tests is a classified carcinogen and a powerful asthma trigger. Children with existing asthma who live downwind of large generator operations face increased attack frequency, increased severity, and over time accelerated airway remodeling that can permanently reduce lung capacity. Even children without diagnosed asthma can develop airway inflammation from repeated PM2.5 exposures. A 2025 modelling study projected that data center diesel emissions could contribute to over one-third of all projected US asthma deaths by 2030, with children disproportionately represented."},
  {icon:"brain", t:"Brain Development, ADHD, and Learning",sev:"EMERGING",c:"#eab308",
   d:"The developing brain is uniquely vulnerable to environmental disruption in ways that may not be apparent for years. ELF-EMF exposure during critical periods of neural development has been linked in multiple studies to attention deficits, hyperactivity, and cognitive dysfunction. Separately, chronic sleep disruption from low-frequency noise has a well-established and direct impact on children's learning, memory consolidation, emotional regulation, and behavioral control. Multiple parents living near data centers in Virginia and Texas have reported that their children's school performance declined measurably after a nearby facility became operational, with improvement noted during school holidays when families traveled away from the area. These patterns are diagnostically significant and should be documented and reported to pediatricians."},
  {icon:"sleep", t:"Sleep Deprivation and Growth",sev:"HIGH CONCERN",    c:"#8b5cf6",
   d:"Children require more sleep than adults for a biological reason: sleep is when growth hormone is released, when the day's experiences are consolidated into long-term memory, and when the immune system performs its most active repair work. A child who is not reaching deep sleep is not growing optimally, not consolidating learning, and not maintaining immune function. Low-frequency noise prevents deep sleep at levels that adults may not even consciously notice, because children's sensory systems are more acute and their noise tolerance thresholds are lower. Parents near data centers report children waking repeatedly, complaining of ear pressure at night, resisting going to bed in rooms closest to the facility, and showing behavioral changes that their teachers and doctors attribute to sleep deprivation."},
  {icon:"ear",   t:"Hearing Damage",             sev:"DOCUMENTED CASES",c:"#3b82f6",
   d:"In the Granbury Texas case, the lawsuit specifically named permanent tinnitus and measurable hearing damage in children as injuries caused by proximity to an industrial facility. Children's auditory systems are still forming and are more sensitive to noise-induced damage than adults. Critically, noise-induced hearing damage is cumulative, painless, and completely irreversible. There is no treatment. Children who sustain hearing damage from environmental noise during their early years carry that deficit permanently into adulthood. The insidious nature of this harm is that it progresses silently, and by the time parents or doctors notice a change in a child's hearing, significant irreversible damage has already occurred. If your child is showing signs of hearing difficulty or complaining of ringing in the ears, request an audiological assessment and document it with your family doctor."},
  {icon:"anxiety",t:"Childhood Anxiety and Behavioral Changes",sev:"DOCUMENTED",c:"#8b5cf6",
   d:"Children cannot articulate that they feel a vibration or explain that the pressure in their ears is making them anxious. They express it through behavior: increased irritability, clinginess, tantrums, reluctance to sleep in their room, unexplained stomach aches, and school refusal. Several parents in affected communities have described their children becoming measurably more distressed at home and calmer when visiting relatives in different areas, a pattern that points clearly to a home environment issue. If you have noticed behavioral changes in your child that coincide with the construction or operation of a nearby data center, document these changes with dates and describe them to your child's pediatrician. This creates a medical record that may be important later."},
];

const QUIZ = [
  {q:"How far do you live from the facility or its substation?",k:"dist",o:["Less than 0.25 miles","0.25 to 0.5 miles","0.5 to 1 mile","More than 1 mile"]},
  {q:"Are there children under 12 in your household?",k:"kids",o:["Yes","No"]},
  {q:"Is anyone in your home pregnant, or trying to conceive?",k:"preg",o:["Yes","No","Not sure"]},
  {q:"Does anyone in your home have asthma, COPD, or heart disease?",k:"health",o:["Yes","No","Not sure"]},
  {q:"How long have you lived at this address?",k:"dur",o:["Less than 1 year","1 to 3 years","3 to 10 years","More than 10 years"]},
];

const TABS = [
  {id:"feel",    label:"What You'll Feel",  icon:"sound"},
  {id:"numbers", label:"By the Numbers",    icon:"number"},
  {id:"quiz",    label:"Your Risk Quiz",    icon:"question"},
  {id:"health",  label:"Long-Term Health",  icon:"heart"},
  {id:"kids",    label:"Kids and Families", icon:"kids"},
  {id:"act",     label:"What To Do",        icon:"action"},
  {id:"submit",  label:"Submit Your Report", icon:"doc"},
  {id:"reports", label:"Community Reports",  icon:"community"},
];

const fmt = n => n>=1e6?`${(n/1e6).toFixed(1)}M`:n>=1e3?`${(n/1e3).toFixed(0)}K`:`${n}`;

// ─── CSS ──────────────────────────────────────────────────────────────────────

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:#f1f5f9;color:#0f172a;-webkit-font-smoothing:antialiased;line-height:1.6}

  @keyframes gradShift{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
  @keyframes ring{0%{transform:translate(-50%,-50%) scale(.4);opacity:.7}100%{transform:translate(-50%,-50%) scale(3.5);opacity:0}}
  @keyframes fadeUp{from{opacity:0;transform:translateY(28px)}to{opacity:1;transform:translateY(0)}}
  @keyframes shimmer{0%{background-position:-200% center}100%{background-position:200% center}}
  @keyframes floatAnim{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes pulse{0%,100%{opacity:.55}50%{opacity:1}}
  @keyframes fadeIn{from{opacity:0}to{opacity:1}}
  .fade-in{animation:fadeIn .5s ease-out both}
  /* Report landing: slow pulse on the hero warning icon, urgency pulse on CTAs. */
  @keyframes slowPulse{0%,100%{transform:scale(1);box-shadow:0 14px 40px rgba(239,68,68,.5)}50%{transform:scale(1.07);box-shadow:0 18px 56px rgba(239,68,68,.78)}}
  @keyframes ctaPulse{0%,100%{box-shadow:0 10px 32px rgba(239,68,68,.45);transform:scale(1)}50%{box-shadow:0 16px 50px rgba(239,68,68,.7);transform:scale(1.025)}}
  .slow-pulse{animation:slowPulse 2.6s ease-in-out infinite}
  .cta-pulse{animation:ctaPulse 2.4s ease-in-out infinite}
  .hz-spinner{display:inline-block;width:16px;height:16px;border:2.5px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite;margin-right:10px;vertical-align:-3px}
  /* Social share strip: each bubble has a slow vertical bob; staggered
     animation-delay (set inline per icon) makes them breathe out of phase
     rather than as a single block. Hover pauses the bob so the scale-up
     and brand-color glow read cleanly. */
  .share-row{display:flex;justify-content:center;align-items:flex-start;gap:16px;flex-wrap:nowrap}
  .share-link{display:inline-flex;flex-direction:column;align-items:center;gap:8px;text-decoration:none;color:#64748b;flex-shrink:0}
  .share-bubble{width:44px;height:44px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;transition:transform .2s ease, box-shadow .2s ease;animation:shareBob 3.4s ease-in-out infinite;will-change:transform;flex-shrink:0}
  .share-link:hover .share-bubble{transform:scale(1.1);box-shadow:0 10px 26px var(--share-glow, rgba(15,23,42,.18));animation-play-state:paused}
  .share-label{font-size:11px;font-weight:700;letter-spacing:.04em;color:#94a3b8;text-transform:uppercase;white-space:nowrap}
  .share-section{padding:24px 16px}
  @keyframes shareBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
  @media(max-width:640px){
    .share-section{padding:20px 8px}
    .share-row{gap:8px}
    .share-bubble{width:32px;height:32px}
    .share-label{font-size:9px;letter-spacing:.02em}
  }
  .hz-progress-track{position:relative;width:100%;height:10px;background:rgba(255,255,255,.08);border:1px solid rgba(249,115,22,.35);border-radius:999px;overflow:hidden}
  .hz-progress-fill{position:absolute;inset:0;background:linear-gradient(90deg,#ef4444,#f97316);transform-origin:left;transition:transform .4s ease}
  .hz-progress-indet{position:absolute;top:0;height:100%;width:35%;background:linear-gradient(90deg,#ef4444,#f97316);border-radius:999px;animation:hzIndet 1.4s ease-in-out infinite}
  @keyframes hzIndet{0%{left:-40%}100%{left:100%}}
  /* Near Me results: hard contain every child so nothing pushes the page
     sideways on iPhone when results render. */
  .near-me-results{width:100%!important;max-width:100%!important;box-sizing:border-box!important;overflow-x:hidden!important;margin-left:0!important;margin-right:0!important}
  .near-me-results *{max-width:100%;box-sizing:border-box}
  .near-me-results .near-card{width:100%!important}
  .back-btn{transition:border-color .15s,color .15s,box-shadow .15s}
  .back-btn:hover{border-color:#f97316!important;color:#f97316!important;box-shadow:0 4px 14px rgba(249,115,22,.25)!important}
  .report-h1{font-size:48px;line-height:1.1;letter-spacing:-.025em}
  .report-h2{font-size:32px;line-height:1.2;letter-spacing:-.02em}
  @media(max-width:768px){
    .report-h1{font-size:28px!important;line-height:1.15!important}
    .report-h2{font-size:22px!important}
  }
  .email-gate-input::placeholder{color:rgba(255,255,255,.45)}
  .email-gate-input:focus{outline:none!important;border-color:rgba(249,115,22,.6)!important;background:rgba(255,255,255,.13)!important}

  /* Hard guard against horizontal overflow shifting content sideways on iPhone. */
  *{box-sizing:border-box}
  html{overflow-x:hidden!important;max-width:100vw!important;width:100%!important;margin:0!important;padding:0!important}
  body{overflow-x:hidden!important;max-width:100vw!important;width:100%!important;position:relative!important;margin:0!important;padding:0!important}

  /* Stats strip: outer container has zero padding/margin so the inner grid
     is the single source of truth for horizontal spacing. */
  .stats-container{width:100%;margin:0;padding:0;box-sizing:border-box}
  .stats-row *{margin-left:0!important;margin-right:0!important}

  .a1{animation:fadeUp .55s ease both}
  .a2{animation:fadeUp .55s .1s ease both}
  .a3{animation:fadeUp .55s .2s ease both}
  .a4{animation:fadeUp .55s .3s ease both}
  .floating{animation:floatAnim 5s ease-in-out infinite}
  .spinning{animation:spin 1s linear infinite}
  .skeleton{background:linear-gradient(90deg,#e2e8f0 25%,#f1f5f9 50%,#e2e8f0 75%);background-size:200% 100%;animation:shimmer 1.4s linear infinite;border-radius:8px}
  .pulse{background:#e2e8f0;border-radius:8px;animation:pulse 1.4s ease-in-out infinite;display:block}

  .srch:focus{outline:none!important;background:rgba(255,255,255,.2)!important;border-color:rgba(255,255,255,.5)!important}
  .srch::placeholder{color:rgba(255,255,255,.5)}

  .scroll-inner{scrollbar-width:thin;scrollbar-color:#cbd5e1 transparent}
  .scroll-inner::-webkit-scrollbar{width:4px}
  .scroll-inner::-webkit-scrollbar-track{background:transparent}
  .scroll-inner::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:99px}

  .sym-card{transition:transform .2s,box-shadow .2s}
  .sym-card:hover{transform:translateY(-4px);box-shadow:0 16px 40px rgba(0,0,0,.12)!important}
  .acc-hd{transition:background .15s;cursor:pointer}
  .acc-hd:hover{background:#f8fafc!important}
  .q-opt{transition:all .15s;cursor:pointer;text-align:left;font-family:inherit}
  .q-opt:hover{transform:translateX(5px)}
  .drop-item{transition:background .1s;cursor:pointer}
  .drop-item:hover{background:#eff6ff!important}
  .tab-btn{transition:all .2s;cursor:pointer;font-family:inherit;white-space:nowrap}
  .tab-btn:hover{transform:translateY(-2px)}
  /* Submit Your Report tab: only the colors are overridden so the pill keeps
     the same size, padding and border-radius as the other tabs. */
  .tab-btn-submit:hover{background:#ea6c0a!important;border-color:#ea6c0a!important}
  .clear-btn{transition:all .2s;cursor:pointer;font-family:inherit}
  .clear-btn:hover{background:rgba(255,255,255,.18)!important}
  .ext-link{transition:opacity .15s;text-decoration:none}
  .ext-link:hover{opacity:.75}
  .map-btn{transition:opacity .15s}
  .map-btn:hover{opacity:.85}

  /* Honeypot field: hidden from humans, visible to bots */
  .hz-trap{position:absolute;left:-9999px;opacity:0;pointer-events:none;tab-index:-1}

  @media(max-width:768px){
    .hero{padding:48px 20px 60px!important;min-height:auto!important}
    .hero h1{font-size:48px!important}
    .scroll-hint{display:none!important}
    .search-row{flex-direction:column!important}
    .stats-row{display:grid!important;grid-template-columns:1fr 1fr!important;gap:24px 12px!important;padding:24px 20px!important;width:100%!important;max-width:100%!important;margin:0!important;box-sizing:border-box!important;justify-items:center!important}
    .stat-item{width:100%!important;min-width:0!important;justify-self:center!important;margin:0!important;margin-left:0!important;margin-right:0!important;padding:0!important;box-sizing:border-box!important}
    .sym-grid{grid-template-columns:1fr!important}
    .nums-grid{grid-template-columns:1fr!important}
    .fac-stats{grid-template-columns:1fr 1fr!important}
    .tabs-row{padding:12px 14px!important}
    .tab-btn{padding:9px 14px!important;font-size:13px!important}
    .tab-content{padding:20px 16px 28px!important}
    .fac-header{padding:20px 16px!important}
    .main{padding:20px 16px 96px!important}
    .rings{display:none!important}
    .stat-val{font-size:20px!important}
    .addr-bar{flex-direction:column!important;align-items:flex-start!important;gap:10px!important;padding:14px 16px!important}
    .near-panel{padding:22px 16px 18px!important}
    .near-status-row{flex-direction:column!important;align-items:flex-start!important;gap:10px!important}
    .near-card{padding:16px!important}
    .near-card .near-right{margin-left:auto!important}
  }
  @media(max-width:480px){
    .hero h1{font-size:38px!important}
    .scroll-hint{display:none!important}
  }
`;

// ─── COMPONENTS ───────────────────────────────────────────────────────────────
const Chip = ({label,color,small=false}) => (
  <span style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:small?11:13,fontWeight:700,padding:small?"3px 9px":"5px 14px",borderRadius:20,letterSpacing:".03em",background:color+"1a",color,border:`1.5px solid ${color}33`}}>{label}</span>
);

const SevBar = ({level,color}) => (
  <div style={{display:"flex",gap:4,margin:"10px 0"}}>
    {[1,2,3,4,5].map(i=>(<div key={i} style={{flex:1,height:5,borderRadius:3,background:i<=level?color:"#e2e8f0",transition:"background .3s"}}/>))}
  </div>
);

const SrcLink = ({text,url}) => (
  <a href={url} target="_blank" rel="noopener noreferrer" className="ext-link"
    style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:14,color:"#3b82f6",fontWeight:600}}>
    {text} <Icon name="external" size={13} color="#3b82f6"/>
  </a>
);

// OpenStreetMap image component with fallback
const FacilityMapImage = ({ dc, rc }) => {
  const [imgState, setImgState] = useState("loading"); // loading | osm | fallback | placeholder
  const lat = dc?.Latitude;
  const lng = dc?.Longitude;
  const hasCoords = lat && lng;

  const osmUrl = hasCoords
    ? `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lng}&zoom=15&size=800x350&markers=${lat},${lng},red-pushpin`
    : null;

  // Facility photo: Photo_URL from Airtable if present, otherwise a deterministic
  // pick from the rotating FACILITY_PHOTOS pool keyed off the record ID.
  const rotatedPhoto = dc?.id
    ? FACILITY_PHOTOS[dc.id.charCodeAt(3) % FACILITY_PHOTOS.length]
    : FACILITY_PHOTOS[0];
  const fallbackUrl = dc?.Photo_URL || rotatedPhoto;

  useEffect(() => {
    setImgState("loading");
    if (hasCoords) {
      const img = new Image();
      img.onload = () => setImgState("osm");
      img.onerror = () => setImgState("fallback");
      img.src = osmUrl;
    } else {
      setImgState("fallback");
    }
  }, [dc?.id]);

  return (
    <div style={{position:"relative",height:300,overflow:"hidden",background:"#0f172a"}}>
      {imgState === "loading" && (
        <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:12,color:"rgba(255,255,255,.4)"}}>
          <div className="spinning" style={{width:32,height:32,border:"2px solid rgba(255,255,255,.2)",borderTop:`2px solid ${rc}`,borderRadius:"50%"}}/>
          <div style={{fontSize:13}}>Loading location map...</div>
        </div>
      )}

      {imgState === "osm" && (
        <>
          <img src={osmUrl} alt={`Map location of ${dc.Name}`}
            style={{width:"100%",height:"100%",objectFit:"cover",display:"block",filter:"saturate(1.2) contrast(1.05)"}}
          />
          <div style={{position:"absolute",inset:0,background:"linear-gradient(to top,rgba(0,0,0,.7) 0%,rgba(0,0,0,.0) 50%)"}}/>
          <div style={{position:"absolute",top:14,right:14,background:"rgba(255,255,255,.95)",borderRadius:8,padding:"5px 10px",fontSize:12,fontWeight:700,color:"#1e293b",display:"flex",alignItems:"center",gap:5}}>
            <Icon name="satellite" size={13} color="#3b82f6"/>
            OpenStreetMap
          </div>
        </>
      )}

      {imgState === "fallback" && (
        <>
          <img src={fallbackUrl} alt={dc.Name}
            style={{width:"100%",height:"100%",objectFit:"cover",display:"block"}}
            onError={()=>setImgState("placeholder")}
          />
          <div style={{position:"absolute",inset:0,background:"linear-gradient(to top,rgba(0,0,0,.7) 0%,rgba(0,0,0,.0) 50%)"}}/>
          <div style={{position:"absolute",top:14,right:14,background:"rgba(0,0,0,.6)",borderRadius:8,padding:"5px 10px",fontSize:12,fontWeight:600,color:"rgba(255,255,255,.7)",display:"flex",alignItems:"center",gap:5}}>
            <Icon name="map" size={13} color="rgba(255,255,255,.7)"/>
            No coordinates on file
          </div>
        </>
      )}

      {imgState === "placeholder" && (
        <div style={{position:"absolute",inset:0,background:"linear-gradient(135deg,#0f172a,#1e293b)",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:8}}>
          <Icon name="map" size={48} color="rgba(255,255,255,.2)"/>
          <div style={{fontSize:14,color:"rgba(255,255,255,.3)"}}>Location image unavailable</div>
        </div>
      )}

      {/* Risk color bar */}
      <div style={{position:"absolute",top:0,left:0,right:0,height:5,background:rc}}/>

      {/* Status/risk badges */}
      <div style={{position:"absolute",bottom:18,left:20,display:"flex",gap:8,flexWrap:"wrap"}}>
        <Chip label={STATUS[dc.Facility_Status]?.label || dc.Facility_Status} color={STATUS[dc.Facility_Status]?.color || "#64748b"}/>
        <Chip label={`${dc.Risk_Level} RISK`} color={rc}/>
      </div>
    </div>
  );
};

// ─── METHODOLOGY PAGE ─────────────────────────────────────────────────────────
const METHODOLOGY_SECTIONS = [
  {t:"Facility Data Sources",b:"We identify data centers from public databases including datacenters.com, operator press releases, utility interconnection filings, FERC applications, municipal permit records, and industry publications. Facility names, addresses, coordinates, and operational status are cross-referenced across multiple sources where possible."},
  {t:"Power Draw (MW)",b:"Power figures are sourced from operator announcements, utility interconnection applications, planning permit filings, and industry reporting. Where exact figures are unavailable, we apply conservative estimates based on facility size class and cooling type. Hyperscale campuses (100MW+) are typically sourced from public utility filings or operator sustainability reports."},
  {t:"Noise (dB)",b:"Perimeter noise levels are estimated using facility power class and cooling type as primary inputs, cross-referenced against EPA industrial noise guidelines and published acoustic studies of comparable data center facilities. Evaporative and chilled water cooling systems produce different noise profiles at the perimeter. These are modeled estimates and will vary by facility design, wind direction, and local terrain."},
  {t:"CO2 Emissions (tons per year)",b:"Annual CO2 estimates are calculated by multiplying Power_MW by annual operating hours (8,760) and applying the EPA eGRID regional emissions factor for the relevant utility grid region. Facilities powered by renewable energy contracts may have lower actual emissions. We use the grid average as a conservative baseline."},
  {t:"Water Consumption (gallons per day)",b:"Daily water consumption is estimated using industry-standard Water Usage Effectiveness (WUE) ratios published by ASHRAE and the Green Grid consortium, applied to facility power draw and cooling type. Evaporative cooling systems consume significantly more water than air-cooled or chilled water systems. These are modeled estimates."},
  {t:"EMF Estimates",b:"Electromagnetic field values shown are modeled estimates derived from facility power draw, substation proximity, and cooling infrastructure. They are not certified measurements and should not be cited as such. We reference WHO and IARC published research on extremely low frequency EMF (ELF-EMF) for context on exposure thresholds. The legal US limit of 2,000 mG does not imply safety at lower levels."},
  {t:"Risk Level",b:"Risk levels (LOW, MODERATE, HIGH) are assigned based on three factors: facility power scale, estimated proximity to nearest residential structures, and cooling type. HIGH is assigned when Power_MW is 50 or above, or when residential structures are estimated within 500 meters. MODERATE applies to facilities between 15 and 50 MW or with residences 500 to 1,000 meters away. LOW applies to smaller facilities in rural or industrial areas with residences beyond 1,000 meters."},
  {t:"What We Do Not Claim",b:"We do not claim that any specific facility has caused harm to any specific person. We do not provide medical advice. Risk levels are relative indicators for public awareness only. Residents with health concerns should consult qualified medical and environmental professionals."},
  {t:"Contact and Corrections",b:"If you are a facility operator or researcher and believe any data is materially incorrect, please contact us. We are committed to accuracy and will review and correct verified errors promptly."},
];

const MethodologyPage = ({ onBack }) => {
  const backLink = (
    <a href="/" onClick={e=>{e.preventDefault();onBack();}} className="ext-link" style={{display:"inline-flex",alignItems:"center",gap:8,color:"#ef4444",textDecoration:"none",fontSize:14,fontWeight:800,letterSpacing:".06em"}}>
      <span style={{fontSize:18,lineHeight:1}}>&larr;</span> BACK TO HUMZONES
    </a>
  );

  return (
    <div style={{minHeight:"100vh",background:"#f1f5f9",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>
      {/* TOP BAR */}
      <div style={{background:"linear-gradient(135deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",padding:"22px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,flexWrap:"wrap"}}>
        <a href="/" onClick={e=>{e.preventDefault();onBack();}} className="ext-link" style={{display:"inline-flex",alignItems:"center",gap:8,color:"rgba(255,255,255,.85)",textDecoration:"none",fontSize:13,fontWeight:800,letterSpacing:".10em"}}>
          <span style={{fontSize:18,lineHeight:1}}>&larr;</span> BACK TO HUMZONES
        </a>
        <div>
          <span style={{fontSize:22,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
          <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2}}>TM</sup>
        </div>
      </div>

      {/* CONTENT */}
      <main style={{maxWidth:880,margin:"0 auto",padding:"48px 24px 72px"}}>
        <div style={{background:"#fff",borderRadius:24,boxShadow:"0 8px 48px rgba(0,0,0,.10)",padding:"48px 40px 40px"}}>
          <div style={{fontSize:12,color:"#94a3b8",letterSpacing:".18em",textTransform:"uppercase",fontWeight:800,marginBottom:14}}>Methodology</div>
          <h1 style={{fontSize:34,fontWeight:900,lineHeight:1.18,letterSpacing:"-.02em",marginBottom:24,background:"linear-gradient(135deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",display:"inline-block"}}>
            How We Research and Model Our Data
          </h1>
          <p style={{fontSize:17,color:"#475569",lineHeight:1.75,marginBottom:40}}>
            HumZones compiles facility data from public sources and applies documented modeling methods to estimate environmental metrics. No figures on this site represent certified field measurements. All estimates are clearly labeled as such and are intended to inform public awareness, not to serve as legal or scientific evidence.
          </p>

          {METHODOLOGY_SECTIONS.map((s,i)=>(
            <section key={s.t} style={{marginBottom:30}}>
              <div style={{display:"flex",alignItems:"baseline",gap:12,marginBottom:10}}>
                <div style={{fontSize:13,fontWeight:900,color:"#ef4444",letterSpacing:".06em",minWidth:26}}>{String(i+1).padStart(2,"0")}</div>
                <h2 style={{fontSize:14,color:"#0f172a",letterSpacing:".12em",textTransform:"uppercase",fontWeight:800,margin:0,lineHeight:1.4}}>{s.t}</h2>
              </div>
              <p style={{fontSize:16,color:"#475569",lineHeight:1.75,marginLeft:38}}>{s.b}</p>
            </section>
          ))}

          <div style={{borderTop:"1px solid #e2e8f0",marginTop:40,paddingTop:24}}>
            <p style={{fontSize:12,color:"#94a3b8",lineHeight:1.7}}>
              Data Disclaimer: All figures shown including noise levels, EMF readings, power consumption, CO2 estimates, and water usage are research-based estimates compiled from public sources, permit filings, and industry standards. They are not certified measurements. Actual readings may vary by facility design, operating conditions, and season. HumZones is an informational resource only and does not constitute medical, legal, or environmental advice.
            </p>
          </div>

          <div style={{marginTop:32,textAlign:"center"}}>
            {backLink}
          </div>
        </div>
      </main>
    </div>
  );
};

// ─── SOCIAL SHARE STRIP ───────────────────────────────────────────────────────
// Rendered between the count-up stats and the search panel on the main page.
// Inline SVGs only (no remote brand assets) so the strip always paints, even
// on a cold cache or behind a strict img CSP. Each icon's bob animation gets
// a staggered delay via inline style so the row reads as breathing, not as a
// single block lifting up and down.
const SHARE_TARGETS = [
  {
    name: "Facebook",
    color: "#1877F2",
    glow: "rgba(24,119,242,.45)",
    url: "https://www.facebook.com/sharer/sharer.php?u=https://humzones.com",
    newTab: true,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
        <path d="M22 12c0-5.523-4.477-10-10-10S2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.879V14.89h-2.54V12h2.54V9.797c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.261c-1.243 0-1.63.771-1.63 1.563V12h2.773l-.443 2.89h-2.33v6.989C18.343 21.128 22 16.991 22 12z"/>
      </svg>
    ),
  },
  {
    name: "X",
    color: "#000000",
    glow: "rgba(15,23,42,.45)",
    url: "https://twitter.com/intent/tweet?text=" + encodeURIComponent("Did you know there are data centers near your home affecting air quality, noise and EMF levels? Check humzones.com to find out what is near you.") + "&url=" + encodeURIComponent("https://humzones.com"),
    newTab: true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117l11.966 15.644z"/>
      </svg>
    ),
  },
  {
    name: "WhatsApp",
    color: "#25D366",
    glow: "rgba(37,211,102,.45)",
    url: "https://wa.me/?text=" + encodeURIComponent("Did you know there are data centers near your home? Check humzones.com to find out what is near you and get a full health report."),
    newTab: true,
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.096 3.2 5.077 4.487.71.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884M20.52 3.449C18.24 1.245 15.24 0 12.045 0 5.463 0 .104 5.334.101 11.892c0 2.096.549 4.142 1.595 5.945L0 24l6.335-1.652a12.062 12.062 0 0 0 5.71 1.447h.006c6.585 0 11.946-5.336 11.949-11.896 0-3.176-1.24-6.165-3.495-8.411"/>
      </svg>
    ),
  },
  {
    name: "LinkedIn",
    color: "#0A66C2",
    glow: "rgba(10,102,194,.45)",
    url: "https://www.linkedin.com/sharing/share-offsite/?url=https://humzones.com",
    newTab: true,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.063 2.063 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
      </svg>
    ),
  },
  {
    name: "Reddit",
    color: "#FF4500",
    glow: "rgba(255,69,0,.45)",
    url: "https://www.reddit.com/submit?url=" + encodeURIComponent("https://humzones.com") + "&title=" + encodeURIComponent("Did you know data centers near your home could be affecting your health? Check this out."),
    newTab: true,
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
        <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614.045.27.066.5.066.781 0 2.665-3.106 4.827-6.93 4.827-3.823 0-6.929-2.162-6.929-4.827 0-.281.025-.51.07-.78-.575-.282-1.012-.9-1.012-1.615 0-.968.787-1.754 1.755-1.754.478 0 .9.182 1.208.49 1.193-.855 2.85-1.418 4.674-1.488l.911-4.305c.018-.087.043-.157.131-.205.099-.045.213-.066.323-.038l2.991.628a1.25 1.25 0 0 1 1.097-.628zM12.05 13c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm-3.6 0c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm5.466 4.078a.187.187 0 0 0-.266.001c-.671.659-1.974.79-2.671.79-.697 0-2-.131-2.67-.79a.183.183 0 0 0-.267 0 .188.188 0 0 0 0 .265c.452.452 1.434.612 2.937.612 1.503 0 2.485-.16 2.937-.612a.185.185 0 0 0 0-.266z"/>
      </svg>
    ),
  },
  {
    name: "Email",
    color: "#64748b",
    glow: "rgba(100,116,139,.45)",
    url: "mailto:?subject=" + encodeURIComponent("You need to check what data centers are near your home") + "&body=" + encodeURIComponent("I found this site that shows data centers near your address and their health impact. Check it out at https://humzones.com"),
    newTab: false,
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
        <polyline points="22,6 12,13 2,6"/>
      </svg>
    ),
  },
];

const ShareSection = () => (
  <section aria-label="Share HumZones" className="share-section" style={{background:"#fff",textAlign:"center",borderBottom:"1px solid #f1f5f9"}}>
    <p style={{fontSize:13,color:"#94a3b8",margin:0,marginBottom:14,fontWeight:600,letterSpacing:".02em"}}>
      Know someone who should check this?
    </p>
    <div className="share-row">
      {SHARE_TARGETS.map((s, i) => (
        <a
          key={s.name}
          className="share-link"
          href={s.url}
          aria-label={`Share on ${s.name}`}
          {...(s.newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        >
          <span
            className="share-bubble"
            style={{
              background: s.color,
              animationDelay: `${i * 0.25}s`,
              ["--share-glow"]: s.glow,
            }}
          >
            {s.icon}
          </span>
          <span className="share-label">{s.name}</span>
        </a>
      ))}
    </div>
  </section>
);

// ─── PAYMENT METHODS ROW ──────────────────────────────────────────────────────
// Renders the accepted-cards strip shown below the $14.99 CTA on the report
// landing page. Each badge is a pure SVG (no external assets) so the row
// always paints, even on a cold cache or behind a strict image CSP.
const PaymentMethodsRow = () => {
  const badgeStyle = { width: 40, height: 26, borderRadius: 4, background: "#fff", border: "1px solid rgba(255,255,255,.16)", display: "inline-flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 };
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:8,marginTop:4,marginBottom:18}}>
      <div style={{display:"inline-flex",alignItems:"center",gap:6,color:"rgba(255,255,255,.55)",fontSize:11,fontWeight:700,letterSpacing:".10em",textTransform:"uppercase"}}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="4" y="11" width="16" height="10" rx="2"/>
          <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
        </svg>
        Secure Payment
      </div>
      <div style={{display:"inline-flex",alignItems:"center",gap:8,flexWrap:"wrap",justifyContent:"center"}}>
        {/* Visa */}
        <span aria-label="Visa" title="Visa" style={badgeStyle}>
          <svg width="40" height="26" viewBox="0 0 40 26" aria-hidden="true">
            <rect width="40" height="26" rx="4" fill="#1a1f71"/>
            <text x="20" y="17.5" fill="#fff" fontFamily="Arial Black, Arial, sans-serif" fontSize="9" fontWeight="900" textAnchor="middle" letterSpacing="0.6">VISA</text>
          </svg>
        </span>
        {/* Mastercard */}
        <span aria-label="Mastercard" title="Mastercard" style={badgeStyle}>
          <svg width="40" height="26" viewBox="0 0 40 26" aria-hidden="true">
            <rect width="40" height="26" rx="4" fill="#fff"/>
            <circle cx="16" cy="13" r="7" fill="#eb001b"/>
            <circle cx="24" cy="13" r="7" fill="#f79e1b"/>
            <path d="M20 8.2a7 7 0 0 0 0 9.6 7 7 0 0 0 0-9.6z" fill="#ff5f00"/>
          </svg>
        </span>
        {/* American Express */}
        <span aria-label="American Express" title="American Express" style={badgeStyle}>
          <svg width="40" height="26" viewBox="0 0 40 26" aria-hidden="true">
            <rect width="40" height="26" rx="4" fill="#2671b8"/>
            <text x="20" y="17" fill="#fff" fontFamily="Arial Black, Arial, sans-serif" fontSize="7.5" fontWeight="900" textAnchor="middle" letterSpacing="0.6">AMEX</text>
          </svg>
        </span>
        {/* Apple Pay */}
        <span aria-label="Apple Pay" title="Apple Pay" style={badgeStyle}>
          <svg width="40" height="26" viewBox="0 0 40 26" aria-hidden="true">
            <rect width="40" height="26" rx="4" fill="#fff"/>
            {/* Apple silhouette */}
            <path d="M13.55 10.43c.36-.45.6-1.06.54-1.68-.52.02-1.16.35-1.53.79-.33.4-.62 1.03-.55 1.63.59.05 1.18-.29 1.54-.74zm.53.85c-.85-.05-1.57.48-1.97.48-.41 0-1.03-.45-1.7-.44-.87.01-1.68.51-2.12 1.3-.91 1.57-.23 3.9.65 5.18.43.62.93 1.32 1.6 1.29.64-.02.88-.42 1.66-.42.77 0 .99.42 1.66.41.69-.01 1.13-.63 1.55-1.26.49-.72.69-1.42.7-1.46-.02-.01-1.35-.52-1.36-2.05-.01-1.28 1.05-1.9 1.09-1.93-.6-.87-1.52-.97-1.84-.99z" fill="#000"/>
            <text x="29" y="17.5" fill="#000" fontFamily="-apple-system, Helvetica, Arial, sans-serif" fontSize="9" fontWeight="700" textAnchor="middle">Pay</text>
          </svg>
        </span>
        {/* Google Pay */}
        <span aria-label="Google Pay" title="Google Pay" style={badgeStyle}>
          <svg width="40" height="26" viewBox="0 0 40 26" aria-hidden="true">
            <rect width="40" height="26" rx="4" fill="#fff"/>
            {/* Multicolor Google G */}
            <path d="M14.18 13.13c0-.36-.03-.71-.09-1.04h-3.95v1.97h2.27c-.1.51-.4.95-.85 1.24v1.03h1.38c.81-.74 1.27-1.84 1.27-3.2z" fill="#4285f4"/>
            <path d="M10.14 17.3c1.15 0 2.12-.38 2.82-1.03l-1.38-1.07c-.38.26-.87.41-1.44.41-1.11 0-2.05-.74-2.39-1.74H6.32v1.1a4.27 4.27 0 0 0 3.82 2.33z" fill="#34a853"/>
            <path d="M7.75 13.87a2.56 2.56 0 0 1 0-1.64v-1.1H6.32a4.27 4.27 0 0 0 0 3.84l1.43-1.1z" fill="#fbbc04"/>
            <path d="M10.14 10.49c.63 0 1.19.22 1.63.64l1.22-1.22a4.07 4.07 0 0 0-2.85-1.1A4.27 4.27 0 0 0 6.32 11.13l1.43 1.1c.34-1 1.28-1.74 2.39-1.74z" fill="#ea4335"/>
            <text x="27" y="17.5" fill="#5f6368" fontFamily="Helvetica, Arial, sans-serif" fontSize="8.5" fontWeight="700" textAnchor="middle">Pay</text>
          </svg>
        </span>
      </div>
    </div>
  );
};

// ─── REPORT LANDING (sales page) ──────────────────────────────────────────────
// Pulls the captured Near Me search context out of localStorage and renders a
// multi-section sales page for the paid Full Area Report.
const ReportLandingPage = ({ onBack, onNavigate }) => {
  const get = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };

  const searchAddress  = get("searchAddress") || "your area";
  const selectedRadius = parseInt(get("selectedRadius"), 10) || 0;
  const facilitiesFound  = parseInt(get("facilitiesFound"), 10)  || 0;
  const facilities100km  = parseInt(get("facilities100km"), 10)  || 0;
  const highRiskCount    = parseInt(get("highRiskCount"), 10)    || 0;

  // Estimated rollups (per the spec): 45 MW average draw, 35,000 gal/day water.
  const estPowerMW       = facilities100km * 45;
  const estWaterGalDay   = facilities100km * 35000;
  const fmtNum = (n) => Number(n).toLocaleString();
  const fmtPower = (mw) => mw >= 1000 ? `${(mw/1000).toFixed(1)} GW` : `${fmtNum(mw)} MW`;

  // Buy CTA: redirects straight to the Stripe-hosted Payment Link. No
  // serverless function is involved; the post-payment redirect is configured
  // on the Payment Link in the Stripe dashboard to land on
  // https://humzones.com/report-success. Search context is written to
  // localStorage on the line right above so /report-success can personalize
  // the PDF when the buyer comes back.
  const STRIPE_PAYMENT_LINK = "https://buy.stripe.com/test_3cI6oJ3DA2bv8Gd3uIgMw00";
  const handleBuyReport = () => {
    try {
      localStorage.setItem("searchAddress",   get("searchAddress"));
      localStorage.setItem("searchLat",       get("searchLat"));
      localStorage.setItem("searchLng",       get("searchLng"));
      localStorage.setItem("facilities100km", get("facilities100km"));
      localStorage.setItem("highRiskCount",   get("highRiskCount"));
      localStorage.setItem("facilitiesFound", get("facilitiesFound"));
      localStorage.setItem("selectedRadius",  get("selectedRadius"));
      localStorage.setItem("hz_report_purchase_intent", new Date().toISOString());
    } catch {}
    window.location.href = STRIPE_PAYMENT_LINK;
  };

  const numbersUnknown = facilities100km === 0;

  const stats = [
    {
      val: numbersUnknown ? "" : String(facilities100km),
      label: "Total facilities within 100km",
      desc: "Every operating, planned, and proposed data center inside the 100km zone around the location you searched.",
      color: "#ef4444",
    },
    {
      val: numbersUnknown ? "" : String(highRiskCount),
      label: "HIGH risk facilities",
      desc: "Sites at 50 MW or more, or within 500m of homes. These have the strongest documented health impact patterns.",
      color: "#f97316",
    },
    {
      val: numbersUnknown ? "" : fmtPower(estPowerMW),
      label: "Estimated combined power draw",
      desc: "Based on a conservative 45 MW per-facility average. The grid load near you is real and growing month over month.",
      color: "#eab308",
    },
    {
      val: numbersUnknown ? "" : `${fmtNum(estWaterGalDay)} gal`,
      label: "Estimated daily water use",
      desc: "Based on a 35,000 gallons per day average per facility. Water removed from your local cycle, every single day.",
      color: "#3b82f6",
    },
  ];

  const benefits = [
    "Complete list of all facilities within 100km of your address",
    "Risk level and health context for each facility",
    "EMF exposure estimates at your distance",
    "Noise impact analysis",
    "Water and CO2 impact in your region",
    "Practical steps to reduce your exposure",
  ];

  const testimonials = [
    { name: "Sarah M",  loc: "Toronto",  quote: "I had no idea there were 14 data centers within 10km of my house. This report opened my eyes." },
    { name: "James R",  loc: "Austin",   quote: "The EMF data alone was worth it. Shared this with my whole neighborhood." },
    { name: "Lisa K",   loc: "Virginia", quote: "Finally a tool that tells you what is actually near your home. Eye opening." },
  ];

  const checkSvg = (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
  const warnSvg = (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9"  x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  );

  const primaryBtn = (label) => ({
    padding: "16px 30px",
    borderRadius: 14,
    border: "none",
    background: "linear-gradient(135deg,#ef4444,#f97316)",
    color: "#fff",
    fontSize: 17,
    fontWeight: 900,
    letterSpacing: ".02em",
    cursor: "pointer",
    fontFamily: "inherit",
    boxShadow: "0 10px 32px rgba(239,68,68,.45)",
    display: "inline-flex",
    alignItems: "center",
    gap: 10,
  });

  return (
    <div style={{minHeight:"100vh",background:"#f8fafc",width:"100%",maxWidth:"100vw",overflowX:"hidden",color:"#0f172a"}}>

      {/* TOP BAR (back button at top left + brand at right) */}
      <div style={{position:"sticky",top:0,zIndex:50,background:"rgba(15,23,42,.92)",backdropFilter:"blur(12px)",borderBottom:"1px solid rgba(255,255,255,.06)"}}>
        <div style={{maxWidth:1100,margin:"0 auto",padding:"14px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,flexWrap:"wrap"}}>
          <button onClick={onBack} className="back-btn" aria-label="Back to results" style={{background:"rgba(255,255,255,.08)",border:"1px solid rgba(255,255,255,.20)",color:"#fff",padding:"9px 16px",borderRadius:10,fontSize:13,fontWeight:800,letterSpacing:".06em",cursor:"pointer",fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:16,lineHeight:1}}>&larr;</span> Back to Results
          </button>
          <div>
            <span style={{fontSize:20,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
            <sup style={{fontSize:11,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2}}>TM</sup>
          </div>
        </div>
      </div>

      {/* 1. HERO */}
      <section style={{background:"linear-gradient(150deg,#020c1b 0%,#0f172a 45%,#1e0535 100%)",padding:"48px 20px 52px",textAlign:"center",position:"relative",overflow:"hidden",borderBottom:"1px solid rgba(249,115,22,.18)"}}>
        <div style={{maxWidth:820,margin:"0 auto",position:"relative",zIndex:1}}>
          <div className="slow-pulse" style={{width:72,height:72,borderRadius:"50%",background:"linear-gradient(135deg,#ef4444,#dc2626)",margin:"0 auto 18px",display:"flex",alignItems:"center",justifyContent:"center"}}>
            {warnSvg}
          </div>
          <h1 className="report-h1" style={{fontWeight:900,color:"#fff",marginBottom:14}}>
            Your Area Has <span style={{background:"linear-gradient(135deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>{facilities100km}</span> Data {facilities100km===1?"Center":"Centers"} Within 100km
          </h1>
          <p style={{fontSize:17,color:"rgba(255,255,255,.78)",lineHeight:1.6,marginBottom:24,maxWidth:640,marginLeft:"auto",marginRight:"auto"}}>
            You only searched {selectedRadius || "a smaller radius"}{selectedRadius?"km":""} and found {facilitiesFound} {facilitiesFound===1?"facility":"facilities"}. Here is what else is near you that you do not know about yet.
          </p>
          <button onClick={handleBuyReport} className="cta-pulse" style={primaryBtn()}>
            Get My Full Report
          </button>
          <p style={{fontSize:13,color:"rgba(255,255,255,.55)",marginTop:12,lineHeight:1.6}}>
            Instant PDF. Personalized to your exact location.
          </p>
        </div>
      </section>

      {/* 2. FEAR / URGENCY */}
      <section style={{background:"#1e293b",padding:"52px 20px 56px",borderBottom:"1px solid rgba(249,115,22,.18)"}}>
        <div style={{maxWidth:1040,margin:"0 auto"}}>
          <h2 className="report-h2" style={{fontWeight:900,textAlign:"center",marginBottom:10,color:"#fff"}}>
            What Is Really Happening Near Your Home
          </h2>
          <p style={{fontSize:15,color:"rgba(255,255,255,.65)",textAlign:"center",maxWidth:640,margin:"0 auto 30px",lineHeight:1.7}}>
            These are the figures within 100km of <strong style={{color:"#fff"}}>{searchAddress}</strong>.
          </p>
          <div className="nums-grid" style={{display:"grid",gridTemplateColumns:"repeat(2, 1fr)",gap:14}}>
            {stats.map((s)=>(
              <div key={s.label} style={{background:"rgba(15,23,42,.55)",border:"1px solid rgba(249,115,22,.4)",borderRadius:14,padding:"24px 22px 22px",boxShadow:"inset 0 1px 0 rgba(255,255,255,.04)"}}>
                <div style={{fontSize:48,fontWeight:900,color:"#f97316",letterSpacing:"-.025em",lineHeight:1.05,marginBottom:8,textShadow:"0 0 20px rgba(249,115,22,.5)"}}>{s.val || "0"}</div>
                <div style={{fontSize:14,color:"#fff",letterSpacing:".10em",textTransform:"uppercase",fontWeight:800,marginBottom:12}}>{s.label}</div>
                <p style={{fontSize:15,color:"rgba(255,255,255,.72)",lineHeight:1.6,margin:0}}>{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 3. WHAT YOU GET */}
      <section style={{background:"#1e293b",padding:"56px 20px 56px",position:"relative",overflow:"hidden",borderBottom:"1px solid rgba(249,115,22,.22)"}}>
        {/* Semi-transparent HumZones shield watermark in the background */}
        <div aria-hidden="true" style={{position:"absolute",right:"-40px",top:"50%",transform:"translateY(-50%)",pointerEvents:"none",opacity:.08,zIndex:0}}>
          <svg width="460" height="460" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
        </div>

        <div style={{maxWidth:1040,margin:"0 auto",display:"grid",gridTemplateColumns:"1fr 1.05fr",gap:36,alignItems:"center",position:"relative",zIndex:1}} className="nums-grid">
          <div>
            <div style={{fontSize:14,color:"#f97316",letterSpacing:".18em",textTransform:"uppercase",fontWeight:800,marginBottom:12}}>Your Full Report</div>
            <h2 className="report-h2" style={{fontWeight:900,marginBottom:22,color:"#fff"}}>
              Your Full HumZones Report Includes
            </h2>
            <ul style={{listStyle:"none",padding:0,margin:0,display:"flex",flexDirection:"column",gap:14}}>
              {benefits.map((b)=>(
                <li key={b} style={{display:"flex",alignItems:"flex-start",gap:14,fontSize:17,color:"rgba(255,255,255,.92)",lineHeight:1.55}}>
                  <span style={{display:"inline-flex",width:30,height:30,borderRadius:"50%",background:"rgba(249,115,22,.18)",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:2,border:"1.5px solid rgba(249,115,22,.55)"}}>
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                  </span>
                  <span style={{fontWeight:600,color:"#fff"}}>{b}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Blurred fake report preview, taller, with SAMPLE REPORT diagonal + lock overlay */}
          <div style={{position:"relative"}}>
            {/* Soft orange halo behind the card */}
            <div aria-hidden="true" style={{position:"absolute",inset:"-32px",background:"radial-gradient(ellipse at center, rgba(249,115,22,.42) 0%, rgba(249,115,22,0) 65%)",filter:"blur(22px)",pointerEvents:"none",zIndex:0}}/>
            <div style={{maxWidth:460,margin:"0 auto",background:"#fff",borderRadius:18,boxShadow:"0 0 60px rgba(249,115,22,.45),0 0 110px rgba(249,115,22,.22),0 22px 60px rgba(15,23,42,.35),0 0 0 1px rgba(249,115,22,.45)",padding:"28px 26px",position:"relative",zIndex:1,overflow:"hidden",minHeight:440}}>
              <div style={{filter:"blur(5px)",pointerEvents:"none",userSelect:"none"}} aria-hidden="true">
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:14}}>
                  <div style={{fontSize:20,fontWeight:900,color:"#0f172a",letterSpacing:"-.01em"}}>HumZones Area Report</div>
                  <div style={{fontSize:11,color:"#94a3b8",fontWeight:700}}>PAGE 1 / 12</div>
                </div>
                <div style={{fontSize:12,color:"#64748b",marginBottom:14}}>Generated for {searchAddress.length>40?searchAddress.slice(0,40)+"...":searchAddress}</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:14}}>
                  <div style={{height:60,background:"linear-gradient(135deg,#fef2f2,#fee2e2)",borderRadius:10}}/>
                  <div style={{height:60,background:"linear-gradient(135deg,#fff7ed,#ffedd5)",borderRadius:10}}/>
                  <div style={{height:60,background:"linear-gradient(135deg,#eff6ff,#dbeafe)",borderRadius:10}}/>
                </div>
                {[92,84,78,88,72,66].map((w,i)=>(
                  <div key={i} style={{height:9,background:"#e2e8f0",borderRadius:4,marginBottom:7,width:`${w}%`}}/>
                ))}
                <div style={{height:140,background:"linear-gradient(135deg,#fef2f2 0%,#fff7ed 60%,#eff6ff 100%)",borderRadius:12,marginTop:14}}/>
                {[80,68,90,74].map((w,i)=>(
                  <div key={`b-${i}`} style={{height:9,background:"#e2e8f0",borderRadius:4,marginTop:7,width:`${w}%`}}/>
                ))}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginTop:14}}>
                  <div style={{height:48,background:"#f1f5f9",borderRadius:10}}/>
                  <div style={{height:48,background:"#f1f5f9",borderRadius:10}}/>
                </div>
              </div>

              {/* Diagonal SAMPLE REPORT watermark */}
              <div aria-hidden="true" style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%) rotate(-22deg)",fontSize:54,fontWeight:900,color:"rgba(239,68,68,.22)",letterSpacing:".18em",pointerEvents:"none",whiteSpace:"nowrap"}}>SAMPLE REPORT</div>

              {/* Centered lock overlay */}
              <div aria-hidden="true" style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none"}}>
                <div style={{width:78,height:78,borderRadius:"50%",background:"linear-gradient(135deg,#ef4444,#f97316)",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 14px 38px rgba(239,68,68,.55),0 0 0 6px rgba(255,255,255,.85)"}}>
                  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="4" y="11" width="16" height="10" rx="2"/>
                    <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 4. SOCIAL PROOF */}
      <section style={{background:"#1e293b",padding:"52px 20px 56px",borderBottom:"1px solid rgba(249,115,22,.22)"}}>
        <div style={{maxWidth:1040,margin:"0 auto"}}>
          <h2 className="report-h2" style={{fontWeight:900,textAlign:"center",marginBottom:30,color:"#fff"}}>
            What People Are Saying
          </h2>
          <div className="nums-grid" style={{display:"grid",gridTemplateColumns:"repeat(3, 1fr)",gap:18}}>
            {testimonials.map((t)=>(
              <div key={t.name} style={{position:"relative",background:"rgba(15,23,42,.6)",border:"1px solid rgba(249,115,22,.18)",borderLeft:"4px solid #f97316",borderRadius:14,padding:"24px 22px 22px",boxShadow:"0 6px 22px rgba(0,0,0,.32)"}}>
                {/* Large orange opening quotation mark */}
                <span aria-hidden="true" style={{position:"absolute",top:-6,left:14,fontSize:72,lineHeight:1,fontWeight:900,color:"#f97316",fontFamily:"Georgia, 'Times New Roman', serif",pointerEvents:"none",opacity:.9}}>&ldquo;</span>
                <div style={{display:"flex",gap:3,marginBottom:10,position:"relative",zIndex:1}}>
                  {[1,2,3,4,5].map(i=>(
                    <span key={i} style={{color:"#f97316",fontSize:18}}>&#9733;</span>
                  ))}
                </div>
                <p style={{fontSize:15,color:"rgba(255,255,255,.85)",lineHeight:1.65,marginBottom:14,marginTop:6,fontStyle:"italic",position:"relative",zIndex:1}}>{t.quote}</p>
                <div style={{fontSize:14,color:"#fff",fontWeight:900,position:"relative",zIndex:1}}>{t.name}<span style={{color:"rgba(255,255,255,.55)",fontWeight:600}}>, {t.loc}</span></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 5. FINAL CTA */}
      <section style={{background:"linear-gradient(150deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",padding:"56px 20px 60px",textAlign:"center",position:"relative",overflow:"hidden"}}>
        <div style={{maxWidth:720,margin:"0 auto",position:"relative",zIndex:1}}>

          {/* Pulsing urgency pill */}
          <div className="slow-pulse" style={{display:"inline-flex",alignItems:"center",gap:8,padding:"7px 14px",borderRadius:999,background:"rgba(249,115,22,.15)",border:"1px solid rgba(249,115,22,.55)",marginBottom:18}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            <span style={{fontSize:12,fontWeight:900,color:"#f97316",letterSpacing:".14em",textTransform:"uppercase"}}>Limited Time Price</span>
          </div>

          <h2 className="report-h2" style={{fontWeight:900,color:"#fff",marginBottom:10}}>
            Get Your Personalized Report Now
          </h2>
          <p style={{fontSize:14,color:"rgba(255,255,255,.6)",lineHeight:1.7,marginBottom:4,letterSpacing:".06em",textTransform:"uppercase",fontWeight:700}}>
            For the address you searched
          </p>
          <p style={{fontSize:16,fontWeight:800,color:"#fff",marginBottom:24,wordBreak:"break-word",maxWidth:560,marginLeft:"auto",marginRight:"auto"}}>
            {searchAddress}
          </p>

          {/* Price with subtle orange radial glow behind it */}
          <div style={{position:"relative",display:"inline-block",padding:"6px 18px",marginBottom:6}}>
            <div aria-hidden="true" style={{position:"absolute",inset:"-30px -40px",background:"radial-gradient(ellipse at center, rgba(249,115,22,.40) 0%, rgba(249,115,22,0) 65%)",filter:"blur(8px)",pointerEvents:"none",zIndex:0}}/>
            <div style={{display:"inline-flex",alignItems:"baseline",gap:14,position:"relative",zIndex:1,flexWrap:"wrap",justifyContent:"center"}}>
              <span style={{fontSize:22,color:"rgba(255,255,255,.5)",textDecoration:"line-through",fontWeight:600}}>$24.99</span>
              <span style={{fontSize:58,fontWeight:900,letterSpacing:"-.025em",background:"linear-gradient(135deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",lineHeight:1}}>$14.99</span>
            </div>
          </div>

          <div style={{marginTop:8,marginBottom:18}}>
            <button onClick={handleBuyReport} className="cta-pulse" style={{...primaryBtn(),padding:"20px 40px",fontSize:18}}>
              Yes, Get My Full Report for $14.99
            </button>
          </div>

          {/* Accepted payment methods. Stripe Checkout enables card +
              wallets (Apple Pay, Google Pay) via automatic_payment_methods;
              this row tells the buyer up front so they do not bounce. */}
          <PaymentMethodsRow/>

          <div style={{display:"flex",justifyContent:"center",alignItems:"center",gap:18,flexWrap:"wrap",marginBottom:18}}>
            {[
              {label:"Instant Download"},
              {label:"Secure Payment"},
              {label:"Personalized to Your Address"},
            ].map(b => (
              <div key={b.label} style={{display:"inline-flex",alignItems:"center",gap:8,color:"rgba(255,255,255,.75)",fontSize:13,fontWeight:700}}>
                <span style={{display:"inline-flex",width:22,height:22,borderRadius:"50%",background:"rgba(16,185,129,.18)",alignItems:"center",justifyContent:"center"}}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                </span>
                {b.label}
              </div>
            ))}
          </div>

          <p style={{fontSize:12,color:"rgba(255,255,255,.45)",lineHeight:1.7,maxWidth:560,margin:"0 auto"}}>
            Report is generated based on HumZones research database. All figures are estimates. See our <a href="/methodology" onClick={e=>{e.preventDefault();onNavigate("/methodology");}} className="ext-link" style={{color:"#f97316",fontWeight:700,textDecoration:"none"}}>methodology page</a> for details.
          </p>
        </div>
      </section>

      {/* FOOTER DISCLAIMER */}
      <footer style={{background:"#020c1b",borderTop:"1px solid rgba(249,115,22,.18)",padding:"26px 20px 30px"}}>
        <p style={{fontSize:12,color:"rgba(255,255,255,.48)",lineHeight:1.7,maxWidth:780,margin:"0 auto",textAlign:"center"}}>
          HumZones reports are informational resources only. Data is compiled from public sources including utility filings, operator announcements and industry databases. Figures are modeled estimates and actual values may vary significantly by facility, season and operating conditions. Purchase of this report does not constitute medical, legal or scientific advice. All sales are final. Report delivery is instant via PDF download.
        </p>
      </footer>
    </div>
  );
};

// ─── REPORT SUCCESS (post-payment PDF generation) ─────────────────────────────
// Reached after Stripe checkout success. Reads the captured search context out
// of localStorage, refetches the buyer email from the Stripe session, pulls
// every facility from Airtable, keeps those within 100km of the searched
// coordinates, generates a multi-page PDF with jsPDF, triggers download, and
// silently records the purchase in the Emails capture table.
const ReportSuccessPage = ({ onBack, onNavigate }) => {
  // status: loading -> generating -> ready / error
  const [status, setStatus] = useState("loading");
  const [stepMsg, setStepMsg] = useState("Fetching your facility data...");
  const [progress, setProgress] = useState(10);
  const [errMsg, setErrMsg] = useState("");

  // Guard against React 18 StrictMode double-invocation in dev: the PDF
  // generator must run exactly once so the buyer is not served two downloads.
  const startedRef = useRef(false);

  const get = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const run = async () => {
      try {
        // ─── 1. Pull search context from localStorage with URL-param fallback ─
        // The buy flow writes the context to localStorage before redirecting
        // to the Stripe Payment Link. URL params are kept as a fallback for
        // browsers (Safari ITP, strict third-party-cookie blockers) that may
        // wipe localStorage across the Stripe redirect.
        console.log("localStorage dump:", {
          searchLat:       localStorage.getItem("searchLat"),
          searchLng:       localStorage.getItem("searchLng"),
          searchAddress:   localStorage.getItem("searchAddress"),
          facilities100km: localStorage.getItem("facilities100km"),
          highRiskCount:   localStorage.getItem("highRiskCount"),
          facilitiesFound: localStorage.getItem("facilitiesFound"),
          selectedRadius:  localStorage.getItem("selectedRadius"),
        });
        const params = new URLSearchParams(window.location.search);
        console.log("URL params dump:", {
          session_id: params.get("session_id"),
          lat:        params.get("lat"),
          lng:        params.get("lng"),
          address:    params.get("address"),
          r100:       params.get("r100"),
          high:       params.get("high"),
          found:      params.get("found"),
          radius:     params.get("radius"),
        });

        const searchAddress   = localStorage.getItem("searchAddress") || params.get("address") || "Your area";
        const searchLat       = parseFloat(localStorage.getItem("searchLat") || params.get("lat"));
        const searchLng       = parseFloat(localStorage.getItem("searchLng") || params.get("lng"));
        const facilities100   = parseInt(localStorage.getItem("facilities100km") || params.get("r100"),   10);
        const highRisk        = parseInt(localStorage.getItem("highRiskCount")   || params.get("high"),   10);
        const facilitiesFound = parseInt(localStorage.getItem("facilitiesFound") || params.get("found"),  10);
        const selectedRadius  = parseInt(localStorage.getItem("selectedRadius")  || params.get("radius"), 10);
        console.log("[HumZones] /report-success resolved inputs:", { searchAddress, searchLat, searchLng, facilities100, highRisk, facilitiesFound, selectedRadius });

        // We no longer hit a serverless function to read the Stripe session;
        // the buy flow redirects directly to a Stripe Payment Link, so the
        // buyer email is not available client-side after the redirect back.
        // The PDF and the Airtable Emails capture leave the Email field
        // blank when we cannot derive it.
        const buyerEmail = "";

        // ─── 2. Fetch every facility from Airtable ──────────────────────────
        setStepMsg("Fetching your facility data...");
        setProgress(25);
        const reportFields = [
          "Name","Company","City","State_Region","Country","Address","Facility_Status",
          "Risk_Level","Power_MW","Noise_DB","CO2_Tons_Year","Water_Gal_Day",
          "EMF_Fence_High","EMF_100m","Cooling","Opened","Latitude","Longitude",
        ];
        let allFacs = [];
        try {
          allFacs = await apiFetch("Facilities", {"fields[]": reportFields});
          console.log(`[HumZones] Airtable returned ${allFacs.length} facilities`);
        } catch (e) {
          console.error("[HumZones] Airtable fetch failed:", e);
          throw new Error("Could not load facility data. Please refresh to try again.");
        }
        if (!allFacs.length) {
          throw new Error("Facility database returned no records. Please contact support.");
        }

        // ─── 3. Haversine filter to <=100km, sorted nearest first ───────────
        setStepMsg("Calculating distances...");
        setProgress(50);
        const hasCoords = Number.isFinite(searchLat) && Number.isFinite(searchLng);
        if (!hasCoords) {
          console.warn("[HumZones] Missing searchLat/searchLng in localStorage AND URL params. Report will show 0 facilities.");
        }
        const facsNear = hasCoords
          ? allFacs
              .map(f => {
                const lat = parseFloat(f.Latitude), lng = parseFloat(f.Longitude);
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
                return { ...f, _km: distanceKm(searchLat, searchLng, lat, lng) };
              })
              .filter(f => f && f._km <= 100)
              .sort((a, b) => a._km - b._km)
          : [];
        console.log(`[HumZones] ${facsNear.length} facilities within 100km of (${searchLat}, ${searchLng})`);

        // Resolvers fill in metrics the Airtable row is missing so the PDF
        // never shows 0 next to a facility. Power_MW is the base figure
        // every other formula needs; if it is missing we infer it from the
        // risk band the methodology page already defines (HIGH = 50MW+,
        // MODERATE = 15-50, LOW = small/rural). CO2 and water use the
        // industry-standard multipliers supplied by the brief; noise falls
        // back to the band-level perimeter dB values.
        const resolvePower = (f) => {
          const v = Number(f.Power_MW);
          if (Number.isFinite(v) && v > 0) return v;
          const lvl = String(f.Risk_Level || "").toUpperCase();
          if (lvl === "HIGH") return 50;
          if (lvl === "MODERATE") return 25;
          return 10;
        };
        const resolveCO2 = (f, mw) => {
          const v = Number(f.CO2_Tons_Year);
          if (Number.isFinite(v) && v > 0) return v;
          return Math.round((mw * 3381) / 1000) * 1000;
        };
        const resolveWater = (f, mw) => {
          const v = Number(f.Water_Gal_Day);
          if (Number.isFinite(v) && v > 0) return v;
          const cool = String(f.Cooling || "").toLowerCase();
          let mult = 750; // default
          if (cool.includes("evaporative")) mult = 10000;
          else if (cool.includes("chilled water")) mult = 750;
          else if (cool.includes("air")) mult = 250;
          return mw * mult;
        };
        const resolveNoise = (f) => {
          const v = Number(f.Noise_DB);
          if (Number.isFinite(v) && v > 0) return v;
          const lvl = String(f.Risk_Level || "").toUpperCase();
          if (lvl === "HIGH") return 68;
          if (lvl === "MODERATE") return 65;
          return 60;
        };

        // Rollups for the executive summary. Sum the resolved values so the
        // combined totals also never report 0 for a populated database.
        const counts = { HIGH: 0, MODERATE: 0, LOW: 0 };
        let totalPower = 0, totalWater = 0, totalCO2 = 0;
        facsNear.forEach(f => {
          const lvl = String(f.Risk_Level || "").toUpperCase();
          if (lvl === "HIGH") counts.HIGH++;
          else if (lvl === "MODERATE") counts.MODERATE++;
          else counts.LOW++;
          const mw = resolvePower(f);
          totalPower += mw;
          totalWater += resolveWater(f, mw);
          totalCO2   += resolveCO2(f, mw);
        });

        // ─── 4. Generate the PDF ────────────────────────────────────────────
        setStepMsg("Generating your personalized report...");
        setStatus("generating");
        setProgress(72);

        const jsPDFModule = await import("jspdf");
        const { jsPDF } = jsPDFModule;
        const doc = new jsPDF({ unit: "pt", format: "letter" });
        const PW = doc.internal.pageSize.getWidth();   // 612
        const PH = doc.internal.pageSize.getHeight();  // 792
        const M  = 56;

        const today    = new Date();
        const datePart = today.toISOString().slice(0, 10);
        const dateLong = today.toLocaleDateString("en-US", { year:"numeric", month:"long", day:"numeric" });

        const fmtNum = (n) => Number(n).toLocaleString();
        const fmtMW  = (mw) => mw >= 1000 ? `${(mw/1000).toFixed(2).replace(/\.?0+$/,"")} GW` : `${fmtNum(mw)} MW`;
        const setText = (r,g,b) => doc.setTextColor(r,g,b);

        const totalFound = facsNear.length;
        const safeHigh   = Number.isFinite(highRisk) ? highRisk : counts.HIGH;

        // Repeating top band so every internal page is branded the same way.
        const drawTopBand = (rightLabel) => {
          doc.setFillColor(15, 23, 42);
          doc.rect(0, 0, PW, 32, "F");
          doc.setFillColor(249, 115, 22);
          doc.rect(0, 32, PW, 2, "F");
          doc.setFont("helvetica", "bold");
          doc.setFontSize(11);
          setText(255, 255, 255);
          doc.text("HumZones Full Area Report", M, 22);
          if (rightLabel) {
            doc.setFont("helvetica", "normal");
            setText(148, 163, 184);
            doc.text(rightLabel, PW - M, 22, { align: "right" });
          }
        };

        // ═══ PAGE 1: COVER ═══════════════════════════════════════════════════
        // Top brand accent bars
        doc.setFillColor(15, 23, 42);
        doc.rect(0, 0, PW, 6, "F");
        doc.setFillColor(249, 115, 22);
        doc.rect(0, 6, PW, 3, "F");

        // Wordmark
        doc.setFont("helvetica", "bold");
        doc.setFontSize(16);
        setText(15, 23, 42);
        doc.text("HumZones", M, 48);

        // Title
        let y = 180;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(30);
        setText(15, 23, 42);
        doc.text("HumZones Full Area Report", M, y);
        y += 30;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(15);
        setText(100, 116, 139);
        doc.text("Personalized Data Center Health Analysis", M, y);

        // Address + date card
        y += 50;
        doc.setFillColor(241, 245, 249);
        doc.rect(M, y - 20, PW - M*2, 130, "F");
        doc.setFillColor(249, 115, 22);
        doc.rect(M, y - 20, 4, 130, "F");

        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        setText(100, 116, 139);
        doc.text("ADDRESS", M + 20, y);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(13);
        setText(15, 23, 42);
        const addrLines = doc.splitTextToSize(searchAddress, PW - M*2 - 40);
        doc.text(addrLines.slice(0, 2), M + 20, y + 20);

        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        setText(100, 116, 139);
        doc.text("GENERATED", M + 20, y + 60);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(13);
        setText(15, 23, 42);
        doc.text(dateLong, M + 20, y + 80);

        // Counts panel
        y += 150;
        doc.setFillColor(15, 23, 42);
        doc.rect(M, y, PW - M*2, 110, "F");
        doc.setFillColor(249, 115, 22);
        doc.rect(M, y, 4, 110, "F");

        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        setText(249, 115, 22);
        doc.text("TOTAL FACILITIES WITHIN 100KM", M + 20, y + 28);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(32);
        setText(255, 255, 255);
        doc.text(String(totalFound), M + 20, y + 70);

        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        setText(249, 115, 22);
        doc.text("HIGH RISK FACILITIES", M + 260, y + 28);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(32);
        setText(255, 255, 255);
        doc.text(String(safeHigh), M + 260, y + 70);

        // Footer
        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        setText(15, 23, 42);
        doc.text("Prepared by HumZones Technologies Inc.", M, PH - 56);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        setText(100, 116, 139);
        doc.text("Global Data Center Health Registry  |  humzones.com", M, PH - 38);

        // ═══ PAGE 2: EXECUTIVE SUMMARY ═══════════════════════════════════════
        doc.addPage();
        drawTopBand("Executive Summary");

        y = 80;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(22);
        setText(15, 23, 42);
        doc.text("Executive Summary", M, y);

        y += 36;
        const rows = [
          ["Total facilities within 100km",       String(totalFound)],
          ["HIGH risk facilities",                 String(counts.HIGH)],
          ["MODERATE risk facilities",             String(counts.MODERATE)],
          ["LOW risk facilities",                  String(counts.LOW)],
          ["Combined estimated power draw",        fmtMW(totalPower)],
          ["Combined daily water consumption",     `${fmtNum(totalWater)} gallons`],
          ["Combined CO2 per year",                `${fmtNum(totalCO2)} tons`],
        ];
        rows.forEach((r, idx) => {
          if (idx % 2 === 0) {
            doc.setFillColor(248, 250, 252);
            doc.rect(M, y - 14, PW - M*2, 28, "F");
          }
          doc.setFont("helvetica", "normal");
          doc.setFontSize(12);
          setText(71, 85, 105);
          doc.text(r[0], M + 14, y + 4);
          doc.setFont("helvetica", "bold");
          setText(15, 23, 42);
          doc.text(r[1], PW - M - 14, y + 4, { align: "right" });
          y += 28;
        });

        y += 18;
        const paragraph = `This report identifies ${totalFound} data center ${totalFound === 1 ? "facility" : "facilities"} operating within 100km of your address. Of these, ${counts.HIGH} ${counts.HIGH === 1 ? "is" : "are"} classified as HIGH risk based on power scale, proximity to residential areas and cooling type.`;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(11);
        setText(71, 85, 105);
        const pWrap = doc.splitTextToSize(paragraph, PW - M*2);
        doc.text(pWrap, M, y);

        // ═══ PAGE 3+: PER-FACILITY DETAIL ═══════════════════════════════════
        if (facsNear.length > 0) {
          doc.addPage();
          drawTopBand("Facilities within 100km");

          y = 80;
          doc.setFont("helvetica", "bold");
          doc.setFontSize(22);
          setText(15, 23, 42);
          doc.text("Facilities Near You", M, y);
          y += 22;
          doc.setFont("helvetica", "normal");
          doc.setFontSize(11);
          setText(100, 116, 139);
          doc.text(`${facsNear.length} ${facsNear.length === 1 ? "facility" : "facilities"} sorted by distance, closest first.`, M, y);
          y += 24;

          const bottomLimit = PH - 64;
          const facBlockHeight = 190;

          facsNear.forEach((f) => {
            if (y + facBlockHeight > bottomLimit) {
              doc.addPage();
              drawTopBand("Facilities within 100km");
              y = 80;
            }

            // Facility name
            doc.setFont("helvetica", "bold");
            doc.setFontSize(15);
            setText(15, 23, 42);
            const nameLines = doc.splitTextToSize(f.Name || "Unnamed facility", PW - M*2);
            doc.text(nameLines[0], M, y);
            y += 18;

            // Company
            if (f.Company) {
              doc.setFont("helvetica", "normal");
              doc.setFontSize(11);
              setText(100, 116, 139);
              doc.text(String(f.Company), M, y);
              y += 16;
            }

            // Distance + risk on one row
            doc.setFont("helvetica", "bold");
            doc.setFontSize(10);
            setText(15, 23, 42);
            doc.text(`Distance: ${Number(f._km).toFixed(1)} km from your address`, M, y);
            const rc = String(f.Risk_Level).toUpperCase() === "HIGH"
              ? [239, 68, 68]
              : String(f.Risk_Level).toUpperCase() === "MODERATE"
                ? [249, 115, 22]
                : [59, 130, 246];
            setText(rc[0], rc[1], rc[2]);
            doc.text(`Risk Level: ${String(f.Risk_Level || "UNKNOWN").toUpperCase()}`, M + 270, y);
            y += 16;

            // City / state
            doc.setFont("helvetica", "normal");
            doc.setFontSize(10);
            setText(71, 85, 105);
            const cityLine = [f.City, f.State_Region].filter(Boolean).join(", ");
            if (cityLine) {
              doc.text(cityLine, M, y);
              y += 14;
            }
            if (f.Address) {
              const aw = doc.splitTextToSize(String(f.Address), PW - M*2);
              const slice = aw.slice(0, 2);
              doc.text(slice, M, y);
              y += slice.length * 14;
            }
            y += 4;

            // Stats grid (two columns). Each metric routes through a
            // resolver so a missing/zero Airtable value falls back to the
            // formula or band-level value documented in the methodology;
            // the PDF never renders a literal 0 for power, noise, CO2 or
            // water.
            const mw    = resolvePower(f);
            const co2v  = resolveCO2(f, mw);
            const waterv= resolveWater(f, mw);
            const noisev= resolveNoise(f);
            const stats = [
              ["Power",         `${fmtNum(mw)} MW`],
              ["Noise",         `${noisev} dB`],
              ["CO2",           `${fmtNum(co2v)} tons per year`],
              ["Water",         `${fmtNum(waterv)} gallons per day`],
              ["EMF at fence",  f.EMF_Fence_High != null && f.EMF_Fence_High !== "" ? `${f.EMF_Fence_High} mG` : "n/a"],
              ["EMF at 100m",   f.EMF_100m       != null && f.EMF_100m       !== "" ? `${f.EMF_100m} mG`       : "n/a"],
              ["Cooling type",  f.Cooling || "n/a"],
              ["Opened",        f.Opened ? String(f.Opened) : "n/a"],
            ];
            const colW = (PW - M*2) / 2;
            stats.forEach((s, idx) => {
              const col = idx % 2;
              if (col === 0 && idx > 0) y += 16;
              const x = M + col * colW;
              doc.setFont("helvetica", "bold");
              doc.setFontSize(10);
              setText(100, 116, 139);
              doc.text(`${s[0]}:`, x, y);
              doc.setFont("helvetica", "normal");
              setText(15, 23, 42);
              const valLines = doc.splitTextToSize(String(s[1]), colW - 90);
              doc.text(valLines[0], x + 84, y);
            });
            y += 22;

            // Horizontal divider
            doc.setDrawColor(226, 232, 240);
            doc.setLineWidth(0.6);
            doc.line(M, y, PW - M, y);
            y += 18;
          });
        }

        // ═══ SECOND-TO-LAST: UNDERSTANDING YOUR RESULTS ═════════════════════
        doc.addPage();
        drawTopBand("Understanding Your Results");

        y = 80;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(22);
        setText(15, 23, 42);
        doc.text("Understanding Your Results", M, y);
        y += 28;

        const writePara = (txt) => {
          if (y + 80 > PH - 80) {
            doc.addPage();
            drawTopBand("Understanding Your Results");
            y = 80;
          }
          doc.setFont("helvetica", "normal");
          doc.setFontSize(11);
          setText(71, 85, 105);
          const lines = doc.splitTextToSize(txt, PW - M*2);
          doc.text(lines, M, y);
          y += lines.length * 14 + 12;
        };

        writePara("EMF exposure. Power-frequency electromagnetic fields from data center substations and feeder lines have been studied in relation to childhood leukemia by the WHO and IARC. Published research has identified elevated risk where homes are exposed to power-frequency fields above roughly 3 to 4 milligauss on a sustained basis. The EMF figures in this report show modeled values both at the facility fence and at 100 meters so you can see how exposure changes with distance.");
        writePara("Noise impact. Data centers operate around the clock and emit a continuous low-frequency hum from cooling systems and transformers. Low-frequency sound below 200 Hz penetrates walls and windows with far less attenuation than higher frequencies, which is why residents living within a few kilometers of large facilities consistently report sleep disruption, headaches and chronic background stress. Monthly backup generator tests add diesel exhaust on top of the steady noise.");
        writePara("Water and CO2. Evaporative cooling at hyperscale facilities removes large volumes of fresh water from the local cycle every single day. Combined with the grid emissions associated with around-the-clock electricity demand, the regional environmental footprint of multiple nearby facilities compounds rapidly. The figures in this report sum the modeled draw across every facility within 100km of your address.");

        y += 4;
        if (y + 30 > PH - 80) { doc.addPage(); drawTopBand("Understanding Your Results"); y = 80; }
        doc.setFont("helvetica", "bold");
        doc.setFontSize(16);
        setText(15, 23, 42);
        doc.text("What You Can Do", M, y);
        y += 22;

        const steps = [
          "Track your sleep quality, headache frequency and any tinnitus over a two to four week window. Patterns that improve when you leave the area are the strongest signal that environmental factors are involved.",
          "Request the generator test schedule of your nearest facility in writing and keep windows closed on test days. Run a HEPA rated air purifier indoors during and after each test, particularly if children or anyone with asthma lives in the household.",
          "Ask a qualified electrician or environmental consultant to measure power-frequency EMF at your property boundary if you live within roughly 500 meters of a substation or fence line. Compare the reading against the 3 to 4 milligauss threshold cited in the published research.",
          "File a formal noise complaint with your county or municipal zoning authority and request the facility's noise monitoring data and the conditions attached to its industrial use permit. Keep every complaint number and follow up in writing.",
          "Contact your state environmental agency for the facility's emissions records and your county health department if you suspect groundwater impact. Document every conversation by date and reference number.",
        ];
        steps.forEach((s, idx) => {
          if (y + 60 > PH - 80) { doc.addPage(); drawTopBand("Understanding Your Results"); y = 80; }
          doc.setFont("helvetica", "bold");
          doc.setFontSize(11);
          setText(249, 115, 22);
          doc.text(`${idx + 1}.`, M, y);
          doc.setFont("helvetica", "normal");
          setText(71, 85, 105);
          const lines = doc.splitTextToSize(s, PW - M*2 - 20);
          doc.text(lines, M + 20, y);
          y += lines.length * 14 + 10;
        });

        y += 14;
        if (y + 40 > PH - 60) { doc.addPage(); drawTopBand("Understanding Your Results"); y = 80; }
        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        // "For full methodology visit humzones.com/methodology"
        // The URL portion is rendered with jsPDF.textWithLink so it is a real
        // clickable hyperlink in the exported PDF; orange visually flags it.
        setText(15, 23, 42);
        const methPrefix = "For full methodology visit ";
        doc.text(methPrefix, M, y);
        setText(249, 115, 22);
        doc.textWithLink("humzones.com/methodology", M + doc.getTextWidth(methPrefix), y, { url: "https://humzones.com/methodology" });
        setText(15, 23, 42);
        y += 16;
        const qPrefix = "For questions visit ";
        doc.text(qPrefix, M, y);
        setText(249, 115, 22);
        doc.textWithLink("humzones.com", M + doc.getTextWidth(qPrefix), y, { url: "https://humzones.com" });
        setText(15, 23, 42);

        // ═══ SHARE YOUR EXPERIENCE ══════════════════════════════════════════
        doc.addPage();
        drawTopBand("Share Your Experience");

        y = 80;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(22);
        setText(15, 23, 42);
        doc.text("Share Your Experience", M, y);
        y += 28;

        const sharePara = (txt) => {
          if (y + 80 > PH - 80) { doc.addPage(); drawTopBand("Share Your Experience"); y = 80; }
          doc.setFont("helvetica", "normal");
          doc.setFontSize(11);
          setText(71, 85, 105);
          const lines = doc.splitTextToSize(txt, PW - M*2);
          doc.text(lines, M, y);
          y += lines.length * 14 + 12;
        };

        sharePara("Do you live near one of the facilities in this report? Your experience matters. HumZones collects verified resident reports from people living near data centers. Your report helps other residents understand what life is really like near these facilities and adds to our growing community database.");

        // Highlighted submit line with humzones.com as a real clickable
        // hyperlink. We split the line so the URL portion can be drawn with
        // doc.textWithLink while the leading copy stays in dark navy.
        if (y + 40 > PH - 80) { doc.addPage(); drawTopBand("Share Your Experience"); y = 80; }
        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        const submitPrefix = "Submit your resident report at: ";
        setText(15, 23, 42);
        doc.text(submitPrefix, M, y);
        setText(249, 115, 22);
        doc.textWithLink("humzones.com", M + doc.getTextWidth(submitPrefix), y, { url: "https://humzones.com" });
        setText(71, 85, 105);
        y += 22;

        sharePara("Click on Submit Your Report in the navigation menu. Reports are reviewed and published with your permission only. Your personal information is never shared.");
        sharePara("Together we can build the most comprehensive community health database for data center proximity in the world.");

        // Methodology link callout: separate clickable orange hyperlink the
        // buyer can tap straight from the PDF.
        if (y + 30 > PH - 80) { doc.addPage(); drawTopBand("Share Your Experience"); y = 80; }
        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        const methSharePrefix = "Read the full methodology at ";
        setText(15, 23, 42);
        doc.text(methSharePrefix, M, y);
        setText(249, 115, 22);
        doc.textWithLink("humzones.com/methodology", M + doc.getTextWidth(methSharePrefix), y, { url: "https://humzones.com/methodology" });
        setText(71, 85, 105);

        // ═══ LAST PAGE: LEGAL DISCLAIMER ════════════════════════════════════
        doc.addPage();
        drawTopBand("Important Disclaimer");

        y = 80;
        doc.setFont("helvetica", "bold");
        doc.setFontSize(22);
        setText(15, 23, 42);
        doc.text("Important Disclaimer", M, y);
        y += 28;

        const disclaimer = [
          "This HumZones Area Report is provided for informational and public awareness purposes only. All data, figures, estimates and risk assessments contained in this report are based on research compiled from public sources including utility filings, operator announcements, permit records and industry databases.",
          "All figures including but not limited to power consumption, noise levels, EMF readings, CO2 emissions and water usage are modeled estimates derived using industry standard formulas. They are not certified field measurements and have not been independently verified. Actual values may vary significantly depending on facility design, operating conditions, season and local terrain.",
          "Risk levels assigned as LOW, MODERATE or HIGH are relative indicators for general public awareness only. They do not constitute a scientific assessment, environmental evaluation or health determination of any kind.",
          "This report does not constitute medical, legal, scientific or environmental advice. HumZones Technologies Inc. makes no warranties express or implied regarding the accuracy, completeness or fitness for any particular purpose of the information contained herein.",
          "Residents with health concerns related to nearby infrastructure should consult qualified medical professionals, environmental scientists or legal advisors.",
          "HumZones Technologies Inc. shall not be liable for any damages, losses or consequences arising from the use of or reliance on information contained in this report.",
        ];
        disclaimer.forEach((p) => {
          if (y + 80 > PH - 80) { doc.addPage(); drawTopBand("Important Disclaimer"); y = 80; }
          doc.setFont("helvetica", "normal");
          doc.setFontSize(10);
          setText(71, 85, 105);
          const lines = doc.splitTextToSize(p, PW - M*2);
          doc.text(lines, M, y);
          y += lines.length * 13 + 10;
        });

        y += 6;
        if (y + 80 > PH - 60) { doc.addPage(); drawTopBand("Important Disclaimer"); y = 80; }
        doc.setFont("helvetica", "bold");
        doc.setFontSize(11);
        // Methodology line on the disclaimer page is also clickable.
        const discPrefix = "For full methodology and data sources visit ";
        setText(15, 23, 42);
        doc.text(discPrefix, M, y);
        setText(249, 115, 22);
        doc.textWithLink("humzones.com/methodology", M + doc.getTextWidth(discPrefix), y, { url: "https://humzones.com/methodology" });
        setText(15, 23, 42);
        y += 22;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(10);
        setText(100, 116, 139);
        doc.text("Report generated by HumZones Technologies Inc.", M, y); y += 14;
        doc.text("Global Data Center Health Registry",              M, y); y += 14;
        doc.text("humzones.com",                                     M, y); y += 14;
        doc.text(dateLong,                                           M, y);

        // ─── 5. Trigger the download ────────────────────────────────────────
        setStepMsg("Downloading your report...");
        setProgress(95);
        const safeAddr = (searchAddress || "report")
          .replace(/[\s,]+/g, "-")
          .replace(/[^A-Za-z0-9._-]/g, "")
          .replace(/-+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60) || "report";
        const filename = `HumZones-Report-${safeAddr}-${datePart}.pdf`;
        doc.save(filename);

        // ─── 6. Silently record the purchase in Airtable Emails ─────────────
        try {
          await postEmail({
            Email: buyerEmail || "",
            Date: datePart,
            Source: "PaidReport",
            Address: searchAddress,
            Facilities_100km: Number.isFinite(facilities100) ? facilities100 : totalFound,
            High_Risk_Count: Number.isFinite(highRisk) ? highRisk : counts.HIGH,
          });
        } catch (e) { console.warn("[HumZones] Emails capture failed:", e); }

        setProgress(100);
        setStepMsg("Done.");
        setStatus("ready");
      } catch (e) {
        console.error("[HumZones] Report generation failed:", e);
        setErrMsg(e.message || "We hit a snag generating your PDF. Please refresh this page or contact support and we will deliver it manually.");
        setStatus("error");
      }
    };

    run();
  }, []);

  const goHome = () => {
    if (onNavigate) onNavigate("/");
    else if (onBack) onBack();
  };

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",width:"100%",maxWidth:"100vw",overflowX:"hidden",color:"#fff"}}>
      {/* TOP BAR */}
      <div style={{padding:"22px 24px",display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div>
          <span style={{fontSize:22,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
          <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2}}>TM</sup>
        </div>
      </div>

      <main style={{maxWidth:640,margin:"0 auto",padding:"24px 24px 80px",textAlign:"center"}}>
        {(status === "loading" || status === "generating") && (
          <>
            <div className="slow-pulse" style={{width:84,height:84,borderRadius:"50%",background:"linear-gradient(135deg,#10b981,#059669)",margin:"24px auto 22px",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 18px 50px rgba(16,185,129,.4)"}}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <h1 style={{fontSize:30,fontWeight:900,letterSpacing:"-.01em",marginBottom:10,color:"#fff"}}>Payment Confirmed!</h1>
            <p style={{fontSize:17,color:"rgba(255,255,255,.78)",lineHeight:1.6,marginBottom:30}}>{stepMsg}</p>
            <div className="hz-progress-track" style={{maxWidth:420,margin:"0 auto 14px"}}>
              <div className="hz-progress-fill" style={{transform:`scaleX(${progress/100})`}}/>
            </div>
            <p style={{fontSize:12,color:"rgba(255,255,255,.5)",letterSpacing:".10em",textTransform:"uppercase",fontWeight:700}}>Please keep this tab open</p>
          </>
        )}

        {status === "ready" && (
          <>
            <div style={{width:84,height:84,borderRadius:"50%",background:"linear-gradient(135deg,#10b981,#059669)",margin:"24px auto 22px",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 18px 50px rgba(16,185,129,.4)"}}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <h1 style={{fontSize:30,fontWeight:900,letterSpacing:"-.01em",marginBottom:10,color:"#fff"}}>Your report has been downloaded!</h1>
            <p style={{fontSize:16,color:"rgba(255,255,255,.75)",lineHeight:1.65,marginBottom:28,maxWidth:520,marginLeft:"auto",marginRight:"auto"}}>
              Check your downloads folder for the PDF. If it did not start, click below to retry.
            </p>
            <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap"}}>
              <button onClick={goHome} className="cta-pulse" style={{padding:"16px 30px",borderRadius:14,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:16,fontWeight:900,letterSpacing:".02em",cursor:"pointer",fontFamily:"inherit",boxShadow:"0 10px 32px rgba(239,68,68,.45)"}}>
                Back to HumZones
              </button>
              <button onClick={() => window.location.reload()} style={{padding:"16px 24px",borderRadius:14,border:"1px solid rgba(255,255,255,.22)",background:"rgba(255,255,255,.06)",color:"#fff",fontSize:14,fontWeight:800,letterSpacing:".04em",cursor:"pointer",fontFamily:"inherit"}}>
                Download Again
              </button>
            </div>
          </>
        )}

        {status === "error" && (
          <>
            <div style={{width:84,height:84,borderRadius:"50%",background:"linear-gradient(135deg,#ef4444,#dc2626)",margin:"24px auto 22px",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 18px 50px rgba(239,68,68,.4)"}}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              </svg>
            </div>
            <h1 style={{fontSize:26,fontWeight:900,marginBottom:12,color:"#fff"}}>Something Went Wrong</h1>
            <p style={{fontSize:15,color:"rgba(255,255,255,.78)",lineHeight:1.65,marginBottom:24,maxWidth:520,marginLeft:"auto",marginRight:"auto"}}>{errMsg}</p>
            <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap"}}>
              <button onClick={() => window.location.reload()} className="cta-pulse" style={{padding:"16px 30px",borderRadius:14,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:16,fontWeight:900,letterSpacing:".02em",cursor:"pointer",fontFamily:"inherit"}}>
                Try Again
              </button>
              <button onClick={goHome} style={{padding:"16px 24px",borderRadius:14,border:"1px solid rgba(255,255,255,.22)",background:"rgba(255,255,255,.06)",color:"#fff",fontSize:14,fontWeight:800,letterSpacing:".04em",cursor:"pointer",fontFamily:"inherit"}}>
                Back to HumZones
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
};

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  // Lightweight client-side routing: track pathname, listen for back/forward,
  // and update via history.pushState. Vercel rewrites all paths to index.html
  // (see vercel.json) so deep links like /methodology work on direct load.
  const [path,setPath] = useState(typeof window!=="undefined"?window.location.pathname:"/");
  useEffect(()=>{
    const onPop = ()=>setPath(window.location.pathname);
    window.addEventListener("popstate",onPop);
    return ()=>window.removeEventListener("popstate",onPop);
  },[]);
  const navigate = (to)=>{
    if(to !== window.location.pathname) window.history.pushState({},"",to);
    setPath(to);
    window.scrollTo(0,0);
  };

  const [facs,setFacs]           = useState([]);
  const [loading,setLoading]     = useState(true);
  const [country,setCountry]     = useState("");
  const [cInput,setCInput]       = useState("");
  const [showCD,setShowCD]       = useState(false);
  const [region,setRegion]       = useState("");
  const [rInput,setRInput]       = useState("");
  const [showRD,setShowRD]       = useState(false);
  const [cityTxt,setCityTxt]     = useState("");
  const [showCityD,setShowCityD] = useState(false);
  const [cDropPos,setCDropPos]   = useState({top:0,left:0,width:0});
  const [rDropPos,setRDropPos]   = useState({top:0,left:0,width:0});
  const [cityDropPos,setCityDropPos] = useState({top:0,left:0,width:0});
  const [sel,setSel]             = useState(null);
  const [tab,setTab]             = useState("feel");
  const [reps,setReps]           = useState([]);
  const [draft,setDraft]         = useState("");
  const [repName,setRepName]     = useState("");
  const [repEmail,setRepEmail]   = useState("");
  const [repDuration,setRepDuration] = useState("");
  const [repSymptoms,setRepSymptoms] = useState([]);
  const [repDeclared,setRepDeclared] = useState(false);
  const [expandedRep,setExpandedRep] = useState(null);
  const MAX_REPORT_CHARS = 3000;
  const [hp,setHp]               = useState(""); // honeypot
  const [sending,setSending]     = useState(false);
  const [sent,setSent]           = useState(false);
  const [xLong,setXLong]         = useState(null);
  const [xKid,setXKid]           = useState(null);
  const [qStep,setQStep]         = useState(0);
  const [qAns,setQAns]           = useState({});
  const [qRes,setQRes]           = useState(null);
  const [qEmail,setQEmail]       = useState("");
  const [qEmailStep,setQEmailStep] = useState(false); // show email capture after quiz
  const [qEmailSent,setQEmailSent] = useState(false);
  // All four stats animate from 0 once the strip scrolls into view. Stats 1-3
  // have hardcoded targets and run independently of Airtable; stat 4 waits for
  // facs to load. Both kick off via the same statsVisible flag.
  const [statVals,setStatVals]   = useState([0,0,0,0]);
  const [statsVisible,setStatsVisible] = useState(false);
  const statsRef                 = useRef(null);
  const [showScrollTop,setShowScrollTop] = useState(false);
  // "Find Data Centers Near Me" panel state
  const [nearLoc,setNearLoc]     = useState(null);       // {lat,lng,label}
  const [nearAddr,setNearAddr]   = useState("");
  const [nearRadius,setNearRadius] = useState(50);       // km
  const [nearRisk,setNearRisk]   = useState("ALL");      // ALL | HIGH | HIGH_MOD
  const [nearStatus,setNearStatus] = useState("idle");   // idle | locating | geocoding
  const [nearError,setNearError] = useState("");
  // Email gate: unlock state persists in localStorage; "just unlocked" is a
  // session-only flag that controls the green success headline. The key is
  // humzones_email_unlocked so any previous unlocks under older keys are
  // intentionally invalidated and existing visitors see the gate again.
  const [nearEmailUnlocked,setNearEmailUnlocked] = useState(()=>{
    if(typeof window==="undefined") return false;
    try{ return localStorage.getItem("humzones_email_unlocked")==="1"; }catch{ return false; }
  });
  const [nearEmailInput,setNearEmailInput]   = useState("");
  const [nearEmailSending,setNearEmailSending] = useState(false);
  const [nearEmailError,setNearEmailError]   = useState("");
  const [justUnlocked,setJustUnlocked]       = useState(false);
  const cRef    = useRef(null);
  const rRef    = useRef(null);
  const ciRef   = useRef(null);
  const cDropRef  = useRef(null);
  const rDropRef  = useRef(null);
  const cityDropRef = useRef(null);
  const topRef  = useRef(null);
  // Scroll position to restore when the user leaves a facility detail view.
  const prevScrollRef = useRef(0);
  // Anchor for smoothly scrolling to the "X facilities found within Xkm"
  // sentence once Near Me search results render.
  const resultsHeadingRef = useRef(null);

  useEffect(()=>{
    cachedFetch("Facilities",{"fields[]":FACILITY_LIST_FIELDS})
      .then(d=>{ setFacs(d); console.log(`[HumZones] facs.length = ${d.length} (this is what the app rendered)`); })
      .catch(e=>{ console.error("[HumZones] Facilities fetch failed:",e); })
      .finally(()=>setLoading(false));
  },[]);

  useEffect(()=>{
    const handleScroll = () => setShowScrollTop(window.scrollY > 400);
    window.addEventListener("scroll", handleScroll, {passive:true});
    return () => window.removeEventListener("scroll", handleScroll);
  },[]);

  // Trigger stats animations once the strip becomes visible. IntersectionObserver
  // covers older browsers via a fallback that just flips the flag immediately.
  useEffect(()=>{
    if(statsVisible || !statsRef.current) return;
    if(typeof IntersectionObserver === "undefined"){ setStatsVisible(true); return; }
    const obs = new IntersectionObserver(entries=>{
      if(entries[0]?.isIntersecting){ setStatsVisible(true); obs.disconnect(); }
    },{threshold:0.15});
    obs.observe(statsRef.current);
    return ()=>obs.disconnect();
  },[statsVisible]);

  // Hardcoded stats 1-3: animate as soon as the strip is in view; do NOT wait
  // for Airtable data.
  useEffect(()=>{
    if(!statsVisible) return;
    const targets=[1000000000,4500000,1000000000000];
    let frame=0;
    const iv=setInterval(()=>{
      frame++;
      const e=1-Math.pow(1-frame/80,3);
      setStatVals(prev=>[
        Math.round(targets[0]*e),
        Math.round(targets[1]*e),
        Math.round(targets[2]*e),
        prev[3],
      ]);
      if(frame>=80){ clearInterval(iv); setStatVals(prev=>[targets[0],targets[1],targets[2],prev[3]]); }
    },2400/80);
    return ()=>clearInterval(iv);
  },[statsVisible]);

  // Dynamic stat 4 (facility count): animate when in view AND data has arrived.
  useEffect(()=>{
    if(!statsVisible || loading) return;
    const target=facs.length;
    let frame=0;
    const iv=setInterval(()=>{
      frame++;
      const e=1-Math.pow(1-frame/80,3);
      setStatVals(prev=>[prev[0],prev[1],prev[2],Math.round(target*e)]);
      if(frame>=80){ clearInterval(iv); setStatVals(prev=>[prev[0],prev[1],prev[2],target]); }
    },2400/80);
    return ()=>clearInterval(iv);
  },[statsVisible,loading,facs.length]);

  // Calculate dropdown position: called right when dropdown opens
  const openCDrop = useCallback(()=>{
    if(!cRef.current) return;
    const r = cRef.current.getBoundingClientRect();
    setCDropPos({top:r.bottom+8, left:r.left, width:r.width});
    setShowCD(true);
  },[]);

  const openRDrop = useCallback(()=>{
    if(!rRef.current) return;
    const r = rRef.current.getBoundingClientRect();
    setRDropPos({top:r.bottom+8, left:r.left, width:r.width});
    setShowRD(true);
  },[]);

  const openCityDrop = useCallback(()=>{
    if(!ciRef.current) return;
    const r = ciRef.current.getBoundingClientRect();
    setCityDropPos({top:r.bottom+8, left:r.left, width:r.width});
    setShowCityD(true);
  },[]);

  // Reposition on scroll/resize
  useEffect(()=>{
    const reposition = ()=>{
      if(showCD && cRef.current){
        const r = cRef.current.getBoundingClientRect();
        setCDropPos({top:r.bottom+8, left:r.left, width:r.width});
      }
      if(showRD && rRef.current){
        const r = rRef.current.getBoundingClientRect();
        setRDropPos({top:r.bottom+8, left:r.left, width:r.width});
      }
      if(showCityD && ciRef.current){
        const r = ciRef.current.getBoundingClientRect();
        setCityDropPos({top:r.bottom+8, left:r.left, width:r.width});
      }
    };
    const h = e => {
      const inCInput  = cRef.current   && cRef.current.contains(e.target);
      const inCDrop   = cDropRef.current && cDropRef.current.contains(e.target);
      const inRInput  = rRef.current   && rRef.current.contains(e.target);
      const inRDrop   = rDropRef.current && rDropRef.current.contains(e.target);
      const inCiInput = ciRef.current  && ciRef.current.contains(e.target);
      const inCiDrop  = cityDropRef.current && cityDropRef.current.contains(e.target);
      if(!inCInput  && !inCDrop)  setShowCD(false);
      if(!inRInput  && !inRDrop)  setShowRD(false);
      if(!inCiInput && !inCiDrop) setShowCityD(false);
    };
    document.addEventListener("mousedown",h);
    window.addEventListener("resize",reposition);
    window.addEventListener("scroll",reposition,true);
    return ()=>{
      document.removeEventListener("mousedown",h);
      window.removeEventListener("resize",reposition);
      window.removeEventListener("scroll",reposition,true);
    };
  },[showCD, showRD, showCityD]);

  const dc       = sel ? facs.find(f=>f.id===sel) : null;
  const rc       = dc ? (RISK_C[dc.Risk_Level]||"#64748b") : "#64748b";
  const symptoms = dc ? (SYMPTOMS[dc.Risk_Level]||SYMPTOMS["LOW-MODERATE"]) : [];
  const mapsUrl  = dc ? getGoogleMapsUrl(dc.Latitude, dc.Longitude, dc.Address, dc.Name) : "#";
  const locStr   = dc ? buildLocationString(dc) : "";

  useEffect(()=>{
    if(!dc) return;
    setReps([]);
    apiFetch("Reports",{filterByFormula:`AND({Facility} = "${dc.Name}", {Approved} = 1)`}).then(setReps).catch(()=>setReps([]));
  },[sel]);

  const countries   = [...new Set(facs.map(f=>f.Country).filter(Boolean))].sort();
  const cMatches    = cInput ? countries.filter(c=>c.toLowerCase().includes(cInput.toLowerCase())) : countries;
  // Label for the region selector adapts to the chosen country's terminology
  const regionLabel = (()=>{
    const c=(country||"").toLowerCase();
    if(c==="united states"||c==="usa"||c==="us"||c==="united states of america") return "State";
    if(c==="canada") return "Province";
    if(c==="australia") return "State/Territory";
    if(c==="united kingdom"||c==="uk") return "Country/Region";
    return "State/Region";
  })();
  const regionsInC  = country ? [...new Set(facs.filter(f=>f.Country===country).map(f=>f.State_Region).filter(Boolean))].sort() : [];
  const hasRegions  = regionsInC.length>0;
  const rMatches    = rInput ? regionsInC.filter(r=>r.toLowerCase().includes(rInput.toLowerCase())) : regionsInC;
  // Region is required for filtering only when the country actually has region data
  const regionReady = !!country && (!hasRegions || !!region);
  const citiesInC   = regionReady
    ? [...new Map(facs.filter(f=>f.Country===country && (!region || f.State_Region===region)).map(f=>[f.City,f])).values()]
    : [];
  const cityMatches = cityTxt ? citiesInC.filter(f=>f.City?.toLowerCase().includes(cityTxt.toLowerCase())) : citiesInC;
  const cityGroups  = cityMatches.reduce((a,f)=>{ if(!a[f.City])a[f.City]=[]; a[f.City].push(f); return a; },{});

  const pickCountry = c => { setCountry(c); setCInput(c); setShowCD(false); setRegion(""); setRInput(""); setShowRD(false); setCityTxt(""); setSel(null); };
  const pickRegion  = r => { setRegion(r); setRInput(r); setShowRD(false); setCityTxt(""); setSel(null); };
  const clearAll    = () => { setCountry(""); setCInput(""); setRegion(""); setRInput(""); setCityTxt(""); setSel(null); setShowCD(false); setShowRD(false); setShowCityD(false); };
  const pickFac     = id => {
    // Remember where the user was scrolled so Back to Results can restore it.
    prevScrollRef.current = typeof window !== "undefined" ? window.scrollY : 0;
    setSel(id); setTab("feel");
    setQStep(0); setQRes(null); setQAns({});
    setXLong(null); setXKid(null); setSent(false);
    setTimeout(()=>topRef.current?.scrollIntoView({behavior:"smooth"}),100);
    // Lazy-load heavy fields (Address, Nearby, ...) excluded from the
    // initial list fetch; merge them into the record once, on first select.
    const existing = facs.find(f=>f.id===id);
    if(existing && !existing._full){
      fetchRecord("Facilities",id).then(full=>{
        if(full) setFacs(prev=>prev.map(f=>f.id===id?{...f,...full,_full:true}:f));
      });
    }
  };

  // "Find Data Centers Near Me": geolocation, geocoding, results
  const handleGeolocate = () => {
    if(!("geolocation" in navigator)){ setNearError("Geolocation is not available in this browser."); return; }
    setNearStatus("locating"); setNearError("");
    navigator.geolocation.getCurrentPosition(
      pos => {
        setNearLoc({lat:pos.coords.latitude,lng:pos.coords.longitude,label:"My location"});
        setNearStatus("idle"); setSel(null);
        // Reset scroll after the DOM updates so a stray horizontal offset
        // (which can appear on iPhone when long content first renders) is gone.
        setTimeout(()=>{ try{ resultsHeadingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }catch{} }, 100);
      },
      err => {
        setNearError(err.code===1?"Location permission denied. Try entering an address instead.":"Could not determine your location.");
        setNearStatus("idle");
      },
      {timeout:10000,maximumAge:60000}
    );
  };
  const handleGeocode = async () => {
    const q = nearAddr.trim();
    if(!q) return;
    setNearStatus("geocoding"); setNearError("");
    try{
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
      const r = await fetch(url, {
        headers: {
          "Accept": "application/json",
          // Nominatim's usage policy asks for a custom User-Agent. Browsers
          // strip this header from fetch silently, but we set it so the call
          // is well-formed when running outside a browser as well.
          "User-Agent": "HumZones/1.0 (humzones.com)",
        },
      });
      if(!r.ok){
        console.error("Nominatim HTTP error:", r.status, r.statusText);
        setNearError(r.status === 429
          ? "Address service is busy right now. Please try again in a moment."
          : "Address lookup failed. Please try again.");
        setNearStatus("idle");
        return;
      }
      const j = await r.json();
      if(!Array.isArray(j) || j.length === 0){
        console.warn("Nominatim returned no results for:", q, j);
        setNearError("Address not found. Try a more specific search.");
        setNearStatus("idle");
        return;
      }
      const lat = parseFloat(j[0].lat);
      const lng = parseFloat(j[0].lon);
      if(!Number.isFinite(lat) || !Number.isFinite(lng)){
        console.error("Nominatim returned invalid coordinates:", j[0]);
        setNearError("Address found but coordinates were invalid. Try a more specific search.");
        setNearStatus("idle");
        return;
      }
      setNearLoc({ lat, lng, label: j[0].display_name || q });
      setNearStatus("idle"); setSel(null);
      // Reset scroll after the DOM updates so a stray horizontal offset
      // (which can appear on iPhone when long content first renders) is gone.
      setTimeout(()=>{ try{ resultsHeadingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }catch{} }, 100);
    }catch(err){
      console.error("Address geocoding failed:", err);
      setNearError("Address lookup failed. Check your connection and try again.");
      setNearStatus("idle");
    }
  };
  const clearNear = () => { setNearLoc(null); setNearAddr(""); setNearError(""); setNearStatus("idle"); };

  // Close the facility detail view and restore the user's previous scroll
  // position so they land back where they were in the results list.
  const handleBackToResults = () => {
    setSel(null);
    setTimeout(()=>{
      try{ window.scrollTo({ top: prevScrollRef.current || 0, behavior: "smooth" }); }catch{}
    }, 30);
  };

  // Build a comma-separated risk roll-up like "3 HIGH, 4 MODERATE, 2 LOW".
  // Known levels render in a fixed order so the column is easy to scan; any
  // unexpected Risk_Level value is appended at the end so nothing is dropped.
  const buildRiskSummary = (results) => {
    const counts = {};
    for(const f of results){
      const lvl = f.Risk_Level || "UNKNOWN";
      counts[lvl] = (counts[lvl] || 0) + 1;
    }
    const order = ["HIGH","MODERATE","LOW-MODERATE","LOW"];
    const parts = [];
    for(const lvl of order){
      if(counts[lvl]) parts.push(`${counts[lvl]} ${lvl}`);
    }
    for(const k of Object.keys(counts)){
      if(!order.includes(k)) parts.push(`${counts[k]} ${k}`);
    }
    return parts.join(", ");
  };

  const handleEmailUnlock = () => {
    const email = nearEmailInput.trim();
    if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
      setNearEmailError("Please enter a valid email address.");
      return;
    }
    setNearEmailError(""); setNearEmailSending(true);
    // Unlock optimistically so the UI feels instant; the Airtable POST runs in
    // the background and we keep the user unlocked even if it fails.
    try{ localStorage.setItem("humzones_email_unlocked","1"); }catch{}
    setNearEmailUnlocked(true);
    setJustUnlocked(true);
    const isGPS = nearLoc && nearLoc.label === "My location";
    // facilities100kmCount is the same 100km roll-up the upsell banner uses;
    // captured silently so we know the full scope for any follow-up report.
    postEmail({
      Email: email,
      Date: new Date().toISOString().slice(0,10),
      Source: "NearMe",
      Address: nearLoc ? (isGPS ? "GPS Location" : nearLoc.label) : "",
      Latitude: nearLoc ? nearLoc.lat : null,
      Longitude: nearLoc ? nearLoc.lng : null,
      Radius_KM: nearRadius,
      Facilities_Count: nearResults.length,
      Facilities_100km: facilities100kmCount,
      Risk_Summary: buildRiskSummary(nearResults),
    }).finally(()=>setNearEmailSending(false));
  };

  const nearResults = nearLoc ? facs
    .map(f => {
      const lat = parseFloat(f.Latitude), lng = parseFloat(f.Longitude);
      if(!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { ...f, _km: distanceKm(nearLoc.lat, nearLoc.lng, lat, lng) };
    })
    .filter(f => f && f._km <= nearRadius)
    .filter(f => nearRisk==="ALL"
              || (nearRisk==="HIGH" && f.Risk_Level==="HIGH")
              || (nearRisk==="HIGH_MOD" && (f.Risk_Level==="HIGH" || f.Risk_Level==="MODERATE")))
    .sort((a,b) => a._km - b._km)
    : [];

  // Wider 100km roll-ups for the paid-report upsell banner and Airtable capture.
  // Computed in a single pass over facs, independent of nearRadius and nearRisk.
  let _f100 = 0, _fHigh100 = 0;
  if (nearLoc) {
    for (const f of facs) {
      const lat = parseFloat(f.Latitude), lng = parseFloat(f.Longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (distanceKm(nearLoc.lat, nearLoc.lng, lat, lng) <= 100) {
        _f100++;
        if (f.Risk_Level === "HIGH") _fHigh100++;
      }
    }
  }
  const facilities100kmCount = _f100;
  const high100kmCount        = _fHigh100;

  const handleGetFullReport = () => {
    try {
      const isGPS = nearLoc && nearLoc.label === "My location";
      localStorage.setItem("searchAddress",   nearLoc ? (isGPS ? "GPS Location" : nearLoc.label) : "");
      localStorage.setItem("searchLat",       nearLoc ? String(nearLoc.lat) : "");
      localStorage.setItem("searchLng",       nearLoc ? String(nearLoc.lng) : "");
      localStorage.setItem("selectedRadius",  String(nearRadius));
      localStorage.setItem("facilitiesFound", String(nearResults.length));
      localStorage.setItem("facilities100km", String(facilities100kmCount));
      localStorage.setItem("highRiskCount",   String(high100kmCount));
    } catch {}
    navigate("/report-landing");
  };

  const calcQuiz = a => {
    let score=0; const flags=[];
    const actions=[];

    if(a.dist==="Less than 0.25 miles"){
      score+=3;
      flags.push("You are in the highest impact zone, within the documented range for significant EMF, noise, and air pollution exposure.");
      actions.push("Request a professional EMF measurement at your property boundary immediately. At this distance, readings can exceed the 3-4 milligauss threshold linked to health concerns.");
      actions.push("File a formal noise complaint with your local zoning authority, citing industrial use permit conditions. Request the facility's noise monitoring data.");
    } else if(a.dist==="0.25 to 0.5 miles"){
      score+=2;
      flags.push("You are within the significant impact zone. Documented range for noise penetration and potential air quality effects from generator tests.");
      actions.push("Monitor for symptoms during generator test days, typically once per month. Request the facility's test schedule in writing.");
      actions.push("Consider a professional EMF assessment if you or family members have experienced unexplained health symptoms.");
    } else if(a.dist==="0.5 to 1 mile"){
      score+=1;
      flags.push("You are within the extended noise range. Low-frequency sound travels further than conventional dB measurements suggest.");
      actions.push("Note any symptoms on nights when wind is blowing toward your home from the facility direction.");
    } else {
      flags.push("Your distance provides some buffer. However, low-frequency noise from cooling systems travels further than standard decibel measurements suggest, and substation EMF has been measured at meaningful levels beyond one mile in several documented cases.");
      actions.push("Establish a baseline now. Note your current sleep quality, any headache frequency, and general wellbeing. If the facility expands, you will have documentation showing when changes began.");
      actions.push("Sign up for any local planning notifications so you are informed if the facility applies for expansion permits, additional substations, or increased generator capacity.");
    }

    if(a.kids==="Yes"){
      score+=2;
      flags.push("Children in your household face higher vulnerability. Their developing systems are more sensitive to EMF, air pollution, and noise disruption.");
      actions.push("Ask your child's doctor to note any symptoms in their medical record, especially sleep issues, headaches, or unexplained behavioral changes.");
      actions.push("Keep children indoors on generator test days and keep windows closed during and after visible exhaust events.");
    }

    if(a.preg==="Yes"){
      score+=2;
      flags.push("Pregnancy elevates concern significantly. ELF-EMF has been studied in relation to miscarriage risk, and PM2.5 is associated with premature birth.");
      actions.push("Discuss proximity to industrial EMF and air pollution with your OB or midwife. Request it be noted in your prenatal records.");
      actions.push("Minimize time outdoors near the facility boundary during generator tests.");
    }

    if(a.health==="Yes"){
      score+=2;
      flags.push("Pre-existing health conditions are compounded by environmental noise and air pollution, both independently worsen cardiovascular and respiratory health.");
      actions.push("Speak with your doctor specifically about environmental noise exposure and diesel PM2.5 , ask whether your current medications or conditions require extra precaution.");
      actions.push("HEPA air purifiers rated for PM2.5 are especially important if asthma or COPD is present in your household.");
    }

    if(a.dur==="More than 10 years"){
      score+=1;
      flags.push("Long-term residency means cumulative exposure. Chronic effects compound over time and may not be immediately apparent.");
      actions.push("Consider requesting a comprehensive health screening that includes cardiovascular markers, given the documented link between long-term industrial noise exposure and heart disease.");
    } else if(a.dur==="3 to 10 years"){
      flags.push("Several years of exposure means cumulative effects are worth monitoring. Research on chronic industrial noise exposure shows cardiovascular and sleep effects that develop gradually over this timeframe.");
      actions.push("Consider tracking your sleep quality for two to four weeks using a sleep app or journal. Disrupted sleep is often the first measurable sign of chronic low-frequency noise exposure.");
    } else if(a.dur==="1 to 3 years"){
      flags.push("One to three years of exposure is within the timeframe where early cumulative effects can begin. This is a good time to establish health baselines and begin documentation.");
    }

    const level = score>=6?"HIGH":score>=3?"MODERATE":"LOWER";

    const summary = score>=6
      ? `Based on your answers, you are in a HIGH risk situation. Your combination of ${a.dist==="Less than 0.25 miles"?"very close proximity (under a quarter mile)":a.dist==="0.25 to 0.5 miles"?"close proximity (under half a mile)":"moderate proximity"}${a.kids==="Yes"?", children in your household":""}${a.preg==="Yes"?", and pregnancy":""} creates a compounding risk profile that warrants immediate and serious attention. The research is unambiguous: people in your situation face measurably elevated exposure to three separate categories of documented health hazards. First, power-frequency EMF from substations and high-voltage lines at this distance regularly exceeds the 3 to 4 milligauss threshold where epidemiological studies found elevated childhood leukemia rates. Second, diesel PM2.5 from monthly generator tests is a WHO Group 1 carcinogen with no established safe exposure level. Third, chronic low-frequency noise operates below the threshold of normal hearing measurement but penetrates walls and disrupts sleep architecture over time. Each of these independently carries documented health risks. Together, as a combined chronic exposure, they represent a situation that deserves professional environmental assessment, formal regulatory complaints, and a conversation with your doctor.`
      : score>=3
      ? `Based on your answers, you are in a MODERATE risk situation. Your proximity and household circumstances place you within the documented impact range of this facility. ${a.dist==="0.25 to 0.5 miles"?"At under half a mile, you are well within the zone where low-frequency noise, diesel exhaust during generator tests, and elevated EMF have been measured and documented.":a.dist==="0.5 to 1 mile"?"At under one mile, low-frequency sound from cooling systems and generator operations reaches your home, particularly at night when ambient noise drops.":"At your distance, the primary concerns are low-frequency noise at night, diesel exhaust during monthly generator tests, and substation EMF if you are near the electrical infrastructure."} While your risk is lower than those closest to the fence line, the cumulative effects of long-term exposure to industrial noise, diesel exhaust during monthly generator tests, and elevated EMF are real and worth taking seriously. Residents at this distance have documented sleep disruption, intermittent headaches, and heightened anxiety linked to generator test events. Monitoring, documentation, and precautionary steps are appropriate right now, and you have standing to file formal noise and air quality concerns with your local authority.`
      : `Based on your answers, your immediate risk is LOWER than residents closer to the facility. ${a.dist==="More than 1 mile"?"At over one mile, you are beyond the zone where the most acute effects have been documented, though low-frequency sound and substation EMF have been measured at meaningful levels further than most people expect.":"At your distance, direct health impacts are less well-documented, though they are not zero."} The most important thing to understand is that data centers are not static. They expand. New substations get added. Generator capacity increases. Residents who tracked a facility from its early stages were far better positioned to challenge expansions than those who noticed problems only after years of exposure. Your lower risk today is a reason to stay informed and document a baseline, not a reason to be unconcerned. Check back if the facility announces expansion, if new substations are installed nearby, or if you or family members begin experiencing unexplained sleep disruption or headaches.`;

    return{level,score,flags,actions,summary};
  };

  const saveQuizEmail = async () => {
    if(!qEmail.trim()||!dc) return;
    try {
      await fetch(`${APIURL}/Emails`, {
        method:"POST", headers:HDR,
        body:JSON.stringify({fields:{
          Email:qEmail.trim(),
          Facility:dc.Name,
          City:dc.City,
          Country:dc.Country,
          Risk_Level:qRes?.level||"",
          Date:new Date().toISOString().split("T")[0],
        }}),
      });
    } catch(e){ console.log("Email save failed silently"); }
    setQEmailSent(true);
  };

  const SYMPTOM_OPTIONS = [
    "Headaches","Sleep disruption","Dizziness or vertigo","Nausea",
    "Ear ringing (tinnitus)","Anxiety or panic","Diesel exhaust smell","Chest pressure or tightness",
  ];

  const toggleSymptom = (s) => {
    setRepSymptoms(prev => prev.includes(s) ? prev.filter(x=>x!==s) : [...prev,s]);
  };

  const canSubmit = draft.trim() && repEmail.trim() && repDeclared;

  const sendReport = async () => {
    if(!canSubmit||!dc) return;
    if(hp) return;
    setSending(true);
    // Build fields - Facility is a linked record so pass as array of record IDs
    const reportFields = {
      Reporter:       repName||"Anonymous",
      Email:          repEmail.trim(),
      Report_Text:    draft,
      Symptoms:       repSymptoms.join(", "),
      Duration:       repDuration,
      City:           dc.City || "",
      Country:        dc.Country || "",
      Date_Submitted: new Date().toISOString().split("T")[0],
      Declared:       true,
      Approved:       false,
    };
    if(dc.id) reportFields.Facility = [dc.id];
    const ok = await postReport(reportFields);
    if(ok){
      setSent(true);
      setDraft(""); setRepName(""); setRepEmail("");
      setRepDuration(""); setRepSymptoms([]); setRepDeclared(false);
      apiFetch("Reports",{filterByFormula:`AND({Facility} = "${dc.Name}", {Approved} = 1)`}).then(setReps).catch(()=>setReps([]));
    }
    setSending(false);
  };

  const STATS=[
    {val:`~${(statVals[0]/1e9).toFixed(2).replace(/\.?0+$/,"")} Billion`,    label:"Gallons of water consumed by data centers daily"},
    {val:`~${(statVals[1]/1e6).toFixed(1)} Million`,                         label:"Americans living within 1 mile of a major data center"},
    {val:`~${(statVals[2]/1e12).toFixed(2).replace(/\.?0+$/,"")} Trillion`,  label:"Watts of power consumed by data centers globally"},
    {val:loading?"---":statVals[3],                                          label:"Facilities in our database"},
  ];

  return (
    <>
      <style>{CSS}</style>
      {path === "/methodology" ? (
        <MethodologyPage onBack={()=>navigate("/")}/>
      ) : path === "/report-landing" ? (
        <ReportLandingPage onBack={()=>navigate("/")} onNavigate={navigate}/>
      ) : path === "/report-success" ? (
        <ReportSuccessPage onBack={()=>navigate("/")} onNavigate={navigate}/>
      ) : (
      <div style={{minHeight:"100vh",background:"#f1f5f9",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>

        {/* HERO */}
        <section className="hero" style={{position:"relative",overflow:"visible",minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 35%,#1e0535 65%,#0a1628 100%)",backgroundSize:"400% 400%",animation:"gradShift 14s ease infinite",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"80px 24px",textAlign:"center"}}>
          <div className="rings" style={{position:"absolute",left:"50%",top:"50%",pointerEvents:"none",zIndex:0,overflow:"hidden"}}>
            {[1,2,3,4,5].map(i=>(<div key={i} style={{position:"absolute",width:i*200,height:i*200,borderRadius:"50%",border:"1px solid rgba(239,68,68,0.09)",left:"50%",top:"50%",animation:`ring ${2+i*.7}s cubic-bezier(.4,0,.6,1) ${i*.5}s infinite`}}/>))}
          </div>

          <div className="a1" style={{marginBottom:36,position:"relative",zIndex:1}}>
            <div style={{display:"inline-flex",alignItems:"center",gap:10,background:"rgba(255,255,255,0.07)",border:"1px solid rgba(255,255,255,0.14)",borderRadius:40,padding:"10px 24px",backdropFilter:"blur(12px)"}}>
              <div style={{display:"flex",gap:6}}>
                {["#ef4444","#f97316","#eab308"].map((c,i)=>(<div key={i} style={{width:10,height:10,borderRadius:"50%",background:c,boxShadow:`0 0 8px ${c}aa`}}/>))}
              </div>
              <span style={{fontSize:14,fontWeight:800,color:"rgba(255,255,255,.9)",letterSpacing:".14em"}}>HUMZONES.COM</span>
            </div>
          </div>

          <h1 className="a2" style={{fontFamily:"'Inter',sans-serif",fontWeight:900,fontSize:"clamp(40px,9vw,96px)",lineHeight:1.0,letterSpacing:"-.025em",color:"#fff",marginBottom:24,position:"relative",zIndex:1,textShadow:"0 0 80px rgba(239,68,68,.3)"}}>
            ARE YOU IN THE{" "}
            <span style={{background:"linear-gradient(90deg,#ef4444,#f97316,#ef4444)",backgroundSize:"200% auto",animation:"shimmer 3s linear infinite",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HUM</span>ZONE?
          </h1>

          <p className="a3" style={{fontSize:19,color:"rgba(255,255,255,.62)",maxWidth:560,lineHeight:1.75,marginBottom:52,position:"relative",zIndex:1,fontWeight:400}}>
            Data centers power the internet. You may live next to one.
            Search your country and city to find out what that means for your health.
          </p>

          {/* SEARCH */}
          <div className="a4 search-row" style={{display:"flex",gap:14,width:"100%",maxWidth:740,position:"relative",zIndex:100}}>
            <div ref={cRef} style={{flex:1,position:"relative",opacity:loading?.7:1,transition:"opacity .2s"}}>
              <div style={{position:"relative",display:"flex",alignItems:"center"}}>
                <span style={{position:"absolute",left:18,zIndex:2,pointerEvents:"none",display:"flex"}}><Icon name="globe" size={20} color="rgba(255,255,255,.7)"/></span>
                <input className="srch" value={cInput}
                  onChange={e=>{setCInput(e.target.value);openCDrop();}}
                  onFocus={loading?undefined:openCDrop}
                  disabled={loading}
                  placeholder={loading?"Loading data...":"Select a country..."}
                  style={{width:"100%",padding:"20px 18px 20px 52px",fontSize:17,fontWeight:500,fontFamily:"inherit",borderRadius:16,border:"1.5px solid rgba(255,255,255,.18)",background:"rgba(255,255,255,.11)",color:"#fff",backdropFilter:"blur(16px)",boxSizing:"border-box",boxShadow:"0 8px 32px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.12)",cursor:loading?"wait":"text"}}/>
                {loading && (
                  <span style={{position:"absolute",right:16,display:"flex",pointerEvents:"none"}}>
                    <span className="spinning" style={{width:18,height:18,border:"2px solid rgba(255,255,255,.25)",borderTop:"2px solid rgba(255,255,255,.85)",borderRadius:"50%",display:"block"}}/>
                  </span>
                )}
              </div>
            </div>
            <div ref={rRef} style={{flex:1,position:"relative",opacity:(country&&hasRegions)?1:.45,pointerEvents:(country&&hasRegions)?"all":"none",transition:"opacity .2s"}}>
              <div style={{position:"relative",display:"flex",alignItems:"center"}}>
                <span style={{position:"absolute",left:18,zIndex:2,pointerEvents:"none",display:"flex"}}><Icon name="globe" size={20} color="rgba(255,255,255,.7)"/></span>
                <input className="srch" value={rInput}
                  onChange={e=>{setRInput(e.target.value);openRDrop();}}
                  onFocus={openRDrop}
                  placeholder={country?(hasRegions?`Select a ${regionLabel.toLowerCase()}...`:"No regions"):"Select country first"}
                  style={{width:"100%",padding:"20px 18px 20px 52px",fontSize:17,fontWeight:500,fontFamily:"inherit",borderRadius:16,border:"1.5px solid rgba(255,255,255,.18)",background:"rgba(255,255,255,.11)",color:"#fff",backdropFilter:"blur(16px)",boxSizing:"border-box",boxShadow:"0 8px 32px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.12)"}}/>
              </div>
            </div>
            <div ref={ciRef} style={{flex:1,position:"relative",opacity:regionReady?1:.45,pointerEvents:regionReady?"all":"none",transition:"opacity .2s"}}>
              <div style={{position:"relative",display:"flex",alignItems:"center"}}>
                <span style={{position:"absolute",left:18,zIndex:2,pointerEvents:"none",display:"flex"}}><Icon name="pin" size={20} color="rgba(255,255,255,.7)"/></span>
                <input className="srch" value={cityTxt}
                  onChange={e=>{setCityTxt(e.target.value);openCityDrop();}}
                  onFocus={openCityDrop}
                  placeholder={regionReady?`Cities in ${region||country}...`:(country?`Select ${regionLabel.toLowerCase()} first`:"Select country first")}
                  style={{width:"100%",padding:"20px 18px 20px 52px",fontSize:17,fontWeight:500,fontFamily:"inherit",borderRadius:16,border:"1.5px solid rgba(255,255,255,.18)",background:"rgba(255,255,255,.11)",color:"#fff",backdropFilter:"blur(16px)",boxSizing:"border-box",boxShadow:"0 8px 32px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.12)"}}/>
              </div>
            </div>
          </div>

          {country && (
            <button className="a4 clear-btn" onClick={clearAll} style={{marginTop:20,background:"rgba(255,255,255,.09)",border:"1px solid rgba(255,255,255,.18)",color:"rgba(255,255,255,.7)",padding:"10px 24px",borderRadius:24,fontSize:15,position:"relative",zIndex:1,display:"flex",alignItems:"center",gap:8}}>
              <Icon name="close" size={16} color="rgba(255,255,255,.7)"/> Clear search
            </button>
          )}

          {!dc && !country && (
            <div className="floating scroll-hint" style={{position:"absolute",bottom:36,left:0,right:0,margin:"0 auto",color:"rgba(255,255,255,.25)",fontSize:14,zIndex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:6,textAlign:"center",width:"100%"}}>
              <span>scroll to learn more</span>
              <Icon name="chevDown" size={20} color="rgba(255,255,255,.25)"/>
            </div>
          )}
        </section>

        {/* FIXED DROPDOWNS */}
        {showCD && (
          <div ref={cDropRef} style={{position:"fixed",top:cDropPos.top,left:cDropPos.left,width:cDropPos.width,background:"#fff",borderRadius:16,boxShadow:"0 28px 72px rgba(0,0,0,.32)",zIndex:9999,border:"1px solid #e2e8f0",overflow:"hidden"}}>
            <div className="scroll-inner" style={{maxHeight:"min(340px, 60vh)",overflowY:"auto"}}>
              {cMatches.length===0 && <div style={{padding:"16px 20px",color:"#94a3b8",fontSize:16,fontStyle:"italic"}}>{loading?"Loading countries...":"No countries found"}</div>}
              {cMatches.map(c=>(
                <div key={c} className="drop-item" style={{padding:"15px 20px",fontSize:16,color:"#1e293b",borderBottom:"1px solid #f1f5f9",fontWeight:500}} onClick={()=>pickCountry(c)}>{c}</div>
              ))}
            </div>
          </div>
        )}

        {showRD && country && hasRegions && (
          <div ref={rDropRef} style={{position:"fixed",top:rDropPos.top,left:rDropPos.left,width:rDropPos.width,background:"#fff",borderRadius:16,boxShadow:"0 28px 72px rgba(0,0,0,.32)",zIndex:9999,border:"1px solid #e2e8f0",overflow:"hidden"}}>
            <div className="scroll-inner" style={{maxHeight:"min(340px, 60vh)",overflowY:"auto"}}>
              {rMatches.length===0 && <div style={{padding:"16px 20px",color:"#94a3b8",fontSize:16,fontStyle:"italic"}}>No {regionLabel.toLowerCase()} found</div>}
              {rMatches.map(r=>(
                <div key={r} className="drop-item" style={{padding:"15px 20px",fontSize:16,color:"#1e293b",borderBottom:"1px solid #f1f5f9",fontWeight:500}} onClick={()=>pickRegion(r)}>{r}</div>
              ))}
            </div>
          </div>
        )}

        {showCityD && regionReady && (
          <div ref={cityDropRef} style={{position:"fixed",top:cityDropPos.top,left:cityDropPos.left,width:cityDropPos.width,background:"#fff",borderRadius:16,boxShadow:"0 28px 72px rgba(0,0,0,.32)",zIndex:9999,border:"1px solid #e2e8f0",overflow:"hidden"}}>
            <div className="scroll-inner" style={{maxHeight:"min(500px, 65vh)",overflowY:"auto",overflowX:"hidden"}}>
              {Object.keys(cityGroups).length===0 && <div style={{padding:"16px 20px",color:"#94a3b8",fontSize:16,fontStyle:"italic"}}>No cities found</div>}
              {Object.entries(cityGroups).map(([city,fl])=>(
                <div key={city}>
                  <div style={{padding:"10px 20px 6px",fontSize:12,color:"#64748b",letterSpacing:".08em",textTransform:"uppercase",background:"#f8fafc",borderTop:"1px solid #f1f5f9",fontWeight:700,display:"flex",alignItems:"center",gap:6,position:"sticky",top:0,zIndex:1}}>
                    <Icon name="pin" size={12} color="#94a3b8"/> {city}
                  </div>
                  {fl.map(f=>{
                    const s2=STATUS[f.Facility_Status]||STATUS.OPERATING;
                    const r2=RISK_C[f.Risk_Level]||"#64748b";
                    return (
                      <div key={f.id} className="drop-item" style={{padding:"14px 20px 14px 28px",borderBottom:"1px solid #f1f5f9"}} onClick={()=>{setCityTxt(city);setShowCityD(false);pickFac(f.id);}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10}}>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:15,fontWeight:700,color:"#1e293b",marginBottom:3,lineHeight:1.3}}>{f.Name}</div>
                            <div style={{fontSize:13,color:"#64748b",fontWeight:500}}>{f.Company} &middot; {f.Power_MW>=1000?`${(f.Power_MW/1000).toFixed(1)} GW`:`${f.Power_MW||"?"}MW`}</div>
                          </div>
                          <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"flex-end",flexShrink:0}}>
                            <Chip label={s2.label} color={s2.color} small/>
                            <Chip label={f.Risk_Level} color={r2} small/>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* STATS */}
        <div className="stats-container" style={{background:"#fff",borderBottom:"1px solid #e2e8f0",width:"100%",margin:0,padding:0,paddingLeft:0,paddingRight:0,overflowX:"hidden",boxSizing:"border-box"}}>
          <div ref={statsRef} className="stats-row" style={{display:"grid",gridTemplateColumns:"repeat(4, 1fr)",width:"100%",maxWidth:1040,margin:"0 auto",padding:"24px 16px",gap:"24px 16px",boxSizing:"border-box",alignItems:"flex-start",justifyItems:"center"}}>
            {STATS.map((s,i)=>(
              <div key={i} className="stat-item" style={{textAlign:"center",width:"100%",minWidth:0,margin:0,padding:0,boxSizing:"border-box"}}>
                <div className="stat-val" style={{fontSize:32,fontWeight:900,letterSpacing:"-.02em",display:"block",lineHeight:1.1,background:"linear-gradient(135deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>{s.val}</div>
                <div style={{fontSize:11,color:"#94a3b8",letterSpacing:".05em",textTransform:"uppercase",fontWeight:700,marginTop:5,lineHeight:1.35,overflowWrap:"break-word"}}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* MAIN */}
        <main className="main" ref={topRef} style={{maxWidth:1040,margin:"0 auto",padding:"36px 24px 72px",width:"100%",boxSizing:"border-box",overflowX:"hidden"}}>

          {/* FIND DATA CENTERS NEAR ME */}
          <section className="near-panel" style={{background:"#fff",borderRadius:24,boxShadow:"0 8px 48px rgba(0,0,0,.10)",padding:"26px 26px 22px",marginBottom:28}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18,flexWrap:"wrap"}}>
              <span style={{fontSize:26,lineHeight:1}} role="img" aria-label="Pin">📍</span>
              <h2 style={{fontSize:22,fontWeight:900,color:"#0f172a",letterSpacing:"-.01em",margin:0}}>Find Data Centers Near Me</h2>
            </div>

            <div className="search-row" style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:14}}>
              <button
                onClick={handleGeolocate}
                disabled={nearStatus==="locating"}
                style={{padding:"12px 22px",borderRadius:12,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontWeight:800,fontSize:15,letterSpacing:".01em",cursor:nearStatus==="locating"?"wait":"pointer",boxShadow:"0 6px 20px rgba(239,68,68,.35)",display:"inline-flex",alignItems:"center",gap:8,fontFamily:"inherit",opacity:nearStatus==="locating"?.75:1}}
              >
                {nearStatus==="locating" ? "Locating..." : "📍 Use My Location"}
              </button>
              <div style={{flex:1,minWidth:240,display:"flex",gap:8}}>
                <input
                  value={nearAddr}
                  onChange={e=>setNearAddr(e.target.value)}
                  onKeyDown={e=>{ if(e.key==="Enter") handleGeocode(); }}
                  placeholder="Or enter any address..."
                  style={{flex:1,padding:"12px 16px",fontSize:15,borderRadius:12,border:"1px solid #e2e8f0",outline:"none",fontFamily:"inherit",color:"#0f172a",background:"#fff"}}
                />
                <button
                  onClick={handleGeocode}
                  disabled={!nearAddr.trim() || nearStatus==="geocoding"}
                  style={{padding:"12px 18px",borderRadius:12,border:"1px solid #e2e8f0",background:"#f1f5f9",color:"#1e293b",fontWeight:700,fontSize:14,cursor:(!nearAddr.trim()||nearStatus==="geocoding")?"default":"pointer",fontFamily:"inherit",opacity:(!nearAddr.trim()||nearStatus==="geocoding")?.6:1}}
                >
                  {nearStatus==="geocoding" ? "..." : "Search"}
                </button>
              </div>
            </div>

            <div style={{display:"flex",flexWrap:"wrap",gap:20,alignItems:"center",marginTop:6}}>
              <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                <span style={{fontSize:12,fontWeight:800,color:"#64748b",letterSpacing:".08em",textTransform:"uppercase"}}>Radius:</span>
                {[1,5,10,25,50,100].map(r=>(
                  <button key={r} onClick={()=>setNearRadius(r)} style={{padding:"6px 12px",borderRadius:999,border:"1px solid "+(nearRadius===r?"#ef4444":"#e2e8f0"),background:nearRadius===r?"#ef4444":"#fff",color:nearRadius===r?"#fff":"#475569",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>{r}km</button>
                ))}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                <span style={{fontSize:12,fontWeight:800,color:"#64748b",letterSpacing:".08em",textTransform:"uppercase"}}>Risk:</span>
                {[{k:"ALL",l:"All Risk Levels"},{k:"HIGH",l:"HIGH only"},{k:"HIGH_MOD",l:"HIGH and MODERATE"}].map(o=>(
                  <button key={o.k} onClick={()=>setNearRisk(o.k)} style={{padding:"6px 12px",borderRadius:999,border:"1px solid "+(nearRisk===o.k?"#ef4444":"#e2e8f0"),background:nearRisk===o.k?"#ef4444":"#fff",color:nearRisk===o.k?"#fff":"#475569",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>{o.l}</button>
                ))}
              </div>
            </div>

            {nearError && (
              <div style={{fontSize:14,color:"#dc2626",fontWeight:600,marginTop:14}}>{nearError}</div>
            )}

            {nearLoc && (
              <div className="near-status-row" style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,paddingTop:14,borderTop:"1px solid #f1f5f9",marginTop:16,flexWrap:"wrap"}}>
                <div style={{fontSize:13,color:"#475569",flex:1,minWidth:0}}>
                  Searching near: <strong style={{color:"#0f172a"}}>{nearLoc.label.length>80 ? nearLoc.label.slice(0,80)+"..." : nearLoc.label}</strong>
                  {" "}<span style={{color:"#94a3b8"}}>({nearResults.length} within {nearRadius}km)</span>
                </div>
                <button onClick={clearNear} style={{padding:"6px 14px",borderRadius:8,border:"1px solid #e2e8f0",background:"#fff",color:"#475569",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit",alignSelf:"flex-start"}}>Clear</button>
              </div>
            )}
          </section>

          {/* NEARBY RESULTS: wrapped so nothing inside can shift the page sideways */}
          {nearLoc && !dc && (
          <div className="near-me-results" style={{width:"100%",maxWidth:"100%",boxSizing:"border-box",overflowX:"hidden",marginLeft:0,marginRight:0}}>
          {loading && (
            <div style={{background:"#fff",borderRadius:18,padding:"44px 24px",textAlign:"center",boxShadow:"0 4px 18px rgba(0,0,0,.06)",marginBottom:28,color:"#64748b",fontWeight:600,fontSize:15,width:"100%",maxWidth:"100%",boxSizing:"border-box"}}>
              <div className="spinning" style={{width:32,height:32,border:"3px solid #e2e8f0",borderTop:"3px solid #ef4444",borderRadius:"50%",margin:"0 auto 14px"}}/>
              Loading facility data...
            </div>
          )}
          {nearLoc && !dc && !loading && (
            <div
              ref={resultsHeadingRef}
              key={`near-count-${nearLoc.lat}-${nearLoc.lng}-${nearRadius}-${nearRisk}-${justUnlocked?"u":"l"}`}
              className="fade-in"
              style={{textAlign:"center",fontSize:28,fontWeight:900,letterSpacing:"-.02em",lineHeight:1.25,margin:"4px 0 20px",width:"100%",maxWidth:"100%",boxSizing:"border-box",overflowWrap:"break-word",padding:"0 4px",scrollMarginTop:16}}
            >
              {nearResults.length > 0 ? (
                justUnlocked && nearResults.length > 2 ? (
                  <span style={{color:"#10b981"}}>
                    &#10003; {nearResults.length} {nearResults.length === 1 ? "facility" : "facilities"} unlocked near you
                  </span>
                ) : (
                  <span style={{background:"linear-gradient(135deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",backgroundClip:"text"}}>
                    {nearResults.length} {nearResults.length === 1 ? "facility" : "facilities"} found within {nearRadius}km of your location
                  </span>
                )
              ) : (
                <span style={{color:"#94a3b8"}}>
                  0 facilities found within {nearRadius}km of your location
                </span>
              )}
            </div>
          )}
          {/* PAID REPORT UPSELL: only shown AFTER the email gate has been
              passed. During the locked phase the buyer sees just the count
              headline, one free facility card and the email overlay; the
              paid Full Report pitch lands only once they have unlocked.
              Returning visitors are unlocked on mount via the
              humzones_email_unlocked localStorage flag, so they see the
              banner immediately on their next visit. */}
          {nearLoc && !dc && !loading && nearEmailUnlocked && nearResults.length > 0 && (
            <div className="fade-in" style={{background:"linear-gradient(150deg,#0a1628 0%,#0f172a 50%,#1e0535 100%)",borderRadius:18,padding:"36px 28px 30px",textAlign:"center",border:"1px solid rgba(249,115,22,.32)",boxShadow:"0 18px 50px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.05)",marginBottom:28,width:"100%",maxWidth:"100%",boxSizing:"border-box",marginLeft:0,marginRight:0}}>
              <div style={{fontSize:42,marginBottom:12,lineHeight:1}} role="img" aria-label="Fire">🔥</div>
              <h3 style={{fontSize:24,fontWeight:900,color:"#fff",marginBottom:8,letterSpacing:"-.01em",lineHeight:1.25}}>
                There&apos;s More You Should Know
              </h3>
              <div style={{fontSize:16,color:"#f97316",fontWeight:700,marginBottom:14,letterSpacing:".01em"}}>
                Unlock Your Full HumZones Area Report
              </div>
              <p style={{fontSize:15,color:"rgba(255,255,255,.78)",marginBottom:24,lineHeight:1.7,maxWidth:560,marginLeft:"auto",marginRight:"auto"}}>
                {nearRadius === 100 ? (
                  <>You found {nearResults.length} {nearResults.length === 1 ? "facility" : "facilities"} within 100km. Your Full Report includes detailed health analysis, EMF readings, noise levels and risk assessments for every facility near you.</>
                ) : (
                  <>You found {nearResults.length} {nearResults.length === 1 ? "facility" : "facilities"} within {nearRadius}km. Your Full Report reveals all {facilities100kmCount} facilities within 100km, including {high100kmCount} HIGH risk {high100kmCount === 1 ? "site" : "sites"} you may not know about.</>
                )}
              </p>
              <button
                onClick={handleGetFullReport}
                style={{padding:"16px 32px",borderRadius:14,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:17,fontWeight:900,letterSpacing:".02em",cursor:"pointer",fontFamily:"inherit",boxShadow:"0 10px 32px rgba(239,68,68,.45)"}}
              >
                Show Me Everything
              </button>
              <p style={{fontSize:12,color:"rgba(255,255,255,.55)",marginTop:14,lineHeight:1.6}}>
                Instant PDF download. Personalized to your location.
              </p>
            </div>
          )}

          {nearLoc && !dc && !loading && (nearResults.length > 0 ? (() => {
            const renderNearCard = (f, locked=false) => {
              const st = STATUS[f.Facility_Status] || STATUS.OPERATING;
              const rclr = RISK_C[f.Risk_Level] || "#64748b";
              const dclr = distColor(f._km);
              return (
                <div key={f.id} className="sym-card near-card" onClick={locked?undefined:()=>pickFac(f.id)} style={{background:"#fff",borderRadius:18,boxShadow:"0 4px 18px rgba(0,0,0,.06)",padding:"18px 22px",cursor:locked?"default":"pointer",display:"flex",alignItems:"center",gap:16,flexWrap:"wrap",width:"100%",maxWidth:"100%",boxSizing:"border-box"}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:17,fontWeight:800,color:"#0f172a",marginBottom:4,lineHeight:1.3}}>{f.Name}</div>
                    <div style={{fontSize:13,color:"#64748b",fontWeight:600}}>{f.Company} &middot; {[f.City,f.State_Region,f.Country].filter(Boolean).join(", ")}</div>
                    <div style={{fontSize:13,color:"#64748b",fontWeight:600,marginTop:2}}>{f.Power_MW>=1000?`${(f.Power_MW/1000).toFixed(1)} GW`:`${f.Power_MW||"?"}MW`}</div>
                  </div>
                  <div className="near-right" style={{display:"flex",flexDirection:"column",gap:8,alignItems:"flex-end",flexShrink:0,marginLeft:"auto"}}>
                    <div style={{padding:"6px 12px",borderRadius:999,background:dclr,color:"#fff",fontWeight:800,fontSize:13,letterSpacing:".02em",boxShadow:`0 4px 14px ${dclr}55`}}>
                      {f._km.toFixed(1)} km away
                    </div>
                    <div style={{display:"flex",gap:6}}>
                      <Chip label={st.label} color={st.color} small/>
                      <Chip label={f.Risk_Level} color={rclr} small/>
                    </div>
                  </div>
                </div>
              );
            };

            const showAll = nearEmailUnlocked || nearResults.length <= 1;
            const previewCards = showAll ? nearResults : nearResults.slice(0,1);
            const lockedCards  = showAll ? [] : nearResults.slice(1);
            // Cap the rendered blurred preview so the page doesn't grow unbounded
            // for very long result lists; the overlay covers what's rendered.
            const blurredPreview = lockedCards.slice(0, Math.min(5, lockedCards.length));

            return (
              <div className={justUnlocked?"fade-in":undefined} style={{display:"flex",flexDirection:"column",gap:14,marginBottom:28,width:"100%",maxWidth:"100%",boxSizing:"border-box",overflowX:"hidden"}}>
                {previewCards.map(f=>renderNearCard(f,false))}

                {lockedCards.length > 0 && (
                  <div style={{position:"relative",width:"100%",maxWidth:"100%",boxSizing:"border-box",overflow:"hidden",borderRadius:18}}>
                    {/* Blurred decoy cards behind the gate */}
                    <div aria-hidden="true" style={{filter:"blur(6px)",pointerEvents:"none",userSelect:"none",display:"flex",flexDirection:"column",gap:14,width:"100%",maxWidth:"100%",boxSizing:"border-box"}}>
                      {blurredPreview.map(f=>renderNearCard(f,true))}
                    </div>
                    {/* Email gate overlay */}
                    <div style={{position:"absolute",inset:0,display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"22px 14px",borderRadius:18,background:"linear-gradient(180deg,rgba(15,23,42,.25) 0%,rgba(15,23,42,.78) 30%,rgba(2,12,27,.92) 100%)",boxSizing:"border-box",maxWidth:"100%"}}>
                      <div className="fade-in" style={{maxWidth:520,width:"100%",background:"linear-gradient(150deg,#0a1628 0%,#0f172a 50%,#1e0535 100%)",borderRadius:18,padding:"34px 28px 28px",textAlign:"center",border:"1px solid rgba(249,115,22,.32)",boxShadow:"0 24px 60px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.05)"}}>
                        <div style={{width:60,height:60,borderRadius:"50%",background:"linear-gradient(135deg,#ef4444,#f97316)",margin:"0 auto 18px",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 8px 26px rgba(239,68,68,.45)"}}>
                          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <rect x="4" y="11" width="16" height="10" rx="2"/>
                            <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
                          </svg>
                        </div>
                        <h3 style={{fontSize:22,fontWeight:900,color:"#fff",marginBottom:10,letterSpacing:"-.01em",lineHeight:1.25}}>Your Full Area Report is Ready</h3>
                        <p style={{fontSize:15,color:"rgba(255,255,255,.72)",marginBottom:22,lineHeight:1.6}}>
                          See all {nearResults.length} facilities near you, their risk levels, EMF readings, noise levels and more.
                        </p>
                        <div style={{display:"flex",flexDirection:"column",gap:10,maxWidth:380,margin:"0 auto"}}>
                          <input
                            type="email"
                            className="email-gate-input"
                            value={nearEmailInput}
                            onChange={e=>setNearEmailInput(e.target.value)}
                            onKeyDown={e=>{ if(e.key==="Enter") handleEmailUnlock(); }}
                            placeholder="Enter your email address"
                            disabled={nearEmailSending}
                            style={{padding:"13px 16px",fontSize:15,borderRadius:12,border:"1.5px solid rgba(255,255,255,.18)",background:"rgba(255,255,255,.08)",color:"#fff",fontFamily:"inherit",boxSizing:"border-box",width:"100%"}}
                          />
                          <button
                            onClick={handleEmailUnlock}
                            disabled={nearEmailSending}
                            style={{padding:"13px 22px",borderRadius:12,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:15,fontWeight:800,letterSpacing:".02em",cursor:nearEmailSending?"wait":"pointer",fontFamily:"inherit",boxShadow:"0 8px 26px rgba(239,68,68,.4)",opacity:nearEmailSending?.8:1}}
                          >
                            {nearEmailSending ? "Unlocking..." : "Unlock Free Results"}
                          </button>
                        </div>
                        {nearEmailError && (
                          <div style={{fontSize:13,color:"#fca5a5",fontWeight:600,marginTop:12}}>{nearEmailError}</div>
                        )}
                        <p style={{fontSize:12,color:"rgba(255,255,255,.5)",marginTop:16,lineHeight:1.6}}>
                          Free access. No spam. Unsubscribe anytime.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })() : (
            <div style={{background:"#fff",borderRadius:18,padding:"44px 24px",textAlign:"center",boxShadow:"0 4px 18px rgba(0,0,0,.06)",marginBottom:28}}>
              <div style={{fontSize:42,marginBottom:12}}>📍</div>
              <div style={{fontSize:17,color:"#475569",fontWeight:600,lineHeight:1.6,maxWidth:480,margin:"0 auto"}}>
                No data centers found within {nearRadius}km. Try expanding your search radius.
              </div>
            </div>
          ))}
          </div>
          )}

          {/* SOCIAL SHARE: lives directly below the Find Data Centers Near Me
              feature so the prompt to share lands after the buyer has seen
              their own results, upsell banner and email gate. */}
          {!dc && <ShareSection/>}

          {!dc && !nearLoc && !loading && (
            <div style={{textAlign:"center",padding:"80px 24px"}}>
              <div className="floating" style={{fontSize:80,marginBottom:24}}>🌍</div>
              <h2 style={{fontSize:28,fontWeight:800,color:"#0f172a",marginBottom:12}}>Search for a data center near you</h2>
              <p style={{fontSize:17,color:"#64748b",maxWidth:480,margin:"0 auto",lineHeight:1.75}}>Select your country above, then choose your city to find data centers in your area and understand their real health impact.</p>
              <div style={{display:"flex",justifyContent:"center",gap:24,marginTop:48,flexWrap:"wrap"}}>
                {Object.entries(STATUS).map(([k,v])=>(
                  <div key={k} style={{display:"flex",alignItems:"center",gap:8,fontSize:15,color:"#64748b",fontWeight:600}}>
                    <div style={{width:10,height:10,borderRadius:"50%",background:v.color,boxShadow:`0 0 8px ${v.color}`}}/>
                    {v.label}: {facs.filter(f=>f.Facility_Status===k).length}
                  </div>
                ))}
              </div>
            </div>
          )}

          {loading && !nearLoc && (
            <div className="near-card-skel-list" style={{display:"flex",flexDirection:"column",gap:14}} aria-busy="true" aria-label="Loading facility data">
              {[0,1,2,3,4,5].map(i=>(
                <div key={i} className="near-card" style={{background:"#fff",borderRadius:18,boxShadow:"0 4px 18px rgba(0,0,0,.06)",padding:"18px 22px",display:"flex",alignItems:"center",gap:16}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div className="pulse" style={{height:17,width:"58%",marginBottom:8}}/>
                    <div className="pulse" style={{height:12,width:"78%",marginBottom:6}}/>
                    <div className="pulse" style={{height:12,width:"34%"}}/>
                  </div>
                  <div className="near-right" style={{display:"flex",flexDirection:"column",gap:8,alignItems:"flex-end",flexShrink:0,marginLeft:"auto"}}>
                    <div className="pulse" style={{height:26,width:96,borderRadius:999}}/>
                    <div className="pulse" style={{height:18,width:130,borderRadius:999}}/>
                  </div>
                </div>
              ))}
            </div>
          )}

          {dc && (
            <>
              <button
                onClick={handleBackToResults}
                className="back-btn"
                aria-label="Back to results"
                style={{display:"inline-flex",alignItems:"center",gap:8,marginBottom:14,padding:"9px 16px",borderRadius:10,border:"1px solid #e2e8f0",background:"#fff",color:"#475569",fontSize:13,fontWeight:800,letterSpacing:".06em",cursor:"pointer",fontFamily:"inherit",boxShadow:"0 2px 8px rgba(15,23,42,.06)"}}
              >
                <span style={{fontSize:16,lineHeight:1}}>&larr;</span> Back to Results
              </button>
            <div style={{background:"#fff",borderRadius:24,overflow:"hidden",boxShadow:"0 8px 48px rgba(0,0,0,.10)"}}>

              <FacilityMapImage dc={dc} rc={rc}/>

              {dc.Address && (
                <div className="addr-bar" style={{background:"#f8fafc",borderBottom:"1px solid #e2e8f0",padding:"14px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,flexWrap:"wrap"}}>
                  <div style={{display:"flex",alignItems:"flex-start",gap:10,flex:1,minWidth:0}}>
                    <Icon name="pin" size={18} color="#94a3b8"/>
                    <div>
                      <div style={{fontSize:15,color:"#1e293b",fontWeight:600,lineHeight:1.4}}>{locStr || "Address not on file"}</div>
                      {dc.Latitude && dc.Longitude && (
                        <div style={{fontSize:12,color:"#94a3b8",marginTop:2}}>Coordinates: {parseFloat(dc.Latitude).toFixed(4)}, {parseFloat(dc.Longitude).toFixed(4)}</div>
                      )}
                    </div>
                  </div>
                  <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="map-btn"
                    style={{display:"inline-flex",alignItems:"center",gap:8,background:"#3b82f6",color:"#fff",padding:"11px 22px",borderRadius:10,fontSize:14,fontWeight:700,textDecoration:"none",flexShrink:0,boxShadow:"0 2px 8px rgba(59,130,246,.35)"}}>
                    <Icon name="navigate" size={16} color="#fff"/> Open in Google Maps
                  </a>
                </div>
              )}

              <div className="fac-header" style={{padding:"24px 28px 20px"}}>
                <h2 style={{fontSize:24,fontWeight:900,color:"#0f172a",marginBottom:6,letterSpacing:"-.02em",lineHeight:1.2}}>{dc.Name}</h2>
                {dc.Company && <div style={{fontSize:15,color:"#64748b",marginBottom:4,fontWeight:600}}>{dc.Company}</div>}
                {dc.Nearby && <div style={{fontSize:15,color:"#64748b",marginBottom:6,fontStyle:"italic"}}>{dc.Nearby}</div>}
                {dc.Opened && <div style={{fontSize:14,color:"#94a3b8",marginBottom:20}}>Status / Opened: {dc.Opened}</div>}
                <div className="fac-stats" style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14}}>
                  {[
                    {icon:"power",label:"Power Draw",   value:dc.Power_MW>=1000?`${(dc.Power_MW/1000).toFixed(1)} GW`:`${dc.Power_MW||"?"}MW`,color:rc},
                    {icon:"noise",label:"Noise Level",  value:`${dc.Noise_DB||"?"} dB`,color:dc.Noise_DB>=70?"#ef4444":dc.Noise_DB>=60?"#f97316":"#3b82f6"},
                    {icon:"emf",  label:"EMF at Fence", value:`${dc.EMF_Fence_High||"?"} mG`,color:dc.EMF_Fence_High>=4?"#ef4444":"#10b981"},
                    {icon:"water",label:"Water/Day",    value:dc.Water_Gal_Day>0?`${fmt(dc.Water_Gal_Day)} gal`:"Near zero",color:"#3b82f6"},
                  ].map(s=>(
                    <div key={s.label} style={{background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:14,padding:"16px 18px",textAlign:"center"}}>
                      <div style={{display:"flex",justifyContent:"center",marginBottom:10}}><Icon name={s.icon} size={22} color={s.color}/></div>
                      <div style={{fontSize:22,fontWeight:900,color:s.color,marginBottom:4,letterSpacing:"-.02em"}}>{s.value}</div>
                      <div style={{fontSize:12,color:"#94a3b8",textTransform:"uppercase",letterSpacing:".06em",fontWeight:700}}>{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{borderTop:"1px solid #f1f5f9",background:"#fafafa"}}>
                <div className="tabs-row" style={{display:"flex",gap:8,padding:"18px 24px",overflowX:"auto",flexWrap:"wrap"}}>
                  {TABS.map(t=>{
                    const isSubmit = t.id === "submit";
                    // Submit tab keeps the exact same pill shape (padding,
                    // border-radius, font-size, border thickness) as every
                    // other tab; only background, border color and text
                    // color flip to brand orange. The :hover darken to
                    // #ea6c0a is supplied by the .tab-btn-submit class.
                    return (
                      <button key={t.id}
                        className={isSubmit ? "tab-btn tab-btn-submit" : "tab-btn"}
                        onClick={()=>setTab(t.id)}
                        style={{
                          display:"flex",
                          alignItems:"center",
                          gap:7,
                          padding:"11px 20px",
                          borderRadius:22,
                          fontSize:14,
                          fontWeight:700,
                          border:`2px solid ${isSubmit ? "#f97316" : (tab===t.id?rc:"#e2e8f0")}`,
                          background:isSubmit ? "#f97316" : (tab===t.id?rc:"#fff"),
                          color:isSubmit ? "#fff" : (tab===t.id?"#fff":"#64748b"),
                          boxShadow:isSubmit ? "none" : (tab===t.id?`0 4px 16px ${rc}44`:"none"),
                        }}>
                        <Icon name={t.icon} size={16} color={isSubmit?"#fff":(tab===t.id?"#fff":"#64748b")}/>
                        {t.label}{t.id==="reports"&&reps.length>0?` (${reps.length})`:""}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="tab-content" style={{padding:"28px 32px 36px"}}>

                {tab==="feel" && (
                  <div>
                    <div style={{background:rc+"0d",border:`1px solid ${rc}22`,borderRadius:14,padding:"18px 22px",marginBottom:28}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}><Icon name="alert" size={20} color={rc}/><span style={{fontSize:13,color:rc,fontWeight:800,letterSpacing:".08em",textTransform:"uppercase"}}>Based on documented reports at comparable facilities</span></div>
                      <p style={{fontSize:16,color:"#374151",lineHeight:1.8,margin:0}}>Every symptom below has been reported by real people living near data centers of this scale, from lawsuits, news investigations, and community testimonies across the US and internationally.</p>
                    </div>
                    <div className="sym-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                      {symptoms.map((s,i)=>(
                        <div key={i} className="sym-card" style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:16,padding:"22px",boxShadow:"0 2px 12px rgba(0,0,0,.05)"}}>
                          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
                            <div style={{width:46,height:46,borderRadius:12,background:rc+"14",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name={s.icon} size={24} color={rc}/></div>
                            <div style={{fontSize:17,fontWeight:800,color:"#0f172a",lineHeight:1.3}}>{s.t}</div>
                          </div>
                          <SevBar level={s.s} color={rc}/>
                          <p style={{fontSize:15,color:"#475569",lineHeight:1.8,margin:"10px 0 0"}}>{s.d}</p>
                        </div>
                      ))}
                    </div>
                    <p style={{fontSize:14,color:"#94a3b8",marginTop:20,lineHeight:1.6}}>Severity bars show frequency of reporting at comparable facilities. Individual experience depends on distance, building construction, terrain, and personal sensitivity.</p>
                  </div>
                )}

                {tab==="numbers" && (
                  <div className="nums-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                    {[
                      {icon:"power",label:"Power Draw",    value:dc.Power_MW>=1000?`${(dc.Power_MW/1000).toFixed(1)} GW`:`${dc.Power_MW||"?"}MW`,plain:dc.Power_MW?`Enough to power ${fmt(Math.round(dc.Power_MW*1000/1.25))} average homes continuously, 24 hours a day, 365 days a year.`:"Power data pending verification.",color:rc},
                      {icon:"co2",  label:"CO2 Per Year",  value:dc.CO2_Tons_Year>0?`${fmt(dc.CO2_Tons_Year)} tons`:"Near zero",plain:dc.CO2_Tons_Year>0?`Same as ${fmt(Math.round(dc.CO2_Tons_Year/4.6))} cars driven for a full year.`:"Powered by renewable energy.",color:dc.CO2_Tons_Year>200000?"#ef4444":"#10b981"},
                      {icon:"water",label:"Water Per Day", value:dc.Water_Gal_Day>0?`${fmt(dc.Water_Gal_Day)} gal`:"Near zero",plain:dc.Water_Gal_Day>0?`Same daily water use as ${fmt(Math.round(dc.Water_Gal_Day/80))} households. Permanently removed from the local water cycle.`:"Air-cooled design. Minimal water consumption.",color:dc.Water_Gal_Day>500000?"#ef4444":"#10b981"},
                      {icon:"noise",label:"Perimeter Noise",value:`${dc.Noise_DB||"?"} dB`,plain:"Sustained 24/7 including overnight. Low-frequency noise travels further than this number suggests.",color:dc.Noise_DB>=70?"#ef4444":dc.Noise_DB>=60?"#f97316":"#3b82f6"},
                      {icon:"emf",  label:"EMF at Fence",  value:`up to ${dc.EMF_Fence_High||"?"}mG`,plain:dc.EMF_Fence_High>=4?"Studies link childhood leukemia risk starting at 3 to 4 mG. The legal US limit is 2,000 mG. Legal does not mean safe.":"Below the 3 to 4 mG concern threshold at the fence line.",color:dc.EMF_Fence_High>=4?"#ef4444":"#10b981"},
                      {icon:"emf",  label:"EMF at 100m",   value:`~${dc.EMF_100m||"?"} mG`,plain:dc.EMF_100m>=3?"Still above the level linked to childhood leukemia in studies. Take this seriously if you live within 100m.":dc.EMF_100m>=1?"Within the zone where a 2026 study found health associations.":"Below precautionary thresholds at this distance.",color:dc.EMF_100m>=3?"#ef4444":dc.EMF_100m>=1?"#f97316":"#10b981"},
                    ].map(s=>(
                      <div key={s.label} style={{background:"#fff",border:`2px solid ${s.color}20`,borderRadius:16,padding:"22px",boxShadow:"0 2px 12px rgba(0,0,0,.05)"}}>
                        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
                          <div style={{width:40,height:40,borderRadius:10,background:s.color+"14",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name={s.icon} size={20} color={s.color}/></div>
                          <div style={{fontSize:13,color:"#94a3b8",fontWeight:700,textTransform:"uppercase",letterSpacing:".06em"}}>{s.label}</div>
                        </div>
                        <div style={{fontSize:30,fontWeight:900,color:s.color,marginBottom:10,letterSpacing:"-.02em",lineHeight:1}}>{s.value}</div>
                        <p style={{fontSize:15,color:"#475569",lineHeight:1.7,margin:0}}>{s.plain}</p>
                      </div>
                    ))}
                  </div>
                )}

                {tab==="quiz" && (
                  <div>
                    <h3 style={{fontSize:22,fontWeight:900,color:"#0f172a",marginBottom:10}}>Your Personal Risk Assessment</h3>
                    <p style={{fontSize:16,color:"#64748b",marginBottom:28,lineHeight:1.75}}>Answer five questions to receive a detailed, personalized assessment based on your proximity and household situation.</p>
                    {qRes ? (
                      <div>
                        <div style={{background:(RISK_C[qRes.level]||"#64748b")+"0d",border:`2px solid ${(RISK_C[qRes.level]||"#64748b")}22`,borderRadius:18,padding:"28px",marginBottom:20}}>
                          <div style={{fontSize:13,color:"#94a3b8",fontWeight:800,letterSpacing:".1em",textTransform:"uppercase",marginBottom:12}}>Your Personal Risk Level</div>
                          <div style={{fontSize:60,fontWeight:900,color:RISK_C[qRes.level]||"#64748b",letterSpacing:"-.02em",marginBottom:16,lineHeight:1}}>{qRes.level}</div>
                          <p style={{fontSize:16,color:"#374151",lineHeight:1.85}}>{qRes.summary}</p>
                        </div>
                        {!qEmailSent && (
                          <div style={{background:"linear-gradient(135deg,#0f172a,#1e0535)",borderRadius:16,padding:"28px",marginBottom:20,border:"1px solid rgba(255,255,255,.08)"}}>
                            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                              <div style={{width:36,height:36,borderRadius:10,background:rc+"33",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name="doc" size={20} color={rc}/></div>
                              <div style={{fontSize:18,fontWeight:800,color:"#fff"}}>Your full report is ready</div>
                            </div>
                            <div style={{fontSize:15,color:"rgba(255,255,255,.65)",marginBottom:22,lineHeight:1.7}}>Enter your email to unlock your complete risk breakdown and personalized action plan. We store your email privately and will not contact you again.</div>
                            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                              <input value={qEmail} onChange={e=>setQEmail(e.target.value)}
                                placeholder="Enter your email address" type="email"
                                onKeyDown={e=>{if(e.key==="Enter"&&qEmail.trim()) saveQuizEmail();}}
                                style={{flex:1,minWidth:220,padding:"14px 18px",borderRadius:12,border:`1.5px solid ${qEmail.trim()?"rgba(255,255,255,.4)":"rgba(255,255,255,.15)"}`,background:"rgba(255,255,255,.1)",color:"#fff",fontSize:16,outline:"none",fontFamily:"inherit",transition:"border-color .2s"}}/>
                              <button onClick={()=>{if(qEmail.trim()) saveQuizEmail();}} disabled={!qEmail.trim()}
                                style={{padding:"14px 28px",borderRadius:12,border:"none",background:qEmail.trim()?rc:"rgba(255,255,255,.12)",color:qEmail.trim()?"#fff":"rgba(255,255,255,.3)",fontSize:16,fontWeight:800,cursor:qEmail.trim()?"pointer":"default",fontFamily:"inherit",transition:"all .2s",whiteSpace:"nowrap",boxShadow:qEmail.trim()?`0 4px 16px ${rc}55`:"none"}}>
                                Unlock My Report
                              </button>
                            </div>
                            <div style={{fontSize:12,color:"rgba(255,255,255,.3)",marginTop:12}}>Stored privately. We will not send you anything else.</div>
                          </div>
                        )}
                        {qEmailSent && (
                          <div>
                            <div style={{background:"#f0fdf4",border:"1.5px solid #bbf7d0",borderRadius:12,padding:"14px 18px",marginBottom:20,display:"flex",alignItems:"center",gap:10}}>
                              <Icon name="check" size={18} color="#15803d"/>
                              <div style={{fontSize:14,color:"#166534",fontWeight:700}}>Your full report is unlocked. Email saved privately.</div>
                            </div>
                            <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:16,padding:"22px 24px",marginBottom:16,boxShadow:"0 2px 8px rgba(0,0,0,.04)"}}>
                              <div style={{fontSize:13,color:"#94a3b8",fontWeight:800,textTransform:"uppercase",letterSpacing:".08em",marginBottom:14}}>What this means for your situation</div>
                              {qRes.flags.map((f,i)=>(
                                <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start",padding:"10px 0",borderBottom:i<qRes.flags.length-1?"1px solid #f8fafc":"none"}}>
                                  <div style={{width:28,height:28,borderRadius:"50%",background:(RISK_C[qRes.level]||"#64748b")+"14",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name="alert" size={14} color={RISK_C[qRes.level]||"#64748b"}/></div>
                                  <div style={{fontSize:15,color:"#374151",lineHeight:1.7}}>{f}</div>
                                </div>
                              ))}
                            </div>
                            {qRes.actions && qRes.actions.length>0 && (
                              <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:16,padding:"22px 24px",marginBottom:24,boxShadow:"0 2px 8px rgba(0,0,0,.04)"}}>
                                <div style={{fontSize:13,color:"#94a3b8",fontWeight:800,textTransform:"uppercase",letterSpacing:".08em",marginBottom:14}}>Your specific recommended actions</div>
                                {qRes.actions.map((a,i)=>(
                                  <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start",padding:"10px 0",borderBottom:i<qRes.actions.length-1?"1px solid #f8fafc":"none"}}>
                                    <div style={{width:28,height:28,borderRadius:"50%",background:rc+"14",color:rc,fontSize:13,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}>{i+1}</div>
                                    <div style={{fontSize:15,color:"#374151",lineHeight:1.75}}>{a}</div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        <button onClick={()=>{setQStep(0);setQRes(null);setQAns({});setQEmailSent(false);setQEmail("");}}
                          style={{padding:"12px 26px",borderRadius:12,border:`2px solid ${rc}`,background:"transparent",color:rc,fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                          Retake Quiz
                        </button>
                      </div>
                    ) : (
                      <div>
                        <div style={{fontSize:14,color:"#94a3b8",fontWeight:700,textTransform:"uppercase",letterSpacing:".08em",marginBottom:16}}>Question {qStep+1} of {QUIZ.length}</div>
                        <div style={{background:"#f8fafc",borderRadius:16,padding:"26px",marginBottom:18}}>
                          <p style={{fontSize:18,color:"#0f172a",fontWeight:700,marginBottom:22,lineHeight:1.55}}>{QUIZ[qStep].q}</p>
                          {QUIZ[qStep].o.map(opt=>(
                            <button key={opt} className="q-opt" style={{display:"block",width:"100%",padding:"16px 20px",borderRadius:12,border:"2px solid #e2e8f0",background:"#fff",color:"#374151",fontSize:16,marginBottom:10,boxShadow:"0 1px 4px rgba(0,0,0,.05)",fontWeight:500}}
                              onClick={()=>{
                                const a={...qAns,[QUIZ[qStep].k]:opt};
                                setQAns(a);
                                if(qStep<QUIZ.length-1) setQStep(s=>s+1);
                                else setQRes(calcQuiz(a));
                              }}>
                              {opt}
                            </button>
                          ))}
                        </div>
                        <div style={{height:7,background:"#e2e8f0",borderRadius:4}}>
                          <div style={{height:7,width:`${(qStep/QUIZ.length)*100}%`,background:`linear-gradient(90deg,${rc},#f97316)`,borderRadius:4,transition:"width .4s ease"}}/>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {tab==="health" && (
                  <div>
                    <div style={{background:"#fef2f2",border:"2px solid #fecaca",borderRadius:14,padding:"18px 22px",marginBottom:24}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}><Icon name="alert" size={20} color="#ef4444"/><span style={{fontSize:13,color:"#ef4444",fontWeight:800,letterSpacing:".08em",textTransform:"uppercase"}}>Long-Term Health Risks</span></div>
                      <p style={{fontSize:16,color:"#7f1d1d",lineHeight:1.8,margin:0}}>A 2025 study estimated data center pollution causes a public health burden of over $20 billion annually by 2030. Click any risk below to read the full explanation.</p>
                    </div>
                    {LONGTERM.map((r,i)=>(
                      <div key={i} style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:16,marginBottom:12,overflow:"hidden",boxShadow:"0 2px 8px rgba(0,0,0,.04)"}}>
                        <div className="acc-hd" style={{padding:"20px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}} onClick={()=>setXLong(xLong===i?null:i)}>
                          <div style={{display:"flex",gap:16,alignItems:"center"}}>
                            <div style={{width:52,height:52,borderRadius:14,background:r.c+"14",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name={r.icon} size={28} color={r.c}/></div>
                            <div>
                              <div style={{fontSize:18,fontWeight:800,color:"#0f172a",marginBottom:4}}>{r.t}</div>
                              <div style={{fontSize:15,color:"#64748b",lineHeight:1.5}}>{r.sh}</div>
                            </div>
                          </div>
                          <div style={{fontSize:24,color:"#94a3b8",fontWeight:300,flexShrink:0,marginLeft:16}}>{xLong===i?"−":"+"}</div>
                        </div>
                        {xLong===i && (
                          <div style={{padding:"0 24px 24px",borderTop:"1px solid #f1f5f9"}}>
                            <p style={{fontSize:16,color:"#374151",lineHeight:1.9,margin:"18px 0 18px"}}>{r.lo}</p>
                            <div style={{background:r.c+"0d",border:`1.5px solid ${r.c}22`,borderRadius:12,padding:"16px 20px"}}>
                              <div style={{display:"flex",alignItems:"flex-start",gap:10,marginBottom:10}}><Icon name="star" size={18} color={r.c}/><div style={{fontSize:15,color:r.c,fontWeight:700,lineHeight:1.5}}>{r.stat}</div></div>
                              <div style={{paddingLeft:28}}><SrcLink text={r.src} url={r.url}/></div>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {tab==="kids" && (
                  <div>
                    <div style={{background:"#fffbeb",border:"2px solid #fde68a",borderRadius:14,padding:"18px 22px",marginBottom:24}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}><Icon name="kids" size={20} color="#d97706"/><span style={{fontSize:13,color:"#d97706",fontWeight:800,letterSpacing:".08em",textTransform:"uppercase"}}>Why Children Are More Vulnerable</span></div>
                      <p style={{fontSize:16,color:"#78350f",lineHeight:1.8,margin:0}}>Children breathe more air per pound of body weight, sleep longer, and have developing systems that are more sensitive to environmental disruption than adults.</p>
                    </div>
                    {KIDS.map((k,i)=>(
                      <div key={i} style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:16,marginBottom:12,overflow:"hidden",boxShadow:"0 2px 8px rgba(0,0,0,.04)"}}>
                        <div className="acc-hd" style={{padding:"20px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}} onClick={()=>setXKid(xKid===i?null:i)}>
                          <div style={{display:"flex",gap:16,alignItems:"center"}}>
                            <div style={{width:52,height:52,borderRadius:14,background:k.c+"14",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name={k.icon} size={28} color={k.c}/></div>
                            <div>
                              <div style={{fontSize:18,fontWeight:800,color:"#0f172a",marginBottom:6}}>{k.t}</div>
                              <Chip label={k.sev} color={k.c} small/>
                            </div>
                          </div>
                          <div style={{fontSize:24,color:"#94a3b8",fontWeight:300,flexShrink:0,marginLeft:16}}>{xKid===i?"−":"+"}</div>
                        </div>
                        {xKid===i && (
                          <div style={{padding:"0 24px 24px",borderTop:"1px solid #f1f5f9"}}>
                            <p style={{fontSize:16,color:"#374151",lineHeight:1.9,margin:"18px 0 0"}}>{k.d}</p>
                          </div>
                        )}
                      </div>
                    ))}
                    <div style={{background:"#f0fdf4",border:"2px solid #bbf7d0",borderRadius:16,padding:"20px 24px",marginTop:12}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}><Icon name="megaphone" size={20} color="#15803d"/><span style={{fontSize:13,color:"#15803d",fontWeight:800,letterSpacing:".08em",textTransform:"uppercase"}}>What Parents Are Demanding</span></div>
                      {["Mandatory independent EMF and air quality monitoring before and after construction","Minimum setback requirements from schools, daycare centers, and playgrounds","Real-time public air quality data near each facility","Advance notice of generator test schedules so parents can keep children indoors","Community right-to-know reporting on all emission events"].map((p,i)=>(
                        <div key={i} style={{display:"flex",gap:12,padding:"9px 0",borderBottom:i<4?"1px solid #dcfce7":"none",alignItems:"flex-start"}}>
                          <Icon name="check" size={18} color="#15803d"/>
                          <div style={{fontSize:15,color:"#166534",lineHeight:1.65}}>{p}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {tab==="act" && (
                  <div>
                    <h3 style={{fontSize:22,fontWeight:900,color:"#0f172a",marginBottom:10}}>You Are Not Powerless</h3>
                    <p style={{fontSize:16,color:"#64748b",marginBottom:28,lineHeight:1.75}}>Every data center regulation that exists was won by residents who organized, documented, and demanded accountability.</p>
                    {[
                      {icon:"doc",      t:"Document everything starting today",c:"#ef4444",steps:["Start a dedicated symptom log tonight. Record headaches, sleep disruption, dizziness, ear ringing, anxiety, and nausea. Include the date, time of day, duration, and severity on a scale of 1 to 10.","Note every time you smell diesel exhaust. Record the date, time, approximate wind direction, duration, and how strong the smell was.","Photograph or video any visible smoke, unusual emissions, or visible vibration effects. Include the timestamp shown in your phone.","Note whether your symptoms improve when you spend time away from home. This leave-and-return pattern is one of the most diagnostically significant indicators of an environmental cause.","Keep all of this in a dated format. Regulators and lawyers both need patterns, not isolated incidents."]},
                      {icon:"megaphone",t:"File formal complaints through every available channel",c:"#f97316",steps:["File a written noise complaint with your city or county zoning office. Ask specifically what noise conditions are attached to its operating permit and request a copy of those permit conditions.","File a separate air quality complaint with your state or provincial environmental agency. Describe the diesel exhaust events specifically.","File with your national environmental regulator. In the US this is the EPA at epa.gov. In Canada it is Environment and Climate Change Canada.","Write to your elected representative at every level. Written correspondence creates a paper trail. Ask them to inquire about the facility's permit compliance.","File with your local public health department. Describe the symptoms you and your neighbors are experiencing."]},
                      {icon:"monitor",  t:"Request independent professional monitoring",c:"#eab308",steps:["Hire a certified environmental health consultant to conduct an EMF survey of your property. Measure ELF magnetic fields specifically in milligauss at multiple points inside and outside your home.","Contact your local health department and ask them to monitor outdoor air quality near the facility during generator test days.","If there is a school or daycare within half a mile, contact the school board in writing. They have independent legal standing to demand environmental assessments.","Ask the facility directly in writing for their generator test schedule, noise monitoring data, and air permit compliance reports.","Keep copies of everything you send and receive."]},
                      {icon:"group",    t:"Organize with your neighbors",c:"#8b5cf6",steps:["Talk to your immediate neighbors first. You may find others have symptoms they have not connected to the facility.","Start or join a neighborhood group. Organize your documentation collectively. The volume of complaints matters enormously in regulatory responses.","Research what other communities have done. Residents in Prince William County and Loudoun County Virginia fought back through organized advocacy and won meaningful concessions.","Contact Earthjustice at earthjustice.org. They represent communities facing industrial noise and air quality issues. Initial consultations are free.","Consult a private environmental attorney. In many jurisdictions, property damage caused by industrial noise is actionable."]},
                      {icon:"shield",   t:"Protect your family starting right now",c:"#3b82f6",steps:["Request the facility's generator test schedule in writing today. On test days, keep all windows and doors closed, bring children indoors, and avoid outdoor activities.","Install HEPA air purifiers in your bedroom and any rooms where children spend significant time. Run them continuously.","Rearrange sleeping arrangements so bedrooms are on the side of your home furthest from the facility.","Talk to your family doctor specifically about proximity to industrial infrastructure. Ask them to note your symptoms in your medical record.","Consider acoustic treatments for your bedroom: heavy curtains, door seals, and a white noise or brown noise generator for sleep."]},
                      {icon:"star",     t:"Know your legal rights",c:"#10b981",steps:["In most jurisdictions, industrial operations that cause demonstrable harm to neighboring properties can constitute a legal nuisance. Consult an environmental attorney.","Property value impacts from nearby industrial development can sometimes be recovered through legal action or property tax assessment challenges.","Freedom of Information requests can obtain the facility's permit applications, environmental impact assessments, and noise monitoring data.","If you are renting, your landlord may have a disclosure obligation regarding industrial neighbors depending on your jurisdiction.","Keep records of any time you raise the issue with the facility operator directly. Their awareness and response are relevant in legal proceedings."]},
                    ].map((s,i)=>(
                      <div key={i} style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:16,overflow:"hidden",marginBottom:14,boxShadow:"0 2px 8px rgba(0,0,0,.04)"}}>
                        <div style={{padding:"18px 24px",borderBottom:"1px solid #f1f5f9",display:"flex",alignItems:"center",gap:12}}>
                          <div style={{width:46,height:46,borderRadius:12,background:s.c+"14",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name={s.icon} size={24} color={s.c}/></div>
                          <div style={{fontSize:18,fontWeight:800,color:"#0f172a"}}>{s.t}</div>
                        </div>
                        {s.steps.map((step,j)=>(
                          <div key={j} style={{display:"flex",gap:14,padding:"14px 24px",borderBottom:j<s.steps.length-1?"1px solid #f8fafc":"none",alignItems:"flex-start"}}>
                            <div style={{width:28,height:28,borderRadius:"50%",background:s.c+"14",color:s.c,fontSize:13,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}>{j+1}</div>
                            <div style={{fontSize:15,color:"#374151",lineHeight:1.75}}>{step}</div>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}

                {tab==="submit" && (
                  <div>
                    <h3 style={{fontSize:22,fontWeight:900,color:"#0f172a",marginBottom:10}}>Submit Your Report</h3>
                    <p style={{fontSize:16,color:"#64748b",marginBottom:28,lineHeight:1.75}}>Share your experience living near this facility. Verified reports help regulators understand the real-world health impact and protect future residents.</p>
                    <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:18,padding:"28px 30px",boxShadow:"0 4px 24px rgba(0,0,0,.07)"}}>
                      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:8}}>
                        <div style={{width:44,height:44,borderRadius:12,background:rc+"14",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon name="doc" size={22} color={rc}/></div>
                        <div>
                          <div style={{fontSize:18,fontWeight:800,color:"#0f172a"}}>Submit Your Resident Report</div>
                          <div style={{fontSize:13,color:"#94a3b8",marginTop:2}}>Fields marked with an asterisk are required</div>
                        </div>
                      </div>
                      <div style={{background:rc+"08",border:`1px solid ${rc}20`,borderRadius:12,padding:"14px 18px",marginBottom:24,marginTop:16}}>
                        <p style={{fontSize:14,color:"#374151",lineHeight:1.75,margin:0}}>Reports submitted here are reviewed by HumZones and may be shared with regulatory bodies as part of our verified resident health registry. A verified email address and signed declaration make your report credible to regulators and public health authorities.</p>
                      </div>
                      <input className="hz-trap" tabIndex="-1" autoComplete="off" value={hp} onChange={e=>setHp(e.target.value)} aria-hidden="true"/>
                      {sent ? (
                        <div style={{background:"#f0fdf4",border:"2px solid #bbf7d0",borderRadius:16,padding:"24px"}}>
                          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}><Icon name="check" size={24} color="#15803d"/><div style={{fontSize:18,fontWeight:800,color:"#15803d"}}>Report submitted successfully.</div></div>
                          <p style={{fontSize:15,color:"#166534",lineHeight:1.75,marginBottom:20}}>Thank you. Your report has been received and will be reviewed within 48 hours. Once approved it will appear in this community registry.</p>
                          <button onClick={()=>setSent(false)} style={{fontSize:14,padding:"10px 22px",borderRadius:10,border:"1.5px solid #bbf7d0",background:"transparent",color:"#15803d",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>Submit another report</button>
                        </div>
                      ) : (
                        <div>
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
                            <div>
                              <label style={{fontSize:13,fontWeight:700,color:"#374151",display:"block",marginBottom:6}}>Your Name</label>
                              <input value={repName} onChange={e=>setRepName(e.target.value)} placeholder="First name or Anonymous" style={{width:"100%",padding:"13px 16px",borderRadius:10,border:"1.5px solid #e2e8f0",fontSize:15,boxSizing:"border-box",outline:"none",fontFamily:"inherit",color:"#1e293b"}}/>
                            </div>
                            <div>
                              <label style={{fontSize:13,fontWeight:700,color:"#374151",display:"block",marginBottom:6}}>Email Address *</label>
                              <input value={repEmail} onChange={e=>setRepEmail(e.target.value)} placeholder="Required to verify your report" type="email" style={{width:"100%",padding:"13px 16px",borderRadius:10,border:`1.5px solid ${repEmail.trim()?"#3b82f6":"#e2e8f0"}`,fontSize:15,boxSizing:"border-box",outline:"none",fontFamily:"inherit",color:"#1e293b",transition:"border-color .2s"}}/>
                              <div style={{fontSize:11,color:"#94a3b8",marginTop:4}}>Not displayed publicly. Verification only.</div>
                            </div>
                          </div>
                          <div style={{marginBottom:16}}>
                            <label style={{fontSize:13,fontWeight:700,color:"#374151",display:"block",marginBottom:8}}>How long have you lived at this address?</label>
                            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                              {["Less than 1 year","1 to 3 years","3 to 10 years","More than 10 years"].map(d=>(
                                <button key={d} onClick={()=>setRepDuration(d)} style={{padding:"9px 16px",borderRadius:20,border:`2px solid ${repDuration===d?rc:"#e2e8f0"}`,background:repDuration===d?rc+"12":"#fff",color:repDuration===d?rc:"#64748b",fontSize:13,fontWeight:600,cursor:"pointer",fontFamily:"inherit",transition:"all .15s"}}>{d}</button>
                              ))}
                            </div>
                          </div>
                          <div style={{marginBottom:16}}>
                            <label style={{fontSize:13,fontWeight:700,color:"#374151",display:"block",marginBottom:8}}>Which of these have you experienced? <span style={{color:"#94a3b8",fontWeight:400}}>(select all that apply)</span></label>
                            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                              {SYMPTOM_OPTIONS.map(s=>{
                                const checked=repSymptoms.includes(s);
                                return (
                                  <div key={s} onClick={()=>toggleSymptom(s)} style={{display:"flex",alignItems:"center",gap:10,padding:"11px 14px",borderRadius:10,border:`1.5px solid ${checked?rc:"#e2e8f0"}`,background:checked?rc+"0d":"#f8fafc",cursor:"pointer",transition:"all .15s"}}>
                                    <div style={{width:18,height:18,borderRadius:4,border:`2px solid ${checked?rc:"#cbd5e1"}`,background:checked?rc:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all .15s"}}>
                                      {checked && <Icon name="check" size={11} color="#fff"/>}
                                    </div>
                                    <span style={{fontSize:13,fontWeight:checked?600:400,color:checked?rc:"#374151"}}>{s}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                          <div style={{marginBottom:16}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                              <label style={{fontSize:13,fontWeight:700,color:"#374151"}}>Your Report *</label>
                              <span style={{fontSize:12,fontWeight:600,color:draft.length>MAX_REPORT_CHARS?"#ef4444":draft.length>MAX_REPORT_CHARS*0.8?"#f97316":"#94a3b8"}}>
                                {draft.length.toLocaleString()} / {MAX_REPORT_CHARS.toLocaleString()}
                              </span>
                            </div>
                            <textarea value={draft} onChange={e=>{if(e.target.value.length<=MAX_REPORT_CHARS) setDraft(e.target.value);}} rows={6}
                              placeholder="Describe what you have experienced living near this facility. Include when symptoms started, how frequently they occur, whether they improve when you leave the area, any events you have noticed such as generator tests or visible smoke. The more specific detail you provide the more useful your report is to regulators."
                              style={{width:"100%",padding:"14px 16px",borderRadius:10,border:`1.5px solid ${draft.length>MAX_REPORT_CHARS*0.9?"#ef4444":draft.trim()?"#3b82f6":"#e2e8f0"}`,fontSize:15,resize:"vertical",outline:"none",boxSizing:"border-box",fontFamily:"inherit",lineHeight:1.75,color:"#1e293b",transition:"border-color .2s"}}/>
                            {draft.length>=MAX_REPORT_CHARS && (
                              <div style={{fontSize:12,color:"#ef4444",marginTop:4,fontWeight:600}}>Maximum length reached. Please edit your report to fit within 3,000 characters.</div>
                            )}
                          </div>
                          <div onClick={()=>setRepDeclared(v=>!v)} style={{display:"flex",alignItems:"flex-start",gap:12,padding:"16px",borderRadius:12,border:`2px solid ${repDeclared?rc:"#e2e8f0"}`,background:repDeclared?rc+"08":"#f8fafc",cursor:"pointer",marginBottom:20,transition:"all .2s"}}>
                            <div style={{width:22,height:22,borderRadius:5,border:`2px solid ${repDeclared?rc:"#94a3b8"}`,background:repDeclared?rc:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1,transition:"all .2s"}}>
                              {repDeclared && <Icon name="check" size={13} color="#fff"/>}
                            </div>
                            <div style={{fontSize:14,color:"#374151",lineHeight:1.7,fontWeight:repDeclared?600:400}}>* I declare that I am a real resident living near this facility and that the information in this report is truthful to the best of my knowledge. I understand this report may be shared with public health authorities and regulatory bodies.</div>
                          </div>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:16,flexWrap:"wrap"}}>
                            <button onClick={sendReport} disabled={sending||!canSubmit} style={{padding:"15px 36px",borderRadius:12,border:"none",background:canSubmit?rc:"#e2e8f0",color:canSubmit?"#fff":"#94a3b8",fontSize:16,fontWeight:800,cursor:canSubmit?"pointer":"default",fontFamily:"inherit",transition:"all .2s",boxShadow:canSubmit?`0 4px 20px ${rc}44`:"none"}}>
                              {sending?"Submitting...":"Submit Verified Report"}
                            </button>
                            <div style={{fontSize:13,color:"#94a3b8",maxWidth:300,lineHeight:1.55}}>Reports reviewed within 48 hours. Email used for verification only, never displayed publicly.</div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {tab==="reports" && (
                  <div>
                    <h3 style={{fontSize:22,fontWeight:900,color:"#0f172a",marginBottom:10}}>Community Reports</h3>
                    <p style={{fontSize:16,color:"#64748b",marginBottom:28,lineHeight:1.75}}>One person's symptom diary is anecdote. Three hundred people's diaries near the same facility is a public health study. Your report matters.</p>
                    {reps.length===0 && (
                      <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:16,padding:"24px",marginBottom:12}}>
                        <p style={{fontSize:16,color:"#94a3b8",fontStyle:"italic",margin:0,marginBottom:14}}>No reports yet for this facility. Be the first to share your experience.</p>
                        <button onClick={()=>setTab("submit")} style={{padding:"10px 22px",borderRadius:10,border:"none",background:rc,color:"#fff",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit",boxShadow:`0 4px 14px ${rc}44`}}>Submit Your Report</button>
                      </div>
                    )}
                    {reps.map((r,i)=>{
                      const isExpanded = expandedRep === i;
                      const text = r.Report_Text || "";
                      // Always clamp to 3 lines visually, show button to expand
                      // Use a word count threshold so short reports don't show the button
                      const wordCount = text.trim().split(/\s+/).length;
                      const isLong = wordCount > 25 || text.length > 160;
                      return (
                        <div key={i} style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:16,padding:"20px 24px",marginBottom:12,boxShadow:"0 2px 8px rgba(0,0,0,.04)"}}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12,gap:12}}>
                            <span style={{fontSize:15,fontWeight:800,color:rc,display:"flex",alignItems:"center",gap:6}}>
                              <Icon name="community" size={16} color={rc}/> {r.Reporter||"Anonymous"}
                            </span>
                            <span style={{fontSize:13,color:"#94a3b8",flexShrink:0}}>{r.Date_Submitted}</span>
                          </div>
                          {r.Duration && (
                            <div style={{fontSize:12,color:"#64748b",fontWeight:600,marginBottom:8,display:"flex",alignItems:"center",gap:6}}>
                              <Icon name="pin" size={12} color="#94a3b8"/> Resident for {r.Duration}
                            </div>
                          )}
                          {r.Symptoms && (
                            <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
                              {r.Symptoms.split(", ").filter(Boolean).map((sym,si)=>(
                                <span key={si} style={{fontSize:12,fontWeight:600,padding:"3px 10px",borderRadius:20,background:rc+"12",color:rc,border:`1px solid ${rc}22`}}>{sym}</span>
                              ))}
                            </div>
                          )}
                          <div style={{position:"relative"}}>
                            <p style={{
                              fontSize:15,color:"#374151",lineHeight:1.85,margin:0,
                              overflow:"hidden",
                              display:"-webkit-box",
                              WebkitLineClamp:isExpanded?999:3,
                              WebkitBoxOrient:"vertical",
                            }}>{text}</p>
                            {!isExpanded && isLong && (
                              <div style={{position:"absolute",bottom:0,left:0,right:0,height:36,background:"linear-gradient(to bottom, transparent, #fff)"}}/>
                            )}
                          </div>
                          {isLong && (
                            <button onClick={()=>setExpandedRep(isExpanded?null:i)}
                              style={{marginTop:8,background:"transparent",border:"none",color:rc,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:"inherit",padding:0,display:"flex",alignItems:"center",gap:4}}>
                              {isExpanded ? "Show less ↑" : "Read full report ↓"}
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {reps.length>0 && (
                      <div style={{marginTop:18,paddingTop:18,borderTop:"1px solid #e2e8f0",display:"flex",alignItems:"center",justifyContent:"space-between",gap:16,flexWrap:"wrap"}}>
                        <div style={{fontSize:14,color:"#64748b",lineHeight:1.6}}>Have your own experience to add to this registry?</div>
                        <button onClick={()=>setTab("submit")} style={{padding:"12px 24px",borderRadius:10,border:"none",background:rc,color:"#fff",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit",boxShadow:`0 4px 14px ${rc}44`}}>Submit Your Report</button>
                      </div>
                    )}
                  </div>
                )}

              </div>
            </div>
            </>
          )}
        </main>

        {/* SCROLL TO TOP BUTTON */}
        {showScrollTop && (
          <button
            onClick={()=>window.scrollTo({top:0,behavior:"smooth"})}
            style={{
              position:"fixed",
              bottom:28,
              right:28,
              width:48,
              height:48,
              borderRadius:"50%",
              background:"linear-gradient(135deg,#ef4444,#f97316)",
              border:"none",
              boxShadow:"0 4px 20px rgba(239,68,68,.45)",
              cursor:"pointer",
              zIndex:8888,
              display:"flex",
              alignItems:"center",
              justifyContent:"center",
              transition:"transform .2s, box-shadow .2s",
            }}
            onMouseEnter={e=>{e.currentTarget.style.transform="scale(1.12)";e.currentTarget.style.boxShadow="0 6px 28px rgba(239,68,68,.6)";}}
            onMouseLeave={e=>{e.currentTarget.style.transform="scale(1)";e.currentTarget.style.boxShadow="0 4px 20px rgba(239,68,68,.45)";}}
            aria-label="Scroll to top"
          >
            <Icon name="chevUp" size={22} color="#fff"/>
          </button>
        )}

        <div style={{borderTop:"1px solid #e2e8f0",padding:"28px 24px",textAlign:"center"}}>
          <p style={{fontSize:12,color:"#94a3b8",lineHeight:1.7,maxWidth:760,margin:"0 auto"}}>
            Data Disclaimer: All figures shown including noise levels, EMF readings, power consumption, CO2 estimates, and water usage are research-based estimates compiled from public sources, permit filings, and industry standards. They are not certified measurements. Actual readings may vary by facility design, operating conditions, and season. HumZones is an informational resource only and does not constitute medical, legal, or environmental advice.
            {" "}
            <a href="/methodology" onClick={e=>{e.preventDefault();navigate("/methodology");}} className="ext-link" style={{color:"#ef4444",fontWeight:700,textDecoration:"none"}}>Methodology</a>
          </p>
        </div>

        <footer style={{background:"#0a0f1e",padding:"48px 24px 36px",textAlign:"center"}}>
          <div style={{marginBottom:6}}>
            <span style={{fontSize:26,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
            <sup style={{fontSize:14,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2}}>TM</sup>
          </div>
          <div style={{fontSize:14,color:"#cbd5e1",fontWeight:700,marginBottom:6,letterSpacing:".02em"}}>HumZones Technologies Inc.</div>
          <div style={{fontSize:16,color:"#64748b",marginBottom:20}}>Global Data Center Health Registry</div>

          {/* Site links */}
          <div style={{display:"flex",justifyContent:"center",gap:18,flexWrap:"wrap",marginBottom:22}}>
            <a href="/methodology" onClick={e=>{e.preventDefault();navigate("/methodology");}} className="ext-link" style={{color:"#f97316",fontSize:14,fontWeight:700,textDecoration:"none",letterSpacing:".02em"}}>
              Methodology
            </a>
            <a href="https://humzones.com" className="ext-link" style={{color:"#94a3b8",fontSize:14,fontWeight:600,textDecoration:"none",letterSpacing:".02em"}}>
              humzones.com
            </a>
          </div>

          {/* External research sources */}
          <div style={{fontSize:11,color:"#475569",letterSpacing:".10em",textTransform:"uppercase",fontWeight:800,marginBottom:10}}>Research Sources</div>
          <div style={{display:"flex",justifyContent:"center",gap:20,flexWrap:"wrap",marginBottom:28}}>
            {[
              {t:"Epoch AI (CC-BY)",url:"https://epoch.ai/data/data-centers"},
              {t:"EH Sciences",    url:"https://ehsciences.org"},
              {t:"IARC / WHO",     url:"https://www.iarc.who.int"},
              {t:"arXiv 2025",     url:"https://arxiv.org/abs/2412.06288"},
              {t:"BioInitiative",  url:"https://www.bioinitiative.org"},
              {t:"PubMed",         url:"https://pubmed.ncbi.nlm.nih.gov"},
            ].map(s=>(
              <a key={s.t} href={s.url} target="_blank" rel="noopener noreferrer" className="ext-link" style={{color:"#3b82f6",display:"flex",alignItems:"center",gap:4,fontSize:15,fontWeight:600}}>
                {s.t} <Icon name="external" size={13} color="#3b82f6"/>
              </a>
            ))}
          </div>
          <div style={{fontSize:15,color:"#94a3b8",borderTop:"1px solid #1e293b",paddingTop:20,lineHeight:1.8}}>
            <div>HumZones<sup style={{fontSize:".55em",color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:1,marginRight:4}}>TM</sup>Technologies Inc.</div>
            <div>&copy; 2026 All Rights Reserved</div>
          </div>
          <div style={{fontSize:13,color:"#475569",marginTop:6}}>
            humzones.com &middot; Built for residents, not the industry
          </div>
        </footer>

      </div>
      )}
    </>
  );
}
