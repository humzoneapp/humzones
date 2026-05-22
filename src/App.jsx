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
// Exposure colors: HIGH red, MODERATE orange, LOW green. There is deliberately
// no blue "LOW-MODERATE" tier; exposureTier() folds that legacy value into
// MODERATE so no blue exposure chip is ever rendered anywhere on the site.
const RISK_C = { HIGH:"#ef4444", MODERATE:"#f97316", LOW:"#22c55e" };

// Normalize a stored Risk_Level into the exposure tier shown to users. The
// legacy "LOW-MODERATE" value displays as MODERATE so no blue tier remains.
const exposureTier = (lvl) => {
  const v = String(lvl || "").toUpperCase();
  if (v === "HIGH") return "HIGH";
  if (v === "LOW")  return "LOW";
  if (v === "MODERATE" || v === "LOW-MODERATE") return "MODERATE";
  return v || "UNKNOWN";
};
const exposureColor = (lvl) => RISK_C[exposureTier(lvl)] || "#64748b";
const exposureLabel = (lvl) => `${exposureTier(lvl)} EXPOSURE`;

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
  {id:"feel",    label:"What Residents Report",  icon:"sound"},
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
  /* Near Me upsell banner heading: bumped to a hero size with a soft drop
     shadow so the "There's More You Should Know" prompt reads as a real
     headline. Scales down on mobile so it does not wrap awkwardly. */
  .upsell-heading{font-size:28px!important;font-weight:900!important;color:#fff!important;text-shadow:0 2px 4px rgba(0,0,0,0.3)!important;line-height:1.2!important;letter-spacing:-.01em!important;margin:0 0 14px!important;display:block!important}
  @media(max-width:640px){
    .upsell-heading{font-size:22px!important;margin:0 0 12px!important}
  }
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
        <Chip label={exposureLabel(dc.Risk_Level)} color={rc}/>
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

const MethodologyPage = ({ onBack, onNavigate }) => {
  const go = onNavigate || onBack;
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

      <footer style={{background:"#0a0f1e",padding:"32px 24px",textAlign:"center"}}>
        <div style={{display:"flex",justifyContent:"center",gap:18,flexWrap:"wrap"}}>
          <a href="/" onClick={e=>{e.preventDefault();go("/");}} className="ext-link" style={{color:"#f97316",fontSize:14,fontWeight:700,textDecoration:"none",letterSpacing:".02em"}}>Home</a>
          <a href="/business" onClick={e=>{e.preventDefault();go("/business");}} className="ext-link" style={{color:"#f97316",fontSize:14,fontWeight:700,textDecoration:"none",letterSpacing:".02em"}}>Business Plans</a>
          <a href="/my-report" onClick={e=>{e.preventDefault();go("/my-report");}} className="ext-link" style={{color:"#f97316",fontSize:14,fontWeight:700,textDecoration:"none",letterSpacing:".02em"}}>Retrieve My Report</a>
          <a href="/privacy" onClick={e=>{e.preventDefault();go("/privacy");}} className="ext-link" style={{color:"#f97316",fontSize:14,fontWeight:700,textDecoration:"none",letterSpacing:".02em"}}>Privacy Policy</a>
        </div>
        <div style={{fontSize:13,color:"#475569",marginTop:16}}>HumZones Technologies Inc. | humzones.com</div>
      </footer>
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

  // Free sample report download. Uses fixed placeholder data so it is
  // identical for every visitor and never reveals real facility figures.
  const [sampleBusy, setSampleBusy] = useState(false);
  const handleSampleDownload = async () => {
    if (sampleBusy) return;
    setSampleBusy(true);
    try {
      const { doc } = await buildSampleReportPdf({
        subtitle: "Local infrastructure, environmental, and community impact insights for your area.",
        address: "123 Main Street, Austin, Texas, United States",
        summaryRows: [
          ["Total facilities within 100km", "8"],
          ["HIGH exposure category facilities", "2"],
          ["MODERATE exposure category facilities", "4"],
          ["LOW exposure category facilities", "2"],
          ["Combined estimated power draw", "318 MW"],
          ["Combined estimated daily water draw", "1,985,000 gallons"],
          ["Combined estimated annual CO2 impact", "1,074,600 tons"],
        ],
        summaryParagraph: "This sample report identifies 8 placeholder data center facilities within 100km of a sample address. Of these, 2 are in the HIGH infrastructure exposure category, 4 are MODERATE and 2 are LOW, based on power scale, proximity to residential areas and cooling type. A full HumZones report lists every facility near a real searched address with the same depth of detail shown on the following pages.",
        facilities: [
          { name:"Amazon Data Center",   city:"Austin, Texas, United States", dist:"15.2 km", cat:"HIGH",     power:"120 MW", noise:"68 dB", emfFence:"45 mG", emf100:"5 mG", co2:"405,720 tons per year", water:"900,000 gallons per day" },
          { name:"Google Cloud Campus",  city:"Austin, Texas, United States", dist:"28.7 km", cat:"MODERATE", power:"45 MW",  noise:"65 dB", emfFence:"40 mG", emf100:"4 mG", co2:"152,145 tons per year", water:"337,500 gallons per day" },
          { name:"Equinix Data Center",  city:"Austin, Texas, United States", dist:"67.3 km", cat:"LOW",      power:"12 MW",  noise:"60 dB", emfFence:"33 mG", emf100:"2 mG", co2:"40,572 tons per year",  water:"90,000 gallons per day" },
        ],
      });
      doc.save("HumZones-Sample-Report.pdf");
    } catch (e) {
      console.error("Sample report generation failed:", e);
      window.alert("We could not generate the sample report. Please try again.");
    } finally {
      setSampleBusy(false);
    }
  };

  // Estimated rollups (per the spec): 45 MW average draw, 35,000 gal/day water.
  const estPowerMW       = facilities100km * 45;
  const estWaterGalDay   = facilities100km * 35000;
  const fmtNum = (n) => Number(n).toLocaleString();
  const fmtPower = (mw) => mw >= 1000 ? `${(mw/1000).toFixed(1)} GW` : `${fmtNum(mw)} MW`;

  // Detect an active business session so we can swap the Stripe CTA for an
  // in-app "Generate Report" button that bills a credit instead of a card.
  const businessAccount = readBusinessAccount();
  const isBusinessActive = !!(businessAccount && businessAccount.status === "Active" &&
    (businessAccount.creditsMonthly >= 999999 || businessAccount.creditsRemaining > 0));
  const businessIsUnlimited = !!(businessAccount && businessAccount.creditsMonthly >= 999999);

  // Buy CTA: redirects straight to the Stripe-hosted Payment Link. No
  // serverless function is involved; the post-payment redirect is configured
  // on the Payment Link in the Stripe dashboard to land on
  // https://humzones.com/report-success. Search context is written to
  // localStorage on the line right above so /report-success can personalize
  // the PDF when the buyer comes back.
  const STRIPE_PAYMENT_LINK = "https://buy.stripe.com/test_3cI6oJ3DA2bv8Gd3uIgMw00";
  const persistSearchContext = () => {
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
  };
  const handleBuyReport = () => {
    persistSearchContext();
    if (isBusinessActive) {
      // Business users skip Stripe and use the dedicated /business-generate
      // page, which handles geocoding, credit deduction and the PDF.
      onNavigate("/business-generate");
      return;
    }
    window.location.href = STRIPE_PAYMENT_LINK;
  };
  const businessCtaLabel = businessIsUnlimited
    ? "Generate Report (Unlimited)"
    : (businessAccount ? `Generate Report (${businessAccount.creditsRemaining} credits remaining)` : "");

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
      label: "HIGH exposure category facilities",
      desc: "Sites at 50 MW or more, or within 500m of homes. These have the strongest documented infrastructure impact patterns.",
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
    "Infrastructure exposure category and infrastructure and community impact context for each facility",
    "EMF exposure estimates at your distance",
    "Noise impact analysis",
    "Water and CO2 impact in your region",
    "Infrastructure awareness and community action steps",
    "Lifetime report access: every report you purchase is saved to your account forever",
    "Re-download anytime: retrieve any past report using your email address, even years later",
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
            {isBusinessActive ? businessCtaLabel : "Get My Full Report"}
          </button>
          <p style={{fontSize:13,color:"rgba(255,255,255,.55)",marginTop:12,lineHeight:1.6}}>
            {isBusinessActive ? "Instant PDF. No additional charge - billed to your business plan." : "Instant PDF. Personalized to your exact location."}
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

          {/* Sample report preview + free sample download */}
          <div style={{position:"relative",display:"flex",flexDirection:"column",alignItems:"center"}}>
            {/* Soft orange halo behind the preview */}
            <div aria-hidden="true" style={{position:"absolute",top:-34,left:"50%",transform:"translateX(-50%)",width:468,height:368,maxWidth:"calc(100% + 68px)",background:"radial-gradient(ellipse at center, rgba(249,115,22,.42) 0%, rgba(249,115,22,0) 65%)",filter:"blur(22px)",pointerEvents:"none",zIndex:0}}/>

            {/* Blurred report preview */}
            <div style={{position:"relative",zIndex:1,width:400,maxWidth:"100%",height:300,background:"linear-gradient(135deg,#2d3748,#1e293b)",borderRadius:8,boxShadow:"0 20px 60px rgba(0,0,0,0.4)",overflow:"hidden"}}>
              <div aria-hidden="true" style={{filter:"blur(4px)",padding:"30px 32px",pointerEvents:"none",userSelect:"none"}}>
                {[92,78,96,66,84,58,90,72,82].map((w,i)=>(
                  <div key={i} style={{height:13,background:"rgba(255,255,255,.20)",borderRadius:4,marginBottom:13,width:`${w}%`}}/>
                ))}
              </div>
              {/* Diagonal SAMPLE text across the entire preview */}
              <div aria-hidden="true" style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%) rotate(-30deg)",fontSize:48,fontWeight:900,color:"rgba(255,255,255,0.15)",letterSpacing:"8px",textTransform:"uppercase",pointerEvents:"none",whiteSpace:"nowrap"}}>Sample</div>
              {/* Centered lock icon overlay */}
              <div aria-hidden="true" style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",fontSize:32,lineHeight:1,background:"rgba(0,0,0,0.5)",borderRadius:"50%",padding:16,color:"#fff",pointerEvents:"none"}}>🔒</div>
            </div>

            {/* Free sample CTA */}
            <h3 style={{fontSize:24,fontWeight:900,color:"#fff",margin:"30px 0 10px",textAlign:"center",letterSpacing:"-.01em"}}>See a Sample Report Before You Buy</h3>
            <p style={{fontSize:15,color:"rgba(255,255,255,.7)",lineHeight:1.6,textAlign:"center",marginBottom:18,maxWidth:400}}>Download a free sample to see the depth and detail of your personalized report.</p>
            <button onClick={handleSampleDownload} disabled={sampleBusy} style={{padding:"14px 30px",borderRadius:12,border:"2px solid #f97316",background:"transparent",color:"#f97316",fontSize:15,fontWeight:900,letterSpacing:".02em",cursor:sampleBusy?"wait":"pointer",fontFamily:"inherit",opacity:sampleBusy?.65:1}}>
              {sampleBusy ? "Generating Sample..." : "Download Free Sample"}
            </button>
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
            <div style={{display:"inline-flex",alignItems:"center",gap:14,position:"relative",zIndex:1,flexWrap:"wrap",justifyContent:"center"}}>
              <span style={{fontSize:22,color:"rgba(255,255,255,.5)",textDecoration:"line-through",fontWeight:600}}>$24.99</span>
              <span style={{fontSize:58,fontWeight:900,letterSpacing:"-.025em",background:"linear-gradient(135deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",lineHeight:1}}>$14.99</span>
              <span style={{display:"inline-flex",alignItems:"center",gap:5,background:"#f97316",color:"#fff",fontSize:12,fontWeight:800,padding:"5px 12px",borderRadius:999,boxShadow:"0 4px 14px rgba(249,115,22,.45)",letterSpacing:".02em",whiteSpace:"nowrap"}}>
                <span role="img" aria-label="Lightning">⚡</span> Instant Download
              </span>
            </div>
          </div>

          <div style={{marginTop:8,marginBottom:18}}>
            <button onClick={handleBuyReport} className="cta-pulse" style={{...primaryBtn(),padding:"20px 40px",fontSize:18}}>
              {isBusinessActive ? businessCtaLabel : "Yes, Get My Full Report for $14.99"}
            </button>
          </div>

          {/* Accepted payment methods. Stripe Checkout enables card +
              wallets (Apple Pay, Google Pay) via automatic_payment_methods;
              this row tells the buyer up front so they do not bounce. */}
          <PaymentMethodsRow/>

          <div style={{display:"flex",justifyContent:"center",alignItems:"center",gap:18,flexWrap:"wrap",marginBottom:18}}>
            {[
              {label:"Instant Download", emphasis:true},
              {label:"Secure Payment"},
              {label:"Personalized to Your Address"},
              {label:"Lifetime Access", emoji:"📁"},
            ].map(b => (
              <div key={b.label} style={{
                display:"inline-flex",
                alignItems:"center",
                gap:8,
                color: b.emphasis ? "#f97316" : "rgba(255,255,255,.75)",
                fontSize: b.emphasis ? 15 : 13,
                fontWeight: b.emphasis ? 800 : 700,
              }}>
                {b.emphasis ? (
                  <span role="img" aria-label="Lightning" style={{fontSize:16,lineHeight:1}}>⚡</span>
                ) : b.emoji ? (
                  <span role="img" aria-label="Folder" style={{fontSize:15,lineHeight:1}}>{b.emoji}</span>
                ) : (
                  <span style={{display:"inline-flex",width:22,height:22,borderRadius:"50%",background:"rgba(16,185,129,.18)",alignItems:"center",justifyContent:"center"}}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                  </span>
                )}
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

// ─── SHARED PDF BUILDER ──────────────────────────────────────────────────────
// Builds the full multi-page "Your Personalized HumZones Report" jsPDF
// document from an already-filtered list of facilities. Used by both the consumer
// /report-success flow and the business /business-generate flow so the two
// PDFs stay identical apart from the radius copy and the saved filename.
// Returns the jsPDF doc plus the rollup numbers the caller may want to
// persist (totalFound, counts, totalPower, totalWater, totalCO2).
async function buildAreaReportPdf({ searchAddress, facsNear, radiusKm = 100, facilities100km, highRisk }) {
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
    let mult = 750;
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

  const counts = { HIGH: 0, MODERATE: 0, LOW: 0 };
  let totalPower = 0, totalWater = 0, totalCO2 = 0;
  facsNear.forEach(f => {
    const tier = exposureTier(f.Risk_Level);
    if (tier === "HIGH") counts.HIGH++;
    else if (tier === "LOW") counts.LOW++;
    else counts.MODERATE++;
    const mw = resolvePower(f);
    totalPower += mw;
    totalWater += resolveWater(f, mw);
    totalCO2   += resolveCO2(f, mw);
  });

  const jsPDFModule = await import("jspdf");
  const { jsPDF } = jsPDFModule;
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const PW = doc.internal.pageSize.getWidth();
  const PH = doc.internal.pageSize.getHeight();
  const M  = 56;

  const today    = new Date();
  const datePart = today.toISOString().slice(0, 10);
  const dateLong = today.toLocaleDateString("en-US", { year:"numeric", month:"long", day:"numeric" });

  const fmtNum = (n) => Number(n).toLocaleString();
  const fmtMW  = (mw) => mw >= 1000 ? `${(mw/1000).toFixed(2).replace(/\.?0+$/,"")} GW` : `${fmtNum(mw)} MW`;
  const setText = (r,g,b) => doc.setTextColor(r,g,b);

  const totalFound = facsNear.length;
  const safeHigh   = Number.isFinite(highRisk) ? highRisk : counts.HIGH;
  const safeTotal  = Number.isFinite(facilities100km) ? facilities100km : totalFound;
  const radiusLbl  = `${radiusKm}km`;
  const facLabel   = `Facilities within ${radiusLbl}`;

  const drawTopBand = (rightLabel) => {
    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, PW, 32, "F");
    doc.setFillColor(249, 115, 22);
    doc.rect(0, 32, PW, 2, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    setText(255, 255, 255);
    doc.text("Your Personalized HumZones™ Report", M, 22);
    if (rightLabel) {
      doc.setFont("helvetica", "normal");
      setText(148, 163, 184);
      doc.text(rightLabel, PW - M, 22, { align: "right" });
    }
  };

  // ═══ PAGE 1: COVER
  doc.setFillColor(15, 23, 42); doc.rect(0, 0, PW, 6, "F");
  doc.setFillColor(249, 115, 22); doc.rect(0, 6, PW, 3, "F");

  doc.setFont("helvetica", "bold"); doc.setFontSize(16);
  setText(15, 23, 42); doc.text("HumZones", M, 48);

  let y = 178;
  // Cover title: 32pt bold, centered, with a superscript TM rendered smaller
  // and raised above the baseline.
  setText(15, 23, 42);
  doc.setFont("helvetica", "bold"); doc.setFontSize(32);
  const titleBefore = "Your Personalized HumZones";
  const titleAfter  = " Report";
  const wTitleBefore = doc.getTextWidth(titleBefore);
  const wTitleAfter  = doc.getTextWidth(titleAfter);
  doc.setFontSize(18);
  const wTitleTM = doc.getTextWidth("TM");
  let titleX = (PW - (wTitleBefore + wTitleTM + wTitleAfter)) / 2;
  doc.setFontSize(32); doc.text(titleBefore, titleX, y);
  doc.setFontSize(18); doc.text("TM", titleX + wTitleBefore, y - 10);
  doc.setFontSize(32); doc.text(titleAfter, titleX + wTitleBefore + wTitleTM, y);
  y += 30;
  doc.setFont("helvetica", "normal"); doc.setFontSize(12);
  setText(100, 116, 139);
  doc.text("Local infrastructure, environmental, and community impact insights for your area.", PW / 2, y, { align: "center" });

  y += 50;
  doc.setFillColor(241, 245, 249); doc.rect(M, y - 20, PW - M*2, 130, "F");
  doc.setFillColor(249, 115, 22); doc.rect(M, y - 20, 4, 130, "F");

  doc.setFont("helvetica", "bold"); doc.setFontSize(11);
  setText(100, 116, 139); doc.text("ADDRESS", M + 20, y);
  doc.setFont("helvetica", "bold"); doc.setFontSize(13);
  setText(15, 23, 42);
  const addrLines = doc.splitTextToSize(searchAddress, PW - M*2 - 40);
  doc.text(addrLines.slice(0, 2), M + 20, y + 20);

  doc.setFont("helvetica", "bold"); doc.setFontSize(11);
  setText(100, 116, 139); doc.text("GENERATED", M + 20, y + 60);
  doc.setFont("helvetica", "bold"); doc.setFontSize(13);
  setText(15, 23, 42); doc.text(dateLong, M + 20, y + 80);

  y += 150;
  doc.setFillColor(15, 23, 42); doc.rect(M, y, PW - M*2, 110, "F");
  doc.setFillColor(249, 115, 22); doc.rect(M, y, 4, 110, "F");

  doc.setFont("helvetica", "bold"); doc.setFontSize(10);
  setText(249, 115, 22);
  doc.text(`TOTAL FACILITIES WITHIN ${radiusLbl.toUpperCase()}`, M + 20, y + 28);
  doc.setFont("helvetica", "bold"); doc.setFontSize(32);
  setText(255, 255, 255); doc.text(String(safeTotal), M + 20, y + 70);

  doc.setFont("helvetica", "bold"); doc.setFontSize(10);
  setText(249, 115, 22); doc.text("HIGH EXPOSURE FACILITIES", M + 260, y + 28);
  doc.setFont("helvetica", "bold"); doc.setFontSize(32);
  setText(255, 255, 255); doc.text(String(safeHigh), M + 260, y + 70);

  doc.setFont("helvetica", "bold"); doc.setFontSize(11);
  setText(15, 23, 42);
  doc.text("Prepared by HumZones™", M, PH - 86);
  doc.setFont("helvetica", "normal"); doc.setFontSize(10);
  setText(100, 116, 139);
  doc.text("Global Data Center Health & Infrastructure Registry", M, PH - 68);
  doc.text("A service of HumZones Technologies Inc.", M, PH - 52);
  doc.text("humzones.com", M, PH - 36);

  // ═══ PAGE 2: EXECUTIVE SUMMARY
  doc.addPage();
  drawTopBand("Executive Summary");

  y = 80;
  doc.setFont("helvetica", "bold"); doc.setFontSize(22);
  setText(15, 23, 42); doc.text("Executive Summary", M, y);

  y += 36;
  const rows = [
    [`Total facilities within ${radiusLbl}`, String(totalFound)],
    ["HIGH exposure facilities",              String(counts.HIGH)],
    ["MODERATE exposure facilities",          String(counts.MODERATE)],
    ["LOW exposure facilities",               String(counts.LOW)],
    ["Combined estimated power draw",         fmtMW(totalPower)],
    ["Combined daily water consumption",      `${fmtNum(totalWater)} gallons`],
    ["Combined CO2 per year",                 `${fmtNum(totalCO2)} tons`],
  ];
  rows.forEach((r, idx) => {
    if (idx % 2 === 0) {
      doc.setFillColor(248, 250, 252);
      doc.rect(M, y - 14, PW - M*2, 28, "F");
    }
    doc.setFont("helvetica", "normal"); doc.setFontSize(12);
    setText(71, 85, 105); doc.text(r[0], M + 14, y + 4);
    doc.setFont("helvetica", "bold"); setText(15, 23, 42);
    doc.text(r[1], PW - M - 14, y + 4, { align: "right" });
    y += 28;
  });

  y += 18;
  const paragraph = `This report identifies ${totalFound} data center ${totalFound === 1 ? "facility" : "facilities"} operating within ${radiusLbl} of your address. Of these, ${counts.HIGH} ${counts.HIGH === 1 ? "is" : "are"} in the HIGH infrastructure exposure category based on power scale, proximity to residential areas and cooling type.`;
  doc.setFont("helvetica", "normal"); doc.setFontSize(11);
  setText(71, 85, 105);
  const pWrap = doc.splitTextToSize(paragraph, PW - M*2);
  doc.text(pWrap, M, y);

  // ═══ PAGE 3+: PER-FACILITY DETAIL
  if (facsNear.length > 0) {
    doc.addPage();
    drawTopBand(facLabel);

    y = 80;
    doc.setFont("helvetica", "bold"); doc.setFontSize(22);
    setText(15, 23, 42); doc.text("Facilities Near You", M, y);
    y += 22;
    doc.setFont("helvetica", "normal"); doc.setFontSize(11);
    setText(100, 116, 139);
    doc.text(`${facsNear.length} ${facsNear.length === 1 ? "facility" : "facilities"} sorted by distance, closest first.`, M, y);
    y += 24;

    const bottomLimit = PH - 64;
    const facBlockHeight = 190;

    facsNear.forEach((f) => {
      if (y + facBlockHeight > bottomLimit) {
        doc.addPage();
        drawTopBand(facLabel);
        y = 80;
      }

      doc.setFont("helvetica", "bold"); doc.setFontSize(15);
      setText(15, 23, 42);
      const nameLines = doc.splitTextToSize(f.Name || "Unnamed facility", PW - M*2);
      doc.text(nameLines[0], M, y);
      y += 18;

      if (f.Company) {
        doc.setFont("helvetica", "normal"); doc.setFontSize(11);
        setText(100, 116, 139); doc.text(String(f.Company), M, y);
        y += 16;
      }

      doc.setFont("helvetica", "bold"); doc.setFontSize(10);
      setText(15, 23, 42);
      doc.text(`Distance: ${Number(f._km).toFixed(1)} km from your address`, M, y);
      const tier = exposureTier(f.Risk_Level);
      const rc = tier === "HIGH"     ? [239, 68, 68]
               : tier === "MODERATE" ? [249, 115, 22]
               : tier === "LOW"      ? [34, 197, 94]
               : [100, 116, 139];
      setText(rc[0], rc[1], rc[2]);
      doc.text(`Exposure Category: ${tier}`, M + 270, y);
      y += 16;

      doc.setFont("helvetica", "normal"); doc.setFontSize(10);
      setText(71, 85, 105);
      const cityLine = [f.City, f.State_Region].filter(Boolean).join(", ");
      if (cityLine) { doc.text(cityLine, M, y); y += 14; }
      if (f.Address) {
        const aw = doc.splitTextToSize(String(f.Address), PW - M*2);
        const slice = aw.slice(0, 2);
        doc.text(slice, M, y);
        y += slice.length * 14;
      }
      y += 4;

      const mw    = resolvePower(f);
      const co2v  = resolveCO2(f, mw);
      const waterv= resolveWater(f, mw);
      const noisev= resolveNoise(f);
      const stats = [
        ["Reported power",       `${fmtNum(mw)} MW`],
        ["Estimated noise",      `${noisev} dB`],
        ["Estimated CO2",        `${fmtNum(co2v)} tons per year`],
        ["Estimated water draw", `${fmtNum(waterv)} gallons per day`],
        ["Modeled EMF at fence", f.EMF_Fence_High != null && f.EMF_Fence_High !== "" ? `${f.EMF_Fence_High} mG` : "n/a"],
        ["Modeled EMF at 100m",  f.EMF_100m       != null && f.EMF_100m       !== "" ? `${f.EMF_100m} mG`       : "n/a"],
        ["Cooling type",         f.Cooling || "n/a"],
        ["Opened",               f.Opened ? String(f.Opened) : "n/a"],
      ];
      const colW = (PW - M*2) / 2;
      stats.forEach((s, idx) => {
        const col = idx % 2;
        if (col === 0 && idx > 0) y += 16;
        const x = M + col * colW;
        doc.setFont("helvetica", "bold"); doc.setFontSize(10);
        setText(100, 116, 139);
        const labelTxt = `${s[0]}:`;
        doc.text(labelTxt, x, y);
        // Value is placed immediately after its own label so the longer
        // infrastructure labels never overlap the figure.
        const valX = x + doc.getTextWidth(labelTxt) + 8;
        doc.setFont("helvetica", "normal"); setText(15, 23, 42);
        const valLines = doc.splitTextToSize(String(s[1]), x + colW - valX - 8);
        doc.text(valLines[0], valX, y);
      });
      y += 22;

      doc.setDrawColor(226, 232, 240); doc.setLineWidth(0.6);
      doc.line(M, y, PW - M, y);
      y += 18;
    });
  }

  // ═══ UNDERSTANDING YOUR RESULTS (personalized)
  doc.addPage();
  drawTopBand("Understanding Your Results");

  y = 80;
  doc.setFont("helvetica", "bold"); doc.setFontSize(22);
  setText(15, 23, 42); doc.text("Understanding Your Results", M, y);
  y += 30;

  // Nearest facility and the facility in the highest exposure tier (ties
  // broken by distance) drive the personalized lines below.
  const tierRank = (t) => t === "HIGH" ? 0 : t === "MODERATE" ? 1 : t === "LOW" ? 2 : 3;
  const nearestFac = facsNear.length ? facsNear[0] : null;
  const topFac = facsNear.length
    ? [...facsNear].sort((a, b) =>
        tierRank(exposureTier(a.Risk_Level)) - tierRank(exposureTier(b.Risk_Level)) || a._km - b._km)[0]
    : null;

  const sectionHeading = (txt) => {
    if (y + 46 > PH - 80) { doc.addPage(); drawTopBand("Understanding Your Results"); y = 80; }
    doc.setFont("helvetica", "bold"); doc.setFontSize(15);
    setText(15, 23, 42); doc.text(txt, M, y);
    y += 20;
  };
  const bullet = (txt) => {
    if (y + 40 > PH - 80) { doc.addPage(); drawTopBand("Understanding Your Results"); y = 80; }
    doc.setFont("helvetica", "bold"); doc.setFontSize(11);
    setText(249, 115, 22); doc.text("-", M, y);
    doc.setFont("helvetica", "normal"); doc.setFontSize(11);
    setText(71, 85, 105);
    const lines = doc.splitTextToSize(txt, PW - M*2 - 16);
    doc.text(lines, M + 16, y);
    y += lines.length * 14 + 7;
  };

  // ── PART A: Your Area at a Glance
  sectionHeading("Your Area at a Glance");
  bullet(`Your search found ${totalFound} ${totalFound === 1 ? "facility" : "facilities"} within ${radiusLbl} of ${searchAddress}.`);
  if (nearestFac) {
    bullet(`The closest facility is ${nearestFac.Name || "an unnamed facility"} at ${nearestFac._km.toFixed(1)}km.`);
  }
  if (topFac) {
    bullet(`The highest exposure category facility near you is ${topFac.Name || "an unnamed facility"} at ${topFac._km.toFixed(1)}km drawing ${fmtNum(resolvePower(topFac))}MW of power.`);
  }
  bullet(`Combined estimated power draw of all facilities within ${radiusLbl}: ${fmtMW(totalPower)}.`);
  bullet(`Combined estimated daily water draw: ${fmtNum(totalWater)} gallons.`);
  bullet(`Combined estimated annual CO2 impact: ${fmtNum(totalCO2)} tons.`);
  y += 12;

  // ── PART B: Exposure by Distance
  sectionHeading("Exposure by Distance");
  [10, 25, 50, 100].forEach((km) => {
    const within = facsNear.filter((f) => f._km <= km);
    const h = within.filter((f) => exposureTier(f.Risk_Level) === "HIGH").length;
    const m = within.filter((f) => exposureTier(f.Risk_Level) === "MODERATE").length;
    const l = within.filter((f) => exposureTier(f.Risk_Level) === "LOW").length;
    bullet(`Within ${km}km: ${within.length} ${within.length === 1 ? "facility" : "facilities"} (${h} HIGH, ${m} MODERATE, ${l} LOW exposure).`);
  });
  y += 12;

  // ── PART C: What This Means
  sectionHeading("What This Means");

  const writePara = (txt) => {
    if (y + 70 > PH - 80) { doc.addPage(); drawTopBand("Understanding Your Results"); y = 80; }
    doc.setFont("helvetica", "normal"); doc.setFontSize(11);
    setText(71, 85, 105);
    const lines = doc.splitTextToSize(txt, PW - M*2);
    doc.text(lines, M, y);
    y += lines.length * 14 + 12;
  };

  const emfClosing = nearestFac
    ? ` The closest facility to your address is ${nearestFac.Name || "an unnamed facility"} at ${nearestFac._km.toFixed(1)}km.`
    : "";
  writePara("EMF exposure. Power-frequency electromagnetic fields from data center substations and feeder lines have been studied in relation to childhood leukemia by the WHO and IARC. Published research has identified elevated risk where homes are exposed to power-frequency fields above roughly 3 to 4 milligauss on a sustained basis. The EMF figures in this report show modeled values both at the facility fence and at 100 meters so you can see how exposure changes with distance." + emfClosing);
  writePara("Noise impact. Data centers operate around the clock and emit a continuous low-frequency hum from cooling systems and transformers. Low-frequency sound below 200 Hz penetrates walls and windows with far less attenuation than higher frequencies, which is why residents living within a few kilometers of large facilities consistently report sleep disruption, headaches and chronic background stress. Facilities operating within 5km of a residence typically produce continuous ambient noise.");
  writePara(`Water and CO2. Evaporative cooling at hyperscale facilities removes large volumes of fresh water from the local cycle every single day. Combined with the grid emissions associated with around-the-clock electricity demand, the regional environmental footprint of multiple nearby facilities compounds rapidly. The combined daily water draw of facilities within ${radiusLbl} of your address is estimated at ${fmtNum(totalWater)} gallons.`);

  // ── PART D: What You Can Do
  y += 4;
  if (y + 30 > PH - 80) { doc.addPage(); drawTopBand("Understanding Your Results"); y = 80; }
  doc.setFont("helvetica", "bold"); doc.setFontSize(16);
  setText(15, 23, 42); doc.text("What You Can Do", M, y);
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
    doc.setFont("helvetica", "bold"); doc.setFontSize(11);
    setText(249, 115, 22); doc.text(`${idx + 1}.`, M, y);
    doc.setFont("helvetica", "normal"); setText(71, 85, 105);
    const lines = doc.splitTextToSize(s, PW - M*2 - 20);
    doc.text(lines, M + 20, y);
    y += lines.length * 14 + 10;
  });

  y += 14;
  if (y + 40 > PH - 60) { doc.addPage(); drawTopBand("Understanding Your Results"); y = 80; }
  doc.setFont("helvetica", "bold"); doc.setFontSize(11);
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

  // ═══ SHARE YOUR EXPERIENCE
  doc.addPage();
  drawTopBand("Share Your Experience");

  y = 80;
  doc.setFont("helvetica", "bold"); doc.setFontSize(22);
  setText(15, 23, 42); doc.text("Share Your Experience", M, y);
  y += 28;

  const sharePara = (txt) => {
    if (y + 80 > PH - 80) { doc.addPage(); drawTopBand("Share Your Experience"); y = 80; }
    doc.setFont("helvetica", "normal"); doc.setFontSize(11);
    setText(71, 85, 105);
    const lines = doc.splitTextToSize(txt, PW - M*2);
    doc.text(lines, M, y);
    y += lines.length * 14 + 12;
  };

  sharePara("Do you live near one of the facilities in this report? Your experience matters. HumZones collects verified resident reports from people living near data centers. Your report helps other residents understand what life is really like near these facilities and adds to our growing community database.");

  if (y + 40 > PH - 80) { doc.addPage(); drawTopBand("Share Your Experience"); y = 80; }
  doc.setFont("helvetica", "bold"); doc.setFontSize(12);
  const submitPrefix = "Submit your resident report at: ";
  setText(15, 23, 42); doc.text(submitPrefix, M, y);
  setText(249, 115, 22);
  doc.textWithLink("humzones.com/submit-report", M + doc.getTextWidth(submitPrefix), y, { url: "https://humzones.com/submit-report" });
  setText(71, 85, 105);
  y += 22;

  sharePara("Visit humzones.com/submit-report to share your experience. Reports are reviewed and published with your permission only. Your personal information is never shared.");
  sharePara("Together we can build the most comprehensive community health database for data center proximity in the world.");

  if (y + 30 > PH - 80) { doc.addPage(); drawTopBand("Share Your Experience"); y = 80; }
  doc.setFont("helvetica", "bold"); doc.setFontSize(11);
  const methSharePrefix = "Read the full methodology at ";
  setText(15, 23, 42); doc.text(methSharePrefix, M, y);
  setText(249, 115, 22);
  doc.textWithLink("humzones.com/methodology", M + doc.getTextWidth(methSharePrefix), y, { url: "https://humzones.com/methodology" });
  setText(71, 85, 105);

  // ═══ LEGAL DISCLAIMER
  doc.addPage();
  drawTopBand("Important Disclaimer");

  y = 80;
  doc.setFont("helvetica", "bold"); doc.setFontSize(22);
  setText(15, 23, 42); doc.text("Important Disclaimer", M, y);
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
    doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    setText(71, 85, 105);
    const lines = doc.splitTextToSize(p, PW - M*2);
    doc.text(lines, M, y);
    y += lines.length * 13 + 10;
  });

  y += 6;
  if (y + 80 > PH - 60) { doc.addPage(); drawTopBand("Important Disclaimer"); y = 80; }
  doc.setFont("helvetica", "bold"); doc.setFontSize(11);
  const discPrefix = "For full methodology and data sources visit ";
  setText(15, 23, 42); doc.text(discPrefix, M, y);
  setText(249, 115, 22);
  doc.textWithLink("humzones.com/methodology", M + doc.getTextWidth(discPrefix), y, { url: "https://humzones.com/methodology" });
  setText(15, 23, 42);
  y += 22;
  doc.setFont("helvetica", "normal"); doc.setFontSize(10);
  setText(100, 116, 139);
  doc.text("Report generated by HumZones Technologies Inc.", M, y); y += 14;
  doc.text("Global Data Center Health & Infrastructure Registry", M, y); y += 14;
  doc.text("humzones.com",                                     M, y); y += 14;
  doc.text(dateLong,                                           M, y);

  return { doc, datePart, dateLong, totalFound, counts, totalPower, totalWater, totalCO2 };
}

// Slugify an address for the PDF filename so the saved file is human-readable
// across operating systems.
function pdfFilenameSafe(address) {
  return (address || "report")
    .replace(/[\s,]+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "report";
}

// ─── SAMPLE REPORT PDF ───────────────────────────────────────────────────────
// Builds a downloadable sample report. Every page carries a diagonal light-grey
// SAMPLE watermark and all facilities and figures are placeholder data, so it
// can never be confused with a paid area report. Callers pass an opts object to
// control the cover, executive summary and sample facilities; the defaults
// produce the generic sample used on the /business page. Returns the jsPDF doc.
async function buildSampleReportPdf(opts = {}) {
  const {
    subtitle = "A demonstration of the infrastructure intelligence included in every HumZones professional report. All facilities and figures shown are placeholder sample data.",
    address = "Sample Address, Sample City, Sample Region",
    summaryRows = [
      ["Total facilities within 100km", "12"],
      ["HIGH exposure category facilities", "3"],
      ["MODERATE exposure category facilities", "5"],
      ["LOW exposure category facilities", "4"],
      ["Combined estimated power draw", "612 MW"],
      ["Combined estimated daily water draw", "2,140,000 gallons"],
      ["Combined estimated annual CO2 impact", "1,180,000 tons"],
    ],
    summaryParagraph = "This sample report identifies 12 placeholder data center facilities within 100km of a sample address. Of these, 3 are in the HIGH infrastructure exposure category, 5 are MODERATE and 4 are LOW, based on power scale, proximity to residential areas and cooling type. A full HumZones report lists every facility near a real searched address with the same depth of detail shown on the following pages.",
    facilities = [
      { name:"SAMPLE Data Center Alpha", company:"Sample Operator LLC", city:"Sample City, Sample Region", dist:"2.4 km", cat:"HIGH", power:"95 MW", noise:"68 dB", emfFence:"6 mG", emf100:"3 mG", co2:"310,000 tons per year", water:"680,000 gallons per day", cooling:"Evaporative", opened:"2022" },
      { name:"SAMPLE Data Center Beta", company:"Example Infrastructure Group", city:"Sample Town, Sample Region", dist:"11.8 km", cat:"MODERATE", power:"38 MW", noise:"64 dB", emfFence:"3 mG", emf100:"1 mG", co2:"120,000 tons per year", water:"210,000 gallons per day", cooling:"Chilled water", opened:"2020" },
      { name:"SAMPLE Data Center Gamma", company:"Placeholder Hosting Inc.", city:"Sample Village, Sample Region", dist:"46.2 km", cat:"LOW", power:"12 MW", noise:"60 dB", emfFence:"1 mG", emf100:"below 1 mG", co2:"Near zero", water:"Minimal", cooling:"Air-cooled", opened:"2019" },
    ],
  } = opts;

  const jsPDFModule = await import("jspdf");
  const { jsPDF } = jsPDFModule;
  const doc = new jsPDF({ unit: "pt", format: "letter" });
  const PW = doc.internal.pageSize.getWidth();
  const PH = doc.internal.pageSize.getHeight();
  const M  = 56;
  const setText = (r,g,b) => doc.setTextColor(r,g,b);
  const dateLong = new Date().toLocaleDateString("en-US", { year:"numeric", month:"long", day:"numeric" });

  // Light grey diagonal SAMPLE watermark. Drawn before page content so it
  // sits behind the text and stays legible underneath.
  const stampSample = () => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(80);
    doc.setTextColor(226, 232, 240);
    doc.text("SAMPLE", PW / 2, PH / 2 + 40, { align: "center", angle: 30 });
    setText(15, 23, 42);
  };

  const drawTopBand = (rightLabel) => {
    doc.setFillColor(15, 23, 42);
    doc.rect(0, 0, PW, 32, "F");
    doc.setFillColor(249, 115, 22);
    doc.rect(0, 32, PW, 2, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    setText(255, 255, 255);
    doc.text("HumZones Sample Report", M, 22);
    doc.setFont("helvetica", "normal");
    setText(148, 163, 184);
    doc.text(rightLabel, PW - M, 22, { align: "right" });
    setText(15, 23, 42);
  };

  const catColor = (cat) => cat === "HIGH" ? [239,68,68] : cat === "MODERATE" ? [249,115,22] : [34,197,94];

  // ═══ PAGE 1: COVER
  stampSample();
  doc.setFillColor(15, 23, 42); doc.rect(0, 0, PW, 6, "F");
  doc.setFillColor(249, 115, 22); doc.rect(0, 6, PW, 3, "F");

  doc.setFont("helvetica", "bold"); doc.setFontSize(16);
  setText(15, 23, 42); doc.text("HumZones", M, 48);

  let y = 200;
  doc.setFont("helvetica", "bold"); doc.setFontSize(26);
  setText(15, 23, 42); doc.text("HumZones Sample Report", M, y);
  y += 30;
  doc.setFont("helvetica", "normal"); doc.setFontSize(12);
  setText(100, 116, 139);
  doc.text(doc.splitTextToSize(subtitle, PW - M*2), M, y);

  y += 74;
  doc.setFillColor(241, 245, 249); doc.rect(M, y - 22, PW - M*2, 82, "F");
  doc.setFillColor(249, 115, 22); doc.rect(M, y - 22, 4, 82, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(11);
  setText(100, 116, 139); doc.text("SAMPLE LOCATION", M + 20, y);
  doc.setFont("helvetica", "bold"); doc.setFontSize(13);
  setText(15, 23, 42); doc.text(address, M + 20, y + 22);
  doc.setFont("helvetica", "normal"); doc.setFontSize(11);
  setText(100, 116, 139); doc.text("This is not a real address. No real location data is shown.", M + 20, y + 44);

  doc.setFont("helvetica", "bold"); doc.setFontSize(11);
  setText(15, 23, 42); doc.text("Prepared by HumZones", M, PH - 86);
  doc.setFont("helvetica", "normal"); doc.setFontSize(10);
  setText(100, 116, 139);
  doc.text("Global Data Center Health & Infrastructure Registry", M, PH - 68);
  doc.text("A service of HumZones Technologies Inc.", M, PH - 52);
  doc.text("humzones.com", M, PH - 36);

  // ═══ PAGE 2: EXECUTIVE SUMMARY
  doc.addPage(); stampSample(); drawTopBand("Executive Summary");
  y = 80;
  doc.setFont("helvetica", "bold"); doc.setFontSize(22);
  setText(15, 23, 42); doc.text("Executive Summary", M, y);
  y += 36;
  summaryRows.forEach((r, idx) => {
    if (idx % 2 === 0) { doc.setFillColor(248,250,252); doc.rect(M, y-14, PW-M*2, 28, "F"); }
    doc.setFont("helvetica", "normal"); doc.setFontSize(12);
    setText(71,85,105); doc.text(r[0], M+14, y+4);
    doc.setFont("helvetica", "bold"); setText(15,23,42);
    doc.text(r[1], PW-M-14, y+4, { align:"right" });
    y += 28;
  });
  y += 22;
  doc.setFont("helvetica", "normal"); doc.setFontSize(11);
  setText(71,85,105);
  doc.text(doc.splitTextToSize(summaryParagraph, PW - M*2), M, y);

  // ═══ SAMPLE FACILITY PAGES
  facilities.forEach((f, i) => {
    doc.addPage(); stampSample(); drawTopBand(`Sample Facility ${i+1} of ${facilities.length}`);
    y = 80;
    doc.setFont("helvetica", "bold"); doc.setFontSize(20);
    setText(15,23,42); doc.text(f.name, M, y);
    y += 22;
    doc.setFont("helvetica", "normal"); doc.setFontSize(11);
    setText(100,116,139);
    if (f.company) { doc.text(f.company, M, y); y += 16; }
    doc.text(f.city, M, y);
    y += 26;
    doc.setFont("helvetica", "bold"); doc.setFontSize(11);
    setText(15,23,42); doc.text(`Distance: ${f.dist} from sample address`, M, y);
    const cc = catColor(f.cat);
    setText(cc[0],cc[1],cc[2]);
    doc.text(`Exposure Category: ${f.cat}`, M + 300, y);
    setText(15,23,42);
    y += 28;
    const facStats = [
      ["Reported power",       f.power],
      ["Estimated noise",      f.noise],
      ["Estimated CO2",        f.co2],
      ["Estimated water draw", f.water],
      ["Modeled EMF at fence", f.emfFence],
      ["Modeled EMF at 100m",  f.emf100],
    ];
    if (f.cooling) facStats.push(["Cooling type", f.cooling]);
    if (f.opened)  facStats.push(["Opened", f.opened]);
    const colW = (PW - M*2) / 2;
    facStats.forEach((s, idx) => {
      const col = idx % 2;
      if (col === 0 && idx > 0) y += 26;
      const x = M + col * colW;
      doc.setFont("helvetica", "bold"); doc.setFontSize(10);
      setText(100,116,139); doc.text(`${s[0]}:`, x, y);
      doc.setFont("helvetica", "normal"); doc.setFontSize(10); setText(15,23,42);
      doc.text(String(s[1]), x + 124, y);
    });
    y += 40;
    doc.setDrawColor(226,232,240); doc.setLineWidth(0.6);
    doc.line(M, y, PW-M, y);
    y += 20;
    doc.setFont("helvetica", "italic"); doc.setFontSize(10);
    setText(148,163,184);
    doc.text(doc.splitTextToSize("Sample data shown for demonstration only. These figures are illustrative placeholder values and do not describe any real facility or location.", PW - M*2), M, y);
  });

  // ═══ INFRASTRUCTURE AND COMMUNITY IMPACT CONSIDERATIONS
  doc.addPage(); stampSample(); drawTopBand("Impact Considerations");
  y = 80;
  doc.setFont("helvetica", "bold"); doc.setFontSize(20);
  setText(15,23,42);
  const considTitle = doc.splitTextToSize("Infrastructure and Community Impact Considerations", PW - M*2);
  doc.text(considTitle, M, y);
  y += considTitle.length * 24 + 16;
  const considerations = [
    "Modeled EMF exposure ranges. Power-frequency electromagnetic fields are associated with the substations and feeder lines that large data centers require. HumZones reports show modeled EMF ranges at the facility fence line and at 100 meters so you can see how modeled exposure changes with distance from the site.",
    "Estimated noise levels. Data centers operate around the clock and produce a continuous low-frequency hum from cooling systems and transformers. Low-frequency sound carries further and penetrates buildings more readily than higher frequencies, which is why noise is a common subject of community feedback near large facilities.",
    "Water and CO2 footprint. Evaporative cooling at large facilities draws significant volumes of water from the local supply each day, and around-the-clock electricity demand carries an associated grid emissions footprint. HumZones reports sum the modeled draw across every facility near a searched address.",
    "Community and development context. Infrastructure-dense areas can see ongoing utility expansion, construction activity and zoning review. The HumZones report gives professionals a clear, location-based view of that context for relocation, valuation, research and consultation work.",
  ];
  considerations.forEach(txt => {
    if (y + 80 > PH - 80) { doc.addPage(); stampSample(); drawTopBand("Impact Considerations"); y = 80; }
    doc.setFont("helvetica", "normal"); doc.setFontSize(11);
    setText(71,85,105);
    const lines = doc.splitTextToSize(txt, PW - M*2);
    doc.text(lines, M, y);
    y += lines.length * 14 + 14;
  });

  // ═══ DISCLAIMER
  doc.addPage(); stampSample(); drawTopBand("Important Disclaimer");
  y = 80;
  doc.setFont("helvetica", "bold"); doc.setFontSize(22);
  setText(15,23,42); doc.text("Important Disclaimer", M, y);
  y += 30;
  const sampleDisclaimer = [
    "This HumZones Sample Report is provided to demonstrate the format and content of a HumZones professional report. Every facility, address, figure and category shown in this document is placeholder sample data and does not describe any real location.",
    "All figures in a full HumZones report, including power, noise, modeled EMF ranges, CO2 and water usage, are modeled estimates compiled from public sources such as planning filings, utility records, environmental assessments, operator disclosures and permitting databases. They are not certified field measurements.",
    "Infrastructure exposure categories are relative indicators for general awareness only. They do not constitute a scientific, environmental or health determination of any kind.",
    "HumZones reports are informational resources only and do not constitute medical, legal, scientific or environmental advice. HumZones Technologies Inc. makes no warranties regarding the accuracy or completeness of the information in a report and shall not be liable for any decisions made in reliance on it.",
  ];
  sampleDisclaimer.forEach(p => {
    if (y + 80 > PH - 80) { doc.addPage(); stampSample(); drawTopBand("Important Disclaimer"); y = 80; }
    doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    setText(71,85,105);
    const lines = doc.splitTextToSize(p, PW - M*2);
    doc.text(lines, M, y);
    y += lines.length * 13 + 12;
  });
  y += 8;
  doc.setFont("helvetica", "normal"); doc.setFontSize(10);
  setText(100,116,139);
  doc.text("Generated by HumZones Technologies Inc.", M, y); y += 14;
  doc.text("humzones.com", M, y); y += 14;
  doc.text(dateLong, M, y);

  return { doc };
}

// ─── REPORT SUCCESS (post-payment PDF generation) ─────────────────────────────
// Reached after Stripe checkout success. Reads the captured search context out
// of localStorage, refetches the buyer email from the Stripe session, pulls
// every facility from Airtable, keeps those within 100km of the searched
// coordinates, generates a multi-page PDF with jsPDF, triggers download, and
// silently records the purchase in the Emails capture table.
const ReportSuccessPage = ({ onBack, onNavigate }) => {
  // status: loading -> need_email -> generating -> ready / error
  const [status, setStatus] = useState("loading");
  const [stepMsg, setStepMsg] = useState("Fetching your facility data...");
  const [progress, setProgress] = useState(10);
  const [errMsg, setErrMsg] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [emailErr, setEmailErr] = useState("");

  // Guard against React 18 StrictMode double-invocation: setup runs once.
  const startedRef = useRef(false);
  // Resolved report context, populated once by the setup effect and read by
  // generate() whether it runs automatically or after the buyer confirms.
  const ctxRef = useRef(null);
  // Guards generate() so a re-render or double click cannot produce two PDFs.
  const generatedRef = useRef(false);

  const goHome = () => {
    if (onNavigate) onNavigate("/");
    else if (onBack) onBack();
  };

  // Saves the buyer to the Airtable Emails table, then builds and downloads
  // the PDF, then sends the purchase confirmation email. The email is saved
  // BEFORE the PDF is generated, per the report capture flow.
  const generate = async (email) => {
    if (generatedRef.current) return;
    generatedRef.current = true;
    const ctx = ctxRef.current;
    if (!ctx) {
      setErrMsg("We lost your report details. Please refresh this page.");
      setStatus("error");
      return;
    }
    const { searchAddress, searchLat, searchLng, facilities100, highRisk, facsNear } = ctx;
    try {
      setStatus("generating");
      setStepMsg("Saving your report details...");
      setProgress(48);

      const facCount  = facsNear.length;
      const highCount = facsNear.filter(f => exposureTier(f.Risk_Level) === "HIGH").length;
      const datePart  = new Date().toISOString().slice(0, 10);

      // ─── Save the buyer to the Airtable Emails table (before the PDF) ─────
      try {
        const captureFields = {
          [EMAIL_FIELD.Email]:            email,
          [EMAIL_FIELD.Source]:           "PaidReport",
          [EMAIL_FIELD.Address]:          searchAddress,
          [EMAIL_FIELD.Radius_KM]:        100,
          [EMAIL_FIELD.Facilities_Count]: facCount,
          [EMAIL_FIELD.High_Risk_Count]:  highCount,
          [EMAIL_FIELD.Date]:             datePart,
        };
        if (Number.isFinite(searchLat)) captureFields[EMAIL_FIELD.Latitude]  = searchLat;
        if (Number.isFinite(searchLng)) captureFields[EMAIL_FIELD.Longitude] = searchLng;
        const capRes = await fetch(`${APIURL}/${EMAILS_TABLE}`, {
          method: "POST",
          headers: HDR,
          body: JSON.stringify({ fields: captureFields }),
        });
        if (!capRes.ok) console.warn("[HumZones] Emails capture responded", capRes.status);
      } catch (e) { console.warn("[HumZones] Emails capture failed:", e); }

      // ─── Generate the PDF via the shared builder ─────────────────────────
      setStepMsg("Generating your personalized report...");
      setProgress(75);
      const { doc, datePart: dp } = await buildAreaReportPdf({
        searchAddress,
        facsNear,
        radiusKm: 100,
        facilities100km: facilities100,
        highRisk,
      });

      // ─── Trigger the download ────────────────────────────────────────────
      setStepMsg("Downloading your report...");
      setProgress(95);
      doc.save(`HumZones-Report-${pdfFilenameSafe(searchAddress)}-${dp || datePart}.pdf`);

      // ─── Send the purchase confirmation email (non-blocking) ─────────────
      fetch("/api/send-purchase-confirmation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, address: searchAddress }),
      }).catch(e => console.warn("[HumZones] purchase confirmation email failed:", e));

      setProgress(100);
      setStepMsg("Done.");
      setStatus("ready");
    } catch (e) {
      console.error("[HumZones] Report generation failed:", e);
      generatedRef.current = false;
      setErrMsg(e.message || "We hit a snag generating your PDF. Please refresh this page or contact support and we will deliver it manually.");
      setStatus("error");
    }
  };

  const confirmEmail = () => {
    const email = emailInput.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setEmailErr("Please enter a valid email address.");
      return;
    }
    setEmailErr("");
    generate(email);
  };

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const run = async () => {
      try {
        // ─── 1. Pull search context (localStorage with URL-param fallback) ──
        const params = new URLSearchParams(window.location.search);
        const searchAddress = localStorage.getItem("searchAddress")        || params.get("address") || "Your area";
        const searchLat     = parseFloat(localStorage.getItem("searchLat") || params.get("lat"));
        const searchLng     = parseFloat(localStorage.getItem("searchLng") || params.get("lng"));
        const facilities100 = parseInt(localStorage.getItem("facilities100km") || params.get("r100"), 10);
        const highRisk      = parseInt(localStorage.getItem("highRiskCount")   || params.get("high"), 10);

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
        } catch (e) {
          console.error("[HumZones] Airtable fetch failed:", e);
          throw new Error("Could not load facility data. Please refresh to try again.");
        }
        if (!allFacs.length) {
          throw new Error("Facility database returned no records. Please contact support.");
        }

        // ─── 3. Haversine filter to <=100km, sorted nearest first ───────────
        setStepMsg("Calculating distances...");
        setProgress(38);
        const hasCoords = Number.isFinite(searchLat) && Number.isFinite(searchLng);
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

        ctxRef.current = { searchAddress, searchLat, searchLng, facilities100, highRisk, facsNear };

        // ─── 4. Resolve the buyer email ─────────────────────────────────────
        // Stripe Payment Links collect the buyer email at checkout. When the
        // success URL is configured to pass it back we use it directly;
        // otherwise we ask the buyer to confirm it before generating the PDF.
        const urlEmail = (params.get("email") || params.get("customer_email") || "").trim();
        if (urlEmail && /^\S+@\S+\.\S+$/.test(urlEmail)) {
          generate(urlEmail);
        } else {
          setStatus("need_email");
        }
      } catch (e) {
        console.error("[HumZones] Report setup failed:", e);
        setErrMsg(e.message || "We hit a snag. Please refresh this page or contact support.");
        setStatus("error");
      }
    };

    run();
  }, []);

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

        {status === "need_email" && (
          <>
            <div style={{width:84,height:84,borderRadius:"50%",background:"linear-gradient(135deg,#10b981,#059669)",margin:"24px auto 22px",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 18px 50px rgba(16,185,129,.4)"}}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <h1 style={{fontSize:30,fontWeight:900,letterSpacing:"-.01em",marginBottom:10,color:"#fff"}}>Payment Confirmed!</h1>
            <p style={{fontSize:16,color:"rgba(255,255,255,.78)",lineHeight:1.6,marginBottom:24,maxWidth:480,marginLeft:"auto",marginRight:"auto"}}>
              Please confirm your email address to save your report for future access.
            </p>
            <div style={{maxWidth:440,margin:"0 auto",background:"rgba(255,255,255,.06)",border:"1px solid rgba(255,255,255,.12)",borderRadius:16,padding:"26px 24px",textAlign:"left"}}>
              <label style={{fontSize:12,fontWeight:800,letterSpacing:".08em",textTransform:"uppercase",color:"rgba(255,255,255,.6)",display:"block",marginBottom:8}}>Email Address</label>
              <input
                className="email-gate-input"
                value={emailInput}
                onChange={e=>{ setEmailInput(e.target.value); if (emailErr) setEmailErr(""); }}
                onKeyDown={e=>{ if (e.key === "Enter") confirmEmail(); }}
                type="email"
                placeholder="you@example.com"
                style={{width:"100%",padding:"14px 16px",borderRadius:12,border:`1.5px solid ${emailErr?"rgba(239,68,68,.7)":"rgba(255,255,255,.18)"}`,background:"rgba(255,255,255,.08)",color:"#fff",fontSize:16,outline:"none",fontFamily:"inherit",boxSizing:"border-box"}}
              />
              {emailErr && <div style={{fontSize:13,color:"#fca5a5",marginTop:8}}>{emailErr}</div>}
              <button onClick={confirmEmail} style={{width:"100%",marginTop:16,padding:"15px 24px",borderRadius:12,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:16,fontWeight:900,letterSpacing:".02em",cursor:"pointer",fontFamily:"inherit",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>
                Confirm and Generate My Report
              </button>
              <div style={{fontSize:12,color:"rgba(255,255,255,.5)",marginTop:12,lineHeight:1.6}}>
                This allows you to retrieve your report anytime at humzones.com/my-report
              </div>
            </div>
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

// ─── VERIFY REPORT (email-link landing) ───────────────────────────────────────
// Reached from the verification email sent by api/send-verification. Parses
// the report payload off the URL, writes it to Airtable Reports with
// Verified=1 / Approved=0, and shows a success card with a Back to HumZones
// button. Idempotent against React 18 StrictMode via the startedRef guard.
const VerifyReportPage = ({ onNavigate }) => {
  const [status, setStatus] = useState("verifying"); // verifying | done | error
  const [errMsg, setErrMsg] = useState("");
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const run = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const token        = params.get("token")     || "";
        const email        = params.get("email")     || "";
        const firstName    = (params.get("firstName") || "").trim();
        const lastName     = (params.get("lastName")  || "").trim();
        const facilityName = params.get("facility")  || "";
        const reportText   = params.get("report")    || "";
        const cityParam    = params.get("city")      || "";
        const countryParam = params.get("country")   || "";
        const symptoms     = params.get("symptoms")  || "";
        const duration     = params.get("duration")  || "";

        console.log("[HumZones] /verify-report params:", {
          token, email, firstName, lastName, facilityName,
          reportText, city: cityParam, country: countryParam,
          symptoms, duration,
        });

        if (!token || !email || !reportText) {
          throw new Error("This verification link is incomplete or has expired. Please resubmit your report.");
        }

        // Reporter is the Airtable display column and is shown publicly,
        // so it gets the first name only. Last name is stored privately in
        // its own field and never displayed. Facility name now has its
        // own dedicated text field, separate from the linked-record
        // Facility column.
        const reporterFirst = firstName || "Anonymous";
        const todayDate = new Date().toISOString().slice(0, 10);
        const fields = {
          fldIvUyYCPw150VXi: reporterFirst,
          fldX8UhImeFqEDL3b: lastName,
          fldLNQyeYF4DyNzkw: facilityName,
          fldvFopZGRsuuhQyc: reportText,
          fldmqFjSvXE3dPMhx: todayDate,
          fldseZCyavu7yQy6a: false,
          fldbC786WMhXAXwRw: cityParam,
          fldCLoVFsFMnp0OSZ: countryParam,
          fld8So0zk95HZ4IpR: email,
          fldtMdp3kL6trwVlm: symptoms,
          fldZHDl5rMXOTduyo: duration,
          fldBBHPerVbEJqWQz: false,
        };

        const r = await fetch(`${APIURL}/tblBBaQ4NFCdaS6Tk?returnFieldsByFieldId=true`, {
          method: "POST",
          headers: HDR,
          body: JSON.stringify({ fields }),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          console.error("Airtable verify-report write failed:", err);
          throw new Error("We could not save your report. Please contact support and we will publish it manually.");
        }

        setStatus("done");
      } catch (e) {
        console.error("[HumZones] /verify-report failed:", e);
        setErrMsg(e.message || "Something went wrong verifying your report.");
        setStatus("error");
      }
    };
    run();
  }, []);

  const goHome = () => onNavigate("/");

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",width:"100%",maxWidth:"100vw",overflowX:"hidden",color:"#fff"}}>
      <div style={{padding:"22px 24px",display:"flex",alignItems:"center",justifyContent:"center"}}>
        <div>
          <span style={{fontSize:22,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
          <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2}}>TM</sup>
        </div>
      </div>

      <main style={{maxWidth:640,margin:"0 auto",padding:"24px 24px 80px",textAlign:"center"}}>
        {status === "verifying" && (
          <>
            <div className="slow-pulse" style={{width:84,height:84,borderRadius:"50%",background:"linear-gradient(135deg,#10b981,#059669)",margin:"24px auto 22px",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 18px 50px rgba(16,185,129,.4)"}}>
              <div className="spinning" style={{width:36,height:36,border:"3px solid rgba(255,255,255,.35)",borderTop:"3px solid #fff",borderRadius:"50%"}}/>
            </div>
            <h1 style={{fontSize:28,fontWeight:900,marginBottom:10,color:"#fff"}}>Verifying your report...</h1>
            <p style={{fontSize:15,color:"rgba(255,255,255,.7)"}}>Saving your verified report to the HumZones registry.</p>
          </>
        )}

        {status === "done" && (
          <>
            <div style={{width:84,height:84,borderRadius:"50%",background:"linear-gradient(135deg,#10b981,#059669)",margin:"24px auto 22px",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 18px 50px rgba(16,185,129,.4)"}}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <h1 style={{fontSize:28,fontWeight:900,marginBottom:14,color:"#fff",letterSpacing:"-.01em"}}>Report Verified</h1>
            <p style={{fontSize:16,color:"rgba(255,255,255,.78)",lineHeight:1.65,marginBottom:28,maxWidth:520,marginLeft:"auto",marginRight:"auto"}}>
              Your report has been verified and submitted for review. Thank you for helping your community. We will review and publish your report shortly.
            </p>
            <button onClick={goHome} className="cta-pulse" style={{padding:"16px 30px",borderRadius:14,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:16,fontWeight:900,letterSpacing:".02em",cursor:"pointer",fontFamily:"inherit",boxShadow:"0 10px 32px rgba(239,68,68,.45)"}}>
              Back to HumZones
            </button>
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
            <h1 style={{fontSize:26,fontWeight:900,marginBottom:12,color:"#fff"}}>Verification Failed</h1>
            <p style={{fontSize:15,color:"rgba(255,255,255,.78)",lineHeight:1.65,marginBottom:24,maxWidth:520,marginLeft:"auto",marginRight:"auto"}}>{errMsg}</p>
            <button onClick={goHome} style={{padding:"16px 30px",borderRadius:14,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:16,fontWeight:900,letterSpacing:".02em",cursor:"pointer",fontFamily:"inherit"}}>
              Back to HumZones
            </button>
          </>
        )}
      </main>
    </div>
  );
};

// ─── BUSINESS SUBSCRIPTIONS ──────────────────────────────────────────────────
// Self-serve B2B flow: Stripe Payment Links -> /business-success collects
// account details -> magic-link email -> /business-login sets a localStorage
// session -> /business-dashboard shows credits and lets the user run reports
// without going back through Stripe.

const BUSINESS_TABLE = "tblHcjycUMDiz6iur";
const BIZ_FIELD = {
  Email:              "fldxOkzq4F6IbKkHH",
  First_Name:         "fldHTSwebBvMcTRr3",
  Last_Name:          "fldtAkjE0Wonu6zuF",
  Company:            "fldNZhwTFpaHcBSJt",
  Plan:               "fldjt5Ti94M1RTZQN",
  Credits_Remaining:  "fld8aey7U37nCHAoR",
  Credits_Monthly:    "fldfQCiHwuKQdOKkY",
  Subscription_ID:    "fldMWdZzuips9yphK",
  Status:             "fldU2MWb01DTMONhQ",
  Renewal_Date:       "fldHKXCTypDhQglSt",
  Date_Joined:        "fldxzk788bSwUWYVt",
  Reports_Generated:  "fldHnMniIko6IwuM9",
  Login_Token:        "fldWIBRNN4MFc30B3",
  Token_Expiry:       "fldlRsSLLbrURuVb1",
  Recovery_PIN:       "fldNCDrm8FTAde1yI",
  Security_Question:  "fld70Jq3GDJEC52W9",
  Security_Answer:    "fldNpLubvAo6qbh45",
  Unsubscribed:       "flddY1vzy1wtjIJVa",
};

// Security questions offered at business signup. The chosen question is
// stored verbatim; the answer is hashed (lowercased + trimmed first).
const SECURITY_QUESTIONS = [
  "What was the name of your first pet?",
  "What street did you grow up on?",
  "What is your mother's maiden name?",
  "What was the name of your first school?",
  "What city were you born in?",
  "What was your childhood nickname?",
  "What is the name of your favorite sports team?",
  "What was the make of your first car?",
];

const BUSINESS_REPORTS_TABLE = "tblFPqxXwxgcuTZhM";
const BIZ_REP_FIELD = {
  Email:            "fldubch2UB05WMTdB",
  Address:          "fldctFXYPbHd6W7Rs",
  Date_Generated:   "fldJkngB5XzHQzvYu",
  Facilities_Count: "fldePGi2V2mtTsqa3",
  High_Risk_Count:  "fldTUqaPihiOgPQ6j",
  Radius_KM:        "fldbccTgbfknNuZT4",
  Latitude:         "flddEQRzWCWwOwQL3",
  Longitude:        "fld8CNu73mNipqVTw",
  Plan:             "fldAfYZVkvTFiBeDw",
  Report_Name:      "fldXeqbdbf3d9hRvq",
};

// Emails capture table (paid report purchases, Near Me email gate, report
// retrieval verification codes). Verified table + field IDs.
const EMAILS_TABLE = "tblHieqgtZdaXZOdw";
const EMAIL_FIELD = {
  Email:              "fldtB7M0LNazwrftI",
  Address:            "fldQEK7KRegxfB1FB",
  Latitude:           "fld8qKY7QEOBLLZVp",
  Longitude:          "fldNtZU5TopmzwLMC",
  Radius_KM:          "fld9WMfUZUrtKyrwB",
  Facilities_Count:   "fldbpQ4byugzV6Ou7",
  Facilities_100km:   "fld3Sz7UrKuCulytD",
  High_Risk_Count:    "fldiG6Ur4LOZ4Rkg1",
  Source:             "fldUcANdD7WdoryMy",
  Date:               "fldAf1RsT5jFoZIpQ",
  Verify_Code:        "fldH2zdk7hrUfPVQB",
  Verify_Code_Expiry: "fldxuKZR2ydvMipMZ",
  Unsubscribed:       "fld90TmavlEPCyk4U",
};

const PLAN_INFO = {
  starter:                { label:"Starter",      credits:10,     pricePer:"$9.90" },
  "starter-annual":       { label:"Starter Annual",      credits:10,     pricePer:"$9.90" },
  professional:           { label:"Professional", credits:30,     pricePer:"$8.30" },
  "professional-annual":  { label:"Professional Annual", credits:30,     pricePer:"$8.30" },
  unlimited:              { label:"Unlimited",    credits:999999, pricePer:"-" },
  "unlimited-annual":     { label:"Unlimited Annual",    credits:999999, pricePer:"-" },
};

const PLAN_LINKS = {
  starter:               "https://buy.stripe.com/test_28E9AVgqm9DX9Kh0iwgMw06",
  professional:          "https://buy.stripe.com/test_4gMaEZa1Y9DX1dL6GUgMw05",
  unlimited:             "https://buy.stripe.com/test_14AeVf5LI8zT9KhghugMw04",
  "starter-annual":      "https://buy.stripe.com/test_8x228ta1Y3fzf4BghugMw03",
  "professional-annual": "https://buy.stripe.com/test_9B6eVf2zw4jD6y5c1egMw02",
  "unlimited-annual":    "https://buy.stripe.com/test_14AeVffmi5nH4pX2qEgMw01",
};

const BIZ_STORE_KEY = "humzones_business_account";

const readBusinessAccount = () => {
  try {
    const raw = localStorage.getItem(BIZ_STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.email ? parsed : null;
  } catch { return null; }
};

const writeBusinessAccount = (acct) => {
  try { localStorage.setItem(BIZ_STORE_KEY, JSON.stringify(acct)); } catch {}
};

const clearBusinessAccount = () => {
  try { localStorage.removeItem(BIZ_STORE_KEY); } catch {}
};

const generateToken = () => {
  const bytes = new Uint8Array(32);
  (window.crypto || window.msCrypto).getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
};

// SHA-256 a string to a lowercase hex digest. Used to hash the recovery PIN
// so the raw 4-digit value is never written to or read from Airtable.
async function sha256Hex(str) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Fetch every Business_Accounts record (paginated), keyed by field ID. Used
// by /business-recover to scan for a matching hashed PIN.
async function fetchAllBusinessAccounts() {
  let all = [], offset = null;
  do {
    const url = new URL(`${APIURL}/${BUSINESS_TABLE}`);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("returnFieldsByFieldId", "true");
    if (offset) url.searchParams.set("offset", offset);
    const r = await fetch(url.toString(), { headers: HDR });
    if (!r.ok) throw new Error("Airtable lookup failed: " + r.status);
    const d = await r.json();
    all = all.concat(d.records || []);
    offset = d.offset || null;
  } while (offset);
  return all;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

// Add months/years cleanly: lock to the same day-of-month and roll over to
// the last day if the target month is shorter (Jan 31 + 1mo -> Feb 28/29).
const addMonths = (months) => {
  const d = new Date();
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
};

// Fetch a single business account row by email. Lower-cased compare so
// signups that vary capitalisation still resolve. Returns the raw Airtable
// record (id + fields keyed by field ID) or null.
async function fetchBusinessAccountByEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;
  const formula = encodeURIComponent("LOWER({Email}) = '" + e.replace(/'/g, "\\'") + "'");
  const url = `${APIURL}/${BUSINESS_TABLE}?filterByFormula=${formula}&maxRecords=1&returnFieldsByFieldId=true`;
  const r = await fetch(url, { headers: HDR });
  if (!r.ok) throw new Error("Airtable lookup failed: " + r.status);
  const d = await r.json();
  const rec = (d.records || [])[0];
  return rec ? { id: rec.id, fields: rec.fields } : null;
}

async function createBusinessAccount(fields) {
  const r = await fetch(`${APIURL}/${BUSINESS_TABLE}?returnFieldsByFieldId=true`, {
    method: "POST",
    headers: HDR,
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    console.error("createBusinessAccount failed:", err);
    throw new Error("Could not create your account. Please contact support.");
  }
  return r.json();
}

async function patchBusinessAccount(id, fields) {
  const r = await fetch(`${APIURL}/${BUSINESS_TABLE}/${id}?returnFieldsByFieldId=true`, {
    method: "PATCH",
    headers: HDR,
    body: JSON.stringify({ fields }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    console.error("patchBusinessAccount failed:", err);
    throw new Error("Could not update your account.");
  }
  return r.json();
}

// Pull a clean app-side view out of a raw Airtable record so the UI never
// has to deal with field-ID keys directly.
function normalizeBusinessAccount(rec) {
  if (!rec) return null;
  const f = rec.fields || {};
  return {
    id:               rec.id,
    email:            f[BIZ_FIELD.Email] || "",
    firstName:        f[BIZ_FIELD.First_Name] || "",
    lastName:         f[BIZ_FIELD.Last_Name] || "",
    company:          f[BIZ_FIELD.Company] || "",
    plan:             f[BIZ_FIELD.Plan] || "",
    creditsRemaining: Number(f[BIZ_FIELD.Credits_Remaining] || 0),
    creditsMonthly:   Number(f[BIZ_FIELD.Credits_Monthly] || 0),
    status:           f[BIZ_FIELD.Status] || "",
    renewalDate:      f[BIZ_FIELD.Renewal_Date] || "",
    dateJoined:       f[BIZ_FIELD.Date_Joined] || "",
    reportsGenerated: Number(f[BIZ_FIELD.Reports_Generated] || 0),
  };
}

// Shared bullet list rendered on every business pricing card. Kept module-
// scoped so the same copy reaches both /business cards and any future surface
// (e.g. a comparison block) without drifting.
const REPORT_INCLUDES = [
  "Complete list of all data centers within 100km of any address",
  "Distance from address to each facility",
  "Infrastructure exposure category",
  "Power draw in megawatts",
  "Estimated noise levels in decibels",
  "Modeled EMF exposure ranges",
  "CO2 emissions per year",
  "Daily water consumption estimate",
  "Cooling system type",
  "Year facility opened",
  "Infrastructure and community impact considerations",
  "Legal disclaimer and methodology reference",
  "Instant PDF download professionally formatted",
];

// Reusable footer for the business-side pages. Mirrors the main-site footer
// (links + disclaimer + copyright) so the business surface does not feel
// detached from the rest of HumZones.
const BusinessFooter = ({ onNavigate }) => (
  <>
    <div style={{borderTop:"1px solid rgba(255,255,255,.08)",padding:"28px 24px",textAlign:"center"}}>
      <p style={{fontSize:12,color:"rgba(255,255,255,.55)",lineHeight:1.7,maxWidth:760,margin:"0 auto"}}>
        Data Disclaimer: All figures shown including noise levels, EMF readings, power consumption, CO2 estimates, and water usage are research-based estimates compiled from public sources, permit filings, and industry standards. They are not certified measurements. Actual readings may vary by facility design, operating conditions, and season. HumZones is an informational resource only and does not constitute medical, legal, or environmental advice.
        {" "}
        <a href="/methodology" onClick={e=>{e.preventDefault();onNavigate("/methodology");}} className="ext-link" style={{color:"#f97316",fontWeight:700,textDecoration:"none"}}>Methodology</a>
      </p>
    </div>
    <footer style={{background:"#0a0f1e",padding:"40px 24px 32px",textAlign:"center",borderTop:"1px solid rgba(255,255,255,.06)"}}>
      <div style={{marginBottom:6}}>
        <span style={{fontSize:24,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
        <sup style={{fontSize:13,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2}}>TM</sup>
      </div>
      <div style={{fontSize:14,color:"#cbd5e1",fontWeight:700,marginBottom:6,letterSpacing:".02em"}}>HumZones Technologies Inc.</div>
      <div style={{fontSize:14,color:"#64748b",marginBottom:20}}>Global Data Center Health & Infrastructure Registry</div>
      <div style={{display:"flex",justifyContent:"center",gap:18,flexWrap:"wrap",marginBottom:22}}>
        <a href="/" onClick={e=>{e.preventDefault();onNavigate("/");}} className="ext-link" style={{color:"#f97316",fontSize:14,fontWeight:700,textDecoration:"none",letterSpacing:".02em"}}>Home</a>
        <a href="/methodology" onClick={e=>{e.preventDefault();onNavigate("/methodology");}} className="ext-link" style={{color:"#f97316",fontSize:14,fontWeight:700,textDecoration:"none",letterSpacing:".02em"}}>Methodology</a>
        <a href="/submit-report" onClick={e=>{e.preventDefault();onNavigate("/submit-report");}} className="ext-link" style={{color:"#f97316",fontSize:14,fontWeight:700,textDecoration:"none",letterSpacing:".02em"}}>Submit Your Report</a>
        <a href="/business" onClick={e=>{e.preventDefault();onNavigate("/business");}} className="ext-link" style={{color:"#f97316",fontSize:14,fontWeight:700,textDecoration:"none",letterSpacing:".02em"}}>Business Plans</a>
        <a href="/my-report" onClick={e=>{e.preventDefault();onNavigate("/my-report");}} className="ext-link" style={{color:"#f97316",fontSize:14,fontWeight:700,textDecoration:"none",letterSpacing:".02em"}}>Retrieve My Report</a>
        <a href="/privacy" onClick={e=>{e.preventDefault();onNavigate("/privacy");}} className="ext-link" style={{color:"#f97316",fontSize:14,fontWeight:700,textDecoration:"none",letterSpacing:".02em"}}>Privacy Policy</a>
      </div>
      <div style={{fontSize:13,color:"#94a3b8",borderTop:"1px solid #1e293b",paddingTop:18,lineHeight:1.8}}>
        <div>HumZones<sup style={{fontSize:".55em",color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:1,marginRight:4}}>TM</sup>Technologies Inc.</div>
        <div>&copy; 2026 All Rights Reserved</div>
      </div>
    </footer>
  </>
);

// ─── /business: PRICING PAGE ─────────────────────────────────────────────────
const BusinessPlansPage = ({ onNavigate }) => {
  const [annual, setAnnual] = useState(false);
  const [sampleBusy, setSampleBusy] = useState(false);

  const plans = [
    {
      key: "starter",
      title: "Starter",
      monthly: 99,  annual: 990,
      credits: "10 reports per month",
      perReport: "$9.90 per report",
      popular: false,
      features: [
        "10 report credits per month",
        "Credits reset monthly",
        "Instant PDF download",
        "Full 100km radius coverage",
        "Email support",
      ],
    },
    {
      key: "professional",
      title: "Professional",
      monthly: 249, annual: 2490,
      credits: "30 reports per month",
      perReport: "$8.30 per report",
      popular: true,
      features: [
        "30 report credits per month",
        "Credits reset monthly",
        "Instant PDF download",
        "Full 100km radius coverage",
        "Priority email support",
        "Team sharing coming soon",
      ],
    },
    {
      key: "unlimited",
      title: "Unlimited",
      monthly: 599, annual: 5990,
      credits: "Unlimited reports",
      perReport: "",
      popular: false,
      features: [
        "Unlimited reports",
        "Instant PDF download",
        "Full 100km radius coverage",
        "Priority email support",
        "Bulk export coming soon",
      ],
    },
  ];

  const handleSubscribe = (planKey) => {
    const key = annual ? `${planKey}-annual` : planKey;
    try { localStorage.setItem("hz_pending_plan", key); } catch {}
    window.location.href = PLAN_LINKS[key];
  };

  // Generates the placeholder sample PDF on the fly and triggers a download.
  const handleSampleDownload = async () => {
    if (sampleBusy) return;
    setSampleBusy(true);
    try {
      const { doc } = await buildSampleReportPdf();
      doc.save("HumZones-Sample-Report.pdf");
    } catch (e) {
      console.error("Sample report generation failed:", e);
      window.alert("We could not generate the sample report. Please try again.");
    } finally {
      setSampleBusy(false);
    }
  };

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",color:"#fff",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>
      <div style={{padding:"22px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",maxWidth:1200,margin:"0 auto"}}>
        <a href="/" onClick={e=>{e.preventDefault();onNavigate("/");}} style={{textDecoration:"none"}}>
          <span style={{fontSize:22,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
          <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2}}>TM</sup>
        </a>
        <a href="/business-login" onClick={e=>{e.preventDefault();onNavigate("/business-login");}} style={{fontSize:14,color:"rgba(255,255,255,.7)",fontWeight:700,textDecoration:"none"}}>
          Sign in
        </a>
      </div>

      <section style={{maxWidth:880,margin:"0 auto",padding:"48px 24px 28px",textAlign:"center"}}>
        <div style={{display:"inline-block",fontSize:12,color:"#f97316",letterSpacing:".18em",textTransform:"uppercase",fontWeight:800,marginBottom:14,padding:"6px 14px",borderRadius:30,background:"rgba(249,115,22,.12)",border:"1px solid rgba(249,115,22,.3)"}}>For Business</div>
        <h1 style={{fontSize:"clamp(36px,6vw,56px)",fontWeight:900,letterSpacing:"-.02em",marginBottom:18,lineHeight:1.1}}>HumZones for Business</h1>
        <p style={{fontSize:19,color:"rgba(255,255,255,.78)",lineHeight:1.6,marginBottom:14,maxWidth:680,marginLeft:"auto",marginRight:"auto"}}>
          Infrastructure intelligence for real estate, environmental, and research professionals.
        </p>
        <p style={{fontSize:14,color:"rgba(255,255,255,.55)",lineHeight:1.6}}>
          Instant report generation. Commercial usage included. No long-term contracts.
        </p>
      </section>

      <section style={{maxWidth:1100,margin:"0 auto",padding:"12px 24px 24px",textAlign:"center"}}>
        <div style={{display:"inline-flex",background:"rgba(255,255,255,.06)",border:"1px solid rgba(255,255,255,.14)",borderRadius:40,padding:4,gap:4}}>
          <button onClick={()=>setAnnual(false)} style={{padding:"10px 22px",borderRadius:30,border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:800,letterSpacing:".04em",background:!annual?"linear-gradient(135deg,#ef4444,#f97316)":"transparent",color:!annual?"#fff":"rgba(255,255,255,.7)"}}>Monthly</button>
          <button onClick={()=>setAnnual(true)} style={{padding:"10px 22px",borderRadius:30,border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:800,letterSpacing:".04em",background:annual?"linear-gradient(135deg,#ef4444,#f97316)":"transparent",color:annual?"#fff":"rgba(255,255,255,.7)"}}>
            Annual <span style={{fontSize:11,opacity:.8,marginLeft:6}}>save 2 months</span>
          </button>
        </div>
      </section>

      <section style={{maxWidth:1180,margin:"0 auto",padding:"24px 24px 48px"}}>
        <div className="biz-grid" style={{display:"grid",gridTemplateColumns:"repeat(3, 1fr)",gap:22,alignItems:"stretch"}}>
          {plans.map(p => {
            const price = annual ? p.annual : p.monthly;
            const cadence = annual ? "/year" : "/month";
            return (
              <div key={p.key} style={{position:"relative",background:p.popular?"linear-gradient(160deg,rgba(249,115,22,.12),rgba(15,23,42,.6))":"rgba(15,23,42,.55)",border:p.popular?"1.5px solid rgba(249,115,22,.6)":"1px solid rgba(255,255,255,.1)",borderRadius:18,padding:"30px 26px",display:"flex",flexDirection:"column",boxShadow:p.popular?"0 24px 60px rgba(249,115,22,.22)":"0 12px 40px rgba(0,0,0,.25)"}}>
                {p.popular && (
                  <div style={{position:"absolute",top:-14,left:"50%",transform:"translateX(-50%)",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",padding:"6px 16px",borderRadius:30,fontSize:11,fontWeight:900,letterSpacing:".14em"}}>MOST POPULAR</div>
                )}
                <div style={{fontSize:13,color:"#f97316",letterSpacing:".18em",textTransform:"uppercase",fontWeight:800,marginBottom:10}}>{p.title}</div>
                <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:6}}>
                  <span style={{fontSize:48,fontWeight:900,letterSpacing:"-.02em",color:"#fff"}}>${price}</span>
                  <span style={{fontSize:15,color:"rgba(255,255,255,.6)",fontWeight:600}}>{cadence}</span>
                </div>
                <div style={{fontSize:14,color:"rgba(255,255,255,.65)",marginBottom:18}}>
                  {p.credits}{p.perReport ? ` - ${p.perReport}` : ""}
                </div>
                <ul style={{listStyle:"none",padding:0,margin:"0 0 22px 0",display:"flex",flexDirection:"column",gap:10}}>
                  {p.features.map(f => (
                    <li key={f} style={{display:"flex",alignItems:"flex-start",gap:10,fontSize:14,color:"rgba(255,255,255,.85)",lineHeight:1.55}}>
                      <span style={{flexShrink:0,display:"inline-flex",width:20,height:20,borderRadius:"50%",background:"rgba(249,115,22,.18)",alignItems:"center",justifyContent:"center",marginTop:2,border:"1px solid rgba(249,115,22,.45)"}}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                      </span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>

                <div style={{margin:"4px 0 22px 0",padding:"16px 16px 14px",borderRadius:12,background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.08)"}}>
                  <div style={{fontSize:12,fontWeight:800,letterSpacing:".14em",textTransform:"uppercase",color:"#f97316",marginBottom:10}}>Each Report Includes</div>
                  <ul style={{listStyle:"none",padding:0,margin:0,display:"flex",flexDirection:"column",gap:7}}>
                    {REPORT_INCLUDES.map(item => (
                      <li key={item} style={{display:"flex",alignItems:"flex-start",gap:8,fontSize:13,color:"rgba(255,255,255,.78)",lineHeight:1.5}}>
                        <span style={{flexShrink:0,display:"inline-flex",width:14,height:14,borderRadius:"50%",background:"rgba(148,163,184,.18)",alignItems:"center",justifyContent:"center",marginTop:3}}>
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                        </span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <button onClick={()=>handleSubscribe(p.key)} style={{marginTop:"auto",padding:"14px 22px",borderRadius:12,border:p.popular?"none":"1px solid rgba(255,255,255,.18)",cursor:"pointer",fontFamily:"inherit",fontSize:15,fontWeight:900,letterSpacing:".04em",background:p.popular?"linear-gradient(135deg,#ef4444,#f97316)":"rgba(255,255,255,.1)",color:"#fff",boxShadow:p.popular?"0 10px 28px rgba(249,115,22,.4)":"none"}}>
                  Get Started
                </button>
              </div>
            );
          })}
        </div>
        <style>{`@media (max-width:880px){.biz-grid{grid-template-columns:1fr !important}}`}</style>
      </section>

      <section style={{maxWidth:780,margin:"0 auto",padding:"12px 24px 60px",textAlign:"center"}}>
        <p style={{fontSize:15,color:"rgba(255,255,255,.72)",lineHeight:1.7,marginBottom:14}}>
          All plans include instant PDF delivery, 100km coverage and the full HumZones facility database.
        </p>
        <p style={{fontSize:14,color:"rgba(255,255,255,.55)"}}>
          Already a member? <a href="/business-login" onClick={e=>{e.preventDefault();onNavigate("/business-login");}} style={{color:"#f97316",fontWeight:700,textDecoration:"none"}}>Sign in</a>
        </p>
        <p style={{fontSize:13,color:"rgba(255,255,255,.45)",marginTop:8}}>
          Forgot your email? <a href="/business-recover" onClick={e=>{e.preventDefault();onNavigate("/business-recover");}} style={{color:"rgba(255,255,255,.65)",fontWeight:700,textDecoration:"underline"}}>Recover your account</a>
        </p>
      </section>

      {/* SAMPLE REPORT CTA */}
      <section style={{background:"#0a0f1e",padding:"58px 24px",textAlign:"center"}}>
        <div style={{maxWidth:720,margin:"0 auto"}}>
          <h2 style={{fontSize:"clamp(26px,4vw,36px)",fontWeight:900,letterSpacing:"-.02em",marginBottom:14,color:"#fff",lineHeight:1.2}}>
            See What You Get Before You Subscribe
          </h2>
          <p style={{fontSize:16,color:"rgba(255,255,255,.7)",lineHeight:1.65,marginBottom:32,maxWidth:560,marginLeft:"auto",marginRight:"auto"}}>
            Download a sample professional report to see the depth and quality of HumZones infrastructure intelligence.
          </p>

          {/* Blurred grey placeholder with diagonal SAMPLE text and a lock overlay */}
          <div style={{position:"relative",width:400,maxWidth:"100%",height:300,margin:"0 auto 34px",borderRadius:14,overflow:"hidden",background:"#94a3b8",border:"1px solid rgba(255,255,255,.12)",boxShadow:"0 20px 50px rgba(0,0,0,.4)"}}>
            <div aria-hidden="true" style={{filter:"blur(6px)",padding:"28px 30px",pointerEvents:"none",userSelect:"none"}}>
              {[88,72,94,64,80,58,90,70].map((w,i)=>(
                <div key={i} style={{height:13,background:"rgba(255,255,255,.55)",borderRadius:4,marginBottom:13,width:`${w}%`}}/>
              ))}
            </div>
            <div aria-hidden="true" style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%) rotate(-28deg)",fontSize:66,fontWeight:900,color:"rgba(255,255,255,.5)",letterSpacing:".2em",pointerEvents:"none",whiteSpace:"nowrap"}}>SAMPLE</div>
            <div aria-hidden="true" style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",pointerEvents:"none"}}>
              <div style={{width:74,height:74,borderRadius:"50%",background:"rgba(15,23,42,.78)",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 12px 30px rgba(0,0,0,.45)"}}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="4" y="11" width="16" height="10" rx="2"/>
                  <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
                </svg>
              </div>
            </div>
          </div>

          <button onClick={handleSampleDownload} disabled={sampleBusy} style={{padding:"18px 38px",borderRadius:14,border:"none",cursor:sampleBusy?"wait":"pointer",fontFamily:"inherit",fontSize:17,fontWeight:900,letterSpacing:".02em",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",boxShadow:"0 12px 32px rgba(249,115,22,.45)",opacity:sampleBusy?.75:1}}>
            {sampleBusy ? "Generating Sample..." : "Download Sample Report"}
          </button>
        </div>
      </section>

      {/* HOW PROFESSIONALS USE HUMZONES */}
      <section style={{background:"#0f172a",padding:"60px 24px"}}>
        <div style={{maxWidth:1000,margin:"0 auto"}}>
          <h2 style={{fontSize:"clamp(26px,4vw,36px)",fontWeight:900,letterSpacing:"-.02em",marginBottom:36,color:"#fff",textAlign:"center",lineHeight:1.2}}>
            How Professionals Use HumZones
          </h2>
          <div className="biz-use-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
            {[
              {icon:"🏠",title:"Real Estate",                    desc:"Neighborhood infrastructure awareness for buyers and relocation clients."},
              {icon:"🚧",title:"Property & Development",          desc:"Monitor nearby infrastructure expansion and utility-intensive development."},
              {icon:"⚖️",title:"Environmental & Legal Research",  desc:"Access location-based infrastructure intelligence for zoning, review, and consultation workflows."},
              {icon:"🔍",title:"Research & Media",               desc:"Track AI infrastructure growth and regional development patterns."},
            ].map(c=>(
              <div key={c.title} style={{background:"rgba(255,255,255,.04)",border:"1px solid rgba(249,115,22,.25)",borderRadius:16,padding:"28px 26px"}}>
                <div style={{fontSize:38,marginBottom:14,lineHeight:1}}>{c.icon}</div>
                <div style={{fontSize:19,fontWeight:800,color:"#fff",marginBottom:10}}>{c.title}</div>
                <p style={{fontSize:15,color:"rgba(255,255,255,.7)",lineHeight:1.6,margin:0}}>{c.desc}</p>
              </div>
            ))}
          </div>
        </div>
        <style>{`@media (max-width:680px){.biz-use-grid{grid-template-columns:1fr !important}}`}</style>
      </section>

      {/* BUILT USING PUBLIC INFRASTRUCTURE DATA */}
      <section style={{background:"#fff",padding:"64px 24px",textAlign:"center"}}>
        <div style={{maxWidth:760,margin:"0 auto"}}>
          <div style={{fontSize:12,color:"#94a3b8",letterSpacing:".18em",textTransform:"uppercase",fontWeight:800,marginBottom:14}}>Data Sources</div>
          <h2 style={{fontSize:"clamp(24px,4vw,34px)",fontWeight:900,letterSpacing:"-.02em",marginBottom:14,color:"#0f172a",lineHeight:1.2}}>
            Built Using Public Infrastructure Data
          </h2>
          <p style={{fontSize:16,color:"#475569",lineHeight:1.65,marginBottom:28}}>
            HumZones compiles publicly available information from:
          </p>
          <div style={{display:"flex",flexWrap:"wrap",justifyContent:"center",gap:12,marginBottom:30}}>
            {["Planning Filings","Utility Records","Environmental Assessments","Operator Disclosures","Permitting Databases","Public Infrastructure Records"].map(s=>(
              <span key={s} style={{display:"inline-flex",alignItems:"center",padding:"10px 18px",borderRadius:30,background:"#f1f5f9",border:"1px solid #e2e8f0",fontSize:14,fontWeight:700,color:"#334155"}}>{s}</span>
            ))}
          </div>
          <p style={{fontSize:13,color:"#94a3b8",lineHeight:1.65,marginBottom:18,maxWidth:560,marginLeft:"auto",marginRight:"auto"}}>
            All figures are modeled estimates compiled for informational purposes only. See our methodology page for full details.
          </p>
          <a href="/methodology" onClick={e=>{e.preventDefault();onNavigate("/methodology");}} className="ext-link" style={{color:"#f97316",fontSize:15,fontWeight:800,textDecoration:"none",letterSpacing:".02em"}}>Read Our Methodology</a>
        </div>
      </section>

      <BusinessFooter onNavigate={onNavigate}/>
    </div>
  );
};

// ─── /business-success: ACCOUNT FORM + AIRTABLE CREATE ───────────────────────
const BusinessSuccessPage = ({ onNavigate }) => {
  const params = new URLSearchParams(window.location.search);
  const planKey = (params.get("plan") || (typeof localStorage!=="undefined"?localStorage.getItem("hz_pending_plan"):"") || "starter").toLowerCase();
  const planInfo = PLAN_INFO[planKey] || PLAN_INFO.starter;
  const isAnnual = planKey.endsWith("-annual");

  const [firstName, setFirstName] = useState("");
  const [lastName,  setLastName]  = useState("");
  const [company,   setCompany]   = useState("");
  const [email,     setEmail]     = useState("");
  const [pin,       setPin]       = useState("");
  const [pinConfirm,setPinConfirm]= useState("");
  const [securityQuestion, setSecurityQuestion] = useState("");
  const [securityAnswer,   setSecurityAnswer]   = useState("");
  const [status,    setStatus]    = useState("form"); // form | submitting | done | error
  const [errMsg,    setErrMsg]    = useState("");
  const [created,   setCreated]   = useState(null);

  // A valid recovery PIN is exactly 4 digits in the 1000-9999 range.
  const pinValid    = /^[0-9]{4}$/.test(pin);
  const pinMismatch = pin && pinConfirm && pin !== pinConfirm;
  const canSubmit = firstName.trim() && company.trim() && email.trim() &&
    pinValid && pin === pinConfirm &&
    securityQuestion && securityAnswer.trim() && status === "form";

  const submit = async () => {
    if (!canSubmit) return;
    setStatus("submitting");
    setErrMsg("");
    try {
      const credits      = planInfo.credits;
      const renewalDate  = isAnnual ? addMonths(12) : addMonths(1);
      const token        = generateToken();
      const tokenExpiry  = new Date(Date.now() + 24*60*60*1000).toISOString();
      // Hash the PIN and the security answer before they leave the browser;
      // the raw values are never written to Airtable. The answer is
      // lowercased and trimmed first so capitalisation never matters.
      const pinHash      = await sha256Hex(pin.trim());
      const answerHash   = await sha256Hex(securityAnswer.trim().toLowerCase());

      const fields = {
        [BIZ_FIELD.Email]:             email.trim(),
        [BIZ_FIELD.First_Name]:        firstName.trim(),
        [BIZ_FIELD.Last_Name]:         lastName.trim(),
        [BIZ_FIELD.Company]:           company.trim(),
        [BIZ_FIELD.Plan]:              planInfo.label,
        [BIZ_FIELD.Credits_Remaining]: credits,
        [BIZ_FIELD.Credits_Monthly]:   credits,
        [BIZ_FIELD.Status]:            "Active",
        [BIZ_FIELD.Renewal_Date]:      renewalDate,
        [BIZ_FIELD.Date_Joined]:       todayIso(),
        [BIZ_FIELD.Reports_Generated]: 0,
        [BIZ_FIELD.Login_Token]:       token,
        [BIZ_FIELD.Token_Expiry]:      tokenExpiry,
        [BIZ_FIELD.Recovery_PIN]:      pinHash,
        [BIZ_FIELD.Security_Question]: securityQuestion,
        [BIZ_FIELD.Security_Answer]:   answerHash,
      };

      const rec = await createBusinessAccount(fields);

      try {
        await fetch("/api/send-business-welcome", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: email.trim(),
            firstName: firstName.trim(),
            plan: planKey,
            credits,
            token,
          }),
        });
      } catch (e) {
        console.warn("Welcome email send failed (account still created):", e);
      }

      try { localStorage.removeItem("hz_pending_plan"); } catch {}

      setCreated({ id: rec.id, firstName: firstName.trim(), credits });
      setStatus("done");
    } catch (e) {
      console.error("Business signup failed:", e);
      setErrMsg(e.message || "Something went wrong creating your account.");
      setStatus("error");
    }
  };

  const inputStyle = (val) => ({
    width:"100%",padding:"13px 16px",borderRadius:10,
    border:`1.5px solid ${val.trim()?"#f97316":"rgba(255,255,255,.18)"}`,
    fontSize:15,boxSizing:"border-box",outline:"none",fontFamily:"inherit",
    color:"#fff",background:"rgba(255,255,255,.06)",transition:"border-color .2s",
  });

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",color:"#fff"}}>
      <div style={{padding:"22px 24px",textAlign:"center"}}>
        <a href="/" onClick={e=>{e.preventDefault();onNavigate("/");}} style={{textDecoration:"none"}}>
          <span style={{fontSize:22,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
          <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2}}>TM</sup>
        </a>
      </div>

      <main style={{maxWidth:540,margin:"0 auto",padding:"24px 24px 80px"}}>
        {status !== "done" && (
          <>
            <div style={{textAlign:"center",marginBottom:30}}>
              <div style={{display:"inline-block",fontSize:12,color:"#22c55e",letterSpacing:".18em",textTransform:"uppercase",fontWeight:800,marginBottom:14,padding:"6px 14px",borderRadius:30,background:"rgba(34,197,94,.12)",border:"1px solid rgba(34,197,94,.3)"}}>Payment confirmed</div>
              <h1 style={{fontSize:30,fontWeight:900,letterSpacing:"-.01em",marginBottom:10}}>Welcome to {planInfo.label}!</h1>
              <p style={{fontSize:15,color:"rgba(255,255,255,.72)",lineHeight:1.65}}>Tell us a bit about you so we can set up your account and send your dashboard login link.</p>
            </div>

            <div style={{background:"rgba(15,23,42,.55)",border:"1px solid rgba(255,255,255,.1)",borderRadius:16,padding:"26px"}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
                <div>
                  <label style={{fontSize:13,fontWeight:700,color:"rgba(255,255,255,.85)",display:"block",marginBottom:6}}>First Name *</label>
                  <input value={firstName} onChange={e=>setFirstName(e.target.value)} placeholder="Your first name" style={inputStyle(firstName)}/>
                </div>
                <div>
                  <label style={{fontSize:13,fontWeight:700,color:"rgba(255,255,255,.85)",display:"block",marginBottom:6}}>Last Name</label>
                  <input value={lastName} onChange={e=>setLastName(e.target.value)} placeholder="Optional" style={inputStyle(lastName)}/>
                </div>
              </div>
              <div style={{marginBottom:14}}>
                <label style={{fontSize:13,fontWeight:700,color:"rgba(255,255,255,.85)",display:"block",marginBottom:6}}>Company Name *</label>
                <input value={company} onChange={e=>setCompany(e.target.value)} placeholder="Your company" style={inputStyle(company)}/>
              </div>
              <div style={{marginBottom:14}}>
                <label style={{fontSize:13,fontWeight:700,color:"rgba(255,255,255,.85)",display:"block",marginBottom:6}}>Email Address *</label>
                <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="Your login email" style={inputStyle(email)}/>
                <div style={{fontSize:12,color:"rgba(255,255,255,.5)",marginTop:6}}>This is your login email and where your magic link will be sent.</div>
              </div>

              <div style={{marginBottom:14}}>
                <label style={{fontSize:13,fontWeight:700,color:"rgba(255,255,255,.85)",display:"block",marginBottom:6}}>Create Your 4-Digit Recovery PIN *</label>
                <input type="number" min="1000" max="9999" value={pin} onChange={e=>setPin(e.target.value)} placeholder="Enter 4 digits" style={inputStyle(pin)}/>
              </div>
              <div style={{marginBottom:14}}>
                <label style={{fontSize:13,fontWeight:700,color:"rgba(255,255,255,.85)",display:"block",marginBottom:6}}>Confirm Your Recovery PIN *</label>
                <input type="number" min="1000" max="9999" value={pinConfirm} onChange={e=>setPinConfirm(e.target.value)} placeholder="Re-enter your 4 digits" style={inputStyle(pinConfirm)}/>
                {pinMismatch && (
                  <div style={{fontSize:13,color:"#fca5a5",marginTop:6}}>PINs do not match. Please try again.</div>
                )}
              </div>

              <div style={{marginBottom:14}}>
                <label style={{fontSize:13,fontWeight:700,color:"rgba(255,255,255,.85)",display:"block",marginBottom:6}}>Choose a Security Question *</label>
                <select value={securityQuestion} onChange={e=>setSecurityQuestion(e.target.value)} style={{...inputStyle(securityQuestion), paddingRight:36, appearance:"none"}}>
                  <option value="" style={{color:"#0f172a"}}>Select a question...</option>
                  {SECURITY_QUESTIONS.map(q => (
                    <option key={q} value={q} style={{color:"#0f172a"}}>{q}</option>
                  ))}
                </select>
              </div>
              <div style={{marginBottom:14}}>
                <label style={{fontSize:13,fontWeight:700,color:"rgba(255,255,255,.85)",display:"block",marginBottom:6}}>Your Answer *</label>
                <input type="text" value={securityAnswer} onChange={e=>setSecurityAnswer(e.target.value)} placeholder="One word answers are easiest to remember" style={inputStyle(securityAnswer)}/>
                <div style={{fontSize:12,color:"rgba(255,255,255,.5)",marginTop:6,lineHeight:1.55}}>
                  Tip: use a single word answer and remember it exactly as you type it. Spelling matters but capitals do not.
                </div>
              </div>

              <div style={{display:"flex",gap:12,alignItems:"flex-start",padding:"14px 16px",borderRadius:12,background:"rgba(249,115,22,.1)",border:"1.5px solid rgba(249,115,22,.55)",marginBottom:18}}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{flexShrink:0,marginTop:1}}>
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                  <line x1="12" y1="9" x2="12" y2="13"/>
                  <line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                <p style={{fontSize:13,color:"rgba(255,255,255,.85)",lineHeight:1.6,margin:0}}>
                  <strong style={{color:"#f97316"}}>Important:</strong> Your 4-digit PIN and security question answer are the only way to recover your login email if you forget it. Store your PIN somewhere safe such as a password manager or written note. If you lose both your PIN and security answer we have no way to verify your identity or recover your account.
                </p>
              </div>

              {status === "error" && (
                <div style={{padding:"12px 14px",borderRadius:10,background:"rgba(239,68,68,.12)",border:"1px solid rgba(239,68,68,.4)",color:"#fecaca",fontSize:14,marginBottom:14}}>{errMsg}</div>
              )}

              <button onClick={submit} disabled={!canSubmit} style={{width:"100%",padding:"16px 22px",borderRadius:12,border:"none",cursor:canSubmit?"pointer":"not-allowed",fontFamily:"inherit",fontSize:15,fontWeight:900,letterSpacing:".04em",background:canSubmit?"linear-gradient(135deg,#ef4444,#f97316)":"rgba(255,255,255,.1)",color:"#fff",boxShadow:canSubmit?"0 10px 28px rgba(249,115,22,.4)":"none"}}>
                {status === "submitting" ? "Setting up your account..." : "Create My Account"}
              </button>
            </div>
          </>
        )}

        {status === "done" && created && (
          <div style={{textAlign:"center"}}>
            <div className="slow-pulse" style={{width:84,height:84,borderRadius:"50%",background:"linear-gradient(135deg,#10b981,#059669)",margin:"24px auto 22px",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 18px 50px rgba(16,185,129,.4)"}}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <h1 style={{fontSize:28,fontWeight:900,marginBottom:14}}>Welcome to HumZones {created.firstName}!</h1>
            <p style={{fontSize:17,color:"rgba(255,255,255,.85)",lineHeight:1.65,marginBottom:10}}>
              You have <strong style={{color:"#f97316"}}>{created.credits >= 999999 ? "unlimited" : created.credits}</strong> report credits ready to use.
            </p>
            <p style={{fontSize:15,color:"rgba(255,255,255,.72)",lineHeight:1.65,marginBottom:28}}>
              Check your email for your login link to access your dashboard.
            </p>
            <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap"}}>
              <button onClick={()=>onNavigate("/business-login")} style={{padding:"14px 26px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:15,fontWeight:900,background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>Go to Sign In</button>
              <button onClick={()=>onNavigate("/")} style={{padding:"14px 22px",borderRadius:12,border:"1px solid rgba(255,255,255,.22)",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:800,background:"rgba(255,255,255,.06)",color:"#fff"}}>Back to HumZones</button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

// ─── /business-generate: BUSINESS-ONLY REPORT GENERATOR ──────────────────────
// Distinct from the consumer /report-landing -> Stripe -> /report-success
// flow. Logged-in business users land here directly to search any address,
// preview the facilities in range, then download a PDF that costs a credit
// (or no credit on the Unlimited plan). Each generated report is written
// to the Business_Reports table so the dashboard can list and re-download
// them later.
const BusinessGeneratePage = ({ onNavigate }) => {
  const [account, setAccount] = useState(() => readBusinessAccount());
  const [radius, setRadius] = useState(50);
  const [address, setAddress] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState("");
  const [results, setResults] = useState(null); // { address, lat, lng, facilities }
  const [downloading, setDownloading] = useState(false);
  const [toast, setToast] = useState("");
  const refreshedRef = useRef(false);

  // Redirect unauthenticated users + refresh the account from Airtable once
  // so the credits badge is current even if a download happened in another
  // tab. We deliberately do NOT block the page on this refresh.
  useEffect(() => {
    if (!account) { onNavigate("/business-login"); return; }
    if (refreshedRef.current) return;
    refreshedRef.current = true;
    fetchBusinessAccountByEmail(account.email)
      .then(rec => {
        if (!rec) return;
        const fresh = normalizeBusinessAccount(rec);
        writeBusinessAccount(fresh);
        setAccount(fresh);
      })
      .catch(e => console.warn("Account refresh failed:", e));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!account) return null;

  const isUnlimited = account.creditsMonthly >= 999999;
  const creditsLabel = isUnlimited ? "Unlimited" : `${account.creditsRemaining} reports remaining`;
  const ctaCreditsLabel = isUnlimited ? "Unlimited" : `${account.creditsRemaining} credits remaining`;

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  };

  const search = async () => {
    if (!address.trim()) return;
    setSearching(true);
    setSearchErr("");
    setResults(null);
    try {
      // Geocode via Nominatim. Public endpoint, no key required; their usage
      // policy asks for a descriptive UA, which Vite-bundled fetch sends by
      // default for the deployed origin.
      const geoUrl = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address.trim())}`;
      const geoRes = await fetch(geoUrl, { headers: { "Accept-Language": "en" } });
      if (!geoRes.ok) throw new Error("Address lookup failed. Please try again.");
      const geoArr = await geoRes.json();
      if (!Array.isArray(geoArr) || geoArr.length === 0) {
        throw new Error("We could not find that address. Try a more specific query.");
      }
      const lat = parseFloat(geoArr[0].lat);
      const lng = parseFloat(geoArr[0].lon);
      const displayName = geoArr[0].display_name || address.trim();

      const reportFields = [
        "Name","Company","City","State_Region","Country","Address","Facility_Status",
        "Risk_Level","Power_MW","Noise_DB","CO2_Tons_Year","Water_Gal_Day",
        "EMF_Fence_High","EMF_100m","Cooling","Opened","Latitude","Longitude",
      ];
      const allFacs = await apiFetch("Facilities", { "fields[]": reportFields });
      const facsNear = allFacs
        .map(f => {
          const flat = parseFloat(f.Latitude), flng = parseFloat(f.Longitude);
          if (!Number.isFinite(flat) || !Number.isFinite(flng)) return null;
          return { ...f, _km: distanceKm(lat, lng, flat, flng) };
        })
        .filter(f => f && f._km <= radius)
        .sort((a, b) => a._km - b._km);

      setResults({ address: displayName, lat, lng, facilities: facsNear });
    } catch (e) {
      setSearchErr(e.message || "Search failed. Please try again.");
    } finally {
      setSearching(false);
    }
  };

  const download = async () => {
    if (!results || downloading) return;
    // Out-of-credits guard. Unlimited plans skip the check entirely.
    if (!isUnlimited && account.creditsRemaining <= 0) {
      const when = account.renewalDate ? ` Credits reset on ${account.renewalDate}.` : "";
      window.alert(`You have no credits remaining.${when} Visit humzones.com/business to upgrade your plan.`);
      return;
    }
    setDownloading(true);
    try {
      const highRiskCount = results.facilities.filter(f => String(f.Risk_Level || "").toUpperCase() === "HIGH").length;

      const { doc, datePart } = await buildAreaReportPdf({
        searchAddress: results.address,
        facsNear: results.facilities,
        radiusKm: radius,
        facilities100km: results.facilities.length,
        highRisk: highRiskCount,
      });
      const filename = `HumZones-Business-Report-${pdfFilenameSafe(results.address)}-${datePart}.pdf`;
      doc.save(filename);

      // Write the report to Business_Reports. Field IDs only so the row goes
      // to the right columns regardless of display-name drift.
      const reportName = `HumZones-Business-Report-${pdfFilenameSafe(results.address)}-${datePart}`;
      try {
        await fetch(`${APIURL}/${BUSINESS_REPORTS_TABLE}?returnFieldsByFieldId=true`, {
          method: "POST",
          headers: HDR,
          body: JSON.stringify({
            fields: {
              [BIZ_REP_FIELD.Email]:            account.email,
              [BIZ_REP_FIELD.Address]:          results.address,
              [BIZ_REP_FIELD.Date_Generated]:   datePart,
              [BIZ_REP_FIELD.Facilities_Count]: results.facilities.length,
              [BIZ_REP_FIELD.High_Risk_Count]:  highRiskCount,
              [BIZ_REP_FIELD.Radius_KM]:        radius,
              [BIZ_REP_FIELD.Latitude]:         results.lat,
              [BIZ_REP_FIELD.Longitude]:        results.lng,
              [BIZ_REP_FIELD.Plan]:             account.plan || "",
              [BIZ_REP_FIELD.Report_Name]:      reportName,
            },
          }),
        });
      } catch (e) {
        console.warn("Business_Reports write failed:", e);
      }

      // Deduct one credit on metered plans. Unlimited only increments the
      // generated counter; credits are never debited.
      const newRemaining = isUnlimited
        ? account.creditsRemaining
        : Math.max(0, account.creditsRemaining - 1);
      const newGenerated = (account.reportsGenerated || 0) + 1;
      try {
        await patchBusinessAccount(account.id, {
          [BIZ_FIELD.Credits_Remaining]: newRemaining,
          [BIZ_FIELD.Reports_Generated]: newGenerated,
        });
      } catch (e) {
        console.error("Credit deduction failed:", e);
      }

      const next = { ...account, creditsRemaining: newRemaining, reportsGenerated: newGenerated };
      writeBusinessAccount(next);
      setAccount(next);

      const remainingLabel = isUnlimited ? "Unlimited" : `${newRemaining}`;
      showToast(`Report downloaded. ${remainingLabel} credits remaining.`);
    } catch (e) {
      console.error("Business report download failed:", e);
      window.alert("Something went wrong generating your report. Please try again.");
    } finally {
      setDownloading(false);
    }
  };

  // Delegates to the shared exposure color map so the legacy LOW-MODERATE
  // value renders MODERATE orange rather than blue.
  const riskColor = (lvl) => exposureColor(lvl);

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",color:"#fff",paddingBottom:results ? 110 : 40}}>
      <div style={{padding:"22px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",maxWidth:1100,margin:"0 auto"}}>
        <a href="/" onClick={e=>{e.preventDefault();onNavigate("/");}} style={{textDecoration:"none"}}>
          <span style={{fontSize:22,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
          <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2}}>TM</sup>
        </a>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <a href="/business-dashboard" onClick={e=>{e.preventDefault();onNavigate("/business-dashboard");}} style={{fontSize:13,color:"rgba(255,255,255,.7)",fontWeight:700,textDecoration:"none"}}>Dashboard</a>
        </div>
      </div>

      <main style={{maxWidth:880,margin:"0 auto",padding:"16px 24px 48px"}}>
        <div style={{background:"rgba(15,23,42,.6)",border:"1px solid rgba(255,255,255,.1)",borderRadius:18,padding:"28px",marginBottom:24}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:14,marginBottom:16,flexWrap:"wrap"}}>
            <h1 style={{fontSize:28,fontWeight:900,letterSpacing:"-.01em",margin:0}}>Generate Your Report</h1>
            <span style={{display:"inline-flex",alignItems:"center",gap:6,padding:"8px 14px",borderRadius:30,background:"rgba(249,115,22,.14)",border:"1px solid rgba(249,115,22,.45)",color:"#f97316",fontSize:13,fontWeight:800,letterSpacing:".04em"}}>
              {creditsLabel}
            </span>
          </div>

          <label style={{fontSize:13,fontWeight:700,color:"rgba(255,255,255,.85)",display:"block",marginBottom:6}}>Address</label>
          <input
            value={address}
            onChange={e=>setAddress(e.target.value)}
            onKeyDown={e=>{ if (e.key === "Enter") search(); }}
            placeholder="Enter any address to analyze"
            style={{width:"100%",padding:"15px 18px",borderRadius:12,border:`1.5px solid ${address.trim()?"#f97316":"rgba(255,255,255,.2)"}`,fontSize:16,boxSizing:"border-box",outline:"none",fontFamily:"inherit",color:"#fff",background:"rgba(255,255,255,.06)",marginBottom:14}}
          />

          <label style={{fontSize:13,fontWeight:700,color:"rgba(255,255,255,.85)",display:"block",marginBottom:6}}>Radius</label>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:18}}>
            {[5,10,25,50,100].map(r => (
              <button key={r} onClick={()=>setRadius(r)} style={{padding:"10px 16px",borderRadius:10,border:"1px solid rgba(255,255,255,.16)",background:radius===r?"linear-gradient(135deg,#ef4444,#f97316)":"rgba(255,255,255,.06)",color:"#fff",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:800}}>{r}km</button>
            ))}
          </div>

          <button onClick={search} disabled={!address.trim() || searching} style={{width:"100%",padding:"16px 22px",borderRadius:12,border:"none",cursor:(!address.trim()||searching)?"not-allowed":"pointer",fontFamily:"inherit",fontSize:16,fontWeight:900,letterSpacing:".04em",background:address.trim()?"linear-gradient(135deg,#ef4444,#f97316)":"rgba(255,255,255,.1)",color:"#fff",boxShadow:address.trim()?"0 10px 28px rgba(249,115,22,.4)":"none"}}>
            {searching ? "Searching..." : "Search"}
          </button>

          {searchErr && (
            <div style={{marginTop:14,padding:"12px 14px",borderRadius:10,background:"rgba(239,68,68,.12)",border:"1px solid rgba(239,68,68,.4)",color:"#fecaca",fontSize:14}}>{searchErr}</div>
          )}
        </div>

        {results && (
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:14,gap:10,flexWrap:"wrap"}}>
              <h2 style={{fontSize:18,fontWeight:800,margin:0}}>
                {results.facilities.length} {results.facilities.length === 1 ? "facility" : "facilities"} found within {radius}km
              </h2>
              <div style={{fontSize:13,color:"rgba(255,255,255,.55)"}}>{results.address}</div>
            </div>

            {results.facilities.length === 0 ? (
              <div style={{padding:"30px 24px",borderRadius:14,background:"rgba(15,23,42,.55)",border:"1px solid rgba(255,255,255,.1)",textAlign:"center",color:"rgba(255,255,255,.7)"}}>
                No facilities found within {radius}km of this address. Try a larger radius.
              </div>
            ) : (
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                {results.facilities.map((f, i) => (
                  <div key={f.id || i} style={{background:"rgba(15,23,42,.55)",border:"1px solid rgba(255,255,255,.08)",borderRadius:14,padding:"18px 20px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,marginBottom:8,flexWrap:"wrap"}}>
                      <div>
                        <div style={{fontSize:16,fontWeight:800,color:"#fff"}}>{f.Name || "Unnamed facility"}</div>
                        {f.Company && <div style={{fontSize:13,color:"rgba(255,255,255,.6)"}}>{f.Company}</div>}
                      </div>
                      <span style={{padding:"4px 12px",borderRadius:20,background:`${riskColor(f.Risk_Level)}22`,border:`1px solid ${riskColor(f.Risk_Level)}66`,color:riskColor(f.Risk_Level),fontSize:11,fontWeight:900,letterSpacing:".10em"}}>
                        {exposureLabel(f.Risk_Level)}
                      </span>
                    </div>
                    <div style={{fontSize:13,color:"#f97316",fontWeight:700,marginBottom:10}}>{Number(f._km).toFixed(1)} km away</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(160px, 1fr))",gap:10,fontSize:13,color:"rgba(255,255,255,.78)"}}>
                      <div><span style={{color:"rgba(255,255,255,.5)"}}>Power: </span>{f.Power_MW != null && f.Power_MW !== "" ? `${f.Power_MW} MW` : "n/a"}</div>
                      <div><span style={{color:"rgba(255,255,255,.5)"}}>Noise: </span>{f.Noise_DB != null && f.Noise_DB !== "" ? `${f.Noise_DB} dB` : "n/a"}</div>
                      <div><span style={{color:"rgba(255,255,255,.5)"}}>EMF fence: </span>{f.EMF_Fence_High != null && f.EMF_Fence_High !== "" ? `${f.EMF_Fence_High} mG` : "n/a"}</div>
                      <div><span style={{color:"rgba(255,255,255,.5)"}}>EMF 100m: </span>{f.EMF_100m != null && f.EMF_100m !== "" ? `${f.EMF_100m} mG` : "n/a"}</div>
                      <div><span style={{color:"rgba(255,255,255,.5)"}}>Cooling: </span>{f.Cooling || "n/a"}</div>
                      <div><span style={{color:"rgba(255,255,255,.5)"}}>Opened: </span>{f.Opened || "n/a"}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {results && results.facilities.length > 0 && (
        <div style={{position:"fixed",bottom:0,left:0,right:0,padding:"14px 18px",background:"rgba(2,12,27,.92)",borderTop:"1px solid rgba(249,115,22,.4)",backdropFilter:"blur(12px)",zIndex:50,display:"flex",justifyContent:"center"}}>
          <button onClick={download} disabled={downloading} style={{maxWidth:560,width:"100%",padding:"16px 22px",borderRadius:12,border:"none",cursor:downloading?"not-allowed":"pointer",fontFamily:"inherit",fontSize:16,fontWeight:900,letterSpacing:".04em",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",boxShadow:"0 14px 32px rgba(249,115,22,.42)"}}>
            {downloading ? "Generating PDF..." : `Download Report (${ctaCreditsLabel})`}
          </button>
        </div>
      )}

      {toast && (
        <div role="status" style={{position:"fixed",top:24,left:"50%",transform:"translateX(-50%)",padding:"12px 22px",borderRadius:30,background:"#0f172a",border:"1px solid rgba(249,115,22,.5)",color:"#fff",fontWeight:700,fontSize:14,zIndex:100,boxShadow:"0 18px 50px rgba(0,0,0,.45)"}}>
          {toast}
        </div>
      )}
    </div>
  );
};

// ─── /business-recover: PIN + SECURITY QUESTION EMAIL RECOVERY ───────────────
// Two-step flow. Step 1: enter the 4-digit PIN; we hash it and scan
// Business_Accounts for matches. Step 2: answer the security question on the
// first matched record; a correct hashed answer reveals the login email.
// Each step has its own 3-attempt lockout tracked in localStorage.
const RECOVER_PIN_ATTEMPTS_KEY    = "humzones_recover_attempts";
const RECOVER_ANSWER_ATTEMPTS_KEY = "humzones_recover_answer_attempts";

const readRecoverAttempts = (key) => {
  try { return parseInt(localStorage.getItem(key) || "0", 10) || 0; } catch { return 0; }
};
const bumpRecoverAttempts = (key) => {
  const n = readRecoverAttempts(key) + 1;
  try { localStorage.setItem(key, String(n)); } catch {}
  return n;
};
const clearRecoverAttempts = (key) => {
  try { localStorage.removeItem(key); } catch {}
};

const BusinessRecoverPage = ({ onNavigate }) => {
  const [step, setStep]   = useState("pin"); // pin | question | done
  const [pin, setPin]     = useState("");
  const [answer, setAnswer] = useState("");
  const [matched, setMatched] = useState(null); // first matched Airtable record
  const [foundEmail, setFoundEmail] = useState("");

  const [pinBusy, setPinBusy]     = useState(false);
  const [pinError, setPinError]   = useState("");
  const [pinLocked, setPinLocked] = useState(() => readRecoverAttempts(RECOVER_PIN_ATTEMPTS_KEY) >= 3);

  const [answerBusy, setAnswerBusy]     = useState(false);
  const [answerError, setAnswerError]   = useState("");
  const [answerLocked, setAnswerLocked] = useState(() => readRecoverAttempts(RECOVER_ANSWER_ATTEMPTS_KEY) >= 3);

  const pinValid = /^[0-9]{4}$/.test(pin);

  const submitPin = async () => {
    if (!pinValid || pinBusy || pinLocked) return;
    setPinBusy(true);
    setPinError("");
    try {
      const hash = await sha256Hex(pin.trim());
      const records = await fetchAllBusinessAccounts();
      const matches = records.filter(rec => rec.fields && rec.fields[BIZ_FIELD.Recovery_PIN] === hash);
      if (matches.length === 0) {
        const n = bumpRecoverAttempts(RECOVER_PIN_ATTEMPTS_KEY);
        if (n >= 3) setPinLocked(true);
        else setPinError("No account found with that PIN. Please check and try again.");
      } else {
        // Multiple PINs can collide; the security answer disambiguates, so
        // we proceed with the first match without revealing anything yet.
        setMatched(matches[0]);
        setAnswer("");
        setAnswerError("");
        setStep("question");
      }
    } catch (e) {
      console.error("Recovery PIN lookup failed:", e);
      setPinError("Something went wrong. Please try again.");
    } finally {
      setPinBusy(false);
    }
  };

  const submitAnswer = async () => {
    if (!answer.trim() || answerBusy || answerLocked || !matched) return;
    setAnswerBusy(true);
    setAnswerError("");
    try {
      const hash = await sha256Hex(answer.trim().toLowerCase());
      if (hash === matched.fields[BIZ_FIELD.Security_Answer]) {
        setFoundEmail(matched.fields[BIZ_FIELD.Email] || "");
        setStep("done");
        clearRecoverAttempts(RECOVER_PIN_ATTEMPTS_KEY);
        clearRecoverAttempts(RECOVER_ANSWER_ATTEMPTS_KEY);
      } else {
        const n = bumpRecoverAttempts(RECOVER_ANSWER_ATTEMPTS_KEY);
        if (n >= 3) setAnswerLocked(true);
        else setAnswerError("Incorrect answer. Please try again.");
      }
    } catch (e) {
      console.error("Recovery answer check failed:", e);
      setAnswerError("Something went wrong. Please try again.");
    } finally {
      setAnswerBusy(false);
    }
  };

  const errorBox = (msg) => (
    <div style={{padding:"12px 14px",borderRadius:10,background:"rgba(239,68,68,.12)",border:"1px solid rgba(239,68,68,.4)",color:"#fecaca",fontSize:14,marginBottom:14}}>{msg}</div>
  );

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",color:"#fff"}}>
      <div style={{padding:"22px 24px"}}>
        <a href="/" onClick={e=>{e.preventDefault();onNavigate("/");}} style={{textDecoration:"none"}}>
          <span style={{fontSize:22,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
          <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2}}>TM</sup>
        </a>
      </div>

      <main style={{maxWidth:480,margin:"0 auto",padding:"24px 24px 80px"}}>

        {step === "pin" && (
          <>
            <div style={{textAlign:"center",marginBottom:24}}>
              <h1 style={{fontSize:30,fontWeight:900,letterSpacing:"-.01em",marginBottom:10}}>Account Recovery</h1>
              <p style={{fontSize:15,color:"rgba(255,255,255,.7)",lineHeight:1.65}}>Enter your 4-digit recovery PIN to begin.</p>
            </div>
            <div style={{background:"rgba(15,23,42,.55)",border:"1px solid rgba(255,255,255,.1)",borderRadius:16,padding:"26px"}}>
              {pinError && errorBox(pinError)}
              {pinLocked && errorBox("Too many failed attempts. Please try again later.")}
              <label style={{fontSize:13,fontWeight:700,color:"rgba(255,255,255,.85)",display:"block",marginBottom:6}}>Recovery PIN</label>
              <input
                type="number" min="1000" max="9999"
                value={pin}
                onChange={e=>setPin(e.target.value)}
                onKeyDown={e=>{ if (e.key === "Enter") submitPin(); }}
                disabled={pinLocked}
                placeholder="Your 4-digit recovery PIN"
                style={{width:"100%",padding:"14px 16px",borderRadius:10,border:`1.5px solid ${pinValid?"#f97316":"rgba(255,255,255,.18)"}`,fontSize:16,boxSizing:"border-box",outline:"none",fontFamily:"inherit",color:"#fff",background:"rgba(255,255,255,.06)",marginBottom:16,opacity:pinLocked?.5:1}}
              />
              <button onClick={submitPin} disabled={!pinValid || pinBusy || pinLocked} style={{width:"100%",padding:"15px 22px",borderRadius:12,border:"none",cursor:(!pinValid||pinBusy||pinLocked)?"not-allowed":"pointer",fontFamily:"inherit",fontSize:16,fontWeight:900,letterSpacing:".04em",background:(pinValid&&!pinLocked)?"linear-gradient(135deg,#ef4444,#f97316)":"rgba(255,255,255,.1)",color:"#fff",boxShadow:(pinValid&&!pinLocked)?"0 10px 28px rgba(249,115,22,.4)":"none"}}>
                {pinBusy ? "Checking..." : "Continue"}
              </button>
              <p style={{fontSize:13,color:"rgba(255,255,255,.55)",textAlign:"center",marginTop:14,paddingTop:14,borderTop:"1px solid rgba(255,255,255,.08)"}}>
                Remembered your email? <a href="/business-login" onClick={e=>{e.preventDefault();onNavigate("/business-login");}} style={{color:"#f97316",fontWeight:700,textDecoration:"none"}}>Sign in</a>
              </p>
            </div>
          </>
        )}

        {step === "question" && (
          <>
            <div style={{textAlign:"center",marginBottom:24}}>
              <h1 style={{fontSize:30,fontWeight:900,letterSpacing:"-.01em",marginBottom:10}}>One more step</h1>
              <p style={{fontSize:15,color:"rgba(255,255,255,.7)",lineHeight:1.65}}>Answer your security question to confirm your identity.</p>
            </div>
            <div style={{background:"rgba(15,23,42,.55)",border:"1px solid rgba(255,255,255,.1)",borderRadius:16,padding:"26px"}}>
              {answerError && errorBox(answerError)}
              {answerLocked && errorBox("Too many failed attempts. Please try again later.")}
              <div style={{fontSize:12,color:"#f97316",letterSpacing:".14em",textTransform:"uppercase",fontWeight:800,marginBottom:8}}>Security Question</div>
              <div style={{fontSize:19,fontWeight:900,color:"#fff",lineHeight:1.4,marginBottom:16}}>
                {(matched && matched.fields[BIZ_FIELD.Security_Question]) || "Answer your security question"}
              </div>
              <label style={{fontSize:13,fontWeight:700,color:"rgba(255,255,255,.85)",display:"block",marginBottom:6}}>Your Answer</label>
              <input
                type="text"
                value={answer}
                onChange={e=>setAnswer(e.target.value)}
                onKeyDown={e=>{ if (e.key === "Enter") submitAnswer(); }}
                disabled={answerLocked}
                placeholder="Your answer"
                style={{width:"100%",padding:"14px 16px",borderRadius:10,border:`1.5px solid ${answer.trim()?"#f97316":"rgba(255,255,255,.18)"}`,fontSize:16,boxSizing:"border-box",outline:"none",fontFamily:"inherit",color:"#fff",background:"rgba(255,255,255,.06)",marginBottom:6,opacity:answerLocked?.5:1}}
              />
              <div style={{fontSize:12,color:"rgba(255,255,255,.5)",marginBottom:16}}>Spelling matters but capitals do not</div>
              <button onClick={submitAnswer} disabled={!answer.trim() || answerBusy || answerLocked} style={{width:"100%",padding:"15px 22px",borderRadius:12,border:"none",cursor:(!answer.trim()||answerBusy||answerLocked)?"not-allowed":"pointer",fontFamily:"inherit",fontSize:16,fontWeight:900,letterSpacing:".04em",background:(answer.trim()&&!answerLocked)?"linear-gradient(135deg,#ef4444,#f97316)":"rgba(255,255,255,.1)",color:"#fff",boxShadow:(answer.trim()&&!answerLocked)?"0 10px 28px rgba(249,115,22,.4)":"none"}}>
                {answerBusy ? "Verifying..." : "Verify My Answer"}
              </button>
              <p style={{fontSize:13,color:"rgba(255,255,255,.55)",textAlign:"center",marginTop:14}}>
                <a href="/business-recover" onClick={e=>{e.preventDefault();setStep("pin");setAnswerError("");}} style={{color:"rgba(255,255,255,.75)",fontWeight:700,textDecoration:"underline",cursor:"pointer"}}>Back</a>
              </p>
            </div>
          </>
        )}

        {step === "done" && (
          <>
            <div style={{textAlign:"center",marginBottom:24}}>
              <h1 style={{fontSize:30,fontWeight:900,letterSpacing:"-.01em",marginBottom:10}}>Account Recovery</h1>
            </div>
            <div style={{background:"rgba(34,197,94,.08)",border:"1px solid rgba(34,197,94,.35)",borderRadius:16,padding:"28px",textAlign:"center"}}>
              <div style={{fontSize:15,color:"#86efac",fontWeight:700,marginBottom:10}}>We found your account. Your login email is:</div>
              <div style={{fontSize:22,fontWeight:900,color:"#f97316",wordBreak:"break-all",marginBottom:20}}>{foundEmail}</div>
              <button onClick={()=>onNavigate("/business-login")} style={{padding:"14px 28px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:15,fontWeight:900,background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>Go to Login</button>
              <p style={{fontSize:13,color:"rgba(255,255,255,.55)",marginTop:14,lineHeight:1.55}}>
                Enter this email at humzones.com/business-login to receive your instant login link.
              </p>
            </div>
          </>
        )}

      </main>
    </div>
  );
};

// ─── /business-login: MAGIC LINK ─────────────────────────────────────────────
const BusinessLoginPage = ({ onNavigate }) => {
  const initialParams = new URLSearchParams(window.location.search);
  const initialToken = initialParams.get("token") || "";
  const initialEmail = initialParams.get("email") || "";

  const [mode, setMode] = useState(initialToken ? "verifying" : "request"); // verifying | request | sent | error
  const [errMsg, setErrMsg] = useState("");
  const [emailInput, setEmailInput] = useState(initialEmail);
  const [sending, setSending] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (mode !== "verifying" || startedRef.current) return;
    startedRef.current = true;
    (async () => {
      try {
        const rec = await fetchBusinessAccountByEmail(initialEmail);
        if (!rec) throw new Error("This link has expired. Request a new one below.");
        const f = rec.fields || {};
        const tokenOnFile = f[BIZ_FIELD.Login_Token];
        const expiry      = f[BIZ_FIELD.Token_Expiry];
        if (!tokenOnFile || tokenOnFile !== initialToken) {
          throw new Error("This link has expired. Request a new one below.");
        }
        if (!expiry || new Date(expiry).getTime() < Date.now()) {
          throw new Error("This link has expired. Request a new one below.");
        }
        const account = normalizeBusinessAccount(rec);
        writeBusinessAccount(account);
        onNavigate("/business-dashboard");
      } catch (e) {
        console.error("Login verify failed:", e);
        setErrMsg(e.message || "This link has expired. Request a new one below.");
        setMode("error");
      }
    })();
  }, [mode]);

  const requestLink = async () => {
    if (!emailInput.trim() || sending) return;
    setSending(true);
    setErrMsg("");
    try {
      const r = await fetch("/api/send-login-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailInput.trim() }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || "Could not send login link.");
      }
      setMode("sent");
    } catch (e) {
      setErrMsg(e.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",color:"#fff"}}>
      <div style={{padding:"22px 24px",textAlign:"center"}}>
        <a href="/" onClick={e=>{e.preventDefault();onNavigate("/");}} style={{textDecoration:"none"}}>
          <span style={{fontSize:22,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
          <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2}}>TM</sup>
        </a>
      </div>

      <main style={{maxWidth:480,margin:"0 auto",padding:"24px 24px 80px"}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <h1 style={{fontSize:28,fontWeight:900,letterSpacing:"-.01em",marginBottom:10}}>Sign In to Your HumZones Account</h1>
          <p style={{fontSize:15,color:"rgba(255,255,255,.7)",lineHeight:1.65}}>We use secure magic links instead of passwords. Enter your email and we will send you an instant login link. No password needed, ever.</p>
        </div>

        {mode === "verifying" && (
          <div style={{background:"rgba(15,23,42,.55)",border:"1px solid rgba(255,255,255,.1)",borderRadius:16,padding:"30px",textAlign:"center"}}>
            <div className="spinning" style={{width:36,height:36,border:"3px solid rgba(255,255,255,.18)",borderTop:"3px solid #f97316",borderRadius:"50%",margin:"0 auto 16px"}}/>
            <div style={{fontSize:15,color:"rgba(255,255,255,.85)"}}>Signing you in...</div>
          </div>
        )}

        {mode === "sent" && (
          <div style={{background:"rgba(34,197,94,.08)",border:"1px solid rgba(34,197,94,.3)",borderRadius:16,padding:"24px",textAlign:"center"}}>
            <div style={{fontSize:18,fontWeight:800,color:"#86efac",marginBottom:8}}>Check your email!</div>
            <p style={{fontSize:14,color:"rgba(255,255,255,.78)",lineHeight:1.65}}>We sent a login link to <strong>{emailInput}</strong>. Click the link in the email to sign in. The link is valid for 24 hours.</p>
          </div>
        )}

        {(mode === "request" || mode === "error") && (
          <div style={{background:"rgba(15,23,42,.55)",border:"1px solid rgba(255,255,255,.1)",borderRadius:16,padding:"26px"}}>
            {mode === "error" && (
              <div style={{padding:"12px 14px",borderRadius:10,background:"rgba(239,68,68,.12)",border:"1px solid rgba(239,68,68,.4)",color:"#fecaca",fontSize:14,marginBottom:14}}>{errMsg}</div>
            )}
            <label style={{fontSize:13,fontWeight:700,color:"rgba(255,255,255,.85)",display:"block",marginBottom:6}}>Email Address</label>
            <input type="email" value={emailInput} onChange={e=>setEmailInput(e.target.value)} placeholder="you@company.com" style={{width:"100%",padding:"13px 16px",borderRadius:10,border:`1.5px solid ${emailInput.trim()?"#f97316":"rgba(255,255,255,.18)"}`,fontSize:15,boxSizing:"border-box",outline:"none",fontFamily:"inherit",color:"#fff",background:"rgba(255,255,255,.06)",marginBottom:14}}/>
            {errMsg && mode !== "error" && (
              <div style={{fontSize:13,color:"#fca5a5",marginBottom:10}}>{errMsg}</div>
            )}
            <button onClick={requestLink} disabled={!emailInput.trim() || sending} style={{width:"100%",padding:"14px 22px",borderRadius:12,border:"none",cursor:(!emailInput.trim()||sending)?"not-allowed":"pointer",fontFamily:"inherit",fontSize:15,fontWeight:900,background:emailInput.trim()?"linear-gradient(135deg,#ef4444,#f97316)":"rgba(255,255,255,.1)",color:"#fff",boxShadow:emailInput.trim()?"0 10px 28px rgba(249,115,22,.4)":"none"}}>
              {sending ? "Sending..." : "Send My Login Link"}
            </button>
            <p style={{fontSize:12,color:"rgba(255,255,255,.5)",textAlign:"center",marginTop:10,lineHeight:1.55}}>
              Check your spam folder if you do not see the email within a few minutes.
            </p>
            <p style={{fontSize:13,color:"rgba(255,255,255,.55)",textAlign:"center",marginTop:12}}>
              Forgot your login email? <a href="/business-recover" onClick={e=>{e.preventDefault();onNavigate("/business-recover");}} style={{color:"rgba(255,255,255,.75)",fontWeight:700,textDecoration:"underline"}}>Recover your account</a>
            </p>
            <p style={{fontSize:13,color:"rgba(255,255,255,.55)",textAlign:"center",marginTop:14,paddingTop:14,borderTop:"1px solid rgba(255,255,255,.08)"}}>
              New to HumZones for Business? Visit <a href="/business" onClick={e=>{e.preventDefault();onNavigate("/business");}} style={{color:"#f97316",fontWeight:700,textDecoration:"none"}}>humzones.com/business</a> to view our plans.
            </p>
          </div>
        )}
      </main>
    </div>
  );
};

// ─── /business-dashboard: ACCOUNT + CREDITS ──────────────────────────────────
const BusinessDashboardPage = ({ onNavigate }) => {
  const [account, setAccount] = useState(() => readBusinessAccount());
  const [loading, setLoading] = useState(false);

  // My Reports state: source list comes from Airtable Business_Reports for
  // the logged-in email; filter/search/date narrow it; pagination slices
  // the narrowed list.
  const [reports, setReports]       = useState([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportsErr, setReportsErr] = useState("");
  const [search, setSearch]         = useState("");
  const [dateFilter, setDateFilter] = useState("all"); // all | month | three
  const [page, setPage]             = useState(1);
  const [downloadingId, setDownloadingId] = useState(null);
  const [toast, setToast]           = useState("");
  const PER_PAGE = 20;

  useEffect(() => {
    if (!account) { onNavigate("/business-login"); return; }
    let cancelled = false;

    // Refresh credits.
    setLoading(true);
    fetchBusinessAccountByEmail(account.email)
      .then(rec => {
        if (cancelled || !rec) return;
        const fresh = normalizeBusinessAccount(rec);
        writeBusinessAccount(fresh);
        setAccount(fresh);
      })
      .catch(e => console.warn("Dashboard refresh failed:", e))
      .finally(() => { if (!cancelled) setLoading(false); });

    // Fetch this account's report history, newest first.
    setReportsLoading(true);
    const formula = encodeURIComponent("LOWER({Email}) = '" + String(account.email).toLowerCase().replace(/'/g, "\\'") + "'");
    const url = `${APIURL}/${BUSINESS_REPORTS_TABLE}?filterByFormula=${formula}&pageSize=100&returnFieldsByFieldId=true`;
    fetch(url, { headers: HDR })
      .then(r => r.ok ? r.json() : Promise.reject(new Error("Failed to load reports")))
      .then(d => {
        if (cancelled) return;
        const rows = (d.records || []).map(rec => ({
          id:        rec.id,
          email:     rec.fields[BIZ_REP_FIELD.Email] || "",
          address:   rec.fields[BIZ_REP_FIELD.Address] || "",
          date:      rec.fields[BIZ_REP_FIELD.Date_Generated] || "",
          facilities:Number(rec.fields[BIZ_REP_FIELD.Facilities_Count] || 0),
          highRisk:  Number(rec.fields[BIZ_REP_FIELD.High_Risk_Count] || 0),
          radius:    Number(rec.fields[BIZ_REP_FIELD.Radius_KM] || 0),
          lat:       Number(rec.fields[BIZ_REP_FIELD.Latitude]),
          lng:       Number(rec.fields[BIZ_REP_FIELD.Longitude]),
          plan:      rec.fields[BIZ_REP_FIELD.Plan] || "",
          name:      rec.fields[BIZ_REP_FIELD.Report_Name] || "",
        }));
        rows.sort((a, b) => (a.date < b.date ? 1 : -1));
        setReports(rows);
      })
      .catch(e => { if (!cancelled) setReportsErr(e.message); })
      .finally(() => { if (!cancelled) setReportsLoading(false); });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset to page 1 whenever the active filter changes.
  useEffect(() => { setPage(1); }, [search, dateFilter]);

  if (!account) return null;

  const isUnlimited = account.creditsMonthly >= 999999;
  const creditsLabel = isUnlimited ? "Unlimited" : String(account.creditsRemaining);

  const signOut = () => {
    clearBusinessAccount();
    onNavigate("/business-login");
  };

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  };

  // Apply date filter then search, both case-insensitive. Date math uses
  // ISO YYYY-MM-DD strings so the comparison is purely lexicographic.
  const now = new Date();
  const startOfMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-01`;
  const threeMonthsAgo = (() => {
    const d = new Date(now); d.setMonth(d.getMonth() - 3); return d.toISOString().slice(0,10);
  })();
  const filtered = reports.filter(r => {
    if (dateFilter === "month" && r.date && r.date < startOfMonth) return false;
    if (dateFilter === "three" && r.date && r.date < threeMonthsAgo) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      if (!String(r.address).toLowerCase().includes(q)) return false;
    }
    return true;
  });
  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));
  const safePage = Math.min(page, pageCount);
  const startIdx = (safePage - 1) * PER_PAGE;
  const endIdx = Math.min(startIdx + PER_PAGE, total);
  const pageRows = filtered.slice(startIdx, endIdx);

  // Re-download: regenerate the PDF from the saved coordinates and radius
  // using fresh facility data. Never deducts a credit.
  const redownload = async (row) => {
    if (downloadingId) return;
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng) || !row.radius) {
      window.alert("This report is missing the coordinates needed to regenerate. Please generate a new report.");
      return;
    }
    setDownloadingId(row.id);
    try {
      const reportFields = [
        "Name","Company","City","State_Region","Country","Address","Facility_Status",
        "Risk_Level","Power_MW","Noise_DB","CO2_Tons_Year","Water_Gal_Day",
        "EMF_Fence_High","EMF_100m","Cooling","Opened","Latitude","Longitude",
      ];
      const allFacs = await apiFetch("Facilities", { "fields[]": reportFields });
      const facsNear = allFacs
        .map(f => {
          const flat = parseFloat(f.Latitude), flng = parseFloat(f.Longitude);
          if (!Number.isFinite(flat) || !Number.isFinite(flng)) return null;
          return { ...f, _km: distanceKm(row.lat, row.lng, flat, flng) };
        })
        .filter(f => f && f._km <= row.radius)
        .sort((a, b) => a._km - b._km);

      const highRiskCount = facsNear.filter(f => String(f.Risk_Level || "").toUpperCase() === "HIGH").length;
      const { doc, datePart } = await buildAreaReportPdf({
        searchAddress: row.address,
        facsNear,
        radiusKm: row.radius,
        facilities100km: facsNear.length,
        highRisk: highRiskCount,
      });
      const filename = `HumZones-Business-Report-${pdfFilenameSafe(row.address)}-${datePart}.pdf`;
      doc.save(filename);
      showToast("Report re-downloaded successfully");
    } catch (e) {
      console.error("Re-download failed:", e);
      window.alert("Something went wrong regenerating that report. Please try again.");
    } finally {
      setDownloadingId(null);
    }
  };

  const inputBase = {
    padding:"11px 14px",borderRadius:10,border:"1.5px solid rgba(255,255,255,.18)",
    fontSize:14,boxSizing:"border-box",outline:"none",fontFamily:"inherit",
    color:"#fff",background:"rgba(255,255,255,.06)",
  };

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",color:"#fff"}}>
      <div style={{padding:"22px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",maxWidth:1100,margin:"0 auto"}}>
        <a href="/" onClick={e=>{e.preventDefault();onNavigate("/");}} style={{textDecoration:"none"}}>
          <span style={{fontSize:22,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
          <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2}}>TM</sup>
        </a>
        <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <a href="/business-profile" onClick={e=>{e.preventDefault();onNavigate("/business-profile");}} style={{fontSize:13,color:"rgba(255,255,255,.7)",fontWeight:700,textDecoration:"none",padding:"8px 12px",borderRadius:10,border:"1px solid rgba(255,255,255,.14)"}}>My Profile</a>
          <a href="/" onClick={e=>{e.preventDefault();onNavigate("/");}} style={{fontSize:13,color:"rgba(255,255,255,.7)",fontWeight:700,textDecoration:"none",padding:"8px 12px",borderRadius:10,border:"1px solid rgba(255,255,255,.14)"}}>Back to HumZones</a>
          <button onClick={signOut} style={{padding:"8px 16px",borderRadius:10,border:"1px solid rgba(255,255,255,.18)",background:"rgba(255,255,255,.06)",color:"rgba(255,255,255,.85)",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700}}>Sign Out</button>
        </div>
      </div>

      <main style={{maxWidth:880,margin:"0 auto",padding:"24px 24px 60px"}}>
        <h1 style={{fontSize:30,fontWeight:900,letterSpacing:"-.01em",marginBottom:6}}>Welcome back {account.firstName || ""}</h1>
        <p style={{fontSize:14,color:"rgba(255,255,255,.6)",marginBottom:28}}>
          {account.company ? `${account.company} - ` : ""}{account.email}
        </p>

        <div style={{background:"linear-gradient(160deg,rgba(249,115,22,.16),rgba(15,23,42,.6))",border:"1.5px solid rgba(249,115,22,.4)",borderRadius:18,padding:"30px",marginBottom:24,boxShadow:"0 20px 50px rgba(249,115,22,.18)"}}>
          <div style={{fontSize:13,color:"#f97316",letterSpacing:".18em",textTransform:"uppercase",fontWeight:800,marginBottom:10}}>Credits</div>
          <div style={{display:"flex",alignItems:"baseline",gap:14,marginBottom:8}}>
            <span style={{fontSize:72,fontWeight:900,letterSpacing:"-.02em",color:"#f97316",lineHeight:1,textShadow:"0 0 28px rgba(249,115,22,.45)"}}>{creditsLabel}</span>
            <span style={{fontSize:17,color:"rgba(255,255,255,.7)",fontWeight:600}}>Reports Remaining</span>
          </div>
          <div style={{fontSize:14,color:"rgba(255,255,255,.65)",marginBottom:20}}>
            {account.plan ? `${account.plan} plan` : "Active plan"}
            {account.renewalDate ? ` - Renews ${account.renewalDate}` : ""}
            {loading ? " - refreshing..." : ""}
          </div>
          <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
            <button onClick={()=>onNavigate("/business-generate")} style={{padding:"14px 26px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:15,fontWeight:900,background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>Generate Report</button>
            <a href="/business" onClick={e=>{e.preventDefault();onNavigate("/business");}} style={{padding:"14px 22px",borderRadius:12,border:"1px solid rgba(255,255,255,.22)",fontFamily:"inherit",fontSize:14,fontWeight:800,background:"rgba(255,255,255,.06)",color:"#fff",textDecoration:"none",display:"inline-flex",alignItems:"center"}}>Need more reports?</a>
          </div>
        </div>

        <div style={{background:"rgba(15,23,42,.55)",border:"1px solid rgba(255,255,255,.1)",borderRadius:16,padding:"24px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,gap:10,flexWrap:"wrap"}}>
            <div style={{fontSize:18,fontWeight:800}}>My Reports</div>
            {!reportsLoading && reports.length > 0 && (
              <div style={{fontSize:13,color:"rgba(255,255,255,.55)"}}>
                {total === 0 ? "No matches" : `Showing ${startIdx + 1}-${endIdx} of ${total} reports`}
              </div>
            )}
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 180px",gap:10,marginBottom:16}}>
            <input
              value={search}
              onChange={e=>setSearch(e.target.value)}
              placeholder="Filter by address..."
              style={inputBase}
            />
            <select value={dateFilter} onChange={e=>setDateFilter(e.target.value)} style={{...inputBase, paddingRight:32}}>
              <option value="all">All Time</option>
              <option value="month">This Month</option>
              <option value="three">Last 3 Months</option>
            </select>
          </div>

          {reportsErr && (
            <div style={{padding:"12px 14px",borderRadius:10,background:"rgba(239,68,68,.12)",border:"1px solid rgba(239,68,68,.4)",color:"#fecaca",fontSize:14,marginBottom:14}}>{reportsErr}</div>
          )}

          {reportsLoading ? (
            <p style={{fontSize:14,color:"rgba(255,255,255,.55)"}}>Loading your reports...</p>
          ) : reports.length === 0 ? (
            <p style={{fontSize:14,color:"rgba(255,255,255,.55)",margin:0}}>No reports generated yet. Click Generate Report to create your first report.</p>
          ) : total === 0 ? (
            <p style={{fontSize:14,color:"rgba(255,255,255,.55)",margin:0}}>No reports match these filters.</p>
          ) : (
            <>
              <ul style={{listStyle:"none",padding:0,margin:0,display:"flex",flexDirection:"column",gap:10}}>
                {pageRows.map(r => (
                  <li key={r.id} style={{padding:"16px 18px",borderRadius:12,background:"rgba(255,255,255,.04)",border:"1px solid rgba(255,255,255,.07)"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:14,flexWrap:"wrap"}}>
                      <div style={{minWidth:0,flex:"1 1 280px"}}>
                        <div style={{fontSize:14,fontWeight:800,color:"#fff",marginBottom:4,overflow:"hidden",textOverflow:"ellipsis"}}>{r.name || r.address || "Report"}</div>
                        {r.name && r.address && (
                          <div style={{fontSize:13,color:"rgba(255,255,255,.65)",marginBottom:6,overflow:"hidden",textOverflow:"ellipsis"}}>{r.address}</div>
                        )}
                        <div style={{fontSize:12,color:"rgba(255,255,255,.55)",display:"flex",gap:14,flexWrap:"wrap"}}>
                          <span>{r.date}</span>
                          <span>{r.facilities} facilities</span>
                          <span>{r.highRisk} high exposure</span>
                          <span>{r.radius}km radius</span>
                          {r.plan && <span>{r.plan}</span>}
                        </div>
                      </div>
                      <button onClick={()=>redownload(r)} disabled={downloadingId === r.id} style={{padding:"10px 16px",borderRadius:10,border:"none",cursor:downloadingId === r.id ? "not-allowed" : "pointer",fontFamily:"inherit",fontSize:13,fontWeight:800,background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",boxShadow:"0 6px 16px rgba(249,115,22,.32)",flexShrink:0}}>
                        {downloadingId === r.id ? "Generating..." : "Re-download"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>

              {pageCount > 1 && (
                <div style={{display:"flex",justifyContent:"center",alignItems:"center",gap:10,marginTop:18}}>
                  <button onClick={()=>setPage(p=>Math.max(1, p-1))} disabled={safePage <= 1} style={{padding:"10px 16px",borderRadius:10,border:"1px solid rgba(249,115,22,.4)",background:safePage <= 1 ? "rgba(255,255,255,.04)" : "rgba(249,115,22,.12)",color:safePage <= 1 ? "rgba(255,255,255,.4)" : "#f97316",cursor:safePage <= 1 ? "not-allowed" : "pointer",fontFamily:"inherit",fontSize:13,fontWeight:800}}>Previous</button>
                  <span style={{fontSize:13,color:"rgba(255,255,255,.7)",padding:"0 8px"}}>Page {safePage} of {pageCount}</span>
                  <button onClick={()=>setPage(p=>Math.min(pageCount, p+1))} disabled={safePage >= pageCount} style={{padding:"10px 16px",borderRadius:10,border:"1px solid rgba(249,115,22,.4)",background:safePage >= pageCount ? "rgba(255,255,255,.04)" : "rgba(249,115,22,.12)",color:safePage >= pageCount ? "rgba(255,255,255,.4)" : "#f97316",cursor:safePage >= pageCount ? "not-allowed" : "pointer",fontFamily:"inherit",fontSize:13,fontWeight:800}}>Next</button>
                </div>
              )}
            </>
          )}
        </div>
      </main>

      <BusinessFooter onNavigate={onNavigate}/>

      {toast && (
        <div role="status" style={{position:"fixed",top:24,left:"50%",transform:"translateX(-50%)",padding:"12px 22px",borderRadius:30,background:"#0f172a",border:"1px solid rgba(249,115,22,.5)",color:"#fff",fontWeight:700,fontSize:14,zIndex:100,boxShadow:"0 18px 50px rgba(0,0,0,.45)"}}>
          {toast}
        </div>
      )}
    </div>
  );
};

// ─── /business-profile: ACCOUNT MANAGEMENT ───────────────────────────────────
// Stripe customer portal link. Placeholder until the real portal URL is
// available; swap this one constant when Stripe provides it.
const STRIPE_PORTAL_URL = "https://billing.stripe.com/p/login/test_yourportallink";

const BusinessProfilePage = ({ onNavigate }) => {
  const [account, setAccount] = useState(() => readBusinessAccount());
  const [firstName, setFirstName] = useState("");
  const [lastName,  setLastName]  = useState("");
  const [company,   setCompany]   = useState("");
  const [saving,    setSaving]    = useState(false);
  const [sendingLink, setSendingLink] = useState(false);
  const [linkSent,  setLinkSent]  = useState(false);
  const [toast,     setToast]     = useState("");
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!account) { onNavigate("/business-login"); return; }
    if (loadedRef.current) return;
    loadedRef.current = true;
    // Seed the editable fields from the cached account immediately, then
    // refresh from Airtable so the subscription panel is accurate.
    setFirstName(account.firstName || "");
    setLastName(account.lastName || "");
    setCompany(account.company || "");
    fetchBusinessAccountByEmail(account.email)
      .then(rec => {
        if (!rec) return;
        const fresh = normalizeBusinessAccount(rec);
        writeBusinessAccount(fresh);
        setAccount(fresh);
        setFirstName(fresh.firstName || "");
        setLastName(fresh.lastName || "");
        setCompany(fresh.company || "");
      })
      .catch(e => console.warn("Profile refresh failed:", e));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!account) return null;

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  };

  const isUnlimited = account.creditsMonthly >= 999999;
  const dirty = firstName !== (account.firstName || "") ||
    lastName !== (account.lastName || "") ||
    company !== (account.company || "");

  const saveChanges = async () => {
    if (saving || !firstName.trim() || !company.trim()) return;
    setSaving(true);
    try {
      await patchBusinessAccount(account.id, {
        [BIZ_FIELD.First_Name]: firstName.trim(),
        [BIZ_FIELD.Last_Name]:  lastName.trim(),
        [BIZ_FIELD.Company]:    company.trim(),
      });
      const next = { ...account, firstName: firstName.trim(), lastName: lastName.trim(), company: company.trim() };
      writeBusinessAccount(next);
      setAccount(next);
      showToast("Profile updated successfully");
    } catch (e) {
      console.error("Profile save failed:", e);
      window.alert("We could not save your changes. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const sendNewLink = async () => {
    if (sendingLink) return;
    setSendingLink(true);
    try {
      const r = await fetch("/api/send-login-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: account.email }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || "Could not send login link.");
      }
      setLinkSent(true);
      showToast("Login link sent. Check your email.");
    } catch (e) {
      window.alert(e.message || "Could not send login link.");
    } finally {
      setSendingLink(false);
    }
  };

  const inputStyle = (val, editable = true) => ({
    width:"100%",padding:"12px 14px",borderRadius:10,
    border:`1.5px solid ${editable ? (String(val).trim()?"#f97316":"rgba(255,255,255,.18)") : "rgba(255,255,255,.1)"}`,
    fontSize:14,boxSizing:"border-box",outline:"none",fontFamily:"inherit",
    color: editable ? "#fff" : "rgba(255,255,255,.55)",
    background: editable ? "rgba(255,255,255,.06)" : "rgba(255,255,255,.03)",
  });
  const sectionStyle = {background:"rgba(15,23,42,.55)",border:"1px solid rgba(255,255,255,.1)",borderRadius:16,padding:"24px",marginBottom:20};
  const sectionTitle = {fontSize:18,fontWeight:800,marginBottom:16};
  const labelStyle = {fontSize:13,fontWeight:700,color:"rgba(255,255,255,.85)",display:"block",marginBottom:6};

  // Read-only subscription rows.
  const subRows = [
    ["Current Plan",            account.plan || "-"],
    ["Status",                  account.status || "-"],
    ["Credits Remaining",       isUnlimited ? "Unlimited" : String(account.creditsRemaining)],
    ["Credits Per Month",       isUnlimited ? "Unlimited" : String(account.creditsMonthly)],
    ["Renewal Date",            account.renewalDate || "-"],
    ["Date Joined",             account.dateJoined || "-"],
    ["Total Reports Generated", String(account.reportsGenerated || 0)],
  ];

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",color:"#fff"}}>
      <div style={{padding:"22px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",maxWidth:1100,margin:"0 auto"}}>
        <a href="/" onClick={e=>{e.preventDefault();onNavigate("/");}} style={{textDecoration:"none"}}>
          <span style={{fontSize:22,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
          <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2}}>TM</sup>
        </a>
        <a href="/business-dashboard" onClick={e=>{e.preventDefault();onNavigate("/business-dashboard");}} style={{fontSize:13,color:"rgba(255,255,255,.7)",fontWeight:700,textDecoration:"none",padding:"8px 12px",borderRadius:10,border:"1px solid rgba(255,255,255,.14)"}}>Back to Dashboard</a>
      </div>

      <main style={{maxWidth:680,margin:"0 auto",padding:"24px 24px 60px"}}>
        <h1 style={{fontSize:30,fontWeight:900,letterSpacing:"-.01em",marginBottom:24}}>My Profile</h1>

        {/* SECTION A - Personal Information */}
        <div style={sectionStyle}>
          <div style={sectionTitle}>Personal Information</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
            <div>
              <label style={labelStyle}>First Name</label>
              <input value={firstName} onChange={e=>setFirstName(e.target.value)} style={inputStyle(firstName)}/>
            </div>
            <div>
              <label style={labelStyle}>Last Name</label>
              <input value={lastName} onChange={e=>setLastName(e.target.value)} style={inputStyle(lastName)}/>
            </div>
          </div>
          <div style={{marginBottom:14}}>
            <label style={labelStyle}>Company Name</label>
            <input value={company} onChange={e=>setCompany(e.target.value)} style={inputStyle(company)}/>
          </div>
          <div style={{marginBottom:6}}>
            <label style={labelStyle}>Email Address</label>
            <input value={account.email} readOnly style={inputStyle(account.email, false)}/>
            <div style={{fontSize:12,color:"rgba(255,255,255,.5)",marginTop:6,lineHeight:1.55}}>
              Your email is your login identifier and cannot be changed. Contact hello@humzones.com if you need to update it.
            </div>
          </div>
          <button onClick={saveChanges} disabled={!dirty || saving || !firstName.trim() || !company.trim()} style={{marginTop:16,padding:"13px 24px",borderRadius:12,border:"none",cursor:(!dirty||saving||!firstName.trim()||!company.trim())?"not-allowed":"pointer",fontFamily:"inherit",fontSize:14,fontWeight:900,letterSpacing:".04em",background:(dirty&&firstName.trim()&&company.trim())?"linear-gradient(135deg,#ef4444,#f97316)":"rgba(255,255,255,.1)",color:"#fff",boxShadow:(dirty&&firstName.trim()&&company.trim())?"0 10px 28px rgba(249,115,22,.4)":"none"}}>
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>

        {/* SECTION B - Subscription Information */}
        <div style={sectionStyle}>
          <div style={sectionTitle}>Subscription Information</div>
          <div style={{display:"flex",flexDirection:"column",gap:2,marginBottom:18}}>
            {subRows.map((r, idx) => (
              <div key={r[0]} style={{display:"flex",justifyContent:"space-between",gap:14,padding:"11px 12px",borderRadius:8,background:idx % 2 === 0 ? "rgba(255,255,255,.04)" : "transparent",fontSize:14}}>
                <span style={{color:"rgba(255,255,255,.6)"}}>{r[0]}</span>
                <span style={{color:"#fff",fontWeight:700,textAlign:"right"}}>{r[1]}</span>
              </div>
            ))}
          </div>
          <a href={STRIPE_PORTAL_URL} target="_blank" rel="noopener noreferrer" style={{display:"inline-block",padding:"13px 24px",borderRadius:12,fontFamily:"inherit",fontSize:14,fontWeight:900,letterSpacing:".04em",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",textDecoration:"none",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>
            Manage or Cancel Subscription
          </a>
        </div>

        {/* SECTION C - Payment Receipts */}
        <div style={sectionStyle}>
          <div style={sectionTitle}>Payment Receipts</div>
          <p style={{fontSize:14,color:"rgba(255,255,255,.7)",lineHeight:1.65,marginBottom:16}}>
            Stripe automatically sends payment receipts to your email address after each charge. Check your inbox at <strong style={{color:"#fff"}}>{account.email}</strong> for all past receipts. If you need a copy resent contact hello@humzones.com and include your subscription start date.
          </p>
          <a href="mailto:hello@humzones.com?subject=Receipt%20Request" style={{display:"inline-block",padding:"13px 24px",borderRadius:12,fontFamily:"inherit",fontSize:14,fontWeight:900,letterSpacing:".04em",background:"rgba(255,255,255,.1)",border:"1px solid rgba(255,255,255,.2)",color:"#fff",textDecoration:"none"}}>
            Contact Support
          </a>
        </div>

        {/* SECTION D - Account Security */}
        <div style={sectionStyle}>
          <div style={sectionTitle}>Login and Security</div>
          <p style={{fontSize:14,color:"rgba(255,255,255,.7)",lineHeight:1.65,marginBottom:16}}>
            HumZones uses secure magic links for authentication. There is no password to manage or reset. Each time you need to sign in simply visit humzones.com/business-login and enter your email address to receive a fresh login link.
          </p>
          <button onClick={sendNewLink} disabled={sendingLink} style={{padding:"13px 24px",borderRadius:12,border:"1px solid rgba(255,255,255,.2)",cursor:sendingLink?"not-allowed":"pointer",fontFamily:"inherit",fontSize:14,fontWeight:900,letterSpacing:".04em",background:"rgba(255,255,255,.1)",color:"#fff"}}>
            {sendingLink ? "Sending..." : "Send Me a New Login Link"}
          </button>
          {linkSent && (
            <p style={{fontSize:13,color:"#86efac",marginTop:12}}>A fresh login link is on its way to {account.email}. Check your inbox.</p>
          )}
        </div>
      </main>

      <BusinessFooter onNavigate={onNavigate}/>

      {toast && (
        <div role="status" style={{position:"fixed",top:24,left:"50%",transform:"translateX(-50%)",padding:"12px 22px",borderRadius:30,background:"#0f172a",border:"1px solid rgba(249,115,22,.5)",color:"#fff",fontWeight:700,fontSize:14,zIndex:100,boxShadow:"0 18px 50px rgba(0,0,0,.45)"}}>
          {toast}
        </div>
      )}
    </div>
  );
};

// ─── COOKIE CONSENT BANNER ───────────────────────────────────────────────────
// Shown once, fixed to the bottom, until the visitor accepts or declines.
// The choice is persisted in localStorage so the banner never reappears.
const COOKIE_CONSENT_KEY = "humzones_cookie_consent";

const CookieConsent = ({ onNavigate }) => {
  const [visible, setVisible] = useState(() => {
    try { return !localStorage.getItem(COOKIE_CONSENT_KEY); } catch { return false; }
  });
  if (!visible) return null;

  const choose = (val) => {
    try { localStorage.setItem(COOKIE_CONSENT_KEY, val); } catch {}
    setVisible(false);
  };

  return (
    <div style={{position:"fixed",left:0,right:0,bottom:0,zIndex:10000,background:"#0a1628",borderTop:"1px solid rgba(249,115,22,.4)",boxShadow:"0 -10px 40px rgba(0,0,0,.5)"}}>
      <style>{`
        @media (max-width: 640px) {
          .hz-cookie-row { flex-direction: column; align-items: stretch !important; }
          .hz-cookie-btns { flex-direction: column; }
          .hz-cookie-btns button { width: 100%; }
        }
      `}</style>
      <div className="hz-cookie-row" style={{maxWidth:1100,margin:"0 auto",padding:"16px 20px",display:"flex",alignItems:"center",gap:18}}>
        <div style={{flexShrink:0}}>
          <span style={{fontSize:18,fontWeight:900,letterSpacing:".06em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
        </div>
        <p style={{flex:1,fontSize:13,color:"rgba(255,255,255,.78)",lineHeight:1.6,margin:0}}>
          We use cookies and local storage to improve your experience and remember your preferences. By continuing to use HumZones you agree to our use of cookies.{" "}
          <a href="/privacy" onClick={e=>{e.preventDefault();onNavigate("/privacy");}} style={{color:"#f97316",fontWeight:700,textDecoration:"none"}}>Privacy Policy</a>
        </p>
        <div className="hz-cookie-btns" style={{display:"flex",gap:10,flexShrink:0}}>
          <button onClick={()=>choose("accepted")} style={{padding:"11px 22px",borderRadius:10,border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:800,background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",boxShadow:"0 8px 22px rgba(249,115,22,.4)"}}>Accept All</button>
          <button onClick={()=>choose("declined")} style={{padding:"11px 22px",borderRadius:10,border:"1px solid rgba(255,255,255,.3)",cursor:"pointer",fontFamily:"inherit",fontSize:14,fontWeight:800,background:"transparent",color:"rgba(255,255,255,.8)"}}>Decline</button>
        </div>
      </div>
    </div>
  );
};

// ─── /privacy: PRIVACY POLICY ────────────────────────────────────────────────
const PrivacyPolicyPage = ({ onNavigate }) => {
  // Each section is a list of blocks: {p} renders a paragraph, {ul} a list.
  const sections = [
    { n:1, title:"Who We Are", blocks:[
      { p:"HumZones Technologies Inc. operates humzones.com, the Global Data Center Health & Infrastructure Registry. We are committed to protecting your privacy and being transparent about how we collect and use your data. For privacy questions contact hello@humzones.com" },
    ]},
    { n:2, title:"Information We Collect", blocks:[
      { p:"We collect the following information:" },
      { ul:[
        "Email address when you unlock search results, submit a community report or purchase a report",
        "Name and company name when you create a business account",
        "Address or location coordinates when you use the Find Data Centers Near Me feature",
        "Payment information processed securely by Stripe. We never see or store your full card details.",
        "Usage data including pages visited and search queries to improve our service",
        "Cookies and local storage data to remember your preferences and session",
      ]},
    ]},
    { n:3, title:"How We Use Your Information", blocks:[
      { p:"We use your information to:" },
      { ul:[
        "Deliver reports and services you have purchased",
        "Send verification and account emails",
        "Improve our database and research",
        "Send occasional updates about new features (you can unsubscribe at any time)",
        "Comply with legal obligations",
      ]},
    ]},
    { n:4, title:"Who We Share Your Information With", blocks:[
      { p:"We share data with these trusted service providers only:" },
      { ul:[
        "Stripe (stripe.com) for payment processing",
        "Airtable (airtable.com) for secure data storage",
        "Vercel (vercel.com) for website hosting",
        "Namecheap Private Email for sending emails",
      ]},
      { p:"We do not sell your personal data to any third party under any circumstances." },
    ]},
    { n:5, title:"Data Retention", blocks:[
      { p:"We retain your data for as long as your account is active or as needed to provide services. You may request deletion of your data at any time by contacting hello@humzones.com. We will delete your data within 30 days of your request." },
    ]},
    { n:6, title:"Your Rights", blocks:[
      { p:"Depending on your location you may have the right to:" },
      { ul:[
        "Access the personal data we hold about you",
        "Correct inaccurate data",
        "Request deletion of your data",
        "Withdraw consent at any time",
        "Lodge a complaint with your local data protection authority",
      ]},
      { p:"To exercise any of these rights contact hello@humzones.com" },
    ]},
    { n:7, title:"Cookies and Local Storage", blocks:[
      { p:"We use cookies and browser local storage to:" },
      { ul:[
        "Remember your search preferences",
        "Keep you logged in to your business account",
        "Remember your cookie consent choice",
        "Cache facility data for faster loading",
      ]},
      { p:"You can clear cookies and local storage at any time through your browser settings." },
    ]},
    { n:8, title:"International Visitors", blocks:[
      { p:"HumZones is operated from Canada and serves visitors worldwide including the European Union, United Kingdom, United States and other countries. By using our site you consent to your data being processed in accordance with this policy. We comply with GDPR, CASL and applicable data protection laws." },
    ]},
    { n:9, title:"Children", blocks:[
      { p:"HumZones is not directed at children under the age of 16. We do not knowingly collect personal data from children." },
    ]},
    { n:10, title:"Changes to This Policy", blocks:[
      { p:"We may update this privacy policy from time to time. We will notify registered users of significant changes by email. Continued use of the site after changes constitutes acceptance of the updated policy." },
    ]},
    { n:11, title:"Contact", blocks:[
      { p:"For any privacy questions or data requests contact:" },
      { p:"HumZones Technologies Inc.\nhello@humzones.com\nhumzones.com" },
    ]},
  ];

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",color:"#fff"}}>
      <div style={{padding:"22px 24px",maxWidth:820,margin:"0 auto"}}>
        <a href="/" onClick={e=>{e.preventDefault();onNavigate("/");}} style={{textDecoration:"none"}}>
          <span style={{fontSize:22,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
          <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2}}>TM</sup>
        </a>
      </div>

      <main style={{maxWidth:820,margin:"0 auto",padding:"16px 24px 80px"}}>
        <h1 style={{fontSize:"clamp(32px,5vw,44px)",fontWeight:900,letterSpacing:"-.02em",marginBottom:8}}>Privacy Policy</h1>
        <p style={{fontSize:14,color:"rgba(255,255,255,.55)",marginBottom:32}}>Last updated: May 2026</p>

        {sections.map(s => (
          <section key={s.n} style={{marginBottom:30}}>
            <h2 style={{fontSize:20,fontWeight:800,color:"#f97316",marginBottom:12}}>{s.n}. {s.title}</h2>
            {s.blocks.map((b, i) => b.ul ? (
              <ul key={i} style={{listStyle:"none",padding:0,margin:"0 0 12px 0",display:"flex",flexDirection:"column",gap:8}}>
                {b.ul.map(item => (
                  <li key={item} style={{display:"flex",alignItems:"flex-start",gap:10,fontSize:15,color:"rgba(255,255,255,.82)",lineHeight:1.6}}>
                    <span style={{flexShrink:0,width:6,height:6,borderRadius:"50%",background:"#f97316",marginTop:8}}/>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p key={i} style={{fontSize:15,color:"rgba(255,255,255,.82)",lineHeight:1.7,marginBottom:12,whiteSpace:"pre-line"}}>{b.p}</p>
            ))}
          </section>
        ))}

        <button onClick={()=>onNavigate("/")} style={{marginTop:12,padding:"14px 26px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:15,fontWeight:900,background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>Back to HumZones</button>
      </main>
    </div>
  );
};

// ─── /unsubscribe: EMAIL OPT-OUT ─────────────────────────────────────────────
const UnsubscribePage = ({ onNavigate }) => {
  const email = (new URLSearchParams(window.location.search).get("email") || "").trim();
  const [status, setStatus] = useState(email ? "confirm" : "noemail"); // confirm | working | done | noemail

  const confirm = async () => {
    setStatus("working");
    const lc = email.toLowerCase().replace(/'/g, "\\'");
    // Emails table: flag every row matching this address.
    try {
      const rows = await apiFetch(EMAILS_TABLE, { filterByFormula: `LOWER({Email}) = '${lc}'` });
      for (const row of rows) {
        await fetch(`${APIURL}/${EMAILS_TABLE}/${row.id}`, {
          method: "PATCH",
          headers: HDR,
          body: JSON.stringify({ fields: { [EMAIL_FIELD.Unsubscribed]: true } }),
        }).catch(e => console.warn("Emails unsubscribe patch failed:", e));
      }
    } catch (e) { console.warn("Emails unsubscribe lookup failed:", e); }
    // Business_Accounts: flag the account if one exists.
    try {
      const rec = await fetchBusinessAccountByEmail(email);
      if (rec) await patchBusinessAccount(rec.id, { [BIZ_FIELD.Unsubscribed]: true });
    } catch (e) { console.warn("Business unsubscribe failed:", e); }
    setStatus("done");
  };

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",color:"#fff"}}>
      <div style={{padding:"22px 24px",textAlign:"center"}}>
        <a href="/" onClick={e=>{e.preventDefault();onNavigate("/");}} style={{textDecoration:"none"}}>
          <span style={{fontSize:22,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
          <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2}}>TM</sup>
        </a>
      </div>

      <main style={{maxWidth:520,margin:"0 auto",padding:"40px 24px 80px",textAlign:"center"}}>
        {status === "noemail" && (
          <>
            <h1 style={{fontSize:26,fontWeight:900,marginBottom:14}}>Unsubscribe</h1>
            <p style={{fontSize:15,color:"rgba(255,255,255,.72)",lineHeight:1.65,marginBottom:24}}>No email address was provided. Please use the unsubscribe link from one of our emails.</p>
            <button onClick={()=>onNavigate("/")} style={{padding:"14px 26px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:15,fontWeight:900,background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>Back to HumZones</button>
          </>
        )}

        {(status === "confirm" || status === "working") && (
          <>
            <h1 style={{fontSize:26,fontWeight:900,marginBottom:16,lineHeight:1.3}}>
              Are you sure you want to unsubscribe {email} from HumZones emails?
            </h1>
            <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap",marginTop:24}}>
              <button onClick={confirm} disabled={status === "working"} style={{padding:"14px 24px",borderRadius:12,border:"none",cursor:status==="working"?"wait":"pointer",fontFamily:"inherit",fontSize:15,fontWeight:900,background:"linear-gradient(135deg,#dc2626,#ef4444)",color:"#fff",boxShadow:"0 10px 28px rgba(239,68,68,.4)"}}>
                {status === "working" ? "Unsubscribing..." : "Yes, Unsubscribe Me"}
              </button>
              <button onClick={()=>onNavigate("/")} disabled={status === "working"} style={{padding:"14px 24px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:15,fontWeight:900,background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>
                No, Keep Me Subscribed
              </button>
            </div>
          </>
        )}

        {status === "done" && (
          <>
            <div style={{width:72,height:72,borderRadius:"50%",background:"linear-gradient(135deg,#10b981,#059669)",margin:"10px auto 22px",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <h1 style={{fontSize:26,fontWeight:900,marginBottom:14}}>You have been unsubscribed</h1>
            <p style={{fontSize:15,color:"rgba(255,255,255,.72)",lineHeight:1.65,marginBottom:24}}>You will no longer receive emails from HumZones.</p>
            <button onClick={()=>onNavigate("/")} style={{padding:"14px 26px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:15,fontWeight:900,background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>Back to HumZones</button>
          </>
        )}
      </main>
    </div>
  );
};

// ─── /my-report: SECURE PAID REPORT RETRIEVAL ────────────────────────────────
// Three steps: enter the purchase email, verify a 6-digit code emailed to
// that address, then list and re-download every paid report on the account.
const MyReportPage = ({ onNavigate }) => {
  const [step, setStep] = useState("email"); // email | code | reports
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [reports, setReports] = useState([]);
  const [busy, setBusy] = useState(false);
  const [emailErr, setEmailErr] = useState("");
  const [codeErr, setCodeErr] = useState("");
  const [codeAttempts, setCodeAttempts] = useState(0);
  const [expiryTs, setExpiryTs] = useState(0);
  const [nowTick, setNowTick] = useState(Date.now());
  const [downloadingId, setDownloadingId] = useState(null);
  const [toast, setToast] = useState("");

  // Drive the verification-code countdown while on the code step.
  useEffect(() => {
    if (step !== "code") return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [step]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  };

  // Fetch every PaidReport row for an email, newest first, keyed by field ID.
  const fetchPaidReports = async (addr) => {
    const lc = addr.trim().toLowerCase().replace(/'/g, "\\'");
    const rows = await apiFetch(EMAILS_TABLE, {
      returnFieldsByFieldId: true,
      filterByFormula: `AND(LOWER({Email}) = '${lc}', {Source} = 'PaidReport')`,
    });
    return rows
      .map(r => ({
        id:        r.id,
        address:   r[EMAIL_FIELD.Address] || "Your area",
        date:      r[EMAIL_FIELD.Date] || "",
        facilities:r[EMAIL_FIELD.Facilities_Count],
        highRisk:  r[EMAIL_FIELD.High_Risk_Count],
        lat:       Number(r[EMAIL_FIELD.Latitude]),
        lng:       Number(r[EMAIL_FIELD.Longitude]),
        radius:    Number(r[EMAIL_FIELD.Radius_KM]) || 100,
        verifyCode:   r[EMAIL_FIELD.Verify_Code],
        verifyExpiry: r[EMAIL_FIELD.Verify_Code_Expiry],
      }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  };

  // Generate, persist and email a fresh 6-digit code against the most recent
  // PaidReport row. Shared by the initial send and the resend link.
  const issueCode = async (rows) => {
    const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiryMs = Date.now() + 10 * 60 * 1000;
    await fetch(`${APIURL}/${EMAILS_TABLE}/${rows[0].id}`, {
      method: "PATCH",
      headers: HDR,
      body: JSON.stringify({ fields: {
        [EMAIL_FIELD.Verify_Code]: verifyCode,
        [EMAIL_FIELD.Verify_Code_Expiry]: new Date(expiryMs).toISOString(),
      } }),
    });
    await fetch("/api/send-report-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim(), code: verifyCode }),
    }).catch(e => console.warn("send-report-code failed:", e));
    setExpiryTs(expiryMs);
  };

  const sendCode = async () => {
    if (!email.trim() || busy) return;
    setBusy(true);
    setEmailErr("");
    try {
      const rows = await fetchPaidReports(email);
      if (!rows.length) {
        setEmailErr("No reports found for this email address. If you believe this is an error contact hello@humzones.com");
        return;
      }
      setReports(rows);
      await issueCode(rows);
      setCode("");
      setCodeErr("");
      setCodeAttempts(0);
      setStep("code");
    } catch (e) {
      console.error("Report code request failed:", e);
      setEmailErr("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const resendCode = async () => {
    if (busy || !reports.length) return;
    setBusy(true);
    setCodeErr("");
    try {
      await issueCode(reports);
      setCode("");
      setCodeAttempts(0);
      showToast("A new code is on its way.");
    } catch (e) {
      console.error("Resend failed:", e);
      setCodeErr("Could not resend the code. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async () => {
    if (busy || codeAttempts >= 3 || !/^[0-9]{6}$/.test(code.trim())) return;
    setBusy(true);
    setCodeErr("");
    try {
      // Re-read the most recent row so the check always reflects Airtable.
      const rows = await fetchPaidReports(email);
      const latest = rows[0];
      const ok = latest &&
        latest.verifyCode && String(latest.verifyCode) === code.trim() &&
        latest.verifyExpiry && new Date(latest.verifyExpiry).getTime() > Date.now();
      if (ok) {
        setReports(rows);
        setStep("reports");
      } else {
        const n = codeAttempts + 1;
        setCodeAttempts(n);
        setCodeErr("Invalid or expired code. Please request a new one.");
      }
    } catch (e) {
      console.error("Code verification failed:", e);
      setCodeErr("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const redownload = async (row) => {
    if (downloadingId) return;
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) {
      window.alert("This report is missing the coordinates needed to regenerate it. Please contact hello@humzones.com.");
      return;
    }
    setDownloadingId(row.id);
    try {
      const reportFields = [
        "Name","Company","City","State_Region","Country","Address","Facility_Status",
        "Risk_Level","Power_MW","Noise_DB","CO2_Tons_Year","Water_Gal_Day",
        "EMF_Fence_High","EMF_100m","Cooling","Opened","Latitude","Longitude",
      ];
      const allFacs = await apiFetch("Facilities", { "fields[]": reportFields });
      const facsNear = allFacs
        .map(f => {
          const flat = parseFloat(f.Latitude), flng = parseFloat(f.Longitude);
          if (!Number.isFinite(flat) || !Number.isFinite(flng)) return null;
          return { ...f, _km: distanceKm(row.lat, row.lng, flat, flng) };
        })
        .filter(f => f && f._km <= row.radius)
        .sort((a, b) => a._km - b._km);
      const highRiskCount = facsNear.filter(f => String(f.Risk_Level || "").toUpperCase() === "HIGH").length;
      const { doc, datePart } = await buildAreaReportPdf({
        searchAddress: row.address,
        facsNear,
        radiusKm: row.radius,
        facilities100km: facsNear.length,
        highRisk: highRiskCount,
      });
      doc.save(`HumZones-Report-${pdfFilenameSafe(row.address)}-${datePart}.pdf`);
      showToast("Your report is downloading");
    } catch (e) {
      console.error("Re-download failed:", e);
      window.alert("Something went wrong regenerating your report. Please try again.");
    } finally {
      setDownloadingId(null);
    }
  };

  const secsLeft = Math.max(0, Math.round((expiryTs - nowTick) / 1000));
  const mm = String(Math.floor(secsLeft / 60)).padStart(2, "0");
  const ss = String(secsLeft % 60).padStart(2, "0");
  const codeLocked = codeAttempts >= 3;

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",color:"#fff"}}>
      <div style={{padding:"22px 24px"}}>
        <a href="/" onClick={e=>{e.preventDefault();onNavigate("/");}} style={{textDecoration:"none"}}>
          <span style={{fontSize:22,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
          <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2}}>TM</sup>
        </a>
      </div>

      <main style={{maxWidth:560,margin:"0 auto",padding:"24px 24px 80px"}}>

        {step === "email" && (
          <div style={{background:"rgba(15,23,42,.55)",border:"1px solid rgba(255,255,255,.1)",borderRadius:16,padding:"28px"}}>
            <h1 style={{fontSize:26,fontWeight:900,letterSpacing:"-.01em",marginBottom:8}}>Retrieve Your Reports</h1>
            <p style={{fontSize:15,color:"rgba(255,255,255,.72)",lineHeight:1.6,marginBottom:18}}>Enter the email address you used when purchasing your report. We will send you a secure 6-digit verification code.</p>
            <input
              type="email"
              value={email}
              onChange={e=>setEmail(e.target.value)}
              onKeyDown={e=>{ if (e.key === "Enter") sendCode(); }}
              placeholder="Your purchase email address"
              style={{width:"100%",padding:"13px 16px",borderRadius:10,border:`1.5px solid ${email.trim()?"#f97316":"rgba(255,255,255,.18)"}`,fontSize:15,boxSizing:"border-box",outline:"none",fontFamily:"inherit",color:"#fff",background:"rgba(255,255,255,.06)",marginBottom:14}}
            />
            <button onClick={sendCode} disabled={!email.trim() || busy} style={{width:"100%",padding:"15px 22px",borderRadius:12,border:"none",cursor:(!email.trim()||busy)?"not-allowed":"pointer",fontFamily:"inherit",fontSize:15,fontWeight:900,letterSpacing:".04em",background:email.trim()?"linear-gradient(135deg,#ef4444,#f97316)":"rgba(255,255,255,.1)",color:"#fff",boxShadow:email.trim()?"0 10px 28px rgba(249,115,22,.4)":"none"}}>
              {busy ? "Sending..." : "Send Verification Code"}
            </button>
            <p style={{fontSize:12,color:"rgba(255,255,255,.5)",marginTop:12,lineHeight:1.55}}>Check your spam folder if you do not receive the code within a few minutes.</p>
            {emailErr && (
              <div style={{marginTop:14,padding:"12px 14px",borderRadius:10,background:"rgba(239,68,68,.12)",border:"1px solid rgba(239,68,68,.4)",color:"#fecaca",fontSize:14,lineHeight:1.6}}>{emailErr}</div>
            )}
            <p style={{fontSize:13,color:"rgba(255,255,255,.55)",marginTop:16,paddingTop:14,borderTop:"1px solid rgba(255,255,255,.08)"}}>
              Need help? Contact hello@humzones.com
            </p>
          </div>
        )}

        {step === "code" && (
          <div style={{background:"rgba(15,23,42,.55)",border:"1px solid rgba(255,255,255,.1)",borderRadius:16,padding:"28px"}}>
            <h1 style={{fontSize:26,fontWeight:900,letterSpacing:"-.01em",marginBottom:8}}>Check Your Email</h1>
            <p style={{fontSize:15,color:"rgba(255,255,255,.72)",lineHeight:1.6,marginBottom:18}}>We sent a 6-digit code to {email}. Enter it below.</p>
            {codeErr && (
              <div style={{padding:"12px 14px",borderRadius:10,background:"rgba(239,68,68,.12)",border:"1px solid rgba(239,68,68,.4)",color:"#fecaca",fontSize:14,marginBottom:14}}>{codeErr}</div>
            )}
            {codeLocked && (
              <div style={{padding:"12px 14px",borderRadius:10,background:"rgba(239,68,68,.12)",border:"1px solid rgba(239,68,68,.4)",color:"#fecaca",fontSize:14,marginBottom:14}}>Too many failed attempts. Please request a new code.</div>
            )}
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={e=>setCode(e.target.value.replace(/[^0-9]/g, ""))}
              onKeyDown={e=>{ if (e.key === "Enter") verifyCode(); }}
              disabled={codeLocked}
              placeholder="000000"
              style={{width:"100%",padding:"16px",borderRadius:10,border:`1.5px solid ${/^[0-9]{6}$/.test(code)?"#f97316":"rgba(255,255,255,.18)"}`,fontSize:32,letterSpacing:"12px",textAlign:"center",boxSizing:"border-box",outline:"none",fontFamily:"inherit",fontWeight:900,color:"#fff",background:"rgba(255,255,255,.06)",marginBottom:8,opacity:codeLocked?.5:1}}
            />
            <div style={{fontSize:13,color:"rgba(255,255,255,.55)",textAlign:"center",marginBottom:14}}>
              {secsLeft > 0 ? `Code expires in ${mm}:${ss}` : "Your code has expired. Request a new one."}
            </div>
            <button onClick={verifyCode} disabled={busy || codeLocked || !/^[0-9]{6}$/.test(code)} style={{width:"100%",padding:"15px 22px",borderRadius:12,border:"none",cursor:(busy||codeLocked||!/^[0-9]{6}$/.test(code))?"not-allowed":"pointer",fontFamily:"inherit",fontSize:15,fontWeight:900,letterSpacing:".04em",background:(/^[0-9]{6}$/.test(code)&&!codeLocked)?"linear-gradient(135deg,#ef4444,#f97316)":"rgba(255,255,255,.1)",color:"#fff",boxShadow:(/^[0-9]{6}$/.test(code)&&!codeLocked)?"0 10px 28px rgba(249,115,22,.4)":"none"}}>
              {busy ? "Verifying..." : "Verify and Show My Reports"}
            </button>
            <p style={{fontSize:13,color:"rgba(255,255,255,.55)",textAlign:"center",marginTop:14}}>
              <a href="/my-report" onClick={e=>{e.preventDefault();resendCode();}} style={{color:"#f97316",fontWeight:700,textDecoration:"none",cursor:"pointer"}}>Resend code</a>
            </p>
          </div>
        )}

        {step === "reports" && (
          <>
            <h1 style={{fontSize:26,fontWeight:900,letterSpacing:"-.01em",marginBottom:8}}>Your Reports</h1>
            <p style={{fontSize:15,color:"rgba(255,255,255,.72)",lineHeight:1.6,marginBottom:6}}>All reports purchased with {email}. Re-download any report at any time.</p>
            <p style={{fontSize:13,color:"rgba(255,255,255,.5)",marginBottom:18}}>You have {reports.length} {reports.length === 1 ? "report" : "reports"} in your account</p>
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {reports.map(r => (
                <div key={r.id} style={{background:"rgba(15,23,42,.55)",border:"1px solid rgba(255,255,255,.08)",borderRadius:14,padding:"18px 20px"}}>
                  <div style={{fontSize:15,fontWeight:800,color:"#fff",marginBottom:6,wordBreak:"break-word"}}>{r.address}</div>
                  <div style={{fontSize:13,color:"rgba(255,255,255,.6)",display:"flex",gap:14,flexWrap:"wrap",marginBottom:14}}>
                    {r.date && <span>Purchased {r.date}</span>}
                    {r.facilities != null && <span>{r.facilities} facilities</span>}
                    {r.highRisk != null && <span>{r.highRisk} high exposure</span>}
                  </div>
                  <button onClick={()=>redownload(r)} disabled={downloadingId === r.id} style={{padding:"11px 20px",borderRadius:10,border:"none",cursor:downloadingId === r.id ? "not-allowed" : "pointer",fontFamily:"inherit",fontSize:14,fontWeight:800,background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",boxShadow:"0 6px 18px rgba(249,115,22,.34)"}}>
                    {downloadingId === r.id ? "Generating..." : "Re-download Report"}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </main>

      {toast && (
        <div role="status" style={{position:"fixed",top:24,left:"50%",transform:"translateX(-50%)",padding:"12px 22px",borderRadius:30,background:"#0f172a",border:"1px solid rgba(249,115,22,.5)",color:"#fff",fontWeight:700,fontSize:14,zIndex:100,boxShadow:"0 18px 50px rgba(0,0,0,.45)"}}>
          {toast}
        </div>
      )}
    </div>
  );
};

// ─── /submit-report: STANDALONE RESIDENT REPORT PAGE ─────────────────────────
// A dedicated page for submitting a resident report from anywhere on the site.
// Loads the Facilities table, lets the visitor narrow by country/region/city,
// pick a facility, and submit through the same verification flow as the
// in-facility form (honeypot, 15-second gate, /api/send-verification).
const SubmitReportPage = ({ onNavigate }) => {
  const [facs, setFacs]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [country, setCountry] = useState("");
  const [region, setRegion]   = useState("");
  const [city, setCity]       = useState("");
  const [found, setFound]     = useState(null); // null until Find Facilities runs

  const [facilityName, setFacilityName]     = useState("");
  const [facilityLocked, setFacilityLocked] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName]   = useState("");
  const [email, setEmail]         = useState("");
  const [duration, setDuration]   = useState("");
  const [symptoms, setSymptoms]   = useState([]);
  const [reportText, setReportText] = useState("");
  const [declared, setDeclared]   = useState(false);
  const [human, setHuman]         = useState(false);
  const [hp, setHp]               = useState(""); // honeypot ("website" field)
  const [sending, setSending]     = useState(false);
  const [sent, setSent]           = useState(false);
  const [sentEmail, setSentEmail] = useState("");

  const formRef = useRef(null);
  // Form-load timestamp for the 15-second minimum gate.
  const formLoadTimeRef = useRef(Date.now());
  const MAX_REPORT_CHARS = 3000;
  const SYMPTOM_OPTIONS = [
    "Headaches","Sleep disruption","Dizziness or vertigo","Nausea",
    "Ear ringing (tinnitus)","Anxiety or panic","Diesel exhaust smell","Chest pressure or tightness",
  ];
  const toggleSymptom = (s) => setSymptoms(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);

  useEffect(() => {
    let alive = true;
    cachedFetch("Facilities", { "fields[]": FACILITY_LIST_FIELDS })
      .then(rows => { if (alive) { setFacs(rows); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const countries = [...new Set(facs.map(f => f.Country).filter(Boolean))].sort();
  const regions   = country
    ? [...new Set(facs.filter(f => f.Country === country).map(f => f.State_Region).filter(Boolean))].sort()
    : [];
  const cities    = country
    ? [...new Set(facs.filter(f => f.Country === country && (!region || f.State_Region === region)).map(f => f.City).filter(Boolean))].sort()
    : [];

  const findFacilities = () => {
    if (!country) return;
    const matches = facs
      .filter(f => f.Country === country && (!region || f.State_Region === region) && (!city || f.City === city))
      .sort((a, b) => (a.Name || "").localeCompare(b.Name || ""));
    setFound(matches);
  };

  const pickFacility = (name) => {
    setFacilityName(name);
    setFacilityLocked(true);
    setTimeout(() => { if (formRef.current) formRef.current.scrollIntoView({ behavior: "smooth", block: "start" }); }, 60);
  };

  const canSubmit = facilityName.trim() && firstName.trim() && email.trim() && reportText.trim() && declared && human;

  const submit = async () => {
    if (!canSubmit) return;
    // Honeypot: bots fill the hidden "website" field. Silently accept so they
    // get no feedback.
    if (hp) { setSentEmail(email.trim()); setSent(true); return; }
    // 15-second minimum: a human cannot meaningfully fill the form faster.
    if (Date.now() - (formLoadTimeRef.current || 0) < 15000) { setSentEmail(email.trim()); setSent(true); return; }

    setSending(true);
    const addr = [city, region, country].filter(Boolean).join(", ");
    try {
      const r = await fetch("/api/send-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email:        email.trim(),
          firstName:    firstName.trim(),
          lastName:     lastName.trim(),
          facilityName: facilityName.trim(),
          reportText,
          address:      addr,
          city:         city || "",
          country:      country || "",
          symptoms:     symptoms.join(", "),
          duration:     duration.trim(),
        }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `Could not send verification email (${r.status})`);
      }
      setSentEmail(email.trim());
      setSent(true);
    } catch (e) {
      console.error("send-verification failed:", e);
      window.alert("We could not send the verification email. Please try again, or contact us if it keeps failing.");
    } finally {
      setSending(false);
    }
  };

  const selStyle = {
    width:"100%", padding:"15px 16px", fontSize:15, fontFamily:"inherit",
    borderRadius:12, border:"1.5px solid rgba(255,255,255,.18)",
    background:"#1e293b", color:"#fff", outline:"none", cursor:"pointer", boxSizing:"border-box",
  };
  const lbl = { fontSize:13, fontWeight:700, color:"#374151", display:"block", marginBottom:6 };
  const inp = (v) => ({
    width:"100%", padding:"13px 16px", borderRadius:10,
    border:`1.5px solid ${v && v.trim() ? "#3b82f6" : "#e2e8f0"}`,
    fontSize:15, boxSizing:"border-box", outline:"none", fontFamily:"inherit", color:"#1e293b",
  });

  return (
    <div style={{minHeight:"100vh",background:"#f1f5f9",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>
      {/* HERO */}
      <section style={{background:"linear-gradient(150deg,#020c1b 0%,#0f172a 45%,#1e0535 100%)",padding:"22px 24px 56px"}}>
        <div style={{maxWidth:1080,margin:"0 auto"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,marginBottom:34}}>
            <button onClick={()=>window.history.back()} className="back-btn" aria-label="Go back" style={{display:"inline-flex",alignItems:"center",gap:8,background:"rgba(255,255,255,.08)",border:"1px solid rgba(255,255,255,.20)",color:"#fff",padding:"12px 20px",borderRadius:10,fontSize:14,fontWeight:800,letterSpacing:".05em",cursor:"pointer",fontFamily:"inherit"}}>
              <span style={{fontSize:17,lineHeight:1}}>&larr;</span> Back
            </button>
            <a href="/" onClick={e=>{e.preventDefault();onNavigate("/");}} style={{textDecoration:"none"}}>
              <span style={{fontSize:22,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
              <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2}}>TM</sup>
            </a>
          </div>
          <div style={{textAlign:"center",maxWidth:760,margin:"0 auto 30px"}}>
            <h1 style={{fontSize:"clamp(30px,5vw,46px)",fontWeight:900,letterSpacing:"-.02em",color:"#fff",lineHeight:1.15,marginBottom:16}}>Submit Your Resident Report</h1>
            <p style={{fontSize:17,color:"rgba(255,255,255,.72)",lineHeight:1.65}}>Have you experienced the effects of living or working near a data center? Your report helps others in your community understand what life is really like near these facilities.</p>
          </div>
          <div style={{maxWidth:820,margin:"0 auto"}}>
            <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
              <div style={{flex:"1 1 200px"}}>
                <select value={country} onChange={e=>{setCountry(e.target.value);setRegion("");setCity("");setFound(null);}} style={selStyle} disabled={loading}>
                  <option value="">{loading?"Loading countries...":"Select a country"}</option>
                  {countries.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div style={{flex:"1 1 200px"}}>
                <select value={region} onChange={e=>{setRegion(e.target.value);setCity("");}} style={{...selStyle,opacity:country?1:.5,cursor:country?"pointer":"not-allowed"}} disabled={!country}>
                  <option value="">{country?"All states / provinces":"Select country first"}</option>
                  {regions.map(r=><option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div style={{flex:"1 1 200px"}}>
                <select value={city} onChange={e=>setCity(e.target.value)} style={{...selStyle,opacity:country?1:.5,cursor:country?"pointer":"not-allowed"}} disabled={!country}>
                  <option value="">{country?"All cities":"Select country first"}</option>
                  {cities.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div style={{textAlign:"center",marginTop:18}}>
              <button onClick={findFacilities} disabled={!country} style={{padding:"15px 42px",borderRadius:12,border:"none",background:country?"linear-gradient(135deg,#ef4444,#f97316)":"rgba(255,255,255,.12)",color:country?"#fff":"rgba(255,255,255,.4)",fontSize:16,fontWeight:900,letterSpacing:".02em",cursor:country?"pointer":"default",fontFamily:"inherit",boxShadow:country?"0 10px 28px rgba(249,115,22,.4)":"none"}}>
                Find Facilities
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* RESULTS */}
      {found !== null && (
        <section style={{maxWidth:1080,margin:"0 auto",padding:"40px 24px 8px"}}>
          <h2 style={{fontSize:22,fontWeight:900,color:"#0f172a",marginBottom:6}}>
            {found.length} {found.length===1?"facility":"facilities"} found
          </h2>
          <p style={{fontSize:15,color:"#64748b",marginBottom:22,lineHeight:1.6}}>Select a facility to submit a report about it, or scroll down to type a facility name yourself.</p>
          {found.length===0 ? (
            <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,padding:"22px",fontSize:15,color:"#64748b",lineHeight:1.65}}>No facilities found for that selection. You can still submit a report by typing the facility name in the form below.</div>
          ) : (
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:16}}>
              {found.map(f=>(
                <div key={f.id} style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:16,padding:"20px",boxShadow:"0 2px 12px rgba(0,0,0,.05)",display:"flex",flexDirection:"column",gap:9}}>
                  <div style={{fontSize:16,fontWeight:800,color:"#0f172a",lineHeight:1.3}}>{f.Name||"Unnamed facility"}</div>
                  {f.Company && <div style={{fontSize:13,color:"#64748b"}}>{f.Company}</div>}
                  <div style={{fontSize:13,color:"#94a3b8"}}>{[f.City,f.State_Region].filter(Boolean).join(", ")||"Location not on file"}</div>
                  <div><Chip label={exposureLabel(f.Risk_Level)} color={exposureColor(f.Risk_Level)} small/></div>
                  <button onClick={()=>pickFacility(f.Name||"")} style={{marginTop:"auto",padding:"11px 16px",borderRadius:10,border:"none",background:"#f97316",color:"#fff",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit"}}>
                    Submit Report for This Facility
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* REPORT FORM */}
      <section ref={formRef} style={{maxWidth:760,margin:"0 auto",padding:"40px 24px 72px"}}>
        <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:18,padding:"32px 32px 34px",boxShadow:"0 4px 24px rgba(0,0,0,.07)"}}>
          <h2 style={{fontSize:24,fontWeight:900,color:"#0f172a",marginBottom:8}}>Your Report</h2>
          {sent ? (
            <div style={{background:"#f0fdf4",border:"2px solid #bbf7d0",borderRadius:14,padding:"22px"}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                <Icon name="check" size={22} color="#15803d"/>
                <div style={{fontSize:18,fontWeight:800,color:"#15803d"}}>Almost done!</div>
              </div>
              <p style={{fontSize:15,color:"#166534",lineHeight:1.7,margin:0}}>We sent a verification email to <strong>{sentEmail||"your inbox"}</strong>. Click the link in that email to publish your report. Check your spam folder if you do not see it within a few minutes.</p>
            </div>
          ) : (
            <>
              <p style={{fontSize:15,color:"#0f172a",fontWeight:800,marginBottom:8}}>Fields marked with an asterisk are required</p>
              <p style={{fontSize:14,color:"#64748b",lineHeight:1.7,marginBottom:24}}>Reports submitted here are reviewed by HumZones and may be shared with regulatory bodies as part of our verified resident health registry. A verified email address and signed declaration make your report credible to regulators and public health authorities.</p>
              {/* Honeypot field, hidden from humans, visible to bots. */}
              <input type="text" name="website" value={hp} onChange={e=>setHp(e.target.value)} tabIndex="-1" autoComplete="off" aria-hidden="true" style={{display:"none"}}/>

              {/* 1. Facility Name */}
              <div style={{marginBottom:16}}>
                <label style={lbl}>Facility Name *</label>
                <input value={facilityName} onChange={e=>setFacilityName(e.target.value)} readOnly={facilityLocked}
                  placeholder="Name of the data center facility"
                  style={{...inp(facilityName),background:facilityLocked?"#f1f5f9":"#fff"}}/>
                {facilityLocked && (
                  <button onClick={()=>setFacilityLocked(false)} style={{marginTop:6,background:"transparent",border:"none",color:"#f97316",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit",padding:0}}>
                    Edit facility name
                  </button>
                )}
              </div>

              {/* 2 + 3. First and Last Name */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:6}}>
                <div>
                  <label style={lbl}>First Name *</label>
                  <input value={firstName} onChange={e=>setFirstName(e.target.value)} placeholder="Your first name" style={inp(firstName)}/>
                </div>
                <div>
                  <label style={lbl}>Last Name</label>
                  <input value={lastName} onChange={e=>setLastName(e.target.value)} placeholder="Optional" style={inp(lastName)}/>
                </div>
              </div>
              <div style={{fontSize:12,color:"#94a3b8",lineHeight:1.5,marginBottom:16}}>
                Only your first name will be displayed with your published report. Your last name is kept private.
              </div>

              {/* 4. Email Address */}
              <div style={{marginBottom:16}}>
                <label style={lbl}>Email Address *</label>
                <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="Required to verify your report" style={inp(email)}/>
                <div style={{fontSize:11,color:"#94a3b8",marginTop:4}}>Not displayed publicly. Verification only.</div>
              </div>

              {/* 5. Duration */}
              <div style={{marginBottom:16}}>
                <label style={lbl}>How long have you lived or worked near this facility?</label>
                <input value={duration} onChange={e=>setDuration(e.target.value)} placeholder="e.g. 2 years, 6 months" style={inp(duration)}/>
              </div>

              {/* 6. Symptoms checkboxes */}
              <div style={{marginBottom:16}}>
                <label style={{...lbl,marginBottom:8}}>Which of these have you experienced? <span style={{color:"#94a3b8",fontWeight:400}}>(select all that apply)</span></label>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  {SYMPTOM_OPTIONS.map(s=>{
                    const checked = symptoms.includes(s);
                    return (
                      <div key={s} onClick={()=>toggleSymptom(s)} style={{display:"flex",alignItems:"center",gap:10,padding:"11px 14px",borderRadius:10,border:`1.5px solid ${checked?"#f97316":"#e2e8f0"}`,background:checked?"#fff7ed":"#f8fafc",cursor:"pointer",transition:"all .15s"}}>
                        <div style={{width:18,height:18,borderRadius:4,border:`2px solid ${checked?"#f97316":"#cbd5e1"}`,background:checked?"#f97316":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all .15s"}}>
                          {checked && <Icon name="check" size={11} color="#fff"/>}
                        </div>
                        <span style={{fontSize:13,fontWeight:checked?600:400,color:checked?"#c2410c":"#374151"}}>{s}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 7. Your Report */}
              <div style={{marginBottom:16}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <label style={{...lbl,marginBottom:0}}>Your Report *</label>
                  <span style={{fontSize:12,fontWeight:600,color:reportText.length>MAX_REPORT_CHARS*0.9?"#ef4444":"#94a3b8"}}>{reportText.length.toLocaleString()} / {MAX_REPORT_CHARS.toLocaleString()}</span>
                </div>
                <textarea value={reportText} onChange={e=>{if(e.target.value.length<=MAX_REPORT_CHARS)setReportText(e.target.value);}} rows={6}
                  placeholder="Describe what you have experienced living or working near this facility. Include when it started, how often it occurs, and whether it improves when you leave the area."
                  style={{...inp(reportText),resize:"vertical",lineHeight:1.7}}/>
              </div>

              {/* 8. Declaration */}
              <div onClick={()=>setDeclared(v=>!v)} style={{display:"flex",alignItems:"flex-start",gap:12,padding:"16px",borderRadius:12,border:`2px solid ${declared?"#f97316":"#e2e8f0"}`,background:declared?"#fff7ed":"#f8fafc",cursor:"pointer",marginBottom:14}}>
                <div style={{width:22,height:22,borderRadius:5,border:`2px solid ${declared?"#f97316":"#94a3b8"}`,background:declared?"#f97316":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}>
                  {declared && <Icon name="check" size={13} color="#fff"/>}
                </div>
                <div style={{fontSize:14,color:"#374151",lineHeight:1.7,fontWeight:declared?600:400}}>I declare that I am a real resident living near this facility and that the information in this report is truthful to the best of my knowledge. I understand this report may be shared with public health authorities and regulatory bodies.</div>
              </div>

              {/* 9. Human verification */}
              <div onClick={()=>setHuman(v=>!v)} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 16px",borderRadius:12,border:`2px solid ${human?"#f97316":"#e2e8f0"}`,background:human?"#fff7ed":"#f8fafc",cursor:"pointer",marginBottom:20}}>
                <div style={{width:22,height:22,borderRadius:5,border:`2px solid ${human?"#f97316":"#94a3b8"}`,background:human?"#f97316":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  {human && <Icon name="check" size={13} color="#fff"/>}
                </div>
                <div style={{fontSize:14,color:"#374151",fontWeight:human?600:400}}>I confirm I am a human and not a bot</div>
              </div>

              <button onClick={submit} disabled={sending||!canSubmit} style={{padding:"15px 38px",borderRadius:12,border:"none",background:canSubmit?"#f97316":"#e2e8f0",color:canSubmit?"#fff":"#94a3b8",fontSize:16,fontWeight:800,cursor:canSubmit?"pointer":"default",fontFamily:"inherit",boxShadow:canSubmit?"0 4px 20px rgba(249,115,22,.4)":"none"}}>
                {sending?"Submitting...":"Submit Verified Report"}
              </button>
              <div style={{fontSize:13,color:"#94a3b8",lineHeight:1.55,marginTop:12}}>Reports reviewed within 48 hours. Email used for verification only, never displayed publicly.</div>
            </>
          )}
        </div>
      </section>

      {/* FOOTER (shared with the business pages, on a dark backdrop) */}
      <div style={{background:"#0a0f1e"}}>
        <BusinessFooter onNavigate={onNavigate}/>
      </div>
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
  const [expandedRep,setExpandedRep] = useState(null);
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
  // Human-confirmation checkbox gating the email-gate unlock button.
  const [nearHumanConfirmed,setNearHumanConfirmed] = useState(false);
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
  const rc       = dc ? exposureColor(dc.Risk_Level) : "#64748b";
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
      ? `Based on your answers, you are in a HIGH exposure situation. Your combination of ${a.dist==="Less than 0.25 miles"?"very close proximity (under a quarter mile)":a.dist==="0.25 to 0.5 miles"?"close proximity (under half a mile)":"moderate proximity"}${a.kids==="Yes"?", children in your household":""}${a.preg==="Yes"?", and pregnancy":""} creates a compounding risk profile that warrants immediate and serious attention. The research is unambiguous: people in your situation face measurably elevated exposure to three separate categories of documented health hazards. First, power-frequency EMF from substations and high-voltage lines at this distance regularly exceeds the 3 to 4 milligauss threshold where epidemiological studies found elevated childhood leukemia rates. Second, diesel PM2.5 from monthly generator tests is a WHO Group 1 carcinogen with no established safe exposure level. Third, chronic low-frequency noise operates below the threshold of normal hearing measurement but penetrates walls and disrupts sleep architecture over time. Each of these independently carries documented health risks. Together, as a combined chronic exposure, they represent a situation that deserves professional environmental assessment, formal regulatory complaints, and a conversation with your doctor.`
      : score>=3
      ? `Based on your answers, you are in a MODERATE exposure situation. Your proximity and household circumstances place you within the documented impact range of this facility. ${a.dist==="0.25 to 0.5 miles"?"At under half a mile, you are well within the zone where low-frequency noise, diesel exhaust during generator tests, and elevated EMF have been measured and documented.":a.dist==="0.5 to 1 mile"?"At under one mile, low-frequency sound from cooling systems and generator operations reaches your home, particularly at night when ambient noise drops.":"At your distance, the primary concerns are low-frequency noise at night, diesel exhaust during monthly generator tests, and substation EMF if you are near the electrical infrastructure."} While your risk is lower than those closest to the fence line, the cumulative effects of long-term exposure to industrial noise, diesel exhaust during monthly generator tests, and elevated EMF are real and worth taking seriously. Residents at this distance have documented sleep disruption, intermittent headaches, and heightened anxiety linked to generator test events. Monitoring, documentation, and precautionary steps are appropriate right now, and you have standing to file formal noise and air quality concerns with your local authority.`
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

  const STATS=[
    {val:`~${(statVals[0]/1e9).toFixed(2).replace(/\.?0+$/,"")} Billion`,    label:"Estimated gallons of water drawn by data centers daily"},
    {val:`~${(statVals[1]/1e6).toFixed(1)} Million`,                         label:"Americans estimated to live within 1 mile of a major data center"},
    {val:`~${(statVals[2]/1e12).toFixed(2).replace(/\.?0+$/,"")} Trillion`,  label:"Estimated watts of power drawn by data centers globally"},
    {val:loading?"---":statVals[3],                                          label:"Facilities tracked in our database"},
  ];

  return (
    <>
      <style>{CSS}</style>
      {path === "/methodology" ? (
        <MethodologyPage onBack={()=>navigate("/")} onNavigate={navigate}/>
      ) : path === "/report-landing" ? (
        <ReportLandingPage onBack={()=>navigate("/")} onNavigate={navigate}/>
      ) : path === "/report-success" ? (
        <ReportSuccessPage onBack={()=>navigate("/")} onNavigate={navigate}/>
      ) : path === "/verify-report" ? (
        <VerifyReportPage onNavigate={navigate}/>
      ) : path === "/business" ? (
        <BusinessPlansPage onNavigate={navigate}/>
      ) : path === "/business-success" ? (
        <BusinessSuccessPage onNavigate={navigate}/>
      ) : path === "/business-generate" ? (
        <BusinessGeneratePage onNavigate={navigate}/>
      ) : path === "/business-login" ? (
        <BusinessLoginPage onNavigate={navigate}/>
      ) : path === "/business-recover" ? (
        <BusinessRecoverPage onNavigate={navigate}/>
      ) : path === "/business-dashboard" ? (
        <BusinessDashboardPage onNavigate={navigate}/>
      ) : path === "/business-profile" ? (
        <BusinessProfilePage onNavigate={navigate}/>
      ) : path === "/privacy" ? (
        <PrivacyPolicyPage onNavigate={navigate}/>
      ) : path === "/unsubscribe" ? (
        <UnsubscribePage onNavigate={navigate}/>
      ) : path === "/my-report" ? (
        <MyReportPage onNavigate={navigate}/>
      ) : path === "/submit-report" ? (
        <SubmitReportPage onNavigate={navigate}/>
      ) : (
      <div style={{minHeight:"100vh",background:"#f1f5f9",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>

        {/* HERO */}
        <section className="hero" style={{position:"relative",overflow:"visible",minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 35%,#1e0535 65%,#0a1628 100%)",backgroundSize:"400% 400%",animation:"gradShift 14s ease infinite",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"80px 24px",textAlign:"center"}}>
          {/* Top-right nav: For Business + Sign-in shortcut once a session exists. */}
          <div style={{position:"absolute",top:18,right:22,zIndex:5,display:"flex",alignItems:"center",gap:14}}>
            <a href="/business" onClick={e=>{e.preventDefault();navigate("/business");}} style={{fontSize:13,fontWeight:800,letterSpacing:".08em",color:"rgba(255,255,255,.85)",textDecoration:"none",padding:"8px 14px",borderRadius:30,border:"1px solid rgba(249,115,22,.45)",background:"rgba(249,115,22,.1)"}}>For Business</a>
          </div>
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
            Data centers power the world's digital infrastructure. Millions of people live near one.
            Search your country and city to understand the infrastructure footprint in your area.
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
                    const r2=exposureColor(f.Risk_Level);
                    return (
                      <div key={f.id} className="drop-item" style={{padding:"14px 20px 14px 28px",borderBottom:"1px solid #f1f5f9"}} onClick={()=>{setCityTxt(city);setShowCityD(false);pickFac(f.id);}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10}}>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:15,fontWeight:700,color:"#1e293b",marginBottom:3,lineHeight:1.3}}>{f.Name}</div>
                            <div style={{fontSize:13,color:"#64748b",fontWeight:500}}>{f.Company} &middot; {f.Power_MW>=1000?`${(f.Power_MW/1000).toFixed(1)} GW`:`${f.Power_MW||"?"}MW`}</div>
                          </div>
                          <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"flex-end",flexShrink:0}}>
                            <Chip label={s2.label} color={s2.color} small/>
                            <Chip label={exposureLabel(f.Risk_Level)} color={r2} small/>
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
              <h3 className="upsell-heading">
                <span role="img" aria-label="Warning" style={{marginRight:10}}>⚠️</span>
                There&apos;s More You Should Know
              </h3>
              <div style={{fontSize:16,color:"#f97316",fontWeight:700,marginBottom:14,letterSpacing:".01em"}}>
                Unlock Your Full HumZones Area Report
              </div>
              <p style={{fontSize:15,color:"rgba(255,255,255,.78)",marginBottom:24,lineHeight:1.7,maxWidth:560,marginLeft:"auto",marginRight:"auto"}}>
                {nearRadius === 100 ? (
                  <>You found {nearResults.length} {nearResults.length === 1 ? "facility" : "facilities"} within 100km. Your Full Report includes detailed health analysis, EMF readings, noise levels and risk assessments for every facility near you.</>
                ) : (
                  <>You found {nearResults.length} {nearResults.length === 1 ? "facility" : "facilities"} within {nearRadius}km. Your Full Report reveals all {facilities100kmCount} facilities within 100km, including {high100kmCount} HIGH exposure {high100kmCount === 1 ? "site" : "sites"} you may not know about.</>
                )}
              </p>
              <button
                onClick={handleGetFullReport}
                style={{padding:"16px 32px",borderRadius:14,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:17,fontWeight:900,letterSpacing:".02em",cursor:"pointer",fontFamily:"inherit",boxShadow:"0 10px 32px rgba(239,68,68,.45)"}}
              >
                Show Me Everything
              </button>
              <p style={{fontSize:13,color:"#fff",marginTop:14,lineHeight:1.6,fontWeight:600,letterSpacing:".01em"}}>
                <span role="img" aria-label="Lightning" style={{marginRight:6}}>⚡</span>
                Instant Download. Get your report in seconds.
              </p>
            </div>
          )}

          {nearLoc && !dc && !loading && (nearResults.length > 0 ? (() => {
            const renderNearCard = (f, locked=false) => {
              const st = STATUS[f.Facility_Status] || STATUS.OPERATING;
              const rclr = exposureColor(f.Risk_Level);
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
                      <Chip label={exposureLabel(f.Risk_Level)} color={rclr} small/>
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
                            onKeyDown={e=>{ if(e.key==="Enter" && nearHumanConfirmed) handleEmailUnlock(); }}
                            placeholder="Enter your email address"
                            disabled={nearEmailSending}
                            style={{padding:"13px 16px",fontSize:15,borderRadius:12,border:"1.5px solid rgba(255,255,255,.18)",background:"rgba(255,255,255,.08)",color:"#fff",fontFamily:"inherit",boxSizing:"border-box",width:"100%"}}
                          />
                          <label style={{display:"flex",alignItems:"center",gap:9,fontSize:13,color:"rgba(255,255,255,.78)",cursor:"pointer",textAlign:"left",lineHeight:1.4}}>
                            <input
                              type="checkbox"
                              checked={nearHumanConfirmed}
                              onChange={e=>setNearHumanConfirmed(e.target.checked)}
                              disabled={nearEmailSending}
                              style={{width:16,height:16,accentColor:"#f97316",cursor:"pointer",flexShrink:0}}
                            />
                            <span>I confirm I am a human and not a bot</span>
                          </label>
                          <button
                            onClick={handleEmailUnlock}
                            disabled={nearEmailSending || !nearHumanConfirmed}
                            style={{padding:"13px 22px",borderRadius:12,border:"none",background:nearHumanConfirmed?"linear-gradient(135deg,#ef4444,#f97316)":"rgba(255,255,255,.12)",color:nearHumanConfirmed?"#fff":"rgba(255,255,255,.45)",fontSize:15,fontWeight:800,letterSpacing:".02em",cursor:nearEmailSending?"wait":(nearHumanConfirmed?"pointer":"not-allowed"),fontFamily:"inherit",boxShadow:nearHumanConfirmed?"0 8px 26px rgba(239,68,68,.4)":"none",opacity:nearEmailSending?.8:1}}
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
                    {icon:"power",label:"Reported Power Draw",   value:dc.Power_MW>=1000?`${(dc.Power_MW/1000).toFixed(1)} GW`:`${dc.Power_MW||"?"}MW`,color:rc},
                    {icon:"noise",label:"Estimated Noise Level",  value:`${dc.Noise_DB||"?"} dB`,color:dc.Noise_DB>=70?"#ef4444":dc.Noise_DB>=60?"#f97316":"#3b82f6"},
                    {icon:"emf",  label:"Modeled EMF Range at Fence", value:`${dc.EMF_Fence_High||"?"} mG`,color:dc.EMF_Fence_High>=4?"#ef4444":"#10b981"},
                    {icon:"water",label:"Estimated Daily Water Draw",    value:dc.Water_Gal_Day>0?`${fmt(dc.Water_Gal_Day)} gal`:"Near zero",color:"#3b82f6"},
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
                        onClick={()=>{ if (isSubmit) navigate("/submit-report"); else setTab(t.id); }}
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
                      {icon:"power",label:"Reported Power",    value:dc.Power_MW>=1000?`${(dc.Power_MW/1000).toFixed(1)} GW`:`${dc.Power_MW||"?"}MW`,plain:dc.Power_MW?`Enough to power ${fmt(Math.round(dc.Power_MW*1000/1.25))} average homes continuously, 24 hours a day, 365 days a year.`:"Power data pending verification.",color:rc},
                      {icon:"co2",  label:"Estimated CO2",  value:dc.CO2_Tons_Year>0?`${fmt(dc.CO2_Tons_Year)} tons`:"Near zero",plain:dc.CO2_Tons_Year>0?`Same as ${fmt(Math.round(dc.CO2_Tons_Year/4.6))} cars driven for a full year.`:"Powered by renewable energy.",color:dc.CO2_Tons_Year>200000?"#ef4444":"#10b981"},
                      {icon:"water",label:"Estimated Water Draw", value:dc.Water_Gal_Day>0?`${fmt(dc.Water_Gal_Day)} gal`:"Near zero",plain:dc.Water_Gal_Day>0?`Same daily water use as ${fmt(Math.round(dc.Water_Gal_Day/80))} households. Permanently removed from the local water cycle.`:"Air-cooled design. Minimal water consumption.",color:dc.Water_Gal_Day>500000?"#ef4444":"#10b981"},
                      {icon:"noise",label:"Estimated Noise",value:`${dc.Noise_DB||"?"} dB`,plain:"Sustained 24/7 including overnight. Low-frequency noise travels further than this number suggests.",color:dc.Noise_DB>=70?"#ef4444":dc.Noise_DB>=60?"#f97316":"#3b82f6"},
                      {icon:"emf",  label:"Modeled EMF at Fence",  value:`up to ${dc.EMF_Fence_High||"?"}mG`,plain:dc.EMF_Fence_High>=4?"Studies link childhood leukemia risk starting at 3 to 4 mG. The legal US limit is 2,000 mG. Legal does not mean safe.":"Below the 3 to 4 mG concern threshold at the fence line.",color:dc.EMF_Fence_High>=4?"#ef4444":"#10b981"},
                      {icon:"emf",  label:"Modeled EMF at 100m",   value:`~${dc.EMF_100m||"?"} mG`,plain:dc.EMF_100m>=3?"Still above the level linked to childhood leukemia in studies. Take this seriously if you live within 100m.":dc.EMF_100m>=1?"Within the zone where a 2026 study found health associations.":"Below precautionary thresholds at this distance.",color:dc.EMF_100m>=3?"#ef4444":dc.EMF_100m>=1?"#f97316":"#10b981"},
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

                {tab==="reports" && (
                  <div>
                    <h3 style={{fontSize:22,fontWeight:900,color:"#0f172a",marginBottom:10}}>Community Reports</h3>
                    <p style={{fontSize:16,color:"#64748b",marginBottom:28,lineHeight:1.75}}>One person's symptom diary is anecdote. Three hundred people's diaries near the same facility is a public health study. Your report matters.</p>
                    {reps.length===0 && (
                      <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:16,padding:"24px",marginBottom:12}}>
                        <p style={{fontSize:16,color:"#94a3b8",fontStyle:"italic",margin:0,marginBottom:14}}>No reports yet for this facility. Be the first to share your experience.</p>
                        <button onClick={()=>navigate("/submit-report")} style={{padding:"10px 22px",borderRadius:10,border:"none",background:rc,color:"#fff",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit",boxShadow:`0 4px 14px ${rc}44`}}>Submit Your Report</button>
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
                        <button onClick={()=>navigate("/submit-report")} style={{padding:"12px 24px",borderRadius:10,border:"none",background:rc,color:"#fff",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit",boxShadow:`0 4px 14px ${rc}44`}}>Submit Your Report</button>
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
          <div style={{fontSize:16,color:"#64748b",marginBottom:20}}>Global Data Center Health & Infrastructure Registry</div>

          {/* Site links */}
          <div style={{display:"flex",justifyContent:"center",gap:18,flexWrap:"wrap",marginBottom:22}}>
            <a href="/methodology" onClick={e=>{e.preventDefault();navigate("/methodology");}} className="ext-link" style={{color:"#f97316",fontSize:14,fontWeight:700,textDecoration:"none",letterSpacing:".02em"}}>
              Methodology
            </a>
            <a href="/business" onClick={e=>{e.preventDefault();navigate("/business");}} className="ext-link" style={{color:"#f97316",fontSize:14,fontWeight:700,textDecoration:"none",letterSpacing:".02em"}}>
              Business Plans
            </a>
            <a href="/submit-report" onClick={e=>{e.preventDefault();navigate("/submit-report");}} className="ext-link" style={{color:"#f97316",fontSize:14,fontWeight:700,textDecoration:"none",letterSpacing:".02em"}}>
              Submit Your Report
            </a>
            <a href="/my-report" onClick={e=>{e.preventDefault();navigate("/my-report");}} className="ext-link" style={{color:"#f97316",fontSize:14,fontWeight:700,textDecoration:"none",letterSpacing:".02em"}}>
              Retrieve My Report
            </a>
            <a href="/privacy" onClick={e=>{e.preventDefault();navigate("/privacy");}} className="ext-link" style={{color:"#f97316",fontSize:14,fontWeight:700,textDecoration:"none",letterSpacing:".02em"}}>
              Privacy Policy
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
      <CookieConsent onNavigate={navigate}/>
    </>
  );
}
