// HumZones - Build refresh May 23 2026
// HumZones - Last updated: May 23 2026
// Build marker: 2026-05-23, force fresh Vercel deployment of plan-card scroll anchors.
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
// Leaflet base stylesheet for the interactive world map. The react-leaflet
// library itself is dynamically imported inside MapSection.
import "leaflet/dist/leaflet.css";

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

// Format the live facility-database size for marketing copy. Under 1000 shows
// the exact count; 1000 or more rounds down to the nearest hundred with a
// trailing plus. Falls back to "1,000+" before the Airtable data has loaded.
const facilityCountLabel = (n) => {
  const c = Number(n) || 0;
  if (c < 1)    return "1,000+";
  if (c < 1000) return c.toLocaleString("en-US");
  return (Math.floor(c / 100) * 100).toLocaleString("en-US") + "+";
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
    home:      <svg style={s} viewBox="0 0 24 24"><path d="M3 10.5L12 3l9 7.5" {...p}/><path d="M5 9.5V21h14V9.5" {...p}/><path d="M9.5 21v-6h5v6" {...p}/></svg>,
    building:  <svg style={s} viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="1.5" {...p}/><rect x="8" y="7" width="2.6" height="2.6" {...p}/><rect x="13.4" y="7" width="2.6" height="2.6" {...p}/><rect x="8" y="12" width="2.6" height="2.6" {...p}/><rect x="13.4" y="12" width="2.6" height="2.6" {...p}/><path d="M10 21v-4h4v4" {...p}/></svg>,
    scales:    <svg style={s} viewBox="0 0 24 24"><path d="M12 3v18M7 21h10M5 7h14" {...p}/><circle cx="12" cy="4.5" r="1.5" {...p}/><path d="M5 7l-3 6.5c1.9 1.5 4.1 1.5 6 0L5 7z" {...p}/><path d="M19 7l-3 6.5c1.9 1.5 4.1 1.5 6 0L19 7z" {...p}/></svg>,
    search:    <svg style={s} viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" {...p}/><path d="M21 21l-5.4-5.4" {...p}/></svg>,
    database:  <svg style={s} viewBox="0 0 24 24"><ellipse cx="12" cy="5" rx="8" ry="3" {...p}/><path d="M4 5v7c0 1.66 3.58 3 8 3s8-1.34 8-3V5" {...p}/><path d="M4 12v7c0 1.66 3.58 3 8 3s8-1.34 8-3v-7" {...p}/></svg>,
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
const exposureLabel = (lvl) => `${exposureTier(lvl)} IMPACT`;

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
  .share-section{padding:26px 26px 22px}
  @keyframes shareBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
  @media(max-width:640px){
    .share-section{padding:22px 16px 18px}
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
  /* /get-report upsell heading: a larger, bolder variant so it reads as the
     single most dominant element in that banner. */
  .get-report-upsell-heading{font-size:32px!important;font-weight:900!important;color:#fff!important;text-shadow:0 4px 16px rgba(0,0,0,.5)!important;line-height:1.12!important;letter-spacing:-.025em!important;margin:0 0 16px!important;display:block!important}
  @media(max-width:640px){
    .get-report-upsell-heading{font-size:24px!important;margin:0 0 12px!important}
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
    /* The old absolutely-positioned hero nav is gone; the sticky GlobalHeader
       reserves its own space in flow so the hero only needs a normal top
       padding above the HUMZONES.COM pill. */
    .hero{padding:32px 20px 60px!important;min-height:auto!important}
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
    .rings{display:none!important}
    .stat-val{font-size:20px!important}
    .addr-bar{flex-direction:column!important;align-items:flex-start!important;gap:10px!important;padding:14px 16px!important}
    .near-status-row{flex-direction:column!important;align-items:flex-start!important;gap:10px!important}
    .near-card{padding:16px!important}
    .near-card .near-right{margin-left:auto!important}
    /* Uniform 24px vertical rhythm between the main-page cards on mobile:
       24px above the first card, then each card carries a 24px bottom margin.
       The map section also drops its own top and bottom padding so it does
       not stack extra space onto the gaps. */
    .main{padding:24px 16px 24px!important}
    .near-panel{padding:22px 16px 18px!important;margin-bottom:24px!important}
    .hz-map-section{padding:24px 0 0!important;margin-bottom:24px!important}
    /* /get-report hero: trim the bottom padding on phones so the
       "Live Database" map heading sits closer to the search button. */
    .hz-getreport-hero{padding-bottom:40px!important}
    .share-section{margin-bottom:0!important}
  }
  @media(max-width:480px){
    .hero h1{font-size:38px!important}
    .scroll-hint{display:none!important}
  }

  /* Site footer: 4 columns on desktop, 2 on tablet, stacked on mobile. */
  .hz-footer-grid{display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;gap:36px}
  .hz-foot-link{transition:color .15s}
  .hz-foot-link:hover{color:#f97316!important}
  /* Hero top-right Login link: subtle white text, orange on hover. */
  .hz-hero-login{transition:color .15s}
  .hz-hero-login:hover{color:#f97316!important}
  /* Research source pills: subtle grey resting state, orange on hover. */
  .hz-research-pill{transition:border-color .15s, color .15s, background .15s}
  .hz-research-pill:hover{border-color:#f97316!important;color:#f97316!important;background:#fff7ed!important}
  /* Live Registry Status: vertical dividers on desktop, dropped on mobile.
     The pulsing dot signals that the counts are drawn from live data. */
  .hz-status-item + .hz-status-item{border-left:1px solid #e2e8f0}
  @media(max-width:560px){
    .hz-status-item + .hz-status-item{border-left:none}
    /* Keep the three counts on a single row on phones by forcing no-wrap
       and shrinking the per-item padding and number size to fit. */
    .hz-status-grid{flex-wrap:nowrap !important;gap:0}
    .hz-status-item{padding:6px 4px !important;flex:1 1 0;min-width:0}
    .hz-status-num{font-size:24px !important}
    .hz-status-label{font-size:11px !important;margin-top:6px !important;text-align:center;line-height:1.25}
    .hz-live-dot{width:7px !important;height:7px !important}
  }
  @keyframes hzLivePulse{
    0%{box-shadow:0 0 0 0 rgba(34,197,94,.55)}
    70%{box-shadow:0 0 0 9px rgba(34,197,94,0)}
    100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}
  }
  .hz-live-dot{animation:hzLivePulse 1.8s ease-out infinite}
  .hz-faq-q{transition:background .15s}
  .hz-faq-q:hover{background:#f8fafc}
  @media(max-width:900px){
    .hz-footer-grid{grid-template-columns:1fr 1fr!important;gap:28px!important}
  }
  @media(max-width:560px){
    .hz-footer-grid{grid-template-columns:1fr!important}
    .hz-footer-bottom{flex-direction:column!important;text-align:center!important;justify-content:center!important}
  }

  /* Interactive world map: 500px tall on desktop, 350px on mobile. */
  .hz-map-wrap{height:500px}
  @media(max-width:768px){
    .hz-map-wrap{height:350px}
  }
  .leaflet-container{font-family:inherit}
  /* Facility marker popup: scoped via the humzones-popup className passed to
     the react-leaflet Popup so we never fight the bundled Leaflet rules. */
  .humzones-popup .leaflet-popup-content-wrapper {
    background: #ffffff !important;
    border-radius: 12px !important;
    overflow: hidden !important;
    border: none !important;
    box-shadow: 0 4px 20px rgba(0,0,0,0.15) !important;
    padding: 0 !important;
  }
  .humzones-popup .leaflet-popup-content {
    margin: 0 !important;
    padding: 16px !important;
    background: #ffffff !important;
    border-radius: 12px !important;
  }
  .humzones-popup .leaflet-popup-tip {
    background: #ffffff !important;
  }
  .humzones-popup .leaflet-popup-tip-container {
    margin-top: -1px !important;
  }
  /* Facility marker tooltip: scoped via the humzones-tooltip className passed
     to the react-leaflet Tooltip. */
  .humzones-tooltip {
    background: #ffffff !important;
    border: 1px solid #e2e8f0 !important;
    border-radius: 6px !important;
    padding: 6px 12px !important;
    font-size: 13px !important;
    color: #1e293b !important;
    font-weight: 600 !important;
    box-shadow: 0 2px 8px rgba(0,0,0,0.1) !important;
  }
  .humzones-tooltip::before {
    border-top-color: #ffffff !important;
  }

  /* AI chat widget: floating button hover and the typing indicator. The
     bottom transition animates the lift above the cookie banner. */
  .hz-chat-fab{background:#f97316;transition:transform .15s ease,background .15s ease,bottom .3s ease}
  .hz-chat-fab:hover{background:#ea580c;transform:scale(1.05)}
  @keyframes hzChatDot{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
  .hz-typing span{display:inline-block;width:7px;height:7px;border-radius:50%;background:#94a3b8;margin:0 2px;animation:hzChatDot 1.2s infinite}
  .hz-typing span:nth-child(2){animation-delay:.15s}
  .hz-typing span:nth-child(3){animation-delay:.3s}
  /* Follow-up suggestion chips shown under each assistant reply. */
  .hz-chat-chip{transition:border-color .15s,color .15s,background .15s}
  .hz-chat-chip:hover{border-color:#f97316!important;color:#f97316!important;background:#fff7ed!important}
  /* Newsletter issue share buttons: thin outlined pills next to each issue. */
  .hz-nl-share{transition:border-color .15s,color .15s}
  .hz-nl-share:hover{border-color:#f97316!important;color:#f97316!important}

  /* GlobalHeader: sticky site-wide nav with mega menu dropdowns. Mounted in
     App so it lives above every route. */
  .hz-gh-shell{position:sticky;top:0;z-index:10000;background:#1e293b;border-bottom:1px solid rgba(249,115,22,.2);box-shadow:0 4px 20px rgba(0,0,0,.3);width:100%;height:64px;display:flex;align-items:center;font-family:inherit}
  .hz-gh-inner{max-width:1200px;margin:0 auto;padding:0 24px;display:flex;align-items:center;justify-content:space-between;width:100%;height:100%;box-sizing:border-box;gap:18px}
  .hz-gh-left{display:flex;align-items:center;gap:4px;min-width:0}
  .hz-gh-back{background:none;border:none;color:rgba(255,255,255,.7);font-size:18px;line-height:1;padding:6px 10px;cursor:pointer;font-family:inherit;border-radius:8px;transition:color .15s, background .15s}
  .hz-gh-back:hover{color:#f97316;background:rgba(249,115,22,.08)}
  .hz-gh-logo{display:flex;flex-direction:column;text-decoration:none;cursor:pointer;line-height:1;gap:3px;background:none;border:none;padding:0;font-family:inherit;text-align:left}
  .hz-gh-logo-title{color:#fff;font-weight:800;font-size:20px;letter-spacing:.01em;display:inline-flex;align-items:baseline}
  .hz-gh-logo-sup{color:#f97316;font-size:10px;font-weight:700;vertical-align:super;margin-left:1px;position:relative;top:-6px}
  .hz-gh-logo-tag{color:#f97316;font-size:10px;font-weight:700;letter-spacing:.06em}
  .hz-gh-nav{display:flex;align-items:center;gap:4px}
  .hz-gh-nav-btn{display:inline-flex;align-items:center;gap:5px;background:none;border:none;color:#fff;font-family:inherit;font-size:14px;font-weight:500;padding:8px 16px;cursor:pointer;border-radius:8px;transition:color .15s, background .15s}
  .hz-gh-nav-btn:hover, .hz-gh-nav-btn.is-open{color:#f97316;background:rgba(249,115,22,.06)}
  .hz-gh-nav-chev{transition:transform .2s;display:inline-block}
  .hz-gh-nav-btn.is-open .hz-gh-nav-chev{transform:rotate(180deg)}
  .hz-gh-right{display:flex;align-items:center;gap:14px}
  .hz-gh-login{color:#94a3b8;font-size:13px;font-weight:600;text-decoration:none;transition:color .15s;background:none;border:none;font-family:inherit;cursor:pointer;padding:6px 8px}
  .hz-gh-login:hover{color:#fff}
  .hz-gh-cta{background:#f97316;color:#fff;border:none;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;transition:background .15s}
  .hz-gh-cta:hover{background:#ea580c}
  .hz-gh-burger{display:none;background:none;border:none;color:#fff;cursor:pointer;padding:8px;font-family:inherit;border-radius:8px}
  .hz-gh-burger:hover{color:#f97316;background:rgba(249,115,22,.08)}
  @media(max-width:767px){
    .hz-gh-shell{height:56px}
    .hz-gh-nav{display:none}
    .hz-gh-login,.hz-gh-cta{display:none}
    .hz-gh-burger{display:inline-flex}
    .hz-gh-logo-tag{display:none}
  }
  .hz-gh-mega{position:absolute;left:0;right:0;top:100%;width:100%;background:#0f172a;border-bottom:2px solid #f97316;box-shadow:0 20px 40px rgba(0,0,0,.4);padding:32px 0;backdrop-filter:blur(10px);background-image:radial-gradient(ellipse at 50% 0%, rgba(249,115,22,.08) 0%, transparent 70%);background-repeat:no-repeat;animation:hzGhDrop .2s ease both;z-index:9999;box-sizing:border-box}
  @keyframes hzGhDrop{from{transform:translateY(-8px);opacity:0}to{transform:translateY(0);opacity:1}}
  .hz-gh-mega-inner{max-width:1200px;margin:0 auto;padding:0 24px;display:grid;gap:36px;width:100%;box-sizing:border-box}
  .hz-gh-mega-3{grid-template-columns:repeat(3,1fr)}
  .hz-gh-mega-2{grid-template-columns:repeat(2,1fr)}
  .hz-gh-mega-col-head{font-size:11px;font-weight:800;letter-spacing:.14em;color:#f97316;text-transform:uppercase;margin-bottom:14px}
  .hz-gh-mega-link{display:block;padding:8px 12px;border-radius:6px;text-decoration:none;cursor:pointer;font-family:inherit;background:transparent;border:none;border-left:3px solid transparent;text-align:left;width:100%;box-sizing:border-box;transition:background .15s, border-color .15s;margin-bottom:4px}
  .hz-gh-mega-link:hover{background:rgba(249,115,22,.05);border-left-color:#f97316}
  .hz-gh-mega-link:hover .hz-gh-mega-link-title{color:#f97316}
  .hz-gh-mega-link[disabled]{cursor:wait;opacity:.7}
  .hz-gh-mega-link-title{display:block;color:#fff;font-size:14px;font-weight:500;line-height:1.4;transition:color .15s}
  .hz-gh-mega-link-desc{display:block;color:#64748b;font-size:12px;line-height:1.5;margin-top:2px}
  .hz-gh-mobile{position:fixed;top:0;right:0;bottom:0;width:100%;max-width:380px;background:#0f172a;color:#fff;z-index:10002;animation:hzGhSlide .25s ease both;display:flex;flex-direction:column;overflow-y:auto;box-shadow:-20px 0 40px rgba(0,0,0,.4)}
  @keyframes hzGhSlide{from{transform:translateX(100%)}to{transform:translateX(0)}}
  .hz-gh-mobile-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid rgba(255,255,255,.08);position:sticky;top:0;background:#0f172a;z-index:1}
  .hz-gh-mobile-close{background:none;border:none;color:#fff;font-size:24px;cursor:pointer;font-family:inherit;line-height:1;padding:6px 10px;border-radius:8px}
  .hz-gh-mobile-close:hover{color:#f97316;background:rgba(249,115,22,.08)}
  .hz-gh-mobile-section{padding:18px 22px 6px;border-bottom:1px solid rgba(255,255,255,.06)}
  .hz-gh-mobile-section-head{font-size:11px;font-weight:800;letter-spacing:.14em;color:#f97316;text-transform:uppercase;margin-bottom:12px}
  .hz-gh-mobile-link{display:block;padding:10px 0;color:#fff;font-size:16px;font-weight:500;text-decoration:none;background:none;border:none;font-family:inherit;text-align:left;cursor:pointer;width:100%}
  .hz-gh-mobile-link:hover{color:#f97316}
  .hz-gh-mobile-link[disabled]{cursor:wait;opacity:.7}
  .hz-gh-mobile-foot{padding:22px;display:flex;flex-direction:column;gap:12px;margin-top:auto}
  .hz-gh-mobile-login{padding:14px;text-align:center;background:transparent;border:1.5px solid rgba(255,255,255,.18);border-radius:10px;color:#fff;font-weight:700;font-size:15px;text-decoration:none;font-family:inherit;cursor:pointer}
  .hz-gh-mobile-cta{padding:14px;text-align:center;background:#f97316;border:none;border-radius:10px;color:#fff;font-weight:800;font-size:15px;text-decoration:none;font-family:inherit;cursor:pointer}
  .hz-gh-mobile-cta:hover{background:#ea580c}
  .hz-gh-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10001;animation:hzGhFade .2s ease both}
  @keyframes hzGhFade{from{opacity:0}to{opacity:1}}

  /* Plain-English info tooltip used beside facility metric labels.
     Pure CSS show/hide so it works on hover (desktop), focus (keyboard)
     and tap (mobile via tabindex=0 -> focus). The arrow points down so
     tooltips read as labels above the icon. */
  .hz-info{position:relative;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;background:rgba(148,163,184,.18);color:#64748b;font-size:9px;font-weight:900;font-style:italic;cursor:help;margin-left:6px;border:1px solid rgba(148,163,184,.45);user-select:none;outline:none;line-height:1;flex-shrink:0;vertical-align:middle}
  .hz-info:hover,.hz-info:focus-visible{background:rgba(249,115,22,.2);color:#f97316;border-color:rgba(249,115,22,.55)}
  .hz-info-tip{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);background:#1e293b;color:#fff;font-size:12px;font-weight:500;line-height:1.5;letter-spacing:.01em;padding:9px 12px;border-radius:8px;max-width:220px;width:max-content;text-align:left;opacity:0;pointer-events:none;transition:opacity .15s ease;box-shadow:0 10px 28px rgba(0,0,0,.35);z-index:1000;white-space:normal;font-style:normal}
  .hz-info-tip::after{content:"";position:absolute;top:100%;left:50%;transform:translateX(-50%);border:6px solid transparent;border-top-color:#1e293b}
  .hz-info:hover .hz-info-tip,.hz-info:focus .hz-info-tip,.hz-info:focus-within .hz-info-tip{opacity:1;pointer-events:auto}
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

// Small "i" icon that reveals a tooltip on hover/focus. Used beside
// facility metric labels and the impact badge so residents can see a
// plain-language explanation without leaving the card. Pure-CSS show
// logic via tabIndex=0 so mobile tap focuses and opens the tip; a tap
// elsewhere blurs and closes it.
const InfoTip = ({ children, label = "More info about this metric" }) => (
  <span className="hz-info" tabIndex={0} role="button" aria-label={label}>
    i
    <span className="hz-info-tip" role="tooltip">{children}</span>
  </span>
);

// Plain-language tooltip copy keyed off the metric name. Power and
// Cooling vary per facility so they are functions; the rest are
// constant strings.
const METRIC_TIP = {
  power: (mw) => {
    const n = Number(mw);
    if (!Number.isFinite(n) || n <= 0) {
      return "The amount of electricity this facility draws during normal operation. Source: public operator filings.";
    }
    const homes = Math.round(n * 750).toLocaleString();
    return `The amount of electricity this facility draws during normal operation. Equivalent to ${homes} homes powered continuously. Source: public operator filings.`;
  },
  noise:    "A modeled estimate of noise levels at the facility boundary. Sustained noise above 65dB is comparable to heavy traffic. This figure is an estimate, not a certified measurement.",
  emfFence: "A modeled estimate of electromagnetic field levels at the facility perimeter. Measured in milliGauss (mG). This is a calculated estimate based on power draw, not a certified field measurement.",
  emf100m:  "A modeled estimate of electromagnetic field levels 100 meters from the facility perimeter. WHO and IARC have studied potential associations between long-term EMF exposure and health. HumZones makes no health claims.",
  cooling: (c) => {
    const v = String(c || "").toLowerCase();
    if (v.includes("evapora")) return "Evaporative: uses water evaporation to remove heat. Very water intensive, can use millions of gallons daily.";
    if (v.includes("chilled")) return "Chilled water: circulates cooled water through servers. Lower water use than evaporative but energy intensive.";
    return "Cooling type for this facility. Chilled water circulates cooled water through servers (lower water use, more energy intensive). Evaporative uses water evaporation to remove heat (very water intensive).";
  },
  opened:   "The year this facility began operations according to publicly available records. Facilities expand over time. The current footprint may be significantly larger than when it opened.",
  water:    "A modeled estimate of daily water draw for cooling. Evaporative cooling can use millions of gallons per day; chilled-water systems use less. This figure is an estimate, not a metered reading.",
  impact: (level) => {
    const l = String(level || "").toUpperCase();
    const closing = l === "HIGH"
      ? "HIGH indicates the largest estimated local footprint."
      : l === "MODERATE" || l === "LOW-MODERATE"
        ? "MODERATE indicates a mid-range estimated local footprint."
        : l === "LOW"
          ? "LOW indicates a smaller estimated local footprint."
          : "Each tier reflects a different estimated local footprint.";
    return "Infrastructure impact categories are relative indicators based on modeled estimates of power draw and proximity to residential areas. They are not scientific measurements or health determinations. " + closing;
  },
};

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
      <div style={{position:"absolute",bottom:18,left:20,display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
        <Chip label={STATUS[dc.Facility_Status]?.label || dc.Facility_Status} color={STATUS[dc.Facility_Status]?.color || "#64748b"}/>
        <span style={{display:"inline-flex",alignItems:"center"}}>
          <Chip label={exposureLabel(dc.Risk_Level)} color={rc}/>
          <InfoTip label="About impact tiers">{METRIC_TIP.impact(dc.Risk_Level)}</InfoTip>
        </span>
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

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = "HumZones Methodology | How We Calculate Infrastructure Data";

    injectHeadEl("meta", "methodology-desc",       { name: "description",         content: "How HumZones calculates modeled estimates for power draw, noise levels, EMF ranges, water consumption and CO2 impact. Data sources, formulas and important limitations." });
    injectHeadEl("link", "methodology-canonical",  { rel: "canonical",            href: "https://humzones.com/methodology" });
    injectHeadEl("meta", "methodology-og-title",   { property: "og:title",        content: "HumZones Methodology | Infrastructure Estimates" });
    injectHeadEl("meta", "methodology-og-desc",    { property: "og:description",  content: "How HumZones calculates power, noise, EMF, water and CO2 estimates. Sources, formulas and important limitations explained." });
    injectHeadEl("meta", "methodology-og-url",     { property: "og:url",          content: "https://humzones.com/methodology" });
    injectHeadEl("meta", "methodology-og-type",    { property: "og:type",         content: "website" });
    injectHeadEl("meta", "methodology-og-site",    { property: "og:site_name",    content: "HumZones" });
    injectHeadEl("meta", "methodology-tw-card",    { name: "twitter:card",        content: "summary" });
    injectHeadEl("meta", "methodology-tw-title",   { name: "twitter:title",       content: "HumZones Methodology" });
    injectHeadEl("meta", "methodology-tw-desc",    { name: "twitter:description", content: "How HumZones calculates infrastructure estimates with sources and limitations." });

    const schema = {
      "@context":    "https://schema.org",
      "@type":       "WebPage",
      "name":        "HumZones Methodology",
      "url":         "https://humzones.com/methodology",
      "description": "How HumZones calculates infrastructure impact estimates including data sources, formulas and limitations.",
    };
    injectHeadEl("script", "methodology-jsonld", { type: "application/ld+json" }, JSON.stringify(schema));

    return () => {
      [
        "methodology-desc","methodology-canonical",
        "methodology-og-title","methodology-og-desc","methodology-og-url","methodology-og-type","methodology-og-site",
        "methodology-tw-card","methodology-tw-title","methodology-tw-desc",
        "methodology-jsonld",
      ].forEach(removeHeadEl);
    };
  }, []);

  return (
    <div style={{minHeight:"100vh",background:"#f1f5f9",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>

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

      <Footer onNavigate={go}/>
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
  <section aria-label="Share HumZones" className="share-section" style={{background:"#fff",textAlign:"center",borderRadius:16,boxShadow:"0 20px 60px rgba(0,0,0,0.2)",marginBottom:0}}>
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

// ─── INTERACTIVE WORLD MAP ───────────────────────────────────────────────────
// Northern Virginia, the data center capital of the world, is the opening view.
const MAP_CENTER = [38.9, -77.4];
const MAP_ZOOM   = 8;

// Marker fill color by exposure tier: HIGH red, MODERATE orange, LOW green,
// anything else grey.
const mapMarkerColor = (lvl) => {
  const t = exposureTier(lvl);
  if (t === "HIGH")     return "#ef4444";
  if (t === "MODERATE") return "#f97316";
  if (t === "LOW")      return "#22c55e";
  return "#94a3b8";
};

// Full-width interactive map of every tracked facility. react-leaflet is
// dynamically imported so the leaflet bundle is code-split and never runs
// during a server render. A grey skeleton holds the space until both the map
// library and the Airtable facility data are ready.
const MapSection = ({ facilities, loading, onSelectFacility }) => {
  const [RL, setRL]   = useState(null);   // the react-leaflet module
  const [map, setMap] = useState(null);   // the underlying Leaflet map instance

  // Keep the latest select handler in a ref so memoized markers always call
  // through to it without having to be rebuilt when its identity changes.
  const onSelectRef = useRef(onSelectFacility);
  useEffect(() => { onSelectRef.current = onSelectFacility; });

  useEffect(() => {
    let alive = true;
    import("react-leaflet")
      .then(mod => { if (alive) setRL(mod); })
      .catch(err => console.error("[HumZones] map library failed to load:", err));
    return () => { alive = false; };
  }, []);

  const all   = facilities || [];
  const ready = !loading && !!RL;
  // When no select handler is supplied (for example on /get-report) the popup
  // simply omits its "View Details" link rather than linking nowhere.
  const hasSelect = !!onSelectFacility;

  // Build one CircleMarker per facility that has real coordinates. Memoized on
  // the facility list and the loaded library so typing elsewhere on the page
  // does not re-diff hundreds of markers.
  const markers = useMemo(() => {
    if (!RL) return null;
    const { CircleMarker, Tooltip, Popup } = RL;
    return all
      .filter(f => {
        const lat = parseFloat(f.Latitude), lng = parseFloat(f.Longitude);
        return Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
      })
      .map(f => {
        const lat = parseFloat(f.Latitude), lng = parseFloat(f.Longitude);
        const color = mapMarkerColor(f.Risk_Level);
        return (
          <CircleMarker
            key={f.id}
            center={[lat, lng]}
            radius={6}
            pathOptions={{ color:"#ffffff", weight:1, fillColor:color, fillOpacity:0.8 }}
            eventHandlers={{
              mouseover: e => e.target.setRadius(9),
              mouseout:  e => e.target.setRadius(6),
            }}
          >
            <Tooltip className="humzones-tooltip">{f.Name || "Unnamed facility"}</Tooltip>
            <Popup className="humzones-popup">
              <div style={{minWidth:190,background:"#ffffff",padding:"12px"}}>
                <div style={{fontSize:14,fontWeight:800,color:"#0f172a",lineHeight:1.3,marginBottom:4}}>{f.Name || "Unnamed facility"}</div>
                {f.Company && <div style={{fontSize:12,color:"#64748b",marginBottom:2}}>{f.Company}</div>}
                <div style={{fontSize:12,color:"#94a3b8",marginBottom:9}}>{[f.City,f.State_Region].filter(Boolean).join(", ") || "Location not on file"}</div>
                <span style={{display:"inline-block",fontSize:10,fontWeight:800,letterSpacing:".06em",padding:"3px 9px",borderRadius:999,color:"#fff",background:color,marginBottom:hasSelect?10:0}}>
                  {exposureLabel(f.Risk_Level)}
                </span>
                {hasSelect && (
                  <div>
                    <button
                      onClick={()=>{ if(onSelectRef.current) onSelectRef.current(f.id); }}
                      style={{background:"none",border:"none",padding:0,color:"#f97316",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:"inherit",textDecoration:"underline"}}
                    >
                      View Details
                    </button>
                  </div>
                )}
              </div>
            </Popup>
          </CircleMarker>
        );
      });
  }, [RL, all, hasSelect]);

  const legendRows = [
    ["#ef4444", "HIGH IMPACT"],
    ["#f97316", "MODERATE IMPACT"],
    ["#22c55e", "LOW IMPACT"],
  ];

  return (
    <section id="interactive-map" aria-label="Data center world map" className="hz-map-section" style={{padding:"32px 0",scrollMarginTop:80}}>
      {/* Heading */}
      <div style={{textAlign:"center",maxWidth:760,margin:"0 auto 22px"}}>
        <div style={{fontSize:12,fontWeight:800,letterSpacing:".16em",color:"#94a3b8",textTransform:"uppercase",marginBottom:9}}>
          Live Database
        </div>
        <h2 style={{fontSize:"clamp(23px,3.6vw,32px)",fontWeight:900,letterSpacing:"-.02em",color:"#0f172a",margin:"0 0 10px",lineHeight:1.2}}>
          {all.length.toLocaleString("en-US")} Data {all.length === 1 ? "Center" : "Centers"} Tracked Worldwide
        </h2>
        <p style={{fontSize:15,color:"#64748b",lineHeight:1.7,margin:0}}>
          Click any marker to explore a facility. Zoom out to see the global picture.
        </p>
      </div>

      {/* Map card, or a grey skeleton of the same size while data loads */}
      <div style={{width:"100%",maxWidth:1200,margin:"0 auto"}}>
        <div className="hz-map-wrap" style={{position:"relative",width:"100%",borderRadius:16,boxShadow:"0 20px 60px rgba(0,0,0,0.2)",overflow:"hidden"}}>
          {ready ? (
            <>
              <RL.MapContainer
                center={MAP_CENTER}
                zoom={MAP_ZOOM}
                scrollWheelZoom={true}
                ref={setMap}
                style={{height:"100%",width:"100%"}}
              >
                <RL.TileLayer
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                />
                {markers}
              </RL.MapContainer>

              {/* Reset View: returns to the Northern Virginia opening view */}
              <button
                onClick={()=>{ if(map) map.setView(MAP_CENTER, MAP_ZOOM); }}
                style={{position:"absolute",top:10,right:10,zIndex:1000,background:"#fff",border:"1px solid #e2e8f0",borderRadius:8,padding:"7px 13px",fontSize:12,fontWeight:800,color:"#1e293b",cursor:"pointer",fontFamily:"inherit",boxShadow:"0 2px 10px rgba(0,0,0,.2)"}}
              >
                Reset View
              </button>

              {/* Legend, bottom right, lifted clear of the attribution strip */}
              <div style={{position:"absolute",bottom:24,right:10,zIndex:1000,background:"rgba(255,255,255,.96)",borderRadius:10,padding:"10px 12px",boxShadow:"0 4px 16px rgba(0,0,0,.2)"}}>
                {legendRows.map(([c,l],i)=>(
                  <div key={l} style={{display:"flex",alignItems:"center",gap:7,marginBottom:i<legendRows.length-1?6:0}}>
                    <span style={{width:11,height:11,borderRadius:"50%",background:c,border:"1.5px solid #fff",boxShadow:"0 0 0 1px rgba(0,0,0,.12)",flexShrink:0}}/>
                    <span style={{fontSize:11,fontWeight:700,color:"#475569"}}>{l}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="hz-map-skeleton" style={{position:"absolute",inset:0,background:"#e2e8f0",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:12,color:"#94a3b8",fontWeight:700,fontSize:14}}>
                <div className="spinning" style={{width:30,height:30,border:"3px solid #cbd5e1",borderTop:"3px solid #94a3b8",borderRadius:"50%"}}/>
                Loading map...
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};

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
  // Set by the /get-report flow once the visitor passes its email gate. When
  // present we already hold their email, so the hero greets them by address
  // and confirms it rather than asking again.
  const userEmail        = get("userEmail");
  const arrivedFromGetReport = !!userEmail;

  // Free sample report download. Uses fixed placeholder data so it is
  // identical for every visitor and never reveals real facility figures.
  const [sampleBusy, setSampleBusy] = useState(false);
  const handleSampleDownload = async () => {
    if (sampleBusy) return;
    setSampleBusy(true);
    try {
      const { doc } = await generateSamplePersonalReportPDF();
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
  // An active session means the user has any credits left. Enterprise no
  // longer offers truly unlimited credits, so the old creditsMonthly >=
  // 999999 carve-out is gone for active-detection. Legacy records with
  // 999999 still resolve as "credits remaining" via the >0 check.
  const isBusinessActive = !!(businessAccount && businessAccount.status === "Active" &&
    businessAccount.creditsRemaining > 0);

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
  const businessCtaLabel = (() => {
    if (!businessAccount) return "";
    const monthly = businessAccount.creditsMonthly >= 999999 ? 200 : businessAccount.creditsMonthly;
    const remaining = businessAccount.creditsRemaining >= 999999 ? 200 : businessAccount.creditsRemaining;
    return `Generate Report (${remaining} of ${monthly} remaining)`;
  })();

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
      label: "HIGH impact category facilities",
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
    "Infrastructure impact category and infrastructure and community impact context for each facility",
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
          {arrivedFromGetReport && (
            <div style={{margin:"0 auto 24px",maxWidth:600,background:"rgba(15,23,42,.55)",border:"1px solid rgba(249,115,22,.4)",borderRadius:14,padding:"16px 20px"}}>
              <div style={{fontSize:12,color:"rgba(255,255,255,.55)",letterSpacing:".10em",textTransform:"uppercase",fontWeight:800,marginBottom:6}}>
                Full Report for
              </div>
              <div style={{fontSize:16,fontWeight:800,color:"#fff",wordBreak:"break-word",lineHeight:1.5}}>
                {searchAddress}
              </div>
              <div style={{fontSize:13,color:"#f97316",fontWeight:700,marginTop:10,display:"flex",alignItems:"center",justifyContent:"center",gap:7,flexWrap:"wrap"}}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                Your report will be sent to {userEmail}
              </div>
            </div>
          )}
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

// ─── GET REPORT (standalone report flow) ─────────────────────────────────────
// Full standalone version of the home page "Find Data Centers Near Me"
// experience. The visitor searches an address, an email gate sits over the
// results, and once it is passed the paid Full Report upsell hands off to
// /report-landing. Reachable at /get-report and linked from the site footer.
const GetReportPage = ({ onNavigate }) => {
  const [facs,setFacs]       = useState([]);
  const [loading,setLoading] = useState(true);

  // Address search state.
  const [addr,setAddr]     = useState("");
  const [radius,setRadius] = useState(50);          // km, default 50
  const [loc,setLoc]       = useState(null);        // {lat,lng,label}
  const [status,setStatus] = useState("idle");      // idle | geocoding
  const [error,setError]   = useState("");

  // SEO + social meta + Product JSON-LD. Cleaned up on unmount.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = "Data Centers Near Me | Personal Area Report | HumZones";

    injectHeadEl("meta", "getreport-desc",      { name: "description",         content: "Search your address and discover data center facilities nearby. Get a personalized report with modeled power, noise, EMF and water estimates for every tracked facility in your area." });
    injectHeadEl("link", "getreport-canonical", { rel: "canonical",            href: "https://humzones.com/get-report" });
    injectHeadEl("meta", "getreport-og-title",  { property: "og:title",        content: "Find Data Centers Near Your Address | HumZones" });
    injectHeadEl("meta", "getreport-og-desc",   { property: "og:description",  content: "Discover what data center infrastructure exists near your home. Personalized reports with modeled power, noise, EMF and water estimates." });
    injectHeadEl("meta", "getreport-og-url",    { property: "og:url",          content: "https://humzones.com/get-report" });
    injectHeadEl("meta", "getreport-og-type",   { property: "og:type",         content: "website" });
    injectHeadEl("meta", "getreport-og-site",   { property: "og:site_name",    content: "HumZones" });
    injectHeadEl("meta", "getreport-tw-card",   { name: "twitter:card",        content: "summary" });
    injectHeadEl("meta", "getreport-tw-title",  { name: "twitter:title",       content: "Find Data Centers Near Your Address" });
    injectHeadEl("meta", "getreport-tw-desc",   { name: "twitter:description", content: "Discover data center infrastructure near your home with modeled power, noise and EMF estimates." });

    const productSchema = {
      "@context":    "https://schema.org",
      "@type":       "Product",
      "name":        "HumZones Personal Area Report",
      "description": "A personalized data center infrastructure report for any address. Covers all tracked facilities within your chosen radius with modeled power draw, noise, EMF, CO2 and water consumption estimates derived from publicly available sources.",
      "url":         "https://humzones.com/get-report",
      "brand":       { "@type": "Brand", "name": "HumZones" },
      "category":    "Infrastructure Intelligence Reports",
      "offers": {
        "@type":         "Offer",
        "availability":  "https://schema.org/InStock",
        "url":           "https://humzones.com/get-report",
        "priceCurrency": "USD",
      },
    };
    injectHeadEl("script", "getreport-jsonld", { type: "application/ld+json" }, JSON.stringify(productSchema));

    return () => {
      [
        "getreport-desc","getreport-canonical",
        "getreport-og-title","getreport-og-desc","getreport-og-url","getreport-og-type","getreport-og-site",
        "getreport-tw-card","getreport-tw-title","getreport-tw-desc",
        "getreport-jsonld",
      ].forEach(removeHeadEl);
    };
  }, []);

  // Email gate. Unlock state persists in localStorage under the shared
  // humzones_email_unlocked key, so a visitor who already unlocked anywhere
  // on the site skips the gate here too.
  const [emailUnlocked,setEmailUnlocked] = useState(()=>{
    if(typeof window==="undefined") return false;
    try{ return localStorage.getItem("humzones_email_unlocked")==="1"; }catch{ return false; }
  });
  const [emailInput,setEmailInput]     = useState("");
  const [emailSending,setEmailSending] = useState(false);
  const [emailError,setEmailError]     = useState("");
  const [humanConfirmed,setHumanConfirmed] = useState(false);
  const [justUnlocked,setJustUnlocked] = useState(false);
  const [hp,setHp]         = useState("");          // honeypot ("website" field)
  // Email captured at the gate, carried into localStorage for /report-landing.
  const [gateEmail,setGateEmail] = useState(()=>{
    if(typeof window==="undefined") return "";
    try{ return localStorage.getItem("userEmail")||""; }catch{ return ""; }
  });

  // Page-load timestamp for the 15-second minimum bot gate.
  const formLoadTimeRef = useRef(Date.now());
  const resultsRef      = useRef(null);

  // Free sample report download — lets visitors preview the report depth
  // before committing an address or email. Same placeholder data as the
  // footer link, so no real facility figures leak.
  const [sampleBusy, setSampleBusy] = useState(false);
  const handleSampleDownload = async () => {
    if (sampleBusy) return;
    setSampleBusy(true);
    try {
      const { doc } = await generateSamplePersonalReportPDF();
      doc.save("HumZones-Sample-Report.pdf");
    } catch (e) {
      console.error("Sample report generation failed:", e);
      window.alert("We could not generate the sample report. Please try again.");
    } finally {
      setSampleBusy(false);
    }
  };

  useEffect(()=>{
    cachedFetch("Facilities",{"fields[]":FACILITY_LIST_FIELDS})
      .then(d=>setFacs(d))
      .catch(e=>console.error("[HumZones] Facilities fetch failed:",e))
      .finally(()=>setLoading(false));
  },[]);

  // Geocode the typed address via OpenStreetMap Nominatim.
  const handleSearch = async () => {
    const q = addr.trim();
    if(!q || status==="geocoding") return;
    setStatus("geocoding"); setError("");
    try{
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
      const r = await fetch(url,{ headers:{ "Accept":"application/json", "User-Agent":"HumZones/1.0 (humzones.com)" } });
      if(!r.ok){
        setError(r.status===429
          ? "Address service is busy right now. Please try again in a moment."
          : "Address lookup failed. Please try again.");
        setStatus("idle"); return;
      }
      const j = await r.json();
      if(!Array.isArray(j) || j.length===0){
        setError("Address not found. Try a more specific search.");
        setStatus("idle"); return;
      }
      const lat = parseFloat(j[0].lat), lng = parseFloat(j[0].lon);
      if(!Number.isFinite(lat) || !Number.isFinite(lng)){
        setError("Address found but coordinates were invalid. Try a more specific search.");
        setStatus("idle"); return;
      }
      setLoc({ lat, lng, label: j[0].display_name || q });
      setStatus("idle");
      setTimeout(()=>{ try{ resultsRef.current?.scrollIntoView({behavior:"smooth",block:"start"}); }catch{} },120);
    }catch(err){
      console.error("Address geocoding failed:",err);
      setError("Address lookup failed. Check your connection and try again.");
      setStatus("idle");
    }
  };

  // Facilities within the chosen radius, nearest first.
  const results = loc ? facs
    .map(f=>{
      const lat=parseFloat(f.Latitude), lng=parseFloat(f.Longitude);
      if(!Number.isFinite(lat)||!Number.isFinite(lng)) return null;
      return { ...f, _km: distanceKm(loc.lat,loc.lng,lat,lng) };
    })
    .filter(f=>f && f._km<=radius)
    .sort((a,b)=>a._km-b._km)
    : [];

  // Wider 100km roll-ups for the upsell banner and the Airtable capture.
  let _f100=0, _fHigh100=0;
  if(loc){
    for(const f of facs){
      const lat=parseFloat(f.Latitude), lng=parseFloat(f.Longitude);
      if(!Number.isFinite(lat)||!Number.isFinite(lng)) continue;
      if(distanceKm(loc.lat,loc.lng,lat,lng)<=100){ _f100++; if(f.Risk_Level==="HIGH") _fHigh100++; }
    }
  }
  const facilities100kmCount = _f100;
  const high100kmCount       = _fHigh100;

  const handleEmailUnlock = () => {
    const email = emailInput.trim();
    if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
      setEmailError("Please enter a valid email address.");
      return;
    }
    setEmailError(""); setEmailSending(true);
    // Honeypot and 15-second minimum: bots trip one or the other. When they
    // do we still unlock the UI so the bot gets no signal, but skip the
    // Airtable write so no junk row is created.
    const isBot = !!hp || (Date.now()-(formLoadTimeRef.current||0) < 15000);
    try{ localStorage.setItem("humzones_email_unlocked","1"); }catch{}
    setEmailUnlocked(true);
    setJustUnlocked(true);
    setGateEmail(email);
    if(isBot){ setEmailSending(false); return; }
    postEmail({
      Email: email,
      Date: new Date().toISOString().slice(0,10),
      Source: "GetReport",
      Address: loc ? loc.label : "",
      Latitude: loc ? loc.lat : null,
      Longitude: loc ? loc.lng : null,
      Radius_KM: radius,
      Facilities_Count: results.length,
      Facilities_100km: facilities100kmCount,
      High_Risk_Count: high100kmCount,
    }).finally(()=>setEmailSending(false));
  };

  // Persist the search context plus the captured email, then hand off to the
  // paid Full Report sales page.
  const handleShowEverything = () => {
    try{
      localStorage.setItem("searchAddress",   loc ? loc.label : "");
      localStorage.setItem("searchLat",       loc ? String(loc.lat) : "");
      localStorage.setItem("searchLng",       loc ? String(loc.lng) : "");
      localStorage.setItem("selectedRadius",  String(radius));
      localStorage.setItem("facilitiesFound", String(results.length));
      localStorage.setItem("facilities100km", String(facilities100kmCount));
      localStorage.setItem("highRiskCount",   String(high100kmCount));
      localStorage.setItem("userEmail",       gateEmail||"");
    }catch{}
    onNavigate("/report-landing");
  };

  const renderCard = (f) => {
    const st   = STATUS[f.Facility_Status] || STATUS.OPERATING;
    const rclr = exposureColor(f.Risk_Level);
    const dclr = distColor(f._km);
    return (
      <div key={f.id} className="sym-card near-card" style={{background:"#fff",borderRadius:18,boxShadow:"0 4px 18px rgba(0,0,0,.06)",padding:"18px 22px",display:"flex",alignItems:"center",gap:16,flexWrap:"wrap",width:"100%",maxWidth:"100%",boxSizing:"border-box"}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:17,fontWeight:800,color:"#0f172a",marginBottom:4,lineHeight:1.3}}>{f.Name}</div>
          <div style={{fontSize:13,color:"#64748b",fontWeight:600}}>{f.Company} &middot; {[f.City,f.State_Region,f.Country].filter(Boolean).join(", ")}</div>
          <div style={{fontSize:13,color:"#64748b",fontWeight:600,marginTop:2,display:"inline-flex",alignItems:"center"}}>
            {f.Power_MW>=1000?`${(f.Power_MW/1000).toFixed(1)} GW`:`${f.Power_MW||"?"}MW`}
            <InfoTip label="About power draw">{METRIC_TIP.power(f.Power_MW)}</InfoTip>
          </div>
        </div>
        <div className="near-right" style={{display:"flex",flexDirection:"column",gap:8,alignItems:"flex-end",flexShrink:0,marginLeft:"auto"}}>
          <div style={{padding:"6px 12px",borderRadius:999,background:dclr,color:"#fff",fontWeight:800,fontSize:13,letterSpacing:".02em",boxShadow:`0 4px 14px ${dclr}55`}}>
            {f._km.toFixed(1)} km away
          </div>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            <Chip label={st.label} color={st.color} small/>
            <span style={{display:"inline-flex",alignItems:"center"}}>
              <Chip label={exposureLabel(f.Risk_Level)} color={rclr} small/>
              <InfoTip label="About impact tiers">{METRIC_TIP.impact(f.Risk_Level)}</InfoTip>
            </span>
          </div>
        </div>
      </div>
    );
  };

  // One facility shows free; everything past the first is blurred behind the
  // email gate. A list of one needs no gate at all.
  const showAll        = emailUnlocked || results.length<=1;
  const previewCards   = showAll ? results : results.slice(0,1);
  const lockedCards    = showAll ? [] : results.slice(1);
  const blurredPreview = lockedCards.slice(0, Math.min(5,lockedCards.length));

  return (
    <div style={{minHeight:"100vh",background:"#f1f5f9",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>


      {/* HERO */}
      <section className="hz-getreport-hero" style={{background:"linear-gradient(150deg,#020c1b 0%,#0f172a 45%,#1e0535 100%)",padding:"0 0 56px",position:"relative",overflow:"hidden",borderBottom:"1px solid rgba(249,115,22,.18)"}}>

        {/* Hero content */}
        <div style={{maxWidth:680,margin:"0 auto",padding:"38px 20px 0",textAlign:"center",position:"relative",zIndex:1}}>
          <h1 className="report-h1" style={{fontWeight:900,color:"#fff",marginBottom:14}}>
            Get Your Personalized <span style={{background:"linear-gradient(135deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span> Report
          </h1>
          <p style={{fontSize:17,color:"rgba(255,255,255,.72)",lineHeight:1.6,marginBottom:30,maxWidth:560,marginLeft:"auto",marginRight:"auto"}}>
            Enter your address below to discover what data centers are near you and get a full personalized infrastructure report.
          </p>

          {/* Address input */}
          <input
            className="email-gate-input"
            value={addr}
            onChange={e=>setAddr(e.target.value)}
            onKeyDown={e=>{ if(e.key==="Enter") handleSearch(); }}
            placeholder="Enter your full address"
            style={{width:"100%",padding:"17px 18px",fontSize:16,fontWeight:500,fontFamily:"inherit",borderRadius:14,border:"1.5px solid rgba(255,255,255,.18)",background:"rgba(255,255,255,.10)",color:"#fff",boxSizing:"border-box",outline:"none",marginBottom:16}}
          />

          {/* Radius selector */}
          <div style={{display:"flex",justifyContent:"center",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:22}}>
            <span style={{fontSize:12,fontWeight:800,color:"rgba(255,255,255,.55)",letterSpacing:".08em",textTransform:"uppercase"}}>Radius:</span>
            {[5,10,25,50,100].map(r=>(
              <button key={r} onClick={()=>setRadius(r)} style={{padding:"7px 14px",borderRadius:999,border:"1px solid "+(radius===r?"#f97316":"rgba(255,255,255,.22)"),background:radius===r?"#f97316":"rgba(255,255,255,.06)",color:radius===r?"#fff":"rgba(255,255,255,.78)",fontWeight:800,fontSize:13,cursor:"pointer",fontFamily:"inherit"}}>{r}km</button>
            ))}
          </div>

          {/* Search button */}
          <button
            onClick={handleSearch}
            disabled={!addr.trim()||status==="geocoding"}
            style={{width:"100%",maxWidth:340,padding:"17px 30px",borderRadius:14,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:17,fontWeight:900,letterSpacing:".02em",cursor:(!addr.trim()||status==="geocoding")?"default":"pointer",fontFamily:"inherit",boxShadow:"0 10px 32px rgba(239,68,68,.45)",opacity:(!addr.trim()||status==="geocoding")?.6:1}}
          >
            {status==="geocoding" ? "Searching..." : "Search"}
          </button>

          {error && <div style={{fontSize:14,color:"#fca5a5",fontWeight:600,marginTop:14}}>{error}</div>}

          {/* Secondary CTA: download a free sample PDF so visitors can see
              the report depth before searching. Matches the outline-button
              styling used in the upsell section. */}
          <button
            onClick={handleSampleDownload}
            disabled={sampleBusy}
            style={{width:"100%",maxWidth:340,marginTop:14,padding:"14px 30px",borderRadius:12,border:"2px solid #f97316",background:"transparent",color:"#f97316",fontSize:15,fontWeight:900,letterSpacing:".02em",cursor:sampleBusy?"wait":"pointer",fontFamily:"inherit",opacity:sampleBusy?.65:1}}
          >
            {sampleBusy ? "Generating Sample..." : "Download Free Sample"}
          </button>

          <p style={{fontSize:12,color:"rgba(255,255,255,.45)",marginTop:16,lineHeight:1.6,maxWidth:480,marginLeft:"auto",marginRight:"auto"}}>
            We use OpenStreetMap to geocode your address. Your location is never stored without your consent.
          </p>
        </div>
      </section>

      {/* RESULTS - the wrapper collapses to zero padding before a search
          has run so the empty section does not push the map far below the
          hero on /get-report. Padding restores once `loc` is set. */}
      <div ref={resultsRef} className="near-me-results" style={{maxWidth:760,margin:"0 auto",padding: loc ? "38px 20px 64px" : "0",width:"100%",boxSizing:"border-box",scrollMarginTop:16}}>

        {loc && loading && (
          <div style={{background:"#fff",borderRadius:18,padding:"44px 24px",textAlign:"center",boxShadow:"0 4px 18px rgba(0,0,0,.06)",color:"#64748b",fontWeight:600,fontSize:15}}>
            <div className="spinning" style={{width:32,height:32,border:"3px solid #e2e8f0",borderTop:"3px solid #ef4444",borderRadius:"50%",margin:"0 auto 14px"}}/>
            Loading facility data...
          </div>
        )}

        {loc && !loading && (
          <>
            {/* Facilities-found count */}
            <div className="fade-in" style={{textAlign:"center",fontSize:28,fontWeight:900,letterSpacing:"-.02em",lineHeight:1.25,margin:"0 0 22px",overflowWrap:"break-word",padding:"0 4px"}}>
              {results.length>0 ? (
                <span style={{background:"linear-gradient(135deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",backgroundClip:"text"}}>
                  {results.length} {results.length===1?"facility":"facilities"} found within {radius}km of your address
                </span>
              ) : (
                <span style={{color:"#94a3b8"}}>0 facilities found within {radius}km of your address</span>
              )}
            </div>

            {/* Upsell banner: shown only once the email gate has been passed. */}
            {emailUnlocked && results.length>0 && (
              <div className="fade-in" style={{background:"linear-gradient(150deg,#0a1628 0%,#0f172a 50%,#1e0535 100%)",borderRadius:18,padding:"36px 28px 30px",textAlign:"center",border:"1px solid rgba(249,115,22,.32)",boxShadow:"0 18px 50px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.05)",marginBottom:24}}>
                <h3 className="get-report-upsell-heading">There&apos;s More You Should Know</h3>
                <div style={{fontSize:18,color:"#f97316",fontWeight:700,marginBottom:14,letterSpacing:".01em"}}>
                  Unlock Your Full HumZones Area Report
                </div>
                <p style={{fontSize:16,color:"rgba(255,255,255,.92)",marginBottom:20,lineHeight:1.7,maxWidth:560,marginLeft:"auto",marginRight:"auto"}}>
                  {radius===100 ? (
                    <>You found {results.length} {results.length===1?"facility":"facilities"} within 100km. Your Full Report includes detailed infrastructure analysis, modeled EMF ranges, noise levels and exposure assessments for every facility near you.</>
                  ) : (
                    <>You found {results.length} {results.length===1?"facility":"facilities"} within {radius}km. Your Full Report reveals all {facilities100kmCount} facilities within 100km including {high100kmCount} HIGH impact {high100kmCount===1?"site":"sites"} you may not know about.</>
                  )}
                </p>
                <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"#f97316",color:"#fff",fontSize:14,fontWeight:800,padding:"7px 16px",borderRadius:999,boxShadow:"0 4px 14px rgba(249,115,22,.45)",letterSpacing:".02em",marginBottom:18}}>
                  <span role="img" aria-label="Lightning">⚡</span> Instant Download
                </div>
                <div>
                  <button onClick={handleShowEverything} style={{padding:"16px 40px",borderRadius:14,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:18,fontWeight:700,letterSpacing:".02em",cursor:"pointer",fontFamily:"inherit",boxShadow:"0 10px 32px rgba(239,68,68,.45)"}}>
                    Show Me Everything
                  </button>
                </div>
                <p style={{fontSize:13,color:"rgba(255,255,255,.6)",marginTop:14,lineHeight:1.6,fontWeight:600}}>
                  Instant PDF download. Personalized to your address.
                </p>
              </div>
            )}

            {results.length>0 ? (
              <div className={justUnlocked?"fade-in":undefined} style={{display:"flex",flexDirection:"column",gap:14,width:"100%",maxWidth:"100%",boxSizing:"border-box"}}>
                {previewCards.map(f=>renderCard(f))}

                {lockedCards.length>0 && (
                  <div style={{position:"relative",width:"100%",maxWidth:"100%",boxSizing:"border-box",overflow:"hidden",borderRadius:18}}>
                    {/* Blurred decoy cards behind the gate */}
                    <div aria-hidden="true" style={{filter:"blur(6px)",pointerEvents:"none",userSelect:"none",display:"flex",flexDirection:"column",gap:14,width:"100%",maxWidth:"100%",boxSizing:"border-box"}}>
                      {blurredPreview.map(f=>renderCard(f))}
                    </div>
                    {/* Email gate overlay */}
                    <div style={{position:"absolute",inset:0,display:"flex",alignItems:"flex-start",justifyContent:"center",padding:"22px 14px",borderRadius:18,background:"linear-gradient(180deg,rgba(15,23,42,.25) 0%,rgba(15,23,42,.78) 30%,rgba(2,12,27,.92) 100%)",boxSizing:"border-box",maxWidth:"100%"}}>
                      <div className="fade-in" style={{maxWidth:520,width:"100%",background:"linear-gradient(150deg,#0a1628 0%,#0f172a 50%,#1e0535 100%)",borderRadius:18,padding:"34px 28px 28px",textAlign:"center",border:"1px solid rgba(249,115,22,.32)",boxShadow:"0 24px 60px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.05)"}}>
                        {/* Lock icon */}
                        <div style={{width:60,height:60,borderRadius:"50%",background:"linear-gradient(135deg,#ef4444,#f97316)",margin:"0 auto 18px",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 8px 26px rgba(239,68,68,.45)"}}>
                          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <rect x="4" y="11" width="16" height="10" rx="2"/>
                            <path d="M8 11V7a4 4 0 0 1 8 0v4"/>
                          </svg>
                        </div>
                        <h3 style={{fontSize:22,fontWeight:900,color:"#fff",marginBottom:10,letterSpacing:"-.01em",lineHeight:1.25}}>
                          See All {results.length} Facilities Near You
                        </h3>
                        <p style={{fontSize:15,color:"rgba(255,255,255,.72)",marginBottom:22,lineHeight:1.6}}>
                          Enter your email for free access to the complete list.
                        </p>
                        <div style={{display:"flex",flexDirection:"column",gap:10,maxWidth:380,margin:"0 auto"}}>
                          {/* Honeypot: hidden from humans, tempting to bots. */}
                          <input
                            type="text"
                            name="website"
                            className="hz-trap"
                            value={hp}
                            onChange={e=>setHp(e.target.value)}
                            tabIndex={-1}
                            autoComplete="off"
                            aria-hidden="true"
                          />
                          <input
                            type="email"
                            className="email-gate-input"
                            value={emailInput}
                            onChange={e=>setEmailInput(e.target.value)}
                            onKeyDown={e=>{ if(e.key==="Enter" && humanConfirmed) handleEmailUnlock(); }}
                            placeholder="Your email address"
                            disabled={emailSending}
                            style={{padding:"13px 16px",fontSize:15,borderRadius:12,border:"1.5px solid rgba(255,255,255,.18)",background:"rgba(255,255,255,.08)",color:"#fff",fontFamily:"inherit",boxSizing:"border-box",width:"100%"}}
                          />
                          <label style={{display:"flex",alignItems:"center",gap:9,fontSize:13,color:"rgba(255,255,255,.78)",cursor:"pointer",textAlign:"left",lineHeight:1.4}}>
                            <input
                              type="checkbox"
                              checked={humanConfirmed}
                              onChange={e=>setHumanConfirmed(e.target.checked)}
                              disabled={emailSending}
                              style={{width:16,height:16,accentColor:"#f97316",cursor:"pointer",flexShrink:0}}
                            />
                            <span>I confirm I am a human and not a bot</span>
                          </label>
                          <button
                            onClick={handleEmailUnlock}
                            disabled={emailSending || !humanConfirmed}
                            style={{padding:"13px 22px",borderRadius:12,border:"none",background:humanConfirmed?"linear-gradient(135deg,#ef4444,#f97316)":"rgba(255,255,255,.12)",color:humanConfirmed?"#fff":"rgba(255,255,255,.45)",fontSize:15,fontWeight:800,letterSpacing:".02em",cursor:emailSending?"wait":(humanConfirmed?"pointer":"not-allowed"),fontFamily:"inherit",boxShadow:humanConfirmed?"0 8px 26px rgba(239,68,68,.4)":"none",opacity:emailSending?.8:1}}
                          >
                            {emailSending ? "Unlocking..." : "Unlock Free Results"}
                          </button>
                        </div>
                        {emailError && (
                          <div style={{fontSize:13,color:"#fca5a5",fontWeight:600,marginTop:12}}>{emailError}</div>
                        )}
                        <p style={{fontSize:12,color:"rgba(255,255,255,.5)",marginTop:16,lineHeight:1.6}}>
                          Free access. No spam. Unsubscribe anytime.
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div style={{background:"#fff",borderRadius:18,padding:"44px 24px",textAlign:"center",boxShadow:"0 4px 18px rgba(0,0,0,.06)"}}>
                <div style={{fontSize:42,marginBottom:12}} role="img" aria-label="Pin">📍</div>
                <div style={{fontSize:17,color:"#475569",fontWeight:600,lineHeight:1.6,maxWidth:480,margin:"0 auto"}}>
                  No data centers found within {radius}km of your address. Try a larger search radius.
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Before a search runs, show the same interactive map and social
          share cards as the main page. Rendered outside the
          .near-me-results wrapper so the global `.near-me-results *`
          size constraints (added for mobile result cards) do not cascade
          into Leaflet popup internals and clip the popup card. The main
          page already places MapSection outside this wrapper for the
          same reason. */}
      {!loc && (
        <div style={{maxWidth:1200,margin:"0 auto",padding:"0 20px 24px",width:"100%",boxSizing:"border-box"}}>
          <MapSection facilities={facs} loading={loading}/>
          <ShareSection/>
        </div>
      )}

      <Footer onNavigate={onNavigate} facilities={facs}/>
    </div>
  );
};

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

// ─── BUSINESS REPORT PDF (NEW FORMAT) ────────────────────────────────────────
// A4 portrait, 10+ page professional report used by all business-plan PDF
// flows (BusinessGeneratePage primary generation, BusinessDashboardPage
// re-download, and the /business sample CTA via the sample wrapper below).
// Pass sample:true to overlay a diagonal SAMPLE watermark on every page so
// the free sample can never be confused with a paid deliverable.
async function generateBusinessReportPDF({
  searchAddress,
  facsInRadius,
  searchRadius = 100,
  facs = [],
  businessAccount,
  sample = false,
}) {
  const jsPDFModule = await import("jspdf");
  const { jsPDF } = jsPDFModule;
  const doc = new jsPDF({ unit: "mm", format: "a4" });

  const CARD_H = 36;
  const CARD_GAP = 4;
  const BADGE_H = 7;
  const BADGE_OFF = 5;
  const PER_PAGE = 5;
  const CARD_START = 52;
  const BLOCK_H = 38;
  const PAGE_W = 210;
  const PAGE_H = 297;

  const resolvePower = (f) => {
    const v = Number(f.Power_MW);
    if (Number.isFinite(v) && v > 0) return v;
    const lvl = String(f.Risk_Level || "").toUpperCase();
    if (lvl === "HIGH") return 50;
    if (lvl === "MODERATE") return 25;
    return 10;
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
  const resolveCO2 = (f, mw) => {
    const v = Number(f.CO2_Tons_Year);
    if (Number.isFinite(v) && v > 0) return v;
    return Math.round((mw * 3381) / 1000) * 1000;
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
  facsInRadius.forEach(f => {
    const t = exposureTier(f.Risk_Level);
    if (t === "HIGH") counts.HIGH++;
    else if (t === "LOW") counts.LOW++;
    else counts.MODERATE++;
    const mw = resolvePower(f);
    totalPower += mw;
    totalWater += resolveWater(f, mw);
    totalCO2 += resolveCO2(f, mw);
  });

  const todayDate = new Date();
  const dateStr = todayDate.toISOString().slice(0, 10);
  const dateCompact = dateStr.replace(/-/g, "");
  const dateLong = todayDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const rid = "HZ-PRO-" + dateCompact + "-" + Math.floor(Math.random() * 90000 + 10000);

  const companyName = (businessAccount && businessAccount.company) ? businessAccount.company : "Your Organization";
  const clientName = companyName + "  |  Confidential";

  const numFacPages = Math.max(1, Math.ceil(facsInRadius.length / PER_PAGE));
  const totalPages = 4 + numFacPages + 4;

  const fmtNum = (n) => Math.round(Number(n) || 0).toLocaleString();

  function logoCell(x, y, mainSize, colorHum, colorZones) {
    const sf = doc.internal.scaleFactor;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(mainSize);
    const wHum = doc.getStringUnitWidth("Hum") * mainSize / sf;
    const wZones = doc.getStringUnitWidth("Zones") * mainSize / sf;
    const tmSize = Math.max(4, Math.floor(mainSize * 0.42));
    doc.setFontSize(tmSize);
    const wTM = doc.getStringUnitWidth("TM") * tmSize / sf;
    const cellH = mainSize * 0.6;
    const baseY = y + cellH * 0.82;
    doc.setFontSize(mainSize);
    doc.setTextColor(...colorHum);
    doc.text("Hum", x, baseY);
    doc.setTextColor(...colorZones);
    doc.text("Zones", x + wHum, baseY);
    doc.setFontSize(tmSize);
    doc.setTextColor(...colorZones);
    doc.text("TM", x + wHum + wZones, baseY - mainSize * 0.2);
    return x + wHum + wZones + wTM + 0.5;
  }

  function impactColors(level) {
    if (level === "HIGH") return { tc: [239, 68, 68], bc: [254, 242, 242] };
    if (level === "MODERATE") return { tc: [249, 115, 22], bc: [255, 247, 237] };
    return { tc: [34, 197, 94], bc: [240, 253, 244] };
  }

  function drawCard(y, name, company, city, distLabel, level, power, noise, emfF, emf100, cooling, opened) {
    const { tc, bc } = impactColors(level);
    doc.setFillColor(...bc); doc.rect(15, y, 180, CARD_H, "F");
    doc.setFillColor(...tc); doc.rect(15, y, 3, CARD_H, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(30, 41, 59);
    doc.text(String(name || "Facility"), 22, y + 3 + 10 * 0.6 * 0.82);
    const bw = level === "MODERATE" ? 28 : 21;
    doc.setFillColor(...tc); doc.rect(195 - bw, y + BADGE_OFF, bw, BADGE_H, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(6); doc.setTextColor(255, 255, 255);
    doc.text(level + " IMPACT", 195 - bw + bw / 2, y + BADGE_OFF + BADGE_H * 0.75, { align: "center" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(100, 116, 139);
    const ccText = String(company || "") + "  |  " + String(city || "");
    doc.text(ccText, 22, y + 11 + 8 * 0.6 * 0.82);
    doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(...tc);
    const ccWidth = doc.getStringUnitWidth(ccText) * 8 / doc.internal.scaleFactor;
    doc.text(distLabel, 22 + ccWidth + 3, y + 11 + 8 * 0.6 * 0.82);
    const metrics = [
      ["Power", power],
      ["Noise", noise],
      ["EMF Fence", emfF],
      ["EMF 100m", emf100],
      ["Cooling", cooling],
      ["Opened", opened],
    ];
    metrics.forEach(([label, val], i) => {
      const mx = 22 + i * 29;
      doc.setFont("helvetica", "bold"); doc.setFontSize(6); doc.setTextColor(100, 116, 139);
      doc.text(label, mx, y + 24 + 6 * 0.6 * 0.82);
      doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(30, 41, 59);
      doc.text(String(val), mx, y + 29 + 7 * 0.6 * 0.82);
    });
  }

  function pageHeader(pageNum) {
    doc.setFillColor(30, 41, 59); doc.rect(0, 0, PAGE_W, 18, "F");
    const sf = doc.internal.scaleFactor;
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(255, 255, 255);
    const wHum = doc.getStringUnitWidth("Hum") * 11 / sf;
    const baseY = 4 + 11 * 0.6 * 0.82;
    doc.text("Hum", 15, baseY);
    doc.setTextColor(249, 115, 22);
    const wZones = doc.getStringUnitWidth("Zones") * 11 / sf;
    doc.text("Zones", 15 + wHum, baseY);
    const tmSize = Math.max(4, Math.floor(11 * 0.42));
    doc.setFontSize(tmSize);
    const wTM = doc.getStringUnitWidth("TM") * tmSize / sf;
    doc.text("TM", 15 + wHum + wZones, baseY - 11 * 0.2);
    const endX = 15 + wHum + wZones + wTM + 0.5;
    doc.setFontSize(8); doc.setTextColor(148, 163, 184);
    const wPipe = doc.getStringUnitWidth(" | ") * 8 / sf;
    doc.text(" | ", endX, baseY);
    doc.setTextColor(255, 255, 255);
    doc.text("Professional Infrastructure Report", endX + wPipe, baseY);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(148, 163, 184);
    doc.text(clientName + "  |  Page " + pageNum + " of " + totalPages, 195, 10, { align: "right" });
  }

  function pageFooter() {
    doc.setFillColor(30, 41, 59); doc.rect(0, 265, PAGE_W, 32, "F");
    const sf = doc.internal.scaleFactor;
    const Y1 = 269;
    const baseY = Y1 + 10 * 0.6 * 0.82;
    doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    const wHum = doc.getStringUnitWidth("Hum") * 10 / sf;
    const wZones = doc.getStringUnitWidth("Zones") * 10 / sf;
    const tmSize = Math.max(4, Math.floor(10 * 0.42));
    const wTM = doc.getStringUnitWidth("TM") * tmSize / sf;
    doc.setFontSize(10); doc.setTextColor(255, 255, 255);
    doc.text("Hum", 15, baseY);
    doc.setTextColor(249, 115, 22);
    doc.text("Zones", 15 + wHum, baseY);
    doc.setFontSize(tmSize);
    doc.text("TM", 15 + wHum + wZones, baseY - 10 * 0.2);
    const endX = 15 + wHum + wZones + wTM + 0.5;
    doc.setFontSize(10); doc.setFont("helvetica", "bold"); doc.setTextColor(255, 255, 255);
    doc.text(" Technologies Inc.", endX, baseY);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(249, 115, 22);
    doc.text("Global Data Center Health & Infrastructure Registry", 15, Y1 + 7 + 6 * 0.75);
    doc.setFontSize(7); doc.setTextColor(100, 116, 139);
    doc.text("humzones.com  |  hello@humzones.com  |  Report ID: " + rid, 15, Y1 + 13 + 6 * 0.75);
  }

  function applyWatermark() {
    if (!sample) return;
    try {
      doc.saveGraphicsState();
      const gs = new doc.GState({ opacity: 0.15 });
      doc.setGState(gs);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(60);
      doc.setTextColor(150, 150, 150);
      doc.text("SAMPLE", PAGE_W / 2, PAGE_H / 2, { align: "center", angle: -45 });
      doc.restoreGraphicsState();
    } catch (e) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(60);
      doc.setTextColor(220, 220, 220);
      doc.text("SAMPLE", PAGE_W / 2, PAGE_H / 2, { align: "center", angle: -45 });
    }
  }

  // ── PAGE 1: COVER ─────────────────────────────────────────────────────────
  doc.setFillColor(30, 41, 59); doc.rect(0, 0, PAGE_W, 110, "F");
  doc.setFillColor(249, 115, 22); doc.rect(0, 108, PAGE_W, 3, "F");
  doc.setFillColor(239, 68, 68); doc.rect(155, 8, 42, 12, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(255, 255, 255);
  doc.text("CONFIDENTIAL", 155 + 21, 15.5, { align: "center" });
  logoCell(15, 12, 26, [255, 255, 255], [249, 115, 22]);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(249, 115, 22);
  doc.text("Global Data Center Health & Infrastructure Registry", 15, 30);
  doc.setFillColor(249, 115, 22); doc.rect(15, 38, 140, 0.5, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(148, 163, 184);
  doc.text("INFRASTRUCTURE INTELLIGENCE REPORT  |  PREPARED FOR", 15, 44);
  doc.setFont("helvetica", "bold"); doc.setFontSize(20); doc.setTextColor(255, 255, 255);
  doc.text(companyName, 15, 54);
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(148, 163, 184);
  doc.text("Professional Infrastructure Intelligence  |  Commercial Use Licensed", 15, 64);
  doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(148, 163, 184);
  doc.text("REPORT ID", 15, 75);
  doc.text("DATE GENERATED", 60, 75);
  doc.text("SEARCH RADIUS", 120, 75);
  doc.setFont("helvetica", "bold"); doc.setFontSize(10);
  doc.setTextColor(249, 115, 22); doc.text(rid, 15, 82);
  doc.setTextColor(255, 255, 255); doc.text(dateLong, 60, 82);
  doc.text(searchRadius + " km", 120, 82);
  doc.setFillColor(15, 23, 42); doc.rect(15, 92, 180, 14, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(148, 163, 184);
  doc.text("SEARCH ADDRESS", 19, 97);
  doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(255, 255, 255);
  const addrLines = doc.splitTextToSize(String(searchAddress || "Address not provided"), 170);
  doc.text(addrLines.slice(0, 1), 19, 103);

  const statTotal = facsInRadius.length;
  const coverStats = [
    { label: "Total Facilities", value: String(statTotal), color: [30, 41, 59] },
    { label: "High Impact", value: String(counts.HIGH), color: [239, 68, 68] },
    { label: "Moderate Impact", value: String(counts.MODERATE), color: [249, 115, 22] },
    { label: "Low Impact", value: String(counts.LOW), color: [34, 197, 94] },
  ];
  coverStats.forEach((s, i) => {
    const x = 15 + i * 45;
    doc.setFillColor(248, 250, 252); doc.rect(x, 118, 38, 38, "F");
    doc.setFillColor(...s.color); doc.rect(x, 118, 38, 4, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(24); doc.setTextColor(...s.color);
    doc.text(s.value, x + 19, 138, { align: "center" });
    doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(100, 116, 139);
    doc.text(s.label.toUpperCase(), x + 19, 150, { align: "center" });
  });

  doc.setFillColor(241, 245, 249); doc.rect(15, 162, 180, 22, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(100, 116, 139);
  doc.text("COMBINED TOTALS", 19, 168);
  doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor(30, 41, 59);
  doc.text(fmtNum(totalPower) + " MW", 19, 178);
  doc.text(fmtNum(totalWater) + " gal", 79, 178);
  doc.text(fmtNum(totalCO2) + " t", 139, 178);
  doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(100, 116, 139);
  doc.text("Combined Power Draw", 19, 182);
  doc.text("Est. Daily Water Use", 79, 182);
  doc.text("Est. Annual CO2", 139, 182);

  doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(30, 41, 59);
  doc.text("This Report Contains", 15, 192);
  doc.setFillColor(249, 115, 22); doc.rect(15, 195, 40, 0.7, "F");
  const coverBullets = [
    "Executive summary with key findings and impact distribution",
    "Infrastructure impact summary segmented by category",
    "Closest facility deep dive with full metric breakdown",
    statTotal + " " + (statTotal === 1 ? "facility" : "facilities") + " across " + numFacPages + " " + (numFacPages === 1 ? "page" : "pages"),
    "Regional context with live registry growth indicators",
    "Professional action steps for site selection and risk review",
    "Full glossary of HumZones terminology",
    "Disclaimer and licensing terms for commercial use",
  ];
  doc.setFont("helvetica", "normal"); doc.setFontSize(8);
  coverBullets.forEach((b, i) => {
    doc.setTextColor(249, 115, 22); doc.text("•", 17, 202 + i * 5);
    doc.setTextColor(71, 85, 105); doc.text(b, 22, 202 + i * 5);
  });

  // Cover footer (full-width band with logo and report ID right-aligned)
  doc.setFillColor(30, 41, 59); doc.rect(0, 265, PAGE_W, 32, "F");
  {
    const sf = doc.internal.scaleFactor;
    const Y1 = 269;
    const baseY = Y1 + 10 * 0.6 * 0.82;
    doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    const wHum = doc.getStringUnitWidth("Hum") * 10 / sf;
    const wZones = doc.getStringUnitWidth("Zones") * 10 / sf;
    const tmSize = Math.max(4, Math.floor(10 * 0.42));
    const wTM = doc.getStringUnitWidth("TM") * tmSize / sf;
    doc.setFontSize(10); doc.setTextColor(255, 255, 255);
    doc.text("Hum", 15, baseY);
    doc.setTextColor(249, 115, 22);
    doc.text("Zones", 15 + wHum, baseY);
    doc.setFontSize(tmSize);
    doc.text("TM", 15 + wHum + wZones, baseY - 10 * 0.2);
    const endX = 15 + wHum + wZones + wTM + 0.5;
    doc.setFontSize(10); doc.setFont("helvetica", "bold"); doc.setTextColor(255, 255, 255);
    doc.text(" Technologies Inc.", endX, baseY);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(148, 163, 184);
    doc.text("Report ID: " + rid, 195, baseY, { align: "right" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(249, 115, 22);
    doc.text("Global Data Center Health & Infrastructure Registry", 15, Y1 + 7 + 6 * 0.75);
    doc.setFontSize(7); doc.setTextColor(100, 116, 139);
    doc.text("Licensed for commercial use under your active business plan.", 15, Y1 + 13 + 6 * 0.75);
  }
  applyWatermark();

  // ── PAGE 2: EXECUTIVE SUMMARY ─────────────────────────────────────────────
  doc.addPage();
  pageHeader(2);
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(30, 41, 59);
  doc.text("Executive Summary", 15, 32);
  doc.setFillColor(249, 115, 22); doc.rect(15, 37, 50, 1.5, "F");
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(100, 116, 139);
  doc.text("Top-line findings across the " + searchRadius + "km search radius.", 15, 45);

  doc.setFillColor(255, 247, 237); doc.rect(15, 51, 180, 32, "F");
  doc.setFillColor(249, 115, 22); doc.rect(15, 51, 3, 32, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(249, 115, 22);
  doc.text("KEY FINDINGS", 22, 57);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(30, 41, 59);
  const closest = facsInRadius[0];
  const topPowerFac = facsInRadius.length ? [...facsInRadius].sort((a, b) => resolvePower(b) - resolvePower(a))[0] : null;
  const findingLines = [
    "• " + statTotal + " " + (statTotal === 1 ? "facility identified" : "facilities identified") + " within " + searchRadius + "km of the search address.",
    "• " + counts.HIGH + " HIGH impact, " + counts.MODERATE + " MODERATE impact, " + counts.LOW + " LOW impact.",
    closest ? "• Closest facility: " + (closest.Name || "Unnamed") + " at " + (closest._km != null ? closest._km.toFixed(1) : "?") + " km." : "• No facilities within radius.",
    topPowerFac ? "• Largest by power: " + (topPowerFac.Name || "Unnamed") + " at " + fmtNum(resolvePower(topPowerFac)) + " MW." : "",
  ].filter(Boolean);
  findingLines.forEach((l, i) => doc.text(l, 22, 64 + i * 5));

  const exec = [
    { label: "Facilities", value: String(statTotal) },
    { label: "High Impact", value: String(counts.HIGH) },
    { label: "Moderate Impact", value: String(counts.MODERATE) },
    { label: "Low Impact", value: String(counts.LOW) },
    { label: "Total MW", value: fmtNum(totalPower) },
    { label: "Daily Water (gal)", value: fmtNum(totalWater) },
    { label: "Annual CO2 (t)", value: fmtNum(totalCO2) },
  ];
  exec.forEach((s, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = 15 + col * 45;
    const y = 92 + row * 32;
    doc.setFillColor(248, 250, 252); doc.rect(x, y, 38, 28, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.setTextColor(30, 41, 59);
    doc.text(s.value, x + 19, y + 14, { align: "center" });
    doc.setFont("helvetica", "bold"); doc.setFontSize(6); doc.setTextColor(100, 116, 139);
    doc.text(s.label.toUpperCase(), x + 19, y + 22, { align: "center" });
  });

  doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(30, 41, 59);
  doc.text("Impact by Distance", 15, 168);
  doc.setFillColor(249, 115, 22); doc.rect(15, 171, 40, 0.7, "F");
  const ranges = [
    { lbl: "0 - 5 km", lo: 0, hi: 5 },
    { lbl: "5 - 15 km", lo: 5, hi: 15 },
    { lbl: "15 - 30 km", lo: 15, hi: 30 },
    { lbl: "30 - 60 km", lo: 30, hi: 60 },
    { lbl: "60 - " + searchRadius + " km", lo: 60, hi: searchRadius },
  ];
  doc.setFillColor(241, 245, 249); doc.rect(15, 175, 180, 8, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(71, 85, 105);
  doc.text("DISTANCE", 19, 180);
  doc.text("FACILITIES", 75, 180);
  doc.text("HIGH", 110, 180);
  doc.text("MODERATE", 130, 180);
  doc.text("LOW", 160, 180);
  doc.text("AVG MW", 175, 180);
  let ry = 187;
  ranges.forEach(r => {
    const inR = facsInRadius.filter(f => (f._km || 0) >= r.lo && (f._km || 0) < r.hi);
    const h = inR.filter(f => exposureTier(f.Risk_Level) === "HIGH").length;
    const m = inR.filter(f => exposureTier(f.Risk_Level) === "MODERATE").length;
    const l = inR.filter(f => exposureTier(f.Risk_Level) === "LOW").length;
    const avgMW = inR.length ? Math.round(inR.reduce((a, f) => a + resolvePower(f), 0) / inR.length) : 0;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(30, 41, 59);
    doc.text(r.lbl, 19, ry);
    doc.text(String(inR.length), 75, ry);
    doc.setTextColor(239, 68, 68); doc.text(String(h), 110, ry);
    doc.setTextColor(249, 115, 22); doc.text(String(m), 130, ry);
    doc.setTextColor(34, 197, 94); doc.text(String(l), 160, ry);
    doc.setTextColor(30, 41, 59); doc.text(String(avgMW), 175, ry);
    ry += 7;
  });

  pageFooter();
  applyWatermark();

  // ── PAGE 3: INFRASTRUCTURE IMPACT SUMMARY ─────────────────────────────────
  doc.addPage();
  pageHeader(3);
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(30, 41, 59);
  doc.text("Infrastructure Impact Summary", 15, 32);
  doc.setFillColor(249, 115, 22); doc.rect(15, 37, 50, 1.5, "F");
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(100, 116, 139);
  doc.text("Distribution of facilities across the four impact tiers used by the HumZones registry.", 15, 45);

  const blocks = [
    { title: "High Impact", desc: "Large facilities (typically 50MW or more), close proximity to residential areas, or evaporative cooling at scale. Highest documented infrastructure footprint in the registry.", count: counts.HIGH, tc: [239, 68, 68], bc: [254, 242, 242] },
    { title: "Moderate Impact", desc: "Mid-scale facilities (10 to 50 MW) with measurable power, water, and noise footprints. Common in suburban edges and along major fiber routes.", count: counts.MODERATE, tc: [249, 115, 22], bc: [255, 247, 237] },
    { title: "Low Impact", desc: "Smaller facilities (under 10 MW) or those with air-cooled designs. Footprint is real but materially smaller than the upper tiers.", count: counts.LOW, tc: [34, 197, 94], bc: [240, 253, 244] },
    { title: "Methodology", desc: "Impact tier is a relative indicator combining power draw, cooling type, and proximity. It is not a regulatory or medical determination. See the methodology page on humzones.com for the full model.", count: null, tc: [71, 85, 105], bc: [241, 245, 249] },
  ];
  let by = 54;
  blocks.forEach(b => {
    doc.setFillColor(...b.bc); doc.rect(15, by, 180, 45, "F");
    doc.setFillColor(...b.tc); doc.rect(15, by, 3, 45, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(...b.tc);
    doc.text(b.title.toUpperCase(), 22, by + 9);
    if (b.count !== null) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(100, 116, 139);
      doc.text("FACILITIES", 188, by + 9, { align: "right" });
      doc.setFont("helvetica", "bold"); doc.setFontSize(20); doc.setTextColor(...b.tc);
      doc.text(String(b.count), 188, by + 20, { align: "right" });
    }
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(71, 85, 105);
    // Wrap to 132mm so the description can never reach the right-column
    // FACILITIES / count block (which lives between x=170 and x=188).
    const wrapped = doc.splitTextToSize(b.desc, 132);
    doc.text(wrapped, 22, by + 28);
    by += 50;
  });

  pageFooter();
  applyWatermark();

  // ── PAGE 4: CLOSEST FACILITY DEEP DIVE ────────────────────────────────────
  doc.addPage();
  pageHeader(4);
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(30, 41, 59);
  doc.text("Closest Facility Deep Dive", 15, 32);
  doc.setFillColor(249, 115, 22); doc.rect(15, 37, 50, 1.5, "F");
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(100, 116, 139);
  doc.text("Full metric breakdown for the closest facility within the search radius.", 15, 45);

  if (closest) {
    const cl = impactColors(exposureTier(closest.Risk_Level));
    doc.setFillColor(...cl.bc); doc.rect(15, 52, 180, 50, "F");
    doc.setFillColor(...cl.tc); doc.rect(15, 52, 4, 50, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.setTextColor(30, 41, 59);
    doc.text(String(closest.Name || "Unnamed Facility"), 24, 62);
    doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(100, 116, 139);
    doc.text((closest.Company || "Operator unknown") + "  |  " + (closest.City || "City unknown"), 24, 70);
    const tier = exposureTier(closest.Risk_Level);
    const cbw = tier === "MODERATE" ? 38 : 28;
    doc.setFillColor(...cl.tc); doc.rect(195 - cbw - 4, 56, cbw, 9, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(255, 255, 255);
    doc.text(tier + " IMPACT", 195 - cbw - 4 + cbw / 2, 62, { align: "center" });
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(...cl.tc);
    doc.text((closest._km != null ? closest._km.toFixed(1) : "?") + " km from your search address", 24, 82);

    const cMW = resolvePower(closest);
    const cNoise = resolveNoise(closest);
    const cWater = resolveWater(closest, cMW);
    const cCO2 = resolveCO2(closest, cMW);
    const rows = [
      ["Operator", closest.Company || "Unknown"],
      ["City / Region", (closest.City || "Unknown") + (closest.Country ? ", " + closest.Country : "")],
      ["Power draw", fmtNum(cMW) + " MW"],
      ["Cooling type", closest.Cooling || "Not on file"],
      ["Year opened", String(closest.Opened || "Not on file")],
      ["Modeled noise (fence)", fmtNum(cNoise) + " dB"],
      ["EMF at fence line", (closest.EMF_Fence_High ? closest.EMF_Fence_High + " mG" : "Modeled estimate")],
      ["EMF at 100 m", (closest.EMF_100m ? closest.EMF_100m + " mG" : "Modeled estimate")],
      ["Daily water (est)", fmtNum(cWater) + " gal"],
      ["Annual CO2 (est)", fmtNum(cCO2) + " t"],
    ];
    let dy = 112;
    rows.forEach((r, i) => {
      if (i % 2 === 0) { doc.setFillColor(248, 250, 252); doc.rect(15, dy - 5, 180, 11, "F"); }
      doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(71, 85, 105);
      doc.text(r[0].toUpperCase(), 22, dy);
      doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(30, 41, 59);
      doc.text(String(r[1]), 100, dy);
      dy += 11;
    });
  } else {
    doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(100, 116, 139);
    doc.text("No facilities were identified within the search radius.", 15, 70);
  }

  pageFooter();
  applyWatermark();

  // ── PAGES 5..(4 + numFacPages): FACILITY LISTINGS ────────────────────────
  function facilityPages(startPage) {
    const chunks = [];
    for (let i = 0; i < facsInRadius.length; i += PER_PAGE) {
      chunks.push(facsInRadius.slice(i, i + PER_PAGE));
    }
    if (chunks.length === 0) chunks.push([]);
    chunks.forEach((chunk, ci) => {
      doc.addPage();
      pageHeader(startPage + ci);
      if (ci === 0) {
        doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(30, 41, 59);
        doc.text("All Facilities Within " + searchRadius + "km", 15, 32);
        doc.setFillColor(249, 115, 22); doc.rect(15, 37, 50, 1.5, "F");
        doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(100, 116, 139);
        doc.text(facsInRadius.length + " facilities sorted by distance  |  All figures are modeled estimates", 15, 45);
      } else {
        doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.setTextColor(30, 41, 59);
        doc.text("All Facilities Within " + searchRadius + "km (continued)", 15, 31);
        doc.setFillColor(249, 115, 22); doc.rect(15, 35, 50, 1.5, "F");
      }
      let cy = CARD_START;
      chunk.forEach(fac => {
        const mw = resolvePower(fac);
        const noise = resolveNoise(fac);
        drawCard(
          cy,
          fac.Name || "Unnamed",
          fac.Company || "",
          fac.City || "",
          "Distance: " + ((fac._km != null) ? fac._km.toFixed(1) : "?") + " km",
          exposureTier(fac.Risk_Level),
          fac.Power_MW ? fac.Power_MW + " MW" : (fmtNum(mw) + " MW"),
          fac.Noise_DB ? fac.Noise_DB + " dB" : (fmtNum(noise) + " dB"),
          fac.EMF_Fence_High ? fac.EMF_Fence_High + " mG" : "Est.",
          fac.EMF_100m ? fac.EMF_100m + " mG" : "Est.",
          fac.Cooling || "N/A",
          fac.Opened || "N/A",
        );
        cy += CARD_H + CARD_GAP;
      });
      if (chunk.length === 0) {
        doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(100, 116, 139);
        doc.text("No facilities were found within the search radius.", 15, CARD_START + 10);
      }
      pageFooter();
      applyWatermark();
    });
  }
  facilityPages(5);

  // ── REGIONAL CONTEXT ──────────────────────────────────────────────────────
  doc.addPage();
  const regionalPage = 5 + numFacPages;
  pageHeader(regionalPage);
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(30, 41, 59);
  doc.text("Regional Context", 15, 32);
  doc.setFillColor(249, 115, 22); doc.rect(15, 37, 50, 1.5, "F");
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(100, 116, 139);
  doc.text("How this region compares to the wider HumZones registry, with live growth indicators.", 15, 45);

  const totalAll = facs.length;
  const regionalStats = [
    { label: "Facilities in Radius", value: String(statTotal) },
    { label: "Tracked Globally", value: fmtNum(totalAll) },
    { label: "Share of Global", value: totalAll ? ((statTotal / totalAll) * 100).toFixed(2) + "%" : "N/A" },
    { label: "Avg MW per Facility", value: statTotal ? fmtNum(totalPower / statTotal) : "N/A" },
  ];
  regionalStats.forEach((s, i) => {
    const x = 15 + i * 45;
    doc.setFillColor(248, 250, 252); doc.rect(x, 52, 38, 30, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor(30, 41, 59);
    doc.text(s.value, x + 19, 67, { align: "center" });
    doc.setFont("helvetica", "bold"); doc.setFontSize(6); doc.setTextColor(100, 116, 139);
    doc.text(s.label.toUpperCase(), x + 19, 76, { align: "center" });
  });

  doc.setFillColor(255, 247, 237); doc.rect(15, 92, 180, 38, "F");
  doc.setFillColor(249, 115, 22); doc.rect(15, 92, 3, 38, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(249, 115, 22);
  doc.text("WHAT THIS MEANS", 22, 98);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(30, 41, 59);
  const whatLines = doc.splitTextToSize(
    "This radius represents " + (totalAll ? ((statTotal / totalAll) * 100).toFixed(2) : "0") + "% of the global facility set tracked by HumZones. Use the live growth indicators below to gauge regional trajectory; planned and building sites are leading indicators of where capacity is heading next.",
    170
  );
  doc.text(whatLines, 22, 106);

  doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(30, 41, 59);
  doc.text("Live Registry Growth", 15, 140);
  doc.setFillColor(249, 115, 22); doc.rect(15, 143, 40, 0.7, "F");
  const statusUpper = (f) => String(f.Facility_Status || "").toUpperCase();
  const operating = facs.filter(f => statusUpper(f) === "OPERATING").length;
  const building = facs.filter(f => statusUpper(f) === "BUILDING").length;
  const planned = facs.filter(f => statusUpper(f) === "PLANNED").length;
  const liveStats = [
    { label: "Operating", value: fmtNum(operating), color: [34, 197, 94] },
    { label: "Building", value: fmtNum(building), color: [249, 115, 22] },
    { label: "Planned", value: fmtNum(planned), color: [59, 130, 246] },
  ];
  liveStats.forEach((s, i) => {
    const x = 15 + i * 60;
    doc.setFillColor(248, 250, 252); doc.rect(x, 150, 55, 30, "F");
    doc.setFillColor(...s.color); doc.rect(x, 150, 55, 3, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.setTextColor(...s.color);
    doc.text(s.value, x + 27, 167, { align: "center" });
    doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(100, 116, 139);
    doc.text(s.label.toUpperCase(), x + 27, 175, { align: "center" });
  });

  pageFooter();
  applyWatermark();

  // ── PROFESSIONAL ACTION STEPS ─────────────────────────────────────────────
  doc.addPage();
  pageHeader(regionalPage + 1);
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(30, 41, 59);
  doc.text("Professional Action Steps", 15, 32);
  doc.setFillColor(249, 115, 22); doc.rect(15, 37, 50, 1.5, "F");
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(100, 116, 139);
  doc.text("Recommended workflow for professionals reviewing infrastructure risk in this region.", 15, 45);

  const actions = [
    { num: "01", title: "Verify the address coordinates", body: "Cross-check the search address against the latitude and longitude pair used to compute facility distances. A misplaced pin can shift the radius result substantially in dense corridors." },
    { num: "02", title: "Confirm the highest-impact facilities", body: "For each HIGH impact facility, pull the operator's most recent regulatory filing or utility interconnection record to confirm modeled power draw matches the live operating load." },
    { num: "03", title: "Document the cooling profile", body: "Cooling type drives the water footprint and a meaningful fraction of the noise footprint. Evaporative designs warrant on-site verification when a project is within 1 km." },
    { num: "04", title: "Stage a community impact memo", body: "Use the facilities table as the starting point for a formal memo. The closest facility's metric block on page 4 is structured to drop directly into a planning packet." },
    { num: "05", title: "Re-run before any close", body: "Re-generate this report immediately before a transaction closes. The registry adds Building and Planned facilities continuously; a 30-day-old report can miss a permitted expansion." },
  ];
  let ay = 51;
  actions.forEach(a => {
    doc.setFillColor(248, 250, 252); doc.rect(15, ay, 180, BLOCK_H, "F");
    doc.setFillColor(249, 115, 22); doc.rect(15, ay, 3, BLOCK_H, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.setTextColor(249, 115, 22);
    doc.text(a.num, 22, ay + 12);
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(30, 41, 59);
    doc.text(a.title, 40, ay + 11);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(71, 85, 105);
    const wrap = doc.splitTextToSize(a.body, 152);
    doc.text(wrap, 40, ay + 19);
    ay += BLOCK_H + 2;
  });

  pageFooter();
  applyWatermark();

  // ── GLOSSARY ──────────────────────────────────────────────────────────────
  doc.addPage();
  pageHeader(regionalPage + 2);
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(30, 41, 59);
  doc.text("Glossary", 15, 32);
  doc.setFillColor(249, 115, 22); doc.rect(15, 37, 50, 1.5, "F");
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(100, 116, 139);
  doc.text("Key terms used throughout HumZones professional reports.", 15, 45);

  const glossary = [
    ["Impact Category", "Relative tier (HIGH, MODERATE, LOW) combining power draw, cooling type, and proximity."],
    ["Power Draw (MW)", "Estimated megawatts of electrical load. Sourced from utility filings where available."],
    ["EMF Fence Line", "Modeled milligauss reading at the facility perimeter from substations and feeders."],
    ["EMF 100 m", "Modeled milligauss reading at 100 meters from the same emission sources."],
    ["Noise (dB)", "Modeled dB(A) sound pressure at the fence line under typical operating load."],
    ["Cooling Type", "Air, chilled water, or evaporative. Drives water footprint and a portion of noise."],
    ["Water Use (gal/day)", "Daily water consumption estimate based on cooling type and load."],
    ["Annual CO2 (t)", "Estimated annual carbon emissions in metric tons from total power draw."],
    ["Facility Status", "Operating, Building, or Planned. From operator announcements and permits."],
    ["Search Radius", "Distance in kilometers from the search address used to filter facilities."],
    ["Modeled Estimate", "Calculated value from publicly available data, not a certified measurement."],
    ["Report ID", "Unique identifier in the format HZ-PRO-YYYYMMDD-NNNNN for audit and re-issue."],
  ];
  let gy = 53;
  glossary.forEach((g, i) => {
    if (i % 2 === 0) { doc.setFillColor(248, 250, 252); doc.rect(15, gy - 4, 180, 16, "F"); }
    doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(30, 41, 59);
    doc.text(g[0], 22, gy + 1);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(71, 85, 105);
    const w = doc.splitTextToSize(g[1], 110);
    doc.text(w, 75, gy + 1);
    gy += 16;
  });

  pageFooter();
  applyWatermark();

  // ── DISCLAIMER ────────────────────────────────────────────────────────────
  doc.addPage();
  pageHeader(regionalPage + 3);
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(30, 41, 59);
  doc.text("Disclaimer and Licensing", 15, 32);
  doc.setFillColor(249, 115, 22); doc.rect(15, 37, 50, 1.5, "F");
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(100, 116, 139);
  doc.text("Please review the following terms before relying on this report for any decision.", 15, 45);

  const sections = [
    ["Informational Purpose Only", "This report is provided for informational and public awareness purposes only. Nothing in this report constitutes medical, legal, scientific, environmental, financial, or real estate advice."],
    ["No Certified Measurements", "All figures including power draw, water use, CO2 emissions, noise levels, and EMF ranges are modeled estimates derived from publicly available information. They are not certified field measurements."],
    ["Impact Tiers Are Relative", "Impact categories (HIGH, MODERATE, LOW) are relative indicators of facility scale and proximity, not regulatory, scientific, or medical determinations of harm."],
    ["No Health Claims", "HumZones makes no claim that any listed facility causes, contributes to, or is associated with any specific health condition or outcome."],
    ["Data Currency", "Registry data is updated continuously. This snapshot reflects the registry state at the time of generation; re-run reports immediately before any transaction close."],
    ["Commercial License", "Use of this report is licensed under your active HumZones business plan. Redistribution outside your organization requires written consent."],
    ["Third-Party References", "References to organizations such as WHO and IARC are provided for general context and do not constitute endorsement by those bodies."],
    ["Limitation of Liability", "HumZones Technologies Inc. accepts no liability for decisions made in reliance on the information in this report. Always consult appropriately qualified professionals."],
  ];
  let sy = 52;
  sections.forEach(s => {
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(30, 41, 59);
    doc.text(s[0], 15, sy);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(71, 85, 105);
    const w = doc.splitTextToSize(s[1], 180);
    doc.text(w, 15, sy + 4);
    sy += 4 + w.length * 3.5 + 5;
  });

  // Final branded footer band
  doc.setFillColor(30, 41, 59); doc.rect(0, 265, PAGE_W, 32, "F");
  {
    const sf = doc.internal.scaleFactor;
    const Y1 = 269;
    const baseY = Y1 + 10 * 0.6 * 0.82;
    doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    const wHum = doc.getStringUnitWidth("Hum") * 10 / sf;
    const wZones = doc.getStringUnitWidth("Zones") * 10 / sf;
    const tmSize = Math.max(4, Math.floor(10 * 0.42));
    const wTM = doc.getStringUnitWidth("TM") * tmSize / sf;
    doc.setFontSize(10); doc.setTextColor(255, 255, 255);
    doc.text("Hum", 15, baseY);
    doc.setTextColor(249, 115, 22);
    doc.text("Zones", 15 + wHum, baseY);
    doc.setFontSize(tmSize);
    doc.text("TM", 15 + wHum + wZones, baseY - 10 * 0.2);
    const endX = 15 + wHum + wZones + wTM + 0.5;
    doc.setFontSize(10); doc.setFont("helvetica", "bold"); doc.setTextColor(255, 255, 255);
    doc.text(" Technologies Inc.", endX, baseY);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(249, 115, 22);
    doc.text("Global Data Center Health & Infrastructure Registry", 15, Y1 + 7 + 6 * 0.75);
    doc.setFontSize(7); doc.setTextColor(100, 116, 139);
    doc.text("humzones.com  |  hello@humzones.com  |  Report ID: " + rid, 15, Y1 + 13 + 6 * 0.75);
    doc.text("End of report.", 195, Y1 + 13 + 6 * 0.75, { align: "right" });
  }
  applyWatermark();

  return { doc, dateStr, rid };
}

// Greenfield Realty Partners sample wrapper used by the /business
// "Download Sample Report" CTA. Identical multi-page layout as the paid
// version with a diagonal SAMPLE watermark overlay on every page so a
// free demo is unambiguously distinguishable from a real deliverable.
async function generateSampleBusinessReportPDF() {
  // Facility_Status is included so the Regional Context page's Live
  // Registry Growth panel renders realistic Operating / Building / Planned
  // counts in the sample (otherwise every tile reads zero).
  const SAMPLE_FACS = [
    { Name: "Amazon Web Services IAD23",   Company: "AWS",                  City: "Ashburn, VA",  Risk_Level: "HIGH",     _km: 12.4, Power_MW: 120, Cooling: "Evaporative",   Opened: "2019", Facility_Status: "OPERATING" },
    { Name: "Equinix DC12",                Company: "Equinix",              City: "Ashburn, VA",  Risk_Level: "MODERATE", _km: 18.7, Power_MW: 36,  Cooling: "Chilled Water", Opened: "2014", Facility_Status: "OPERATING" },
    { Name: "Microsoft Azure East US",     Company: "Microsoft",            City: "Boydton, VA",  Risk_Level: "LOW",      _km: 28.3, Power_MW: 100, Cooling: "Air",           Opened: "2020", Facility_Status: "OPERATING" },
    { Name: "Digital Realty IAD44",        Company: "Digital Realty",       City: "Ashburn, VA",  Risk_Level: "MODERATE", _km: 34.1, Power_MW: 36,  Cooling: "Chilled Water", Opened: "2017", Facility_Status: "OPERATING" },
    { Name: "QTS Richmond 1",              Company: "QTS Realty Trust",     City: "Richmond, VA", Risk_Level: "HIGH",     _km: 48.2, Power_MW: 130, Cooling: "Evaporative",   Opened: "2018", Facility_Status: "OPERATING" },
    { Name: "Equinix DC10",                Company: "Equinix",              City: "Ashburn, VA",  Risk_Level: "MODERATE", _km: 51.3, Power_MW: 36,  Cooling: "Chilled Water", Opened: "2013", Facility_Status: "OPERATING" },
    { Name: "Google Loudoun County",       Company: "Google",               City: "Leesburg, VA", Risk_Level: "LOW",      _km: 58.7, Power_MW: 150, Cooling: "Air",           Opened: "2021", Facility_Status: "OPERATING" },
    { Name: "CyrusOne Northern VA",        Company: "CyrusOne",             City: "Sterling, VA", Risk_Level: "MODERATE", _km: 62.1, Power_MW: 20,  Cooling: "Chilled Water", Opened: "2016", Facility_Status: "BUILDING" },
    { Name: "Iron Mountain Manassas",      Company: "Iron Mountain",        City: "Manassas, VA", Risk_Level: "HIGH",     _km: 71.4, Power_MW: 280, Cooling: "Evaporative",   Opened: "2019", Facility_Status: "BUILDING" },
    { Name: "DataBank LGA3",               Company: "DataBank",             City: "Culpeper, VA", Risk_Level: "LOW",      _km: 82.6, Power_MW: 15,  Cooling: "Air",           Opened: "2015", Facility_Status: "OPERATING" },
    { Name: "Vantage Ashburn III",         Company: "Vantage Data Centers", City: "Ashburn, VA",  Risk_Level: "MODERATE", _km: 88.3, Power_MW: 48,  Cooling: "Chilled Water", Opened: "2020", Facility_Status: "PLANNED" },
    { Name: "CoreSite BO1",                Company: "CoreSite",             City: "Reston, VA",   Risk_Level: "HIGH",     _km: 94.7, Power_MW: 18,  Cooling: "Evaporative",   Opened: "2012", Facility_Status: "PLANNED" },
  ];
  return generateBusinessReportPDF({
    searchAddress: "1600 Pennsylvania Avenue NW, Washington DC 20500",
    facsInRadius: SAMPLE_FACS,
    searchRadius: 100,
    facs: SAMPLE_FACS,
    businessAccount: { company: "Greenfield Realty Partners" },
    sample: true,
  });
}

// ─── PERSONAL REPORT PDF (NEW FORMAT) ────────────────────────────────────────
// A4 portrait, six-section consumer report used by the paid $14.99
// /verify-report flow and the /my-report re-download flow. Returns
// { doc, dateStr, rid } so the caller can save under a stable filename
// and persist the report ID alongside the Airtable row.
async function generatePersonalReportPDF({
  searchAddress,
  facsInRadius,
  searchRadius = 100,
  sample = false,
}) {
  const jsPDFModule = await import("jspdf");
  const { jsPDF } = jsPDFModule;
  const doc = new jsPDF({ unit: "mm", format: "a4" });

  const CARD_H = 34;
  const CARD_GAP = 4;
  const BADGE_H = 7;
  const BADGE_OFF = 5;
  const PER_PAGE = 5;
  const CARD_START = 52;
  const PAGE_W = 210;
  const PAGE_H = 297;

  const resolvePower = (f) => {
    const v = Number(f.Power_MW);
    if (Number.isFinite(v) && v > 0) return v;
    const lvl = String(f.Risk_Level || "").toUpperCase();
    if (lvl === "HIGH") return 50;
    if (lvl === "MODERATE") return 25;
    return 10;
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
  const resolveCO2 = (f, mw) => {
    const v = Number(f.CO2_Tons_Year);
    if (Number.isFinite(v) && v > 0) return v;
    return Math.round((mw * 3381) / 1000) * 1000;
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
  facsInRadius.forEach(f => {
    const t = exposureTier(f.Risk_Level);
    if (t === "HIGH") counts.HIGH++;
    else if (t === "LOW") counts.LOW++;
    else counts.MODERATE++;
    const mw = resolvePower(f);
    totalPower += mw;
    totalWater += resolveWater(f, mw);
    totalCO2 += resolveCO2(f, mw);
  });

  const todayDate = new Date();
  const dateStr = todayDate.toISOString().slice(0, 10);
  const dateCompact = dateStr.replace(/-/g, "");
  const dateLong = todayDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const rid = "HZ-" + dateCompact + "-" + Math.floor(Math.random() * 90000 + 10000);

  const facilityPageCount = Math.max(1, Math.ceil(facsInRadius.length / PER_PAGE));
  const TOTAL_PAGES = 1 + 1 + 1 + facilityPageCount + 1 + 1;

  const fmtNum = (n) => Math.round(Number(n) || 0).toLocaleString();

  // Split the geocoded address into a primary line and a secondary
  // city/region line so the cover header reads cleanly on two rows.
  const addrParts = String(searchAddress || "").split(",").map(s => s.trim()).filter(Boolean);
  const primaryLine = addrParts[0] || "Address not provided";
  const secondaryLine = addrParts.slice(1).join(", ") || "";

  function logoCell(x, y, mainSize, colorHum, colorZones) {
    const sf = doc.internal.scaleFactor;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(mainSize);
    const wHum = doc.getStringUnitWidth("Hum") * mainSize / sf;
    const wZones = doc.getStringUnitWidth("Zones") * mainSize / sf;
    const tmSize = Math.max(4, Math.floor(mainSize * 0.42));
    doc.setFontSize(tmSize);
    const wTM = doc.getStringUnitWidth("TM") * tmSize / sf;
    const cellH = mainSize * 0.6;
    const baseY = y + cellH * 0.82;
    doc.setFontSize(mainSize);
    doc.setTextColor(...colorHum);
    doc.text("Hum", x, baseY);
    doc.setTextColor(...colorZones);
    doc.text("Zones", x + wHum, baseY);
    doc.setFontSize(tmSize);
    doc.setTextColor(...colorZones);
    doc.text("TM", x + wHum + wZones, baseY - mainSize * 0.2);
    return x + wHum + wZones + wTM + 0.5;
  }

  function impactColors(level) {
    if (level === "HIGH") return { tc: [239, 68, 68], bc: [254, 242, 242] };
    if (level === "MODERATE") return { tc: [249, 115, 22], bc: [255, 247, 237] };
    return { tc: [34, 197, 94], bc: [240, 253, 244] };
  }

  function consumerPageHeader(pageNum) {
    doc.setFillColor(30, 41, 59); doc.rect(0, 0, PAGE_W, 18, "F");
    logoCell(15, 4, 11, [255, 255, 255], [249, 115, 22]);
    doc.setFontSize(8); doc.setFont("helvetica", "normal"); doc.setTextColor(148, 163, 184);
    doc.text("Your Personalized Area Report  |  Page " + pageNum + " of " + TOTAL_PAGES, 195, 10, { align: "right" });
  }

  function consumerPageFooter() {
    doc.setFillColor(30, 41, 59); doc.rect(0, 267, PAGE_W, 30, "F");
    const sf = doc.internal.scaleFactor;
    const Y1 = 271;
    const Y2 = Y1 + 7;
    const baseY = Y1 + 9 * 0.6 * 0.82;
    doc.setFontSize(9); doc.setFont("helvetica", "bold");
    const wHum = doc.getStringUnitWidth("Hum") * 9 / sf;
    const wZones = doc.getStringUnitWidth("Zones") * 9 / sf;
    const tmSize = Math.max(4, Math.floor(9 * 0.42));
    const wTM = doc.getStringUnitWidth("TM") * tmSize / sf;
    doc.setFontSize(9); doc.setTextColor(255, 255, 255);
    doc.text("Hum", 15, baseY);
    doc.setTextColor(249, 115, 22);
    doc.text("Zones", 15 + wHum, baseY);
    doc.setFontSize(tmSize);
    doc.text("TM", 15 + wHum + wZones, baseY - 9 * 0.2);
    const endX = 15 + wHum + wZones + wTM + 0.5;
    doc.setFontSize(9); doc.setFont("helvetica", "bold"); doc.setTextColor(255, 255, 255);
    doc.text(" Technologies Inc.", endX, baseY);
    doc.setFontSize(7); doc.setFont("helvetica", "normal"); doc.setTextColor(100, 116, 139);
    doc.text("humzones.com  |  Report ID: " + rid + "  |  All figures are modeled estimates", 15, Y2 + 6 * 0.75);
    applyWatermark();
  }

  // Diagonal SAMPLE watermark applied last on every page when sample:true
  // so a freely downloaded demo can never be confused with a paid report.
  function applyWatermark() {
    if (!sample) return;
    try {
      doc.saveGraphicsState();
      const gs = new doc.GState({ opacity: 0.15 });
      doc.setGState(gs);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(60);
      doc.setTextColor(150, 150, 150);
      doc.text("SAMPLE", PAGE_W / 2, PAGE_H / 2, { align: "center", angle: -45 });
      doc.restoreGraphicsState();
    } catch (e) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(60);
      doc.setTextColor(220, 220, 220);
      doc.text("SAMPLE", PAGE_W / 2, PAGE_H / 2, { align: "center", angle: -45 });
    }
  }

  function drawConsumerCard(y, name, company, city, dist, level, power, noise, emfF, emf100, cooling, opened) {
    const { tc, bc } = impactColors(level);
    doc.setFillColor(...bc); doc.rect(15, y, 180, CARD_H, "F");
    doc.setFillColor(...tc); doc.rect(15, y, 3, CARD_H, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(30, 41, 59);
    doc.text(String(name || "Facility"), 22, y + 3 + 10 * 0.6 * 0.82);
    const bw = level === "MODERATE" ? 28 : 21;
    doc.setFillColor(...tc); doc.rect(195 - bw, y + BADGE_OFF, bw, BADGE_H, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(6); doc.setTextColor(255, 255, 255);
    doc.text(level + " IMPACT", 195 - bw + bw / 2, y + BADGE_OFF + BADGE_H * 0.75, { align: "center" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(100, 116, 139);
    const ccText = String(company || "") + "  |  " + String(city || "");
    doc.text(ccText, 22, y + 11 + 8 * 0.6 * 0.82);
    doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(...tc);
    const ccWidth = doc.getStringUnitWidth(ccText) * 8 / doc.internal.scaleFactor;
    doc.text(dist + " km from your address", 22 + ccWidth + 3, y + 11 + 8 * 0.6 * 0.82);
    const metrics = [
      ["Power", power],
      ["Noise", noise],
      ["EMF Fence", emfF],
      ["EMF 100m", emf100],
      ["Cooling", cooling],
      ["Opened", opened],
    ];
    metrics.forEach(([label, val], i) => {
      const mx = 22 + i * 29;
      doc.setFont("helvetica", "bold"); doc.setFontSize(6); doc.setTextColor(100, 116, 139);
      doc.text(label, mx, y + 22 + 6 * 0.6 * 0.82);
      doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(30, 41, 59);
      doc.text(String(val || "N/A"), mx, y + 27 + 7 * 0.6 * 0.82);
    });
  }

  // ── PAGE 1: COVER ─────────────────────────────────────────────────────────
  doc.setFillColor(15, 23, 42); doc.rect(0, 0, PAGE_W, 130, "F");
  doc.setFillColor(249, 115, 22); doc.rect(0, 128, PAGE_W, 3, "F");
  logoCell(15, 12, 24, [255, 255, 255], [249, 115, 22]);
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(249, 115, 22);
  doc.text("Global Data Center Health & Infrastructure Registry", 15, 29);
  doc.setFillColor(249, 115, 22); doc.rect(15, 40, 75, 10, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(255, 255, 255);
  doc.text("YOUR PERSONALIZED AREA REPORT", 15 + 37.5, 40 + 6.5, { align: "center" });
  doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(148, 163, 184);
  doc.text("ADDRESS ANALYZED", 15, 56);
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(255, 255, 255);
  doc.text(primaryLine, 15, 63);
  doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(148, 163, 184);
  doc.text((secondaryLine ? secondaryLine + "  |  " : "") + searchRadius + " km radius", 15, 73);

  doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(148, 163, 184);
  doc.text("INFRASTRUCTURE WITHIN YOUR SEARCH AREA", 15, 88);

  const statTotal = facsInRadius.length;
  const coverStats = [
    { color: [255, 255, 255], value: String(statTotal), label1: "Total",     label2: "Facilities" },
    { color: [239, 68, 68],   value: String(counts.HIGH), label1: "HIGH",     label2: "Impact" },
    { color: [249, 115, 22],  value: String(counts.MODERATE), label1: "MODERATE", label2: "Impact" },
    { color: [34, 197, 94],   value: String(counts.LOW),  label1: "LOW",      label2: "Impact" },
  ];
  coverStats.forEach((s, i) => {
    const x = 15 + i * 47;
    doc.setFont("helvetica", "bold"); doc.setFontSize(28); doc.setTextColor(...s.color);
    doc.text(s.value, x + 22, 108, { align: "center" });
    doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(148, 163, 184);
    doc.text(s.label1, x + 22, 116, { align: "center" });
    doc.text(s.label2, x + 22, 120, { align: "center" });
  });

  // Light section
  doc.setFillColor(248, 250, 252); doc.rect(0, 131, PAGE_W, 136, "F");
  doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(100, 116, 139);
  doc.text("Report ID: " + rid, 15, 138);
  doc.text("Generated: " + dateLong, 195, 138, { align: "right" });

  doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor(30, 41, 59);
  doc.text("What This Report Includes", 15, 148);
  doc.setFillColor(249, 115, 22); doc.rect(15, 156, 25, 1.5, "F");

  const coverItems = [
    { t: "Area at a Glance",          d: "Summary statistics for the facilities within your search radius." },
    { t: "Understanding Your Results", d: "What HIGH, MODERATE, and LOW impact actually mean in plain language." },
    { t: "Facility Listings",         d: "Every facility within your radius with metrics on power, noise, EMF, and cooling." },
    { t: "What You Can Do",           d: "Five concrete next steps to learn more, share, and stay informed." },
    { t: "Important Disclaimer",      d: "Plain-English terms describing what this report is and is not." },
  ];
  let ciy = 163;
  coverItems.forEach(it => {
    doc.setFillColor(249, 115, 22); doc.rect(15, ciy, 3, 3, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(30, 41, 59);
    doc.text(it.t, 22, ciy + 2);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(100, 116, 139);
    doc.text(it.d, 22, ciy + 8);
    ciy += 17;
  });

  // Cover footer
  doc.setFillColor(30, 41, 59); doc.rect(0, 267, PAGE_W, 30, "F");
  {
    const sf = doc.internal.scaleFactor;
    const Y1 = 271;
    const Y2 = Y1 + 7;
    const baseY = Y1 + 9 * 0.6 * 0.82;
    doc.setFont("helvetica", "bold"); doc.setFontSize(9);
    const wHum = doc.getStringUnitWidth("Hum") * 9 / sf;
    const wZones = doc.getStringUnitWidth("Zones") * 9 / sf;
    const tmSize = Math.max(4, Math.floor(9 * 0.42));
    const wTM = doc.getStringUnitWidth("TM") * tmSize / sf;
    doc.setFontSize(9); doc.setTextColor(255, 255, 255);
    doc.text("Hum", 15, baseY);
    doc.setTextColor(249, 115, 22);
    doc.text("Zones", 15 + wHum, baseY);
    doc.setFontSize(tmSize);
    doc.text("TM", 15 + wHum + wZones, baseY - 9 * 0.2);
    const endX = 15 + wHum + wZones + wTM + 0.5;
    doc.setFontSize(9); doc.setFont("helvetica", "bold"); doc.setTextColor(255, 255, 255);
    doc.text(" Technologies Inc.", endX, baseY);
    doc.setFontSize(7); doc.setFont("helvetica", "normal"); doc.setTextColor(100, 116, 139);
    doc.text("Report ID: " + rid + "  |  humzones.com  |  All figures are modeled estimates - not certified measurements", 15, Y2 + 6 * 0.75);
  }
  applyWatermark();

  // ── PAGE 2: AREA AT A GLANCE ──────────────────────────────────────────────
  doc.addPage();
  consumerPageHeader(2);
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(30, 41, 59);
  doc.text("Area at a Glance", 15, 32);
  doc.setFillColor(249, 115, 22); doc.rect(15, 37, 35, 1.5, "F");
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(100, 116, 139);
  const introLines = doc.splitTextToSize(
    "This page summarizes the infrastructure footprint within your " + searchRadius + " km search radius. All figures are modeled from publicly available data.",
    180
  );
  doc.text(introLines, 15, 45);

  // 3 summary stat boxes
  const summary = [
    { label: "COMBINED POWER",  value: fmtNum(totalPower) + " MW", sub: "Total estimated megawatts" },
    { label: "DAILY WATER USE", value: fmtNum(totalWater) + " gal", sub: "Estimated total per day" },
    { label: "ANNUAL CO2",      value: fmtNum(totalCO2) + " t",     sub: "Estimated tons per year" },
  ];
  summary.forEach((s, i) => {
    const x = 15 + i * 63;
    doc.setFillColor(248, 250, 252); doc.rect(x, 70, 57, 32, "F");
    doc.setFillColor(249, 115, 22); doc.rect(x, 70, 57, 2, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(100, 116, 139);
    doc.text(s.label, x + 4, 79);
    doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor(30, 41, 59);
    doc.text(s.value, x + 4, 90);
    doc.setFont("helvetica", "normal"); doc.setFontSize(6); doc.setTextColor(100, 116, 139);
    doc.text(s.sub, x + 4, 96);
  });

  // Closest facility highlight
  const closest = facsInRadius[0];
  if (closest) {
    const tier = exposureTier(closest.Risk_Level);
    const cl = impactColors(tier);
    doc.setFillColor(...cl.bc); doc.rect(15, 118, 180, 35, "F");
    doc.setFillColor(...cl.tc); doc.rect(15, 118, 4, 35, "F");
    const cbw = tier === "MODERATE" ? 32 : 24;
    doc.setFillColor(...cl.tc); doc.rect(195 - cbw - 4, 122, cbw, 8, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(255, 255, 255);
    doc.text(tier + " IMPACT", 195 - cbw - 4 + cbw / 2, 127, { align: "center" });
    doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(30, 41, 59);
    doc.text("Closest Facility", 24, 128);
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(...cl.tc);
    doc.text(String(closest.Name || "Unnamed Facility"), 24, 137);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(100, 116, 139);
    const cMW = resolvePower(closest);
    doc.text(
      (closest._km != null ? closest._km.toFixed(1) : "?") + " km  |  " +
      fmtNum(cMW) + " MW  |  " +
      (closest.City || "City unknown"),
      24, 145
    );
  } else {
    doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(100, 116, 139);
    doc.text("No facilities were identified within your search radius.", 15, 130);
  }

  // Facilities by distance
  doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor(30, 41, 59);
  doc.text("Facilities by Distance", 15, 160);
  doc.setFillColor(249, 115, 22); doc.rect(15, 168, 35, 1.5, "F");

  const r1 = searchRadius / 3;
  const r2 = 2 * searchRadius / 3;
  const distBands = [
    { lbl: "0 - " + r1.toFixed(0) + " km",                                  lo: 0,  hi: r1, color: [239, 68, 68], bc: [254, 242, 242] },
    { lbl: r1.toFixed(0) + " - " + r2.toFixed(0) + " km",                   lo: r1, hi: r2, color: [249, 115, 22], bc: [255, 247, 237] },
    { lbl: r2.toFixed(0) + " - " + searchRadius + " km",                    lo: r2, hi: searchRadius, color: [34, 197, 94], bc: [240, 253, 244] },
  ];
  let dby = 175;
  distBands.forEach(d => {
    const inBand = facsInRadius.filter(f => (f._km || 0) >= d.lo && (f._km || 0) < d.hi + 0.001);
    const h = inBand.filter(f => exposureTier(f.Risk_Level) === "HIGH").length;
    const m = inBand.filter(f => exposureTier(f.Risk_Level) === "MODERATE").length;
    const l = inBand.filter(f => exposureTier(f.Risk_Level) === "LOW").length;
    doc.setFillColor(248, 250, 252); doc.rect(15, dby, 180, 16, "F");
    doc.setFillColor(...d.color); doc.rect(15, dby, 3, 16, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(30, 41, 59);
    doc.text(d.lbl, 22, dby + 7);
    doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.setTextColor(...d.color);
    doc.text(String(inBand.length), 22, dby + 13);
    // Mini-badges
    const tiers = [
      { lbl: "HIGH " + h,     c: [239, 68, 68] },
      { lbl: "MOD " + m,      c: [249, 115, 22] },
      { lbl: "LOW " + l,      c: [34, 197, 94] },
    ];
    tiers.forEach((t, i) => {
      const tx = 60 + i * 26;
      doc.setFillColor(...t.c); doc.rect(tx, dby + 4, 22, 8, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(255, 255, 255);
      doc.text(t.lbl, tx + 11, dby + 9, { align: "center" });
    });
    dby += 18;
  });

  consumerPageFooter();

  // ── PAGE 3: UNDERSTANDING YOUR RESULTS ────────────────────────────────────
  doc.addPage();
  consumerPageHeader(3);
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(30, 41, 59);
  doc.text("Understanding Your Results", 15, 32);
  doc.setFillColor(249, 115, 22); doc.rect(15, 37, 45, 1.5, "F");
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(100, 116, 139);
  const understandLines = doc.splitTextToSize(
    "Impact categories are relative indicators of facility scale and proximity, not regulatory, scientific, or medical determinations. Use them to compare facilities in your area, not as a hard threshold of harm.",
    180
  );
  doc.text(understandLines, 15, 45);

  const impactBlocks = [
    { lvl: "HIGH IMPACT",     title: "Large or close-in industrial-scale facilities", desc: "Typically 50 MW or more, very close to residential areas, or running evaporative cooling at scale. These have the largest documented footprint for power, water, noise, and EMF.", color: [239, 68, 68], bc: [254, 242, 242] },
    { lvl: "MODERATE IMPACT", title: "Mid-scale facilities with measurable footprint", desc: "Usually 10 to 50 MW with measurable power draw and noise. Common along major fiber routes and on suburban edges. Real impact, but materially smaller than the upper tier.", color: [249, 115, 22], bc: [255, 247, 237] },
    { lvl: "LOW IMPACT",      title: "Smaller or air-cooled facilities", desc: "Typically under 10 MW or running air-cooled designs. The footprint is real but limited, and EMF exposure at residential distances is generally low.", color: [34, 197, 94], bc: [240, 253, 244] },
  ];
  let iby = 70;
  impactBlocks.forEach(b => {
    doc.setFillColor(...b.bc); doc.rect(15, iby, 180, 40, "F");
    doc.setFillColor(...b.color); doc.rect(15, iby, 4, 40, "F");
    // Big label badge on the left
    doc.setFillColor(...b.color); doc.rect(22, iby + 8, 55, 10, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(255, 255, 255);
    doc.text(b.lvl, 22 + 27.5, iby + 14.5, { align: "center" });
    doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(30, 41, 59);
    doc.text(b.title, 82, iby + 15);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(100, 116, 139);
    const wrap = doc.splitTextToSize(b.desc, 165);
    doc.text(wrap, 22, iby + 25);
    iby += 45;
  });

  // Important note box
  doc.setFillColor(241, 245, 249); doc.rect(15, 208, 180, 35, "F");
  doc.setFillColor(59, 130, 246); doc.rect(15, 208, 3, 35, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(30, 41, 59);
  doc.text("Important Note on These Figures", 22, 216);
  doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(71, 85, 105);
  const noteLines = doc.splitTextToSize(
    "Every figure in this report is a modeled estimate derived from publicly available data such as utility filings, permits, and operator announcements. They are not certified field measurements. Use them as a starting point for your own questions and conversations, not as a final regulatory or medical determination.",
    170
  );
  doc.text(noteLines, 22, 224);

  consumerPageFooter();

  // ── PAGES 4..(3 + facilityPageCount): FACILITY LISTINGS ──────────────────
  function facilityPages(startPage) {
    const chunks = [];
    for (let i = 0; i < facsInRadius.length; i += PER_PAGE) {
      chunks.push(facsInRadius.slice(i, i + PER_PAGE));
    }
    if (chunks.length === 0) chunks.push([]);
    chunks.forEach((chunk, ci) => {
      doc.addPage();
      consumerPageHeader(startPage + ci);
      if (ci === 0) {
        doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(30, 41, 59);
        doc.text("Facilities Near Your Address", 15, 32);
        doc.setFillColor(249, 115, 22); doc.rect(15, 37, 45, 1.5, "F");
        doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(100, 116, 139);
        doc.text(facsInRadius.length + " " + (facsInRadius.length === 1 ? "facility" : "facilities") + " within " + searchRadius + " km, sorted by distance", 15, 45);
      } else {
        doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.setTextColor(30, 41, 59);
        doc.text("Facilities Near Your Address (continued)", 15, 31);
        doc.setFillColor(249, 115, 22); doc.rect(15, 35, 45, 1.5, "F");
      }
      let cy = CARD_START;
      chunk.forEach(fac => {
        const mw = resolvePower(fac);
        const noise = resolveNoise(fac);
        drawConsumerCard(
          cy,
          fac.Name || "Unnamed",
          fac.Company || "",
          fac.City || "",
          (fac._km != null ? fac._km.toFixed(1) : "?"),
          exposureTier(fac.Risk_Level),
          fac.Power_MW ? fac.Power_MW + " MW" : (fmtNum(mw) + " MW"),
          fac.Noise_DB ? fac.Noise_DB + " dB" : (fmtNum(noise) + " dB"),
          fac.EMF_Fence_High ? fac.EMF_Fence_High + " mG" : "Est.",
          fac.EMF_100m ? fac.EMF_100m + " mG" : "Est.",
          fac.Cooling || "N/A",
          fac.Opened || "N/A",
        );
        cy += CARD_H + CARD_GAP;
      });
      if (chunk.length === 0) {
        doc.setFont("helvetica", "normal"); doc.setFontSize(11); doc.setTextColor(100, 116, 139);
        doc.text("No facilities were found within your search radius.", 15, CARD_START + 10);
      }
      consumerPageFooter();
    });
  }
  facilityPages(4);

  // ── WHAT YOU CAN DO ───────────────────────────────────────────────────────
  doc.addPage();
  const actionPageNum = 4 + facilityPageCount;
  consumerPageHeader(actionPageNum);
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(30, 41, 59);
  doc.text("What You Can Do", 15, 32);
  doc.setFillColor(249, 115, 22); doc.rect(15, 37, 35, 1.5, "F");
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(100, 116, 139);
  doc.text("Five concrete next steps you can take with the information in this report.", 15, 45);

  const actions = [
    { t: "1. Learn More", d: "Read the full HumZones methodology to see exactly how each figure in this report is modeled. Visit humzones.com/methodology." },
    { t: "2. Talk to Your Neighbors", d: "Share this report with neighbors so the wider community understands the infrastructure footprint in your area." },
    { t: "3. Submit Your Experience", d: "If you have experienced noise, vibration, or other impacts from a nearby facility, submit a report at humzones.com/submit-report." },
    { t: "4. Contact Local Representatives", d: "Bring this report to your local planning board, council member, or zoning office. Public officials act on documented community concerns." },
    { t: "5. Stay Informed", d: "Re-run this report every few months. The registry adds Building and Planned facilities continuously and your area's footprint can shift quickly." },
  ];
  let aty = 53;
  actions.forEach(a => {
    doc.setFillColor(255, 247, 237); doc.rect(15, aty, 180, 28, "F");
    doc.setFillColor(249, 115, 22); doc.rect(15, aty, 3, 28, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(30, 41, 59);
    doc.text(a.t, 22, aty + 9);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(100, 116, 139);
    const w = doc.splitTextToSize(a.d, 168);
    doc.text(w, 22, aty + 16);
    aty += 30;
  });

  // CTA box
  doc.setFillColor(30, 41, 59); doc.rect(15, 210, 180, 40, "F");
  doc.setFillColor(249, 115, 22); doc.rect(15, 210, 180, 2, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor(255, 255, 255);
  doc.text("Share Your Experience With HumZones", 105, 222, { align: "center" });
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(148, 163, 184);
  doc.text("Your verified report becomes part of the public registry at humzones.com", 105, 230, { align: "center" });
  doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(249, 115, 22);
  doc.text("humzones.com/submit-report", 105, 238, { align: "center" });
  doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(148, 163, 184);
  doc.text("Free to submit  |  Email verified  |  Anonymous option available", 105, 245, { align: "center" });

  consumerPageFooter();

  // ── DISCLAIMER (final page) ───────────────────────────────────────────────
  doc.addPage();
  const disclaimerPageNum = 5 + facilityPageCount;
  consumerPageHeader(disclaimerPageNum);
  doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.setTextColor(30, 41, 59);
  doc.text("Important Disclaimer", 15, 32);
  doc.setFillColor(249, 115, 22); doc.rect(15, 37, 45, 1.5, "F");
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(100, 116, 139);
  doc.text("Please read the following disclaimer carefully before relying on any information in this report.", 15, 45);

  const disclaim = [
    ["1. Informational Purpose Only", "This report is provided for informational and public awareness purposes only. Nothing in this report constitutes medical, legal, scientific, environmental, financial, or real estate advice."],
    ["2. No Certified Measurements", "All figures including power draw, water use, CO2 emissions, noise levels, and EMF ranges are modeled estimates derived from publicly available information. They are NOT certified field measurements and should not be cited as such."],
    ["3. No Health Claims", "HumZones(TM) Technologies Inc. makes no claim that any facility listed in this report causes, contributes to, or is associated with any specific health condition or outcome."],
    ["4. No Environmental or Regulatory Claims", "This report is not a regulatory filing, an environmental assessment, or a substitute for one. Impact categories are relative indicators, not regulatory determinations."],
    ["5. Data Sources", "Facility data is sourced from publicly available sources including utility filings, operator announcements, and permits. Information may be incomplete or out of date; the registry is updated continuously."],
    ["6. Limitation of Liability", "HumZones Technologies Inc. accepts no liability for decisions made in reliance on the information in this report. Always consult appropriately qualified professionals before making significant decisions."],
    ["7. Contact and Corrections", "If you believe any information in this report is inaccurate, please email hello@humzones.com. The full disclaimer is published at humzones.com/disclaimer."],
  ];
  let sy = 49;
  disclaim.forEach(s => {
    doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(30, 41, 59);
    doc.text(s[0], 15, sy);
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(71, 85, 105);
    const w = doc.splitTextToSize(s[1], 180);
    doc.text(w, 15, sy + 4);
    sy += 4 + w.length * 3.3 + 4;
  });

  // Final branded footer
  doc.setFillColor(30, 41, 59); doc.rect(0, 257, PAGE_W, 40, "F");
  doc.setFillColor(249, 115, 22); doc.rect(0, 257, PAGE_W, 2, "F");
  {
    const sf = doc.internal.scaleFactor;
    const Y1 = 264;
    const baseY = Y1 + 10 * 0.6 * 0.82;
    doc.setFont("helvetica", "bold"); doc.setFontSize(10);
    const wHum = doc.getStringUnitWidth("Hum") * 10 / sf;
    const wZones = doc.getStringUnitWidth("Zones") * 10 / sf;
    const tmSize = Math.max(4, Math.floor(10 * 0.42));
    const wTM = doc.getStringUnitWidth("TM") * tmSize / sf;
    doc.setFontSize(10); doc.setTextColor(255, 255, 255);
    doc.text("Hum", 15, baseY);
    doc.setTextColor(249, 115, 22);
    doc.text("Zones", 15 + wHum, baseY);
    doc.setFontSize(tmSize);
    doc.text("TM", 15 + wHum + wZones, baseY - 10 * 0.2);
    const endX = 15 + wHum + wZones + wTM + 0.5;
    doc.setFontSize(10); doc.setFont("helvetica", "bold"); doc.setTextColor(255, 255, 255);
    doc.text(" Technologies Inc.", endX, baseY);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(249, 115, 22);
    doc.text("Global Data Center Health & Infrastructure Registry", 15, Y1 + 8 + 6 * 0.75);
    doc.setFontSize(7); doc.setTextColor(148, 163, 184);
    doc.text("humzones.com  |  hello@humzones.com  |  Report ID: " + rid, 15, Y1 + 14 + 6 * 0.75);
    doc.text("Generated: " + dateLong + "  |  For personal, non-commercial use only.", 15, Y1 + 20 + 6 * 0.75);
  }
  applyWatermark();

  return { doc, dateStr, rid };
}

// Personal sample wrapper used by every consumer-facing "View Sample
// Report" CTA (the /get-report success teaser, the footer button, and the
// global header Reports menu). Reuses the paid generator with placeholder
// Austin facilities and a diagonal SAMPLE watermark on every page.
async function generateSamplePersonalReportPDF() {
  const SAMPLE_FACS = [
    { Name: "Amazon Data Center",        Company: "AWS",             City: "Austin, TX",       Risk_Level: "HIGH",     _km: 5.2,  Power_MW: 120, Cooling: "Evaporative",   Opened: "2019" },
    { Name: "Google Cloud Campus",       Company: "Google",          City: "Austin, TX",       Risk_Level: "MODERATE", _km: 12.8, Power_MW: 45,  Cooling: "Chilled Water", Opened: "2017" },
    { Name: "Microsoft Azure Region",    Company: "Microsoft",       City: "San Antonio, TX",  Risk_Level: "LOW",      _km: 24.6, Power_MW: 80,  Cooling: "Air",           Opened: "2020" },
    { Name: "Equinix DA11",              Company: "Equinix",         City: "Dallas, TX",       Risk_Level: "MODERATE", _km: 38.9, Power_MW: 32,  Cooling: "Chilled Water", Opened: "2015" },
    { Name: "Digital Realty DFW10",      Company: "Digital Realty",  City: "Dallas, TX",       Risk_Level: "HIGH",     _km: 47.3, Power_MW: 110, Cooling: "Evaporative",   Opened: "2018" },
    { Name: "CyrusOne Austin II",        Company: "CyrusOne",        City: "Austin, TX",       Risk_Level: "MODERATE", _km: 58.1, Power_MW: 28,  Cooling: "Chilled Water", Opened: "2016" },
    { Name: "QTS San Antonio 1",         Company: "QTS Realty Trust", City: "San Antonio, TX", Risk_Level: "LOW",      _km: 71.7, Power_MW: 18,  Cooling: "Air",           Opened: "2014" },
    { Name: "Iron Mountain Houston",     Company: "Iron Mountain",   City: "Houston, TX",      Risk_Level: "HIGH",     _km: 88.4, Power_MW: 95,  Cooling: "Evaporative",   Opened: "2019" },
  ];
  return generatePersonalReportPDF({
    searchAddress: "123 Main Street, Austin, Texas 78701",
    facsInRadius: SAMPLE_FACS,
    searchRadius: 100,
    sample: true,
  });
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

      // ─── Generate the PDF via the new consumer builder ───────────────────
      setStepMsg("Generating your personalized report...");
      setProgress(75);
      const { doc, dateStr } = await generatePersonalReportPDF({
        searchAddress,
        facsInRadius: facsNear,
        searchRadius: 100,
      });
      // Alias for downstream code that still references `dp` / datePart.
      const dp = dateStr;

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
          <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2,position:"relative",top:"-4px"}}>TM</sup>
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
            <div style={{marginTop:28,maxWidth:520,marginLeft:"auto",marginRight:"auto",background:"rgba(249,115,22,.10)",borderLeft:"3px solid #f97316",borderRadius:8,padding:"12px 16px",textAlign:"left"}}>
              <p style={{fontSize:13,color:"rgba(255,255,255,.78)",lineHeight:1.6,margin:0}}>
                Glad this was useful? Help us keep the database growing.{" "}
                <a href="/donate" onClick={e=>{e.preventDefault();onNavigate("/donate");}} style={{color:"#f97316",fontWeight:700,textDecoration:"none"}}>Support HumZones</a>.
              </p>
            </div>
            {/* Newsletter prompt. Hidden once the visitor has already
                subscribed (the form sets humzones_nl_subscribed in
                localStorage on success). */}
            {(typeof localStorage === "undefined" || localStorage.getItem("humzones_nl_subscribed") !== "1") && (
              <div style={{marginTop:20,maxWidth:520,marginLeft:"auto",marginRight:"auto",background:"#eff6ff",borderLeft:"3px solid #3b82f6",borderRadius:8,padding:"12px 16px",textAlign:"left"}}>
                <p style={{fontSize:13,color:"#1e3a8a",lineHeight:1.6,margin:"0 0 8px",fontWeight:700}}>Stay informed about data center developments near you.</p>
                <NewsletterSignupForm source="Report Download" variant="light" showFirstName={false} compact/>
              </div>
            )}
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
        const addressParam = params.get("address")   || "";
        const symptoms          = params.get("symptoms")          || "";
        const duration          = params.get("duration")          || "";
        const observations      = params.get("observations")      || "";
        const extraObservations = params.get("extraObservations") || "";

        console.log("[HumZones] /verify-report params:", {
          token, email, firstName, lastName, facilityName,
          reportText, address: addressParam, city: cityParam, country: countryParam,
          symptoms, duration, observations, extraObservations,
        });

        // Compose the Airtable Observations cell from the structured list
        // and the optional free-text addendum. The free-text line is
        // prefixed with "Other: " so reviewers can distinguish it from
        // the canonical checkbox values.
        const obsParts = [];
        if (observations.trim())      obsParts.push(observations.trim());
        if (extraObservations.trim()) obsParts.push("Other: " + extraObservations.trim());
        const observationsValue = obsParts.join("\n");

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
        // Only attach Observations when the reporter actually filled
        // something in. Airtable accepts an absent key without complaint
        // and a totally empty observations submission stays absent from
        // the row rather than writing an empty string.
        if (observationsValue) {
          fields.fld5HXSnw6zBqHZpT = observationsValue;
        }

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
          <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2,position:"relative",top:"-4px"}}>TM</sup>
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
  unlimited:              { label:"Enterprise",        credits:200,    pricePer:"$2.99" },
  "unlimited-annual":     { label:"Enterprise Annual", credits:200,    pricePer:"$2.99" },
};

// Legacy Unlimited accounts used Credits_Monthly = 999999. The plan is now
// Enterprise with a 200-report monthly cap. Treat anything at or above 999999
// as legacy and migrate it on first read.
const LEGACY_UNLIMITED_CAP = 999999;
const ENTERPRISE_MONTHLY   = 200;

const PLAN_LINKS = {
  starter:               "https://buy.stripe.com/test_28E9AVgqm9DX9Kh0iwgMw06",
  professional:          "https://buy.stripe.com/test_4gMaEZa1Y9DX1dL6GUgMw05",
  unlimited:             "https://buy.stripe.com/test_14AeVf5LI8zT9KhghugMw04",
  "starter-annual":      "https://buy.stripe.com/test_8x228ta1Y3fzf4BghugMw03",
  "professional-annual": "https://buy.stripe.com/test_9B6eVf2zw4jD6y5c1egMw02",
  "unlimited-annual":    "https://buy.stripe.com/test_14AeVffmi5nH4pX2qEgMw01",
};

const BIZ_STORE_KEY     = "humzones_business_account";
// Separate localStorage key holding just the Airtable record ID for the
// signed-in business account. Kept alongside BIZ_STORE_KEY so the credit
// deduction flow on /business-generate can GET/PATCH the exact row even
// if the cached account blob is stale or missing fields.
const BIZ_RECORD_ID_KEY = "humzones_biz_record_id";

// Auto-logout policy: 8 hours of inactivity OR 14 days since initial login,
// whichever comes first. Magic-link auth and bounded blast radius (wasted
// report credits, not stolen money or PII) put us closer to a B2B SaaS
// policy than a banking policy, but the absolute cap still catches the
// abandoned-device case. Tuned in tandem with the Login page's expired
// notice that surfaces after an auto-logout redirect.
const SESSION_IDLE_MS     = 8 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_EXPIRED_KEY = "humzones_session_expired";

const isSessionExpired = (acct, now = Date.now()) => {
  if (!acct) return false;
  const loginAt      = acct.loginAt      || now;
  const lastActiveAt = acct.lastActiveAt || now;
  return now - loginAt > SESSION_ABSOLUTE_MS || now - lastActiveAt > SESSION_IDLE_MS;
};

const readBusinessAccount = () => {
  try {
    const raw = localStorage.getItem(BIZ_STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.email) return null;
    if (isSessionExpired(parsed)) {
      try {
        localStorage.removeItem(BIZ_STORE_KEY);
        sessionStorage.setItem(SESSION_EXPIRED_KEY, "1");
      } catch {}
      return null;
    }
    return parsed;
  } catch { return null; }
};

const writeBusinessAccount = (acct) => {
  try {
    const now = Date.now();
    // Preserve the original loginAt across in-place refreshes so the
    // 14-day absolute cap is measured from the actual sign-in, not from
    // each Airtable re-sync. Reset it if the stored email changes (a
    // different user clicked a magic link on this device).
    let loginAt = now;
    try {
      const existing = JSON.parse(localStorage.getItem(BIZ_STORE_KEY) || "null");
      if (existing && existing.loginAt && existing.email === acct.email) {
        loginAt = existing.loginAt;
      }
    } catch {}
    const next = { ...acct, loginAt, lastActiveAt: now };
    localStorage.setItem(BIZ_STORE_KEY, JSON.stringify(next));
    // Mirror the Airtable record ID into its own key so the credit
    // deduction flow can read it directly without having to JSON.parse
    // the full account blob.
    if (acct && acct.id) {
      localStorage.setItem(BIZ_RECORD_ID_KEY, acct.id);
    }
  } catch {}
};

// Bumps lastActiveAt only; does not extend an already-expired session
// (in that case the record is cleared so the next readBusinessAccount
// returns null and any guarded page redirects to login).
const touchBusinessAccount = () => {
  try {
    const raw = localStorage.getItem(BIZ_STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.email) return;
    if (isSessionExpired(parsed)) {
      try {
        localStorage.removeItem(BIZ_STORE_KEY);
        sessionStorage.setItem(SESSION_EXPIRED_KEY, "1");
      } catch {}
      return;
    }
    parsed.lastActiveAt = Date.now();
    localStorage.setItem(BIZ_STORE_KEY, JSON.stringify(parsed));
  } catch {}
};

const clearBusinessAccount = () => {
  try {
    localStorage.removeItem(BIZ_STORE_KEY);
    localStorage.removeItem(BIZ_RECORD_ID_KEY);
  } catch {}
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

// Fetch a single business account row by Airtable record ID. Used by the
// /business-generate credit deduction flow so the deduction lands on the
// exact row the user signed in as, even if the cached account blob has
// drifted. Returns { id, fields } keyed by field ID, or null on 404.
async function fetchBusinessAccountById(id) {
  const recId = String(id || "").trim();
  if (!recId) return null;
  const url = `${APIURL}/${BUSINESS_TABLE}/${recId}?returnFieldsByFieldId=true`;
  const r = await fetch(url, { headers: HDR });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("Airtable lookup failed: " + r.status);
  const rec = await r.json();
  if (!rec || !rec.id) return null;
  return await migrateLegacyUnlimited({ id: rec.id, fields: rec.fields });
}

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
  if (!rec) return null;
  return await migrateLegacyUnlimited({ id: rec.id, fields: rec.fields });
}

// One-shot in-place migration for legacy "Unlimited" accounts. Anything with
// Credits_Monthly >= 999999 is rewritten to the new Enterprise cap (200/200)
// the first time we read it back. Returns the rewritten record on success,
// or the original on failure so a transient Airtable hiccup never blocks
// the user from signing in.
async function migrateLegacyUnlimited(rec) {
  if (!rec || !rec.fields) return rec;
  const monthly = Number(rec.fields[BIZ_FIELD.Credits_Monthly] || 0);
  if (monthly < LEGACY_UNLIMITED_CAP) return rec;
  try {
    console.log("[migrate] legacy Unlimited account -> Enterprise 200/200:", rec.id);
    const updated = await patchBusinessAccount(rec.id, {
      [BIZ_FIELD.Credits_Monthly]:   ENTERPRISE_MONTHLY,
      [BIZ_FIELD.Credits_Remaining]: ENTERPRISE_MONTHLY,
    });
    return { id: updated.id, fields: updated.fields };
  } catch (e) {
    console.warn("[migrate] failed to migrate legacy Unlimited:", e);
    return rec;
  }
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
  "Infrastructure impact category",
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

// ─── SITE FOOTER ──────────────────────────────────────────────────────────────
// Reusable 4-column footer rendered on every page. The "View Sample Report"
// link generates the placeholder sample PDF on the fly.
const Footer = ({ onNavigate, facilities = [] }) => {
  const [sampleBusy, setSampleBusy] = useState(false);
  const go = (to) => { if (onNavigate) onNavigate(to); };

  // Navigate home, then smoothly scroll to the Find Data Centers Near Me
  // section once the home page has rendered.
  const goNearMe = () => {
    go("/");
    setTimeout(() => {
      const el = document.getElementById("near-me");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 350);
  };

  const handleSample = async () => {
    if (sampleBusy) return;
    setSampleBusy(true);
    try {
      const { doc } = await generateSamplePersonalReportPDF();
      doc.save("HumZones-Sample-Report.pdf");
    } catch (e) {
      console.error("Sample report generation failed:", e);
      window.alert("We could not generate the sample report. Please try again.");
    } finally {
      setSampleBusy(false);
    }
  };

  const colHead = { fontSize:12, fontWeight:800, letterSpacing:".14em", textTransform:"uppercase", color:"#f97316", borderBottom:"1px solid rgba(255,255,255,.12)", paddingBottom:9, marginBottom:14 };
  const linkBase = { color:"rgba(255,255,255,.78)", fontSize:14, fontWeight:600, textDecoration:"none", cursor:"pointer", background:"none", border:"none", padding:0, fontFamily:"inherit", textAlign:"left", lineHeight:1.5 };
  const navLink = (label, to) => (
    <a href={to} onClick={e=>{e.preventDefault();go(to);}} className="hz-foot-link" style={linkBase}>{label}</a>
  );
  const colWrap = { display:"flex", flexDirection:"column", gap:11, alignItems:"flex-start" };

  // Live counts of facilities by status, drawn from the already-fetched
  // Airtable data. Only statuses with at least one facility are shown. The
  // Proposed bucket accepts either PLANNED or PROPOSED status values.
  const statusMeta = [
    { label:"Operating",          color:"#22c55e", match:["OPERATING"],          live:true  },
    { label:"Under Construction", color:"#f97316", match:["BUILDING"],           live:false },
    { label:"Proposed",           color:"#3b82f6", match:["PLANNED","PROPOSED"], live:false },
    { label:"Approved",           color:"#8b5cf6", match:["APPROVED"],           live:false },
  ];
  const statusCounts = statusMeta
    .map(s => ({ ...s, count: facilities.filter(f => s.match.includes(String(f.Facility_Status || "").toUpperCase())).length }))
    .filter(s => s.count > 0);

  // Peer-reviewed and open research the registry draws on. Each badge opens
  // its source in a new tab.
  const researchSources = [
    { label:"Epoch AI (CC-BY)", url:"https://epoch.ai/data/data-centers" },
    { label:"EH Sciences", url:"https://ehsciences.org/" },
    { label:"IARC / WHO", url:"https://www.iarc.who.int/" },
    { label:"arXiv 2025", url:"https://arxiv.org/abs/2412.06288" },
    { label:"BioInitiative", url:"https://www.bioinitiative.org/" },
    { label:"PubMed", url:"https://pubmed.ncbi.nlm.nih.gov/" },
  ];

  return (
    <footer style={{background:"#0a0f1e",color:"#fff"}}>
      {/* RESEARCH SOURCES */}
      <div style={{background:"#f8fafc",borderBottom:"1px solid #e2e8f0",padding:"34px 24px"}}>
        <div style={{maxWidth:900,margin:"0 auto",textAlign:"center"}}>
          <div style={{fontSize:12,color:"#94a3b8",letterSpacing:".18em",textTransform:"uppercase",fontWeight:800,marginBottom:16}}>Research Sources</div>
          <div style={{display:"flex",flexWrap:"wrap",justifyContent:"center",gap:10}}>
            {researchSources.map(s=>(
              <a
                key={s.label}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="hz-research-pill"
                style={{display:"inline-flex",alignItems:"center",padding:"8px 16px",borderRadius:30,background:"#f1f5f9",border:"1px solid #e2e8f0",fontSize:13,fontWeight:700,color:"#334155",textDecoration:"none"}}
              >
                {s.label}
              </a>
            ))}
          </div>
        </div>
      </div>

      {/* LIVE REGISTRY STATUS */}
      {statusCounts.length > 0 && (
        <div id="live-registry-status" style={{background:"#fff",borderBottom:"1px solid #e2e8f0",padding:"34px 24px",scrollMarginTop:80}}>
          <div style={{maxWidth:900,margin:"0 auto",textAlign:"center"}}>
            <div style={{fontSize:12,color:"#94a3b8",letterSpacing:".18em",textTransform:"uppercase",fontWeight:800,marginBottom:18}}>Live Registry Status</div>
            <div className="hz-status-grid" style={{display:"flex",flexWrap:"wrap",justifyContent:"center",alignItems:"stretch"}}>
              {statusCounts.map(s=>(
                <div key={s.label} className="hz-status-item" style={{display:"flex",flexDirection:"column",alignItems:"center",padding:"6px 30px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:9}}>
                    {s.live && <span className="hz-live-dot" style={{width:9,height:9,borderRadius:"50%",background:"#22c55e",display:"inline-block",flexShrink:0}}/>}
                    <span className="hz-status-num" style={{fontSize:40,fontWeight:900,lineHeight:1,letterSpacing:"-.02em",color:s.color}}>{s.count}</span>
                  </div>
                  <div className="hz-status-label" style={{fontSize:13,fontWeight:700,color:"#64748b",marginTop:9}}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* TOP: 4 columns */}
      <div style={{maxWidth:1180,margin:"0 auto",padding:"48px 24px 38px"}}>
        <div className="hz-footer-grid">
          {/* Column 1: Brand */}
          <div>
            <div style={{marginBottom:8}}>
              <span style={{fontSize:24,fontWeight:900,color:"#fff",letterSpacing:".03em"}}>HumZones</span>
              <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2,position:"relative",top:"-4px"}}>TM</sup>
            </div>
            <div style={{fontSize:13,color:"#94a3b8",marginBottom:3}}>HumZones Technologies Inc.</div>
            <div style={{fontSize:13,color:"#94a3b8",marginBottom:14,lineHeight:1.5}}>Global Data Center Health & Infrastructure Registry</div>
            <div style={{fontSize:13,color:"#f97316",fontWeight:700,lineHeight:1.6,marginBottom:18}}>Transparency in infrastructure. Awareness for communities.</div>
            {/* Compact newsletter signup. Email + button, no first name
                capture (kept minimal for the footer column). */}
            <div style={{marginTop:4}}>
              <div style={{fontSize:13,fontWeight:600,color:"#fff",marginBottom:2}}>Infrastructure Intelligence</div>
              <div style={{fontSize:11,color:"#94a3b8",marginBottom:8}}>Free weekly data center briefing</div>
              <NewsletterSignupForm source="Footer" variant="footer" showFirstName={false}/>
            </div>
          </div>

          {/* Column 2: Explore */}
          <div>
            <div style={colHead}>Explore</div>
            <div style={colWrap}>
              {navLink("Home","/")}
              <a href="/#near-me" onClick={e=>{e.preventDefault();goNearMe();}} className="hz-foot-link" style={linkBase}>Find Data Centers Near Me</a>
              {navLink("Newsletter","/newsletter")}
              {navLink("Community Reports","/submit-report")}
              {navLink("Submit Your Report","/submit-report")}
              {navLink("Why It Matters","/why-it-matters")}
              {navLink("Resident Guides","/learn")}
              {navLink("Infrastructure Glossary","/glossary")}
              {navLink("Methodology","/methodology")}
              {navLink("FAQ","/faq")}
              <a href="/donate" onClick={e=>{e.preventDefault();go("/donate");}} className="hz-foot-link" style={linkBase}>
                <span aria-hidden="true" style={{color:"#f97316",marginRight:6}}>♥</span>Donate
              </a>
            </div>
          </div>

          {/* Column 3: Reports & Plans */}
          <div>
            <div style={colHead}>Reports & Plans</div>
            <div style={colWrap}>
              {navLink("Get My Report","/get-report")}
              {navLink("Retrieve My Report","/my-report")}
              {navLink("For Business","/business")}
              {navLink("Business Login","/business-login")}
              <button onClick={handleSample} disabled={sampleBusy} className="hz-foot-link" style={{...linkBase,cursor:sampleBusy?"wait":"pointer"}}>
                {sampleBusy ? "Generating Sample..." : "View Sample Report"}
              </button>
            </div>
          </div>

          {/* Column 4: Company */}
          <div>
            <div style={colHead}>Company</div>
            <div style={colWrap}>
              {navLink("About Us","/about")}
              {navLink("Contact Us","/contact")}
              {navLink("Privacy Policy","/privacy")}
              {navLink("Terms of Service","/terms")}
              {navLink("Legal Disclaimer","/disclaimer")}
              <a href="mailto:hello@humzones.com" className="hz-foot-link" style={{...linkBase,color:"#f97316"}}>hello@humzones.com</a>
            </div>
          </div>
        </div>
      </div>

      {/* BOTTOM BAR */}
      <div style={{background:"#060912",borderTop:"1px solid rgba(255,255,255,.06)"}}>
        <div className="hz-footer-bottom" style={{maxWidth:1180,margin:"0 auto",padding:"18px 24px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <div style={{fontSize:12,color:"#64748b"}}>&copy; 2026 HumZones Technologies Inc. All Rights Reserved</div>
          <div style={{fontSize:12,color:"#64748b",display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",justifyContent:"center"}}>
            <a href="/privacy" onClick={e=>{e.preventDefault();go("/privacy");}} className="hz-foot-link" style={{color:"#64748b",textDecoration:"none"}}>Privacy Policy</a>
            <span aria-hidden="true">|</span>
            <a href="/terms" onClick={e=>{e.preventDefault();go("/terms");}} className="hz-foot-link" style={{color:"#64748b",textDecoration:"none"}}>Terms of Service</a>
            <span aria-hidden="true">|</span>
            <a href="/disclaimer" onClick={e=>{e.preventDefault();go("/disclaimer");}} className="hz-foot-link" style={{color:"#64748b",textDecoration:"none"}}>Legal Disclaimer</a>
            <span aria-hidden="true">|</span>
            <a href="/methodology" onClick={e=>{e.preventDefault();go("/methodology");}} className="hz-foot-link" style={{color:"#64748b",textDecoration:"none"}}>Methodology</a>
          </div>
        </div>
      </div>

      {/* DISCLAIMER */}
      <div style={{background:"#060912",padding:"0 24px 24px"}}>
        <p style={{maxWidth:900,margin:"0 auto",fontSize:11,color:"#475569",lineHeight:1.75,textAlign:"center"}}>
          All facility data and figures shown on this site are research-based estimates compiled from public sources. They are not certified measurements. HumZones is an informational resource only and does not constitute medical, legal or environmental advice. See our Methodology page for full details.
        </p>
      </div>
    </footer>
  );
};

// ─── /business: PRICING PAGE ─────────────────────────────────────────────────
const BusinessPlansPage = ({ onNavigate, facilityCount, facs = [] }) => {
  // SEO + social meta + Service JSON-LD. Cleaned up on unmount.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = "Professional Infrastructure Reports | HumZones Business";

    injectHeadEl("meta", "business-desc",      { name: "description",         content: "Professional data center infrastructure intelligence for real estate, legal and research firms. Detailed facility reports with modeled estimates. Monthly plans with commercial use license." });
    injectHeadEl("link", "business-canonical", { rel: "canonical",            href: "https://humzones.com/business" });
    injectHeadEl("meta", "business-og-title",  { property: "og:title",        content: "Professional Data Center Intelligence | HumZones" });
    injectHeadEl("meta", "business-og-desc",   { property: "og:description",  content: "Infrastructure reports for real estate due diligence, legal research and investment analysis. Monthly plans with commercial use license." });
    injectHeadEl("meta", "business-og-url",    { property: "og:url",          content: "https://humzones.com/business" });
    injectHeadEl("meta", "business-og-type",   { property: "og:type",         content: "website" });
    injectHeadEl("meta", "business-og-site",   { property: "og:site_name",    content: "HumZones" });
    injectHeadEl("meta", "business-tw-card",   { name: "twitter:card",        content: "summary" });
    injectHeadEl("meta", "business-tw-title",  { name: "twitter:title",       content: "Professional Infrastructure Reports | HumZones" });
    injectHeadEl("meta", "business-tw-desc",   { name: "twitter:description", content: "Data center infrastructure intelligence for real estate, legal and research professionals." });

    const serviceSchema = {
      "@context":    "https://schema.org",
      "@type":       "Service",
      "name":        "HumZones Professional Infrastructure Intelligence",
      "description": "Commercial-grade data center infrastructure reports for real estate due diligence, legal proceedings, environmental research and investment analysis. Monthly subscription with report credits and commercial use license.",
      "url":         "https://humzones.com/business",
      "provider":    { "@type": "Organization", "name": "HumZones Technologies Inc.", "url": "https://humzones.com" },
      "serviceType": "Infrastructure Intelligence Reports",
      "audience":    { "@type": "Audience", "audienceType": "Real estate professionals, legal researchers, investment analysts, environmental consultants" },
      "offers": {
        "@type":         "AggregateOffer",
        "priceCurrency": "USD",
        "offerCount":    "3",
      },
    };
    injectHeadEl("script", "business-jsonld", { type: "application/ld+json" }, JSON.stringify(serviceSchema));

    return () => {
      [
        "business-desc","business-canonical",
        "business-og-title","business-og-desc","business-og-url","business-og-type","business-og-site",
        "business-tw-card","business-tw-title","business-tw-desc",
        "business-jsonld",
      ].forEach(removeHeadEl);
    };
  }, []);

  // Initial toggle position respects a one-shot flag set by the header's
  // Business -> Annual Plans entry so that link lands on the annual prices.
  const [annual, setAnnual] = useState(() => {
    try {
      if (sessionStorage.getItem("hz_business_annual") === "1") {
        sessionStorage.removeItem("hz_business_annual");
        return true;
      }
    } catch {}
    return false;
  });
  const [sampleBusy, setSampleBusy] = useState(false);

  // If the user is already on /business and clicks Business -> Annual Plans
  // in the header, the page is not remounted, so listen for an explicit
  // event from the header and flip the toggle in place.
  useEffect(() => {
    const onAnnual = () => setAnnual(true);
    window.addEventListener("hz:business-annual", onAnnual);
    return () => window.removeEventListener("hz:business-annual", onAnnual);
  }, []);

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
        "Dedicated dashboard where all your reports are stored, saved and available for re-download at any time",
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
        "Dedicated dashboard where all your reports are stored, saved and available for re-download at any time",
        "Instant PDF download",
        "Full 100km radius coverage",
        "Priority email support",
        "Team sharing coming soon",
      ],
    },
    {
      key: "unlimited",
      title: "Enterprise",
      monthly: 599, annual: 5990,
      credits: "200 reports per month",
      perReport: "$2.99 per report",
      popular: false,
      features: [
        "200 report credits per month",
        "Credits reset monthly",
        "Dedicated dashboard where all your reports are stored, saved and available for re-download at any time",
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

  // Generates the watermarked Greenfield Realty sample using the new
  // multi-page business format and triggers a download.
  const handleSampleDownload = async () => {
    if (sampleBusy) return;
    setSampleBusy(true);
    try {
      const { doc } = await generateSampleBusinessReportPDF();
      doc.save("HumZones-Sample-Business-Report.pdf");
    } catch (e) {
      console.error("Sample report generation failed:", e);
      window.alert("We could not generate the sample report. Please try again.");
    } finally {
      setSampleBusy(false);
    }
  };

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",color:"#fff",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>
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

      {/* Canonical "Each Report Includes" callout, scrolled to by the
          GlobalHeader Reports -> What Is Included entry. Sourced from the
          same REPORT_INCLUDES array as the per-plan cards below so the
          list cannot drift between the two places. */}
      <section id="report-contents" style={{maxWidth:1180,margin:"0 auto",padding:"8px 24px 28px",scrollMarginTop:80}}>
        <div style={{background:"rgba(15,23,42,.55)",border:"1px solid rgba(249,115,22,.25)",borderRadius:18,padding:"28px 28px 26px",boxShadow:"0 14px 40px rgba(0,0,0,.25)"}}>
          <div style={{fontSize:12,fontWeight:800,letterSpacing:".14em",textTransform:"uppercase",color:"#f97316",marginBottom:8}}>What every report includes</div>
          <h2 style={{fontSize:"clamp(22px,3vw,28px)",fontWeight:900,letterSpacing:"-.01em",margin:"0 0 6px"}}>Each Report Includes</h2>
          <p style={{fontSize:14,color:"rgba(255,255,255,.65)",lineHeight:1.65,margin:"0 0 18px"}}>
            Every personal and business report contains the same complete data set for every facility within a 100km radius of the searched address.
          </p>
          <ul style={{listStyle:"none",padding:0,margin:0,display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(260px, 1fr))",gap:10}}>
            {REPORT_INCLUDES.map(item => (
              <li key={item} style={{display:"flex",alignItems:"flex-start",gap:10,fontSize:14,color:"rgba(255,255,255,.85)",lineHeight:1.55}}>
                <span style={{flexShrink:0,display:"inline-flex",width:18,height:18,borderRadius:"50%",background:"rgba(249,115,22,.18)",alignItems:"center",justifyContent:"center",marginTop:1,border:"1px solid rgba(249,115,22,.45)"}}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#f97316" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section style={{maxWidth:1180,margin:"0 auto",padding:"24px 24px 48px"}}>
        <div className="biz-grid" style={{display:"grid",gridTemplateColumns:"repeat(3, 1fr)",gap:22,alignItems:"stretch"}}>
          {plans.map(p => {
            const price = annual ? p.annual : p.monthly;
            const cadence = annual ? "/year" : "/month";
            const cardId = `plan-${p.key === "unlimited" ? "enterprise" : p.key}`;
            return (
              <div key={p.key} id={cardId} style={{position:"relative",background:p.popular?"linear-gradient(160deg,rgba(249,115,22,.12),rgba(15,23,42,.6))":"rgba(15,23,42,.55)",border:p.popular?"1.5px solid rgba(249,115,22,.6)":"1px solid rgba(255,255,255,.1)",borderRadius:18,padding:"30px 26px",display:"flex",flexDirection:"column",boxShadow:p.popular?"0 24px 60px rgba(249,115,22,.22)":"0 12px 40px rgba(0,0,0,.25)",scrollMarginTop:80}}>
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
          All plans include instant PDF delivery, 100km coverage and the full HumZones facility database of {facilityCountLabel(facilityCount)} facilities.
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
              {icon:"home",    title:"Real Estate",                   desc:"Neighborhood infrastructure awareness for buyers and relocation clients."},
              {icon:"building",title:"Property & Development",         desc:"Monitor nearby infrastructure expansion and utility-intensive development."},
              {icon:"scales",  title:"Environmental & Legal Research", desc:"Access location-based infrastructure intelligence for zoning, review, and consultation workflows."},
              {icon:"search",  title:"Research & Media",               desc:"Track AI infrastructure growth and regional development patterns."},
            ].map(c=>(
              <div key={c.title} style={{background:"rgba(255,255,255,.04)",border:"1px solid rgba(249,115,22,.25)",borderRadius:16,padding:"28px 26px"}}>
                <div style={{marginBottom:14,lineHeight:1}}><Icon name={c.icon} size={34} color="#f97316"/></div>
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

      <Footer onNavigate={onNavigate} facilities={facs}/>
    </div>
  );
};

// ─── /business-success: ACCOUNT FORM + AIRTABLE CREATE ───────────────────────
const BusinessSuccessPage = ({ onNavigate }) => {
  // Reinstatement case: a logged-in business user landed here from the
  // dashboard's Reinstate flow. The Airtable row already exists and the
  // webhook is patching plan/credits/Status in the background — no form
  // to fill, just send them back to the dashboard.
  useEffect(() => {
    const existing = readBusinessAccount();
    if (existing && existing.email) {
      onNavigate("/business-dashboard");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2,position:"relative",top:"-4px"}}>TM</sup>
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
              You have <strong style={{color:"#f97316"}}>{created.credits >= LEGACY_UNLIMITED_CAP ? ENTERPRISE_MONTHLY : created.credits}</strong> report credits ready to use.
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
// on every plan. Each generated report is written to the Business_Reports
// table so the dashboard can list and re-download them later.
const BusinessGeneratePage = ({ onNavigate }) => {
  const [account, setAccount] = useState(() => readBusinessAccount());
  const [radius, setRadius] = useState(50);
  const [address, setAddress] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState("");
  const [results, setResults] = useState(null); // { address, lat, lng, facilities }
  const [downloading, setDownloading] = useState(false);
  const [toast, setToast] = useState("");
  // Surface a yellow warning banner near the download button when the
  // credit-deduction PATCH fails. The PDF download itself still succeeds,
  // so this is informational rather than blocking.
  const [creditError, setCreditError] = useState(false);
  // Confirmation modal triggered by the Download button. Forces the user
  // to acknowledge the address and radius before a credit is spent.
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Post-download success card. Holds the remaining credit count and the
  // monthly cap so the user sees their new balance plus a Return-to-Dashboard
  // exit instead of an auto-dismissing toast.
  const [downloadComplete, setDownloadComplete] = useState(null); // { remaining, monthly } | null
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

  // Every plan deducts credits now (Enterprise has a 200 monthly cap, no
  // truly unlimited tier). Anything still stamped 999999 in localStorage is
  // treated as 200 until the next Airtable read swaps it in for real.
  const monthlyCap = account.creditsMonthly >= LEGACY_UNLIMITED_CAP
    ? ENTERPRISE_MONTHLY
    : account.creditsMonthly;
  const remainingDisplay = account.creditsRemaining >= LEGACY_UNLIMITED_CAP
    ? ENTERPRISE_MONTHLY
    : account.creditsRemaining;
  const creditsLabel    = `${remainingDisplay} of ${monthlyCap} reports remaining`;
  const ctaCreditsLabel = `${remainingDisplay} of ${monthlyCap} remaining`;

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  };

  const search = async () => {
    if (!address.trim()) return;
    setSearching(true);
    setSearchErr("");
    setResults(null);
    setDownloadComplete(null);
    setCreditError(false);
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

      setResults({ address: displayName, lat, lng, facilities: facsNear, allFacs });
    } catch (e) {
      setSearchErr(e.message || "Search failed. Please try again.");
    } finally {
      setSearching(false);
    }
  };

  const download = async () => {
    if (!results || downloading) return;
    // Out-of-credits guard. Every plan deducts credits now, including
    // Enterprise, so this check applies universally.
    if (remainingDisplay <= 0) {
      const when = account.renewalDate ? ` Credits reset on ${account.renewalDate}.` : "";
      window.alert(`You have no credits remaining.${when} Visit humzones.com/business to upgrade your plan.`);
      return;
    }
    setDownloading(true);
    setCreditError(false);
    setDownloadComplete(null);
    try {
      const highRiskCount = results.facilities.filter(f => String(f.Risk_Level || "").toUpperCase() === "HIGH").length;

      const { doc, dateStr } = await generateBusinessReportPDF({
        searchAddress: results.address,
        facsInRadius: results.facilities,
        searchRadius: radius,
        facs: results.allFacs || results.facilities,
        businessAccount: account,
      });
      const filename = `HumZones-Report-${pdfFilenameSafe(results.address)}-${dateStr}.pdf`;
      doc.save(filename);
      // Alias kept so the downstream Business_Reports write below
      // continues to reference the field by its original name.
      const datePart = dateStr;

      // Re-read the live Business_Accounts row by record ID so the deduction
      // lands on the exact row the user signed in as. Prefer the dedicated
      // humzones_biz_record_id key written at login; fall back to account.id
      // for sessions that pre-date that key.
      let recordId = "";
      try { recordId = localStorage.getItem(BIZ_RECORD_ID_KEY) || ""; } catch {}
      if (!recordId) recordId = account.id || "";

      let liveRec = null;
      try {
        liveRec = await fetchBusinessAccountById(recordId);
        console.log("[business-generate] fetched live account by id:", recordId, liveRec);
      } catch (e) {
        console.error("[business-generate] live account fetch by id failed:", e);
      }
      const liveFields  = (liveRec && liveRec.fields) || {};
      const liveId      = (liveRec && liveRec.id) || recordId || account.id;
      const rawCredits  = Number(liveFields[BIZ_FIELD.Credits_Remaining] || account.creditsRemaining || 0);
      const rawMonthly  = Number(liveFields[BIZ_FIELD.Credits_Monthly] || account.creditsMonthly || 0);
      // Defensive: if the live record still carries the legacy 999999 cap
      // (migration has not yet caught it), treat the deduction as if it
      // were already on the 200 Enterprise cap.
      const liveCredits   = rawCredits >= LEGACY_UNLIMITED_CAP ? ENTERPRISE_MONTHLY : rawCredits;
      const liveMonthly   = rawMonthly >= LEGACY_UNLIMITED_CAP ? ENTERPRISE_MONTHLY : rawMonthly;
      const liveGenerated = Number(liveFields[BIZ_FIELD.Reports_Generated] || account.reportsGenerated || 0);

      // Write the report row to Business_Reports. Uses field IDs so the row
      // lands in the right columns regardless of any display-name drift.
      const reportName = `HumZones-Business-Report-${pdfFilenameSafe(results.address)}-${datePart}`;
      const reportPayload = {
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
      };
      try {
        console.log("[business-generate] POST Business_Reports payload:", reportPayload);
        const repRes = await fetch(`${APIURL}/${BUSINESS_REPORTS_TABLE}?returnFieldsByFieldId=true`, {
          method: "POST",
          headers: HDR,
          body: JSON.stringify(reportPayload),
        });
        const repBody = await repRes.json().catch(() => ({}));
        console.log("[business-generate] POST Business_Reports response:", repRes.status, repBody);
        if (!repRes.ok) {
          console.error("[business-generate] Business_Reports write failed:", repRes.status, repBody);
        }
      } catch (e) {
        console.error("[business-generate] Business_Reports write threw:", e);
      }

      // Deduct one credit on every plan and bump Reports_Generated.
      const newRemaining = Math.max(0, liveCredits - 1);
      const newGenerated = liveGenerated + 1;
      const acctPayload = {
        fields: {
          [BIZ_FIELD.Credits_Remaining]: newRemaining,
          [BIZ_FIELD.Reports_Generated]: newGenerated,
        },
      };
      // PATCH the credit deduction and surface failures to the user via a
      // yellow banner — the PDF has already saved locally at this point, so
      // a silent Airtable error would leave the row out of sync without
      // anyone noticing.
      let patchOk = false;
      try {
        console.log("[business-generate] PATCH Business_Accounts id:", liveId, "payload:", acctPayload);
        const acctRes = await fetch(`${APIURL}/${BUSINESS_TABLE}/${liveId}?returnFieldsByFieldId=true`, {
          method: "PATCH",
          headers: HDR,
          body: JSON.stringify(acctPayload),
        });
        const acctBody = await acctRes.json().catch(() => ({}));
        console.log("[business-generate] PATCH Business_Accounts response:", acctRes.status, acctBody);
        if (!acctRes.ok) {
          console.error("[business-generate] Credit deduction failed:", acctRes.status, acctBody);
        } else {
          patchOk = true;
        }
      } catch (e) {
        console.error("[business-generate] Credit deduction threw:", e);
      }
      if (!patchOk) setCreditError(true);

      // Reflect the new counts in the on-screen badge immediately and
      // persist them so other tabs pick up the same values without needing
      // a refresh.
      const next = {
        ...account,
        id: liveId,
        creditsRemaining: newRemaining,
        creditsMonthly:   liveMonthly || account.creditsMonthly,
        reportsGenerated: newGenerated,
      };
      writeBusinessAccount(next);
      setAccount(next);

      setDownloadComplete({ remaining: newRemaining, monthly: liveMonthly });
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
                      <span style={{display:"inline-flex",alignItems:"center",padding:"4px 12px",borderRadius:20,background:`${riskColor(f.Risk_Level)}22`,border:`1px solid ${riskColor(f.Risk_Level)}66`,color:riskColor(f.Risk_Level),fontSize:11,fontWeight:900,letterSpacing:".10em"}}>
                        {exposureLabel(f.Risk_Level)}
                        <InfoTip label="About impact tiers">{METRIC_TIP.impact(f.Risk_Level)}</InfoTip>
                      </span>
                    </div>
                    <div style={{fontSize:13,color:"#f97316",fontWeight:700,marginBottom:10}}>{Number(f._km).toFixed(1)} km away</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(160px, 1fr))",gap:10,fontSize:13,color:"rgba(255,255,255,.78)"}}>
                      <div><span style={{color:"rgba(255,255,255,.5)"}}>Power<InfoTip label="About power draw">{METRIC_TIP.power(f.Power_MW)}</InfoTip>: </span>{f.Power_MW != null && f.Power_MW !== "" ? `${f.Power_MW} MW` : "n/a"}</div>
                      <div><span style={{color:"rgba(255,255,255,.5)"}}>Noise<InfoTip label="About noise estimate">{METRIC_TIP.noise}</InfoTip>: </span>{f.Noise_DB != null && f.Noise_DB !== "" ? `${f.Noise_DB} dB` : "n/a"}</div>
                      <div><span style={{color:"rgba(255,255,255,.5)"}}>EMF fence<InfoTip label="About EMF at fence">{METRIC_TIP.emfFence}</InfoTip>: </span>{f.EMF_Fence_High != null && f.EMF_Fence_High !== "" ? `${f.EMF_Fence_High} mG` : "n/a"}</div>
                      <div><span style={{color:"rgba(255,255,255,.5)"}}>EMF 100m<InfoTip label="About EMF at 100m">{METRIC_TIP.emf100m}</InfoTip>: </span>{f.EMF_100m != null && f.EMF_100m !== "" ? `${f.EMF_100m} mG` : "n/a"}</div>
                      <div><span style={{color:"rgba(255,255,255,.5)"}}>Cooling<InfoTip label="About cooling type">{METRIC_TIP.cooling(f.Cooling)}</InfoTip>: </span>{f.Cooling || "n/a"}</div>
                      <div><span style={{color:"rgba(255,255,255,.5)"}}>Opened<InfoTip label="About opened year">{METRIC_TIP.opened}</InfoTip>: </span>{f.Opened || "n/a"}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {results && results.facilities.length > 0 && (
        <div style={{position:"fixed",bottom:0,left:0,right:0,padding:"14px 18px",background:"rgba(2,12,27,.92)",borderTop:"1px solid rgba(249,115,22,.4)",backdropFilter:"blur(12px)",zIndex:50,display:"flex",flexDirection:"column",alignItems:"center",gap:10}}>
          <button onClick={()=>{ if(!downloading) setConfirmOpen(true); }} disabled={downloading} style={{maxWidth:560,width:"100%",padding:"16px 22px",borderRadius:12,border:"none",cursor:downloading?"not-allowed":"pointer",fontFamily:"inherit",fontSize:16,fontWeight:900,letterSpacing:".04em",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",boxShadow:"0 14px 32px rgba(249,115,22,.42)"}}>
            {downloading ? "Generating PDF..." : `Download Report (${ctaCreditsLabel})`}
          </button>
          {creditError && (
            <div role="alert" style={{maxWidth:560,width:"100%",display:"flex",alignItems:"flex-start",gap:10,padding:"12px 14px",borderRadius:10,background:"#fef3c7",border:"1px solid #f59e0b",color:"#78350f",fontSize:13,lineHeight:1.5,fontWeight:600}}>
              <span style={{flex:1}}>
                Your report downloaded successfully but we could not update your credit balance. Please contact{" "}
                <a href="mailto:hello@humzones.com" style={{color:"#78350f",fontWeight:800,textDecoration:"underline"}}>hello@humzones.com</a>{" "}
                and we will adjust it manually.
              </span>
              <button onClick={()=>setCreditError(false)} aria-label="Dismiss" style={{background:"transparent",border:"none",color:"#78350f",fontSize:18,fontWeight:900,cursor:"pointer",lineHeight:1,padding:"0 4px",fontFamily:"inherit"}}>&times;</button>
            </div>
          )}
        </div>
      )}

      {toast && (
        <div role="status" style={{position:"fixed",top:24,left:"50%",transform:"translateX(-50%)",padding:"12px 22px",borderRadius:30,background:"#0f172a",border:"1px solid rgba(249,115,22,.5)",color:"#fff",fontWeight:700,fontSize:14,zIndex:100,boxShadow:"0 18px 50px rgba(0,0,0,.45)"}}>
          {toast}
        </div>
      )}

      {/* Pre-download confirmation modal. Forces the user to acknowledge
          the radius and address before a credit is spent. */}
      {confirmOpen && results && (
        <div role="dialog" aria-modal="true" style={{position:"fixed",inset:0,background:"rgba(2,12,27,.78)",backdropFilter:"blur(6px)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px"}}>
          <div style={{maxWidth:480,width:"100%",background:"#0f172a",border:"1px solid rgba(249,115,22,.4)",borderRadius:16,padding:"26px 26px 22px",boxShadow:"0 30px 80px rgba(0,0,0,.55)"}}>
            <h3 style={{fontSize:20,fontWeight:900,color:"#fff",margin:"0 0 12px"}}>Confirm your report</h3>
            <p style={{fontSize:14,color:"rgba(255,255,255,.78)",lineHeight:1.55,margin:"0 0 18px"}}>
              Generate a report for <span style={{color:"#fff",fontWeight:800}}>{results.address}</span> with a <span style={{color:"#f97316",fontWeight:800}}>{radius} km radius</span>? This will use 1 credit. If the radius is not what you want, cancel and select a different one before downloading.
            </p>
            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              <button onClick={()=>setConfirmOpen(false)} style={{flex:"1 1 140px",padding:"13px 18px",borderRadius:10,border:"1px solid rgba(255,255,255,.25)",background:"transparent",color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer",fontFamily:"inherit"}}>
                Cancel
              </button>
              <button onClick={()=>{ setConfirmOpen(false); download(); }} style={{flex:"1 1 200px",padding:"13px 18px",borderRadius:10,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontWeight:900,fontSize:14,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>
                Confirm &amp; Download
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Persistent post-download success card with a Return-to-Dashboard
          exit. Replaces the old auto-dismissing toast so the user has a
          clear next step instead of being stranded on the generate page. */}
      {downloadComplete && (
        <div role="status" style={{position:"fixed",top:24,left:"50%",transform:"translateX(-50%)",maxWidth:520,width:"calc(100% - 32px)",padding:"16px 18px",borderRadius:14,background:"#0f172a",border:"1px solid rgba(34,197,94,.55)",color:"#fff",zIndex:100,boxShadow:"0 18px 50px rgba(0,0,0,.5)",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <div style={{flex:"1 1 200px",fontSize:14,fontWeight:700,lineHeight:1.45}}>
            Report downloaded. {downloadComplete.remaining} of {downloadComplete.monthly} credits remaining.
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <button onClick={()=>onNavigate("/business-dashboard")} style={{padding:"10px 16px",borderRadius:10,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontWeight:900,fontSize:13,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 8px 20px rgba(249,115,22,.38)"}}>
              Return to Dashboard
            </button>
            <button onClick={()=>setDownloadComplete(null)} aria-label="Dismiss" style={{background:"transparent",border:"none",color:"rgba(255,255,255,.7)",fontSize:20,fontWeight:900,cursor:"pointer",lineHeight:1,padding:"0 6px",fontFamily:"inherit"}}>&times;</button>
          </div>
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

      <Footer onNavigate={onNavigate}/>
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

  // One-shot banner shown after an auto-logout redirect (8h idle or
  // 14d absolute cap). readBusinessAccount sets the flag when it nulls
  // out an expired record; we clear it on read so a manual page refresh
  // here doesn't keep re-displaying the banner.
  const [expiredNotice, setExpiredNotice] = useState(false);
  useEffect(() => {
    try {
      if (sessionStorage.getItem(SESSION_EXPIRED_KEY) === "1") {
        sessionStorage.removeItem(SESSION_EXPIRED_KEY);
        setExpiredNotice(true);
      }
    } catch {}
  }, []);

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

      <main style={{maxWidth:480,margin:"0 auto",padding:"24px 24px 80px"}}>
        <div style={{textAlign:"center",marginBottom:24}}>
          <h1 style={{fontSize:28,fontWeight:900,letterSpacing:"-.01em",marginBottom:10}}>Sign In to Your HumZones Account</h1>
          <p style={{fontSize:15,color:"rgba(255,255,255,.7)",lineHeight:1.65}}>We use secure magic links instead of passwords. Enter your email and we will send you an instant login link. No password needed, ever.</p>
        </div>

        {expiredNotice && mode !== "verifying" && (
          <div style={{padding:"12px 14px",borderRadius:10,background:"rgba(249,115,22,.12)",border:"1px solid rgba(249,115,22,.4)",color:"#fed7aa",fontSize:14,marginBottom:16,textAlign:"center"}}>
            You were signed out for your security. Please sign in again.
          </div>
        )}

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

      <Footer onNavigate={onNavigate}/>
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
  // Reinstatement modal — opened from the Cancelled-state banner so a
  // returning customer can pick a plan and check out without leaving
  // the dashboard context.
  const [reinstateOpen, setReinstateOpen] = useState(false);
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

  // Display the Enterprise 200 cap even if a legacy 999999 record has not
  // yet been migrated. The big numeric label keeps the remaining count and
  // the subtitle line carries the "of 200 reports remaining" context.
  const monthlyCap = account.creditsMonthly >= LEGACY_UNLIMITED_CAP
    ? ENTERPRISE_MONTHLY
    : account.creditsMonthly;
  const remainingDisplay = account.creditsRemaining >= LEGACY_UNLIMITED_CAP
    ? ENTERPRISE_MONTHLY
    : account.creditsRemaining;
  const creditsLabel = String(remainingDisplay);
  // The webhook flips Status to "Cancelled" when the Stripe subscription
  // ends. In that state the report-generate flow is gated; the rest of
  // the dashboard (profile, history, re-downloads) stays accessible.
  const isCancelled = String(account.status || "").toLowerCase() === "cancelled";

  const signOut = () => {
    clearBusinessAccount();
    onNavigate("/business-login");
  };

  // Send the user to the Stripe Payment Link for a given plan, tagging
  // the session with client_reference_id="plan:<key>" so the webhook
  // can grant the right number of credits when they come back. Email
  // is prefilled so they don't retype it.
  const startReinstateCheckout = (planKey) => {
    const url = PLAN_LINKS[planKey];
    if (!url) return;
    const params = new URLSearchParams({
      client_reference_id: "plan:" + planKey,
      prefilled_email:     account.email || "",
    });
    window.location.href = url + (url.includes("?") ? "&" : "?") + params.toString();
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

      const { doc, dateStr } = await generateBusinessReportPDF({
        searchAddress: row.address,
        facsInRadius: facsNear,
        searchRadius: row.radius,
        facs: allFacs,
        businessAccount: account,
      });
      const filename = `HumZones-Report-${pdfFilenameSafe(row.address)}-${dateStr}.pdf`;
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
      <main style={{maxWidth:880,margin:"0 auto",padding:"24px 24px 60px"}}>
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:14,marginBottom:28,flexWrap:"wrap"}}>
          <div>
            <h1 style={{fontSize:30,fontWeight:900,letterSpacing:"-.01em",marginBottom:6}}>Welcome back {account.firstName || ""}</h1>
            <p style={{fontSize:14,color:"rgba(255,255,255,.6)",margin:0}}>
              {account.company ? `${account.company} - ` : ""}{account.email}
            </p>
          </div>
          <button onClick={signOut} style={{padding:"8px 16px",borderRadius:10,border:"1px solid rgba(255,255,255,.18)",background:"rgba(255,255,255,.06)",color:"rgba(255,255,255,.85)",cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:700}}>Sign Out</button>
        </div>

        {isCancelled ? (
          <div style={{background:"linear-gradient(160deg,rgba(234,179,8,.14),rgba(15,23,42,.6))",border:"1.5px solid rgba(234,179,8,.45)",borderRadius:18,padding:"30px",marginBottom:24,boxShadow:"0 20px 50px rgba(234,179,8,.14)"}}>
            <div style={{fontSize:13,color:"#facc15",letterSpacing:".18em",textTransform:"uppercase",fontWeight:800,marginBottom:10}}>Subscription Cancelled</div>
            <h2 style={{fontSize:24,fontWeight:900,letterSpacing:"-.01em",margin:"0 0 10px",color:"#fff"}}>Your subscription is no longer active</h2>
            <p style={{fontSize:14,color:"rgba(255,255,255,.78)",lineHeight:1.65,margin:"0 0 18px"}}>
              You can still view and re-download your past reports below. To generate new reports, reinstate your subscription and pick the plan that fits your team.
            </p>
            <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
              <button onClick={()=>setReinstateOpen(true)} style={{padding:"14px 26px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:15,fontWeight:900,background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>Reinstate Subscription</button>
              <a href="/business" onClick={e=>{e.preventDefault();onNavigate("/business");}} style={{padding:"14px 22px",borderRadius:12,border:"1px solid rgba(255,255,255,.22)",fontFamily:"inherit",fontSize:14,fontWeight:800,background:"rgba(255,255,255,.06)",color:"#fff",textDecoration:"none",display:"inline-flex",alignItems:"center"}}>Compare plans</a>
            </div>
          </div>
        ) : (
          <div style={{background:"linear-gradient(160deg,rgba(249,115,22,.16),rgba(15,23,42,.6))",border:"1.5px solid rgba(249,115,22,.4)",borderRadius:18,padding:"30px",marginBottom:24,boxShadow:"0 20px 50px rgba(249,115,22,.18)"}}>
            <div style={{fontSize:13,color:"#f97316",letterSpacing:".18em",textTransform:"uppercase",fontWeight:800,marginBottom:10}}>Credits</div>
            <div style={{display:"flex",alignItems:"baseline",gap:14,marginBottom:8}}>
              <span style={{fontSize:72,fontWeight:900,letterSpacing:"-.02em",color:"#f97316",lineHeight:1,textShadow:"0 0 28px rgba(249,115,22,.45)"}}>{creditsLabel}</span>
              <span style={{fontSize:17,color:"rgba(255,255,255,.7)",fontWeight:600}}>of {monthlyCap} Reports Remaining</span>
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
            <div style={{display:"flex",alignItems:"flex-start",gap:8,padding:"10px 14px",borderRadius:8,background:"#eff6ff",borderLeft:"3px solid #3b82f6",marginTop:16}}>
              <span aria-hidden="true" style={{flexShrink:0,display:"inline-flex",alignItems:"center",justifyContent:"center",width:16,height:16,borderRadius:"50%",background:"#3b82f6",color:"#fff",fontSize:10,fontWeight:800,marginTop:2,lineHeight:1}}>i</span>
              <p style={{fontSize:13,color:"#1e3a8a",lineHeight:1.55,margin:0}}>
                Your business name from your profile will appear on the cover of every report you generate. Visit{" "}
                <a href="/business-profile" onClick={e=>{e.preventDefault();onNavigate("/business-profile");}} style={{color:"#f97316",fontWeight:700,textDecoration:"none"}}>My Profile</a>
                {" "}to ensure your company name is correct before generating reports.
              </p>
            </div>
          </div>
        )}

        <div style={{background:"rgba(15,23,42,.55)",border:"1px solid rgba(255,255,255,.1)",borderRadius:16,padding:"24px"}}>
          {(() => {
            const retentionNote = "Your report history is stored for 12 months. You can re-download any report at any time during this period and your report will be regenerated fresh with the latest facility data. Reports older than 12 months are automatically removed from your history but can always be regenerated by searching the same address again at no additional credit cost.";
            return (
              <>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14,gap:10,flexWrap:"wrap"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:18,fontWeight:800}}>My Reports</span>
                    <span
                      role="img"
                      aria-label="About report history"
                      title={retentionNote}
                      style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:18,height:18,borderRadius:"50%",border:"1px solid rgba(148,163,184,.55)",color:"rgba(148,163,184,.85)",fontSize:11,fontWeight:800,fontFamily:"inherit",cursor:"help",lineHeight:1}}
                    >
                      i
                    </span>
                  </div>
                  {!reportsLoading && reports.length > 0 && (
                    <div style={{fontSize:13,color:"rgba(255,255,255,.55)"}}>
                      {total === 0 ? "No matches" : `Showing ${startIdx + 1}-${endIdx} of ${total} reports`}
                    </div>
                  )}
                </div>
                <div style={{display:"flex",alignItems:"flex-start",gap:8,padding:"10px 12px",borderRadius:10,background:"rgba(148,163,184,.06)",border:"1px solid rgba(148,163,184,.16)",marginBottom:16}}>
                  <span aria-hidden="true" style={{flexShrink:0,display:"inline-flex",alignItems:"center",justifyContent:"center",width:16,height:16,borderRadius:"50%",border:"1px solid rgba(148,163,184,.55)",color:"rgba(148,163,184,.85)",fontSize:10,fontWeight:800,marginTop:2,lineHeight:1}}>i</span>
                  <p style={{fontSize:12,color:"rgba(255,255,255,.55)",lineHeight:1.6,margin:0}}>{retentionNote}</p>
                </div>
              </>
            );
          })()}

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
                          <span>{r.highRisk} high impact</span>
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

      <Footer onNavigate={onNavigate}/>

      {toast && (
        <div role="status" style={{position:"fixed",top:24,left:"50%",transform:"translateX(-50%)",padding:"12px 22px",borderRadius:30,background:"#0f172a",border:"1px solid rgba(249,115,22,.5)",color:"#fff",fontWeight:700,fontSize:14,zIndex:100,boxShadow:"0 18px 50px rgba(0,0,0,.45)"}}>
          {toast}
        </div>
      )}

      {/* Reinstatement modal. Triggered from the Cancelled banner above.
          Each option redirects to the matching Stripe Payment Link with
          client_reference_id="plan:<key>" so the webhook knows which
          plan to grant on return. */}
      {reinstateOpen && (
        <div role="dialog" aria-modal="true" style={{position:"fixed",inset:0,background:"rgba(2,12,27,.78)",backdropFilter:"blur(6px)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px",overflowY:"auto"}}>
          <div style={{maxWidth:720,width:"100%",background:"#0f172a",border:"1px solid rgba(249,115,22,.4)",borderRadius:18,padding:"26px 26px 22px",boxShadow:"0 30px 80px rgba(0,0,0,.55)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:14,marginBottom:14}}>
              <div>
                <h3 style={{fontSize:22,fontWeight:900,color:"#fff",margin:"0 0 6px"}}>Reinstate your subscription</h3>
                <p style={{fontSize:13,color:"rgba(255,255,255,.7)",lineHeight:1.55,margin:0}}>Pick the plan that fits your team. You will be sent to Stripe to complete payment, then returned to your dashboard.</p>
              </div>
              <button onClick={()=>setReinstateOpen(false)} aria-label="Close" style={{background:"transparent",border:"none",color:"rgba(255,255,255,.7)",fontSize:22,fontWeight:900,cursor:"pointer",lineHeight:1,padding:"0 4px",fontFamily:"inherit"}}>&times;</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:12}}>
              {Object.entries(PLAN_INFO).map(([key, info]) => {
                const isAnnual = key.endsWith("-annual");
                return (
                  <button key={key} onClick={()=>startReinstateCheckout(key)} style={{textAlign:"left",padding:"16px 16px 14px",borderRadius:12,border:"1px solid rgba(255,255,255,.16)",background:"rgba(255,255,255,.04)",cursor:"pointer",fontFamily:"inherit",color:"#fff",transition:"border-color .15s, background .15s"}}>
                    <div style={{fontSize:11,letterSpacing:".14em",textTransform:"uppercase",fontWeight:800,color:isAnnual ? "#f97316" : "rgba(255,255,255,.55)",marginBottom:6}}>
                      {isAnnual ? "Annual" : "Monthly"}
                    </div>
                    <div style={{fontSize:17,fontWeight:900,marginBottom:4}}>{info.label}</div>
                    <div style={{fontSize:13,color:"rgba(255,255,255,.7)",marginBottom:10}}>
                      {info.credits >= LEGACY_UNLIMITED_CAP ? ENTERPRISE_MONTHLY : info.credits} reports / month
                    </div>
                    <div style={{fontSize:12,color:"#f97316",fontWeight:800}}>{info.pricePer} per report &rarr;</div>
                  </button>
                );
              })}
            </div>
            <p style={{fontSize:12,color:"rgba(255,255,255,.5)",lineHeight:1.55,marginTop:14}}>
              Already paid? Subscriptions take a moment to update after checkout. If you do not see credits within a minute, refresh this page.
            </p>
          </div>
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

  // Display the Enterprise 200 cap even on legacy records that have not yet
  // been migrated from the old Credits_Monthly = 999999 marker.
  const displayMonthly = account.creditsMonthly >= LEGACY_UNLIMITED_CAP
    ? ENTERPRISE_MONTHLY
    : account.creditsMonthly;
  const displayRemaining = account.creditsRemaining >= LEGACY_UNLIMITED_CAP
    ? ENTERPRISE_MONTHLY
    : account.creditsRemaining;
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
    ["Credits Remaining",       String(displayRemaining)],
    ["Credits Per Month",       String(displayMonthly)],
    ["Renewal Date",            account.renewalDate || "-"],
    ["Date Joined",             account.dateJoined || "-"],
    ["Total Reports Generated", String(account.reportsGenerated || 0)],
  ];

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",color:"#fff"}}>
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
            Stripe automatically sends payment receipts to your email address after each charge. Check your inbox at <strong style={{color:"#fff"}}>{account.email}</strong> for all past receipts.
          </p>
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

      <Footer onNavigate={onNavigate}/>

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
    <div id="hz-cookie-banner" style={{position:"fixed",left:0,right:0,bottom:0,zIndex:10000,background:"#0a1628",borderTop:"1px solid rgba(249,115,22,.4)",boxShadow:"0 -10px 40px rgba(0,0,0,.5)"}}>
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

// ─── FAQ HELP WIDGET ────────────────────────────────────────────────────────
// Zero-token floating help widget. User questions are matched against a
// local FAQ database with simple keyword scoring. No network calls, no
// API costs. The component is still exported as ChatWidget so the render
// site does not need to change.

const FAQ_WELCOME =
  "Hi! Ask me anything about HumZones, data center metrics or how to use " +
  "your report. For general questions try Google or visit our Glossary.";

const FAQ_FALLBACK =
  "I did not find a specific answer to that. You can:\n" +
  "- Browse our Glossary at humzones.com/glossary\n" +
  "- Read our Resident Guides at humzones.com/learn\n" +
  "- Email us at hello@humzones.com";

const FAQ_STOPWORDS = new Set([
  "what","is","how","does","do","i","the","a","an","of","to","for","in","on",
  "with","my","me","can","are","it","that","this","any","about","some","and",
  "or","if","at","by","be","as","from","was","were","will","would","you","your"
]);

const FAQS = [
  {
    keywords: ["impact","category","high","moderate","low","exposure","rating","mean"],
    q: "What do the impact categories mean?",
    a: "Infrastructure impact categories (HIGH, MODERATE, LOW) are relative indicators based on modeled estimates of facility power draw and proximity to residential areas. HIGH indicates the largest estimated local footprint. These are not scientific measurements or health determinations."
  },
  {
    keywords: ["report","cost","price","much","pay","14.99","buy","purchase"],
    q: "How much does a report cost?",
    a: "A personalized area report costs $14.99 and covers all tracked data center facilities within your chosen radius. Business reports start at $14.99 per report depending on your plan. Reports include power, noise, EMF and water estimates for every facility."
  },
  {
    keywords: ["emf","electromagnetic","field","radiation","milligauss","mg","measured"],
    q: "How are EMF figures calculated?",
    a: "EMF figures are modeled estimates based on facility power draw and distance. They are NOT certified field measurements. HumZones makes no health claims. The figures are provided so residents can ask informed questions of local officials."
  },
  {
    keywords: ["power","mw","megawatt","electricity","draw","consumption","energy"],
    q: "What does the power draw figure mean?",
    a: "Power draw is the reported electricity consumption of a facility in megawatts (MW). One megawatt powers approximately 750 average American homes continuously. A 100MW facility draws as much electricity as 75,000 homes running 24 hours a day."
  },
  {
    keywords: ["noise","db","decibel","sound","loud","quiet","measured","level"],
    q: "What does the noise estimate mean?",
    a: "Noise figures are modeled estimates of perimeter sound levels based on facility power class and cooling type. They are not certified acoustic measurements. For context, 65dB is comparable to heavy traffic, and data center cooling systems run 24 hours a day including overnight."
  },
  {
    keywords: ["water","gallon","consumption","cooling","daily","use","evaporative"],
    q: "How much water do data centers use?",
    a: "Water consumption estimates are based on facility power draw and cooling type using WUE ratios from ASHRAE and the Green Grid. Evaporative cooling systems can use millions of gallons per day. Chilled water systems use less. These are modeled estimates not certified measurements."
  },
  {
    keywords: ["submit","report","experience","community","share","symptoms","observations"],
    q: "How do I submit my experience?",
    a: "Visit humzones.com/submit-report to add your verified experience to the public registry. It is free. You can report symptoms, observations like noise or generator activity, and anything else you have noticed near a facility. Reports are email-verified."
  },
  {
    keywords: ["interconnection","queue","filing","grid","connect","utility","pjm","ferc"],
    q: "What is an interconnection queue?",
    a: "An interconnection queue is the official waiting list a company must join before connecting a large new electrical load to the power grid. Each entry is a public signal that a large facility may be planned nearby, often 12 to 36 months before construction begins."
  },
  {
    keywords: ["proposed","approved","building","operating","status","planned","construction"],
    q: "What do the facility status labels mean?",
    a: "Proposed means announced but not yet approved. Approved means permits granted but construction not started. Building means actively under construction. Operating means the facility is live and consuming power. Engaging with the planning process is most effective when a facility is still Proposed."
  },
  {
    keywords: ["business","plan","professional","commercial","credits","monthly","subscription"],
    q: "What are the business plans?",
    a: "HumZones offers professional business plans for real estate, legal and research firms. Plans include monthly report credits, detailed facility data and licensed commercial use. Visit the Business section or contact hello@humzones.com for plan details."
  },
  {
    keywords: ["accurate","data","source","where","information","come","from","verified"],
    q: "Where does the data come from?",
    a: "Facility data is compiled from publicly available sources including municipal planning filings, utility interconnection applications, operator press releases and permitting databases. All power, noise, EMF, CO2 and water figures are modeled estimates not certified measurements."
  },
  {
    keywords: ["newsletter","subscribe","email","weekly","infrastructure","intelligence"],
    q: "What is Infrastructure Intelligence?",
    a: "Infrastructure Intelligence is a free weekly newsletter published by HumZones every Monday and Thursday. It translates data center interconnection filings, utility permits and facility news into plain language for residents. Subscribe free at humzones.com/newsletter."
  },
  {
    keywords: ["glossary","term","definition","meaning","explain","understand","jargon"],
    q: "Where can I learn more about technical terms?",
    a: "Visit humzones.com/glossary for plain-language definitions of data center infrastructure terms including interconnection queues, megawatts, balancing authorities, WUE and more. Or read our resident guides at humzones.com/learn."
  },
  {
    keywords: ["foia","public","record","request","document","filing","access","obtain"],
    q: "How do I get public records about a facility?",
    a: "Most data center approvals involve public documents you can request. Contact your local planning department for permit records. File FOIA requests with your state utility commission for interconnection filings. Visit humzones.com/learn for step-by-step guides on reading these documents."
  },
  {
    keywords: ["planning","board","council","official","oppose","attend","hearing","comment"],
    q: "How can I engage with local officials about a data center?",
    a: "Attend public planning hearings and submit written comments before deadlines. Contact your board of supervisors or county council directly. Reference specific factual concerns like power draw, noise and water estimates. Organized neighborhood groups are more effective than individual voices. Read our full guide at humzones.com/learn."
  },
  {
    keywords: ["unsubscribe","cancel","stop","email","opt","out","remove"],
    q: "How do I unsubscribe?",
    a: "Click the Unsubscribe link at the bottom of any email from HumZones, or visit humzones.com/unsubscribe and enter your email address. You will be removed from all HumZones email lists immediately."
  },
  {
    keywords: ["contact","help","support","question","email","hello","reach"],
    q: "How do I contact HumZones?",
    a: "Email us at hello@humzones.com. We read every message. For report corrections, data questions or media inquiries we typically respond within 1-2 business days."
  },
  {
    keywords: ["co2","carbon","emissions","greenhouse","climate","environment","annual"],
    q: "How are CO2 estimates calculated?",
    a: "CO2 estimates are calculated by applying EPA eGRID regional emissions factors to each facility's reported power draw. These are annual estimates. For context, a 100MW data center in a typical Mid-Atlantic grid produces roughly the same CO2 as 80,000 cars driven for a year. All figures are modeled estimates."
  },
  {
    keywords: ["cooling","chilled","evaporative","tower","system","type","difference"],
    q: "What is the difference between cooling types?",
    a: "Chilled water cooling circulates cooled water through servers. Lower water consumption but energy intensive. Evaporative cooling removes heat through water evaporation and is very water intensive but more energy efficient in dry climates. Evaporative facilities can consume millions of gallons of water daily."
  },
  {
    keywords: ["hyperscale","amazon","google","microsoft","meta","aws","cloud","large"],
    q: "What is a hyperscale data center?",
    a: "A hyperscale data center exceeds 100MW of power capacity and is typically operated by a major cloud provider such as Amazon Web Services, Google, Microsoft Azure or Meta. Northern Virginia has the highest concentration of hyperscale infrastructure in the world."
  }
];

function faqTokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => !FAQ_STOPWORDS.has(w));
}

function faqMatch(question) {
  const tokens = faqTokenize(question);
  if (tokens.length === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const entry of FAQS) {
    const keywordSet = new Set(entry.keywords.map(k => k.toLowerCase()));
    const haystack = (entry.keywords.join(" ") + " " + entry.q + " " + entry.a).toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (keywordSet.has(t)) score += 2;        // exact keyword hit
      else if (haystack.includes(t)) score += 1; // soft match anywhere in the entry
    }
    if (score > bestScore) { bestScore = score; best = entry; }
  }
  return bestScore > 0 ? best : null;
}

const ChatWidget = ({ onNavigate }) => {
  const [open, setOpen]         = useState(false);
  const [messages, setMessages] = useState([
    { role: "assistant", content: FAQ_WELCOME, ts: Date.now() }
  ]);
  const [input, setInput]       = useState("");
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" && window.innerWidth <= 600
  );

  const bodyRef    = useRef(null);
  const taRef      = useRef(null);
  const lastMsgRef = useRef(null);

  // Resize listener so the panel switches between desktop and mobile layouts.
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 600);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Scroll the latest message into view when messages change or the panel opens.
  useEffect(() => {
    if (open && lastMsgRef.current) {
      lastMsgRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages, open]);

  // Focus the input when the panel opens.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => { if (taRef.current) taRef.current.focus(); }, 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  const fmtTime = (ts) => {
    const d = new Date(ts);
    let h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12; if (h === 0) h = 12;
    return h + ":" + String(m).padStart(2, "0") + " " + ampm;
  };

  const ask = (q) => {
    const trimmed = String(q || "").trim();
    if (!trimmed) return;
    const userMsg = { role: "user", content: trimmed, ts: Date.now() };
    const match   = faqMatch(trimmed);
    const answer  = match ? match.a : FAQ_FALLBACK;
    const botMsg  = { role: "assistant", content: answer, ts: Date.now() + 1 };
    setMessages(prev => [...prev, userMsg, botMsg]);
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
  };

  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ask(input);
    }
  };

  const windowStyle = isMobile
    ? { position:"fixed", left:0, right:0, bottom:0, width:"100vw", height:"60vh", borderRadius:"16px 16px 0 0" }
    : { position:"fixed", right:24, bottom:90, width:360, height:500, borderRadius:16 };

  return (
    <>
      {!open && (
        <button
          className="hz-chat-fab"
          onClick={() => setOpen(true)}
          aria-label="Open the HumZones help widget"
          style={{position:"fixed",right:24,bottom:24,zIndex:9998,width:56,height:56,borderRadius:"50%",border:"none",cursor:"pointer",boxShadow:"0 8px 24px rgba(249,115,22,.45)",display:"flex",alignItems:"center",justifyContent:"center",background:"#f97316"}}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
        </button>
      )}

      {open && (
        <div className="hz-chat-window" style={{...windowStyle,background:"#fff",boxShadow:"0 20px 60px rgba(0,0,0,0.2)",zIndex:9999,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          {/* HEADER */}
          <div style={{flexShrink:0,background:"#1e293b",borderRadius:"16px 16px 0 0",padding:"13px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
            <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
              <div style={{width:32,height:32,borderRadius:"50%",background:"#f97316",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
              </div>
              <div style={{minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <span style={{fontSize:14,fontWeight:800,color:"#fff"}}>HumZones Help</span>
                  <span style={{width:8,height:8,borderRadius:"50%",background:"#22c55e",boxShadow:"0 0 6px rgba(34,197,94,.9)",flexShrink:0}}/>
                </div>
                <div style={{fontSize:11,color:"#94a3b8",marginTop:1}}>Common questions answered instantly.</div>
              </div>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Close help" style={{background:"none",border:"none",color:"rgba(255,255,255,.7)",cursor:"pointer",padding:4,display:"flex",flexShrink:0}}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>

          {/* BODY */}
          <div ref={bodyRef} style={{flex:1,minHeight:0,overflowY:"auto",background:"#fff",padding:"16px 14px",display:"flex",flexDirection:"column",gap:12}}>
            {messages.map((m, i) => (
              <div key={i} ref={i === messages.length - 1 ? lastMsgRef : null} style={{display:"flex",flexDirection:"column",alignItems:m.role==="user"?"flex-end":"flex-start"}}>
                <div style={{maxWidth:"84%",padding:"10px 13px",borderRadius:14,fontSize:14,lineHeight:1.55,whiteSpace:"pre-wrap",wordBreak:"break-word",background:m.role==="user"?"#f97316":"#f1f5f9",color:m.role==="user"?"#fff":"#1e293b",borderBottomRightRadius:m.role==="user"?4:14,borderBottomLeftRadius:m.role==="user"?14:4}}>
                  {m.content}
                </div>
                <div style={{fontSize:10,color:"#94a3b8",marginTop:3,padding:"0 4px"}}>{fmtTime(m.ts)}</div>
              </div>
            ))}
          </div>

          {/* INPUT */}
          <div style={{flexShrink:0,borderTop:"1px solid #e2e8f0",background:"#fff",padding:"10px 12px",display:"flex",alignItems:"flex-end",gap:8}}>
            <textarea
              ref={taRef}
              value={input}
              onChange={e => { setInput(e.target.value); const t=e.target; t.style.height="auto"; t.style.height=Math.min(t.scrollHeight,100)+"px"; }}
              onKeyDown={onKey}
              rows={1}
              placeholder="Ask me anything about data centers..."
              style={{flex:1,resize:"none",border:"1px solid #e2e8f0",borderRadius:12,padding:"10px 12px",fontSize:14,fontFamily:"inherit",outline:"none",maxHeight:100,lineHeight:1.4,color:"#1e293b",boxSizing:"border-box"}}
            />
            <button onClick={() => ask(input)} disabled={!input.trim()} aria-label="Send question" style={{flexShrink:0,width:40,height:40,borderRadius:12,border:"none",cursor:input.trim()?"pointer":"default",background:input.trim()?"#f97316":"#fdba74",display:"flex",alignItems:"center",justifyContent:"center"}}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
            </button>
          </div>
        </div>
      )}
    </>
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

        <p style={{fontSize:14,color:"rgba(255,255,255,.7)",lineHeight:1.7,margin:"4px 0 18px"}}>
          See also our full <a href="/disclaimer" onClick={e=>{e.preventDefault();onNavigate("/disclaimer");}} style={{color:"#f97316",fontWeight:700,textDecoration:"none"}}>Legal Disclaimer</a> at humzones.com/disclaimer
        </p>
        <button onClick={()=>onNavigate("/")} style={{marginTop:12,padding:"14px 26px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:15,fontWeight:900,background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>Back to HumZones</button>
      </main>
      <Footer onNavigate={onNavigate}/>
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
    // Newsletter_Subscribers: a single unsubscribe link removes them from
    // the weekly newsletter as well as the near-me email list.
    try {
      const subsTable    = "tblTTCCngCteIBbbv";
      const NL_EMAIL     = "fldbcBeZpmy6QxGSd";
      const NL_UNSUB     = "flddV4PhEATPwiHzl";
      const formula      = encodeURIComponent(`LOWER({Email}) = '${lc}'`);
      const lookup = await fetch(`${APIURL}/${subsTable}?filterByFormula=${formula}&maxRecords=1&returnFieldsByFieldId=true`, { headers: HDR });
      const data = await lookup.json().catch(() => ({}));
      const rec = (data.records || [])[0];
      if (rec) {
        await fetch(`${APIURL}/${subsTable}/${rec.id}`, {
          method: "PATCH",
          headers: HDR,
          body: JSON.stringify({ fields: { [NL_UNSUB]: true } }),
        });
      }
      void NL_EMAIL; // suppress unused-var lint; kept for documentation
    } catch (e) { console.warn("Newsletter unsubscribe failed:", e); }
    setStatus("done");
  };

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",color:"#fff"}}>
      <div style={{padding:"22px 24px",textAlign:"center"}}>
        <a href="/" onClick={e=>{e.preventDefault();onNavigate("/");}} style={{textDecoration:"none"}}>
          <span style={{fontSize:22,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
          <sup style={{fontSize:12,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2,position:"relative",top:"-4px"}}>TM</sup>
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
      const { doc, dateStr } = await generatePersonalReportPDF({
        searchAddress: row.address,
        facsInRadius: facsNear,
        searchRadius: row.radius,
      });
      doc.save(`HumZones-Report-${pdfFilenameSafe(row.address)}-${dateStr}.pdf`);
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
                    {r.highRisk != null && <span>{r.highRisk} high impact</span>}
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

      <Footer onNavigate={onNavigate}/>
    </div>
  );
};

// ─── CASCADING DROPDOWN ──────────────────────────────────────────────────────
// One styled dropdown used by the cascading Country / State / City / Facility
// selector on the resident report form. Each option can carry an optional
// sublabel (the facility address) shown in smaller grey text below the label.
const CascadeSelect = ({ label, placeholder, options, value, onChange, disabled }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const selected = options.find(o => o.value === value) || null;
  const filled = !!selected;
  return (
    <div ref={ref} style={{marginBottom:16,position:"relative"}}>
      <label style={{fontSize:13,fontWeight:700,color:"#374151",display:"block",marginBottom:6}}>{label}</label>
      <button
        type="button"
        onClick={()=>{ if(!disabled) setOpen(o=>!o); }}
        disabled={disabled}
        style={{
          width:"100%",padding:"13px 16px",borderRadius:10,
          border:`1.5px solid ${filled?"#3b82f6":"#e2e8f0"}`,
          fontSize:15,boxSizing:"border-box",outline:"none",fontFamily:"inherit",
          background:disabled?"#f1f5f9":"#fff",
          color:filled?"#1e293b":"#94a3b8",
          cursor:disabled?"not-allowed":"pointer",
          display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,textAlign:"left",
        }}
      >
        <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{selected?selected.label:placeholder}</span>
        <span style={{fontSize:11,color:"#94a3b8",flexShrink:0}}>{open?"▲":"▼"}</span>
      </button>
      {open && !disabled && (
        <div style={{position:"absolute",top:"100%",left:0,right:0,marginTop:4,background:"#fff",border:"1px solid #e2e8f0",borderRadius:10,boxShadow:"0 12px 32px rgba(0,0,0,.14)",maxHeight:264,overflowY:"auto",zIndex:50}}>
          {options.length===0 ? (
            <div style={{padding:"13px 16px",fontSize:14,color:"#94a3b8"}}>No options available</div>
          ) : options.map(o=>(
            <div
              key={o.value}
              onClick={()=>{ onChange(o.value); setOpen(false); }}
              className="drop-item"
              style={{padding:"11px 16px",cursor:"pointer",borderBottom:"1px solid #f1f5f9"}}
            >
              <div style={{fontSize:14,fontWeight:600,color:"#1e293b",lineHeight:1.35}}>{o.label}</div>
              {o.sublabel && <div style={{fontSize:12,color:"#94a3b8",marginTop:2,lineHeight:1.4}}>{o.sublabel}</div>}
            </div>
          ))}
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

  // SEO + social meta + WebPage JSON-LD. Cleaned up on unmount.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = "Report a Data Center Experience | HumZones Community";

    injectHeadEl("meta", "submitreport-desc",      { name: "description",         content: "Living near a data center? Share your verified experience with the HumZones community registry. Report noise, generator activity, sleep disruption and other observations. Free to submit." });
    injectHeadEl("link", "submitreport-canonical", { rel: "canonical",            href: "https://humzones.com/submit-report" });
    injectHeadEl("meta", "submitreport-og-title",  { property: "og:title",        content: "Share Your Data Center Experience | HumZones" });
    injectHeadEl("meta", "submitreport-og-desc",   { property: "og:description",  content: "Add your verified experience to the public registry. Report noise, generator activity and other observations near data center facilities. Free." });
    injectHeadEl("meta", "submitreport-og-url",    { property: "og:url",          content: "https://humzones.com/submit-report" });
    injectHeadEl("meta", "submitreport-og-type",   { property: "og:type",         content: "website" });
    injectHeadEl("meta", "submitreport-og-site",   { property: "og:site_name",    content: "HumZones" });
    injectHeadEl("meta", "submitreport-tw-card",   { name: "twitter:card",        content: "summary" });
    injectHeadEl("meta", "submitreport-tw-title",  { name: "twitter:title",       content: "Report Your Data Center Experience | HumZones" });
    injectHeadEl("meta", "submitreport-tw-desc",   { name: "twitter:description", content: "Share verified observations about living near data center infrastructure. Free community registry." });

    const pageSchema = {
      "@context":    "https://schema.org",
      "@type":       "WebPage",
      "name":        "Submit Your Data Center Experience",
      "url":         "https://humzones.com/submit-report",
      "description": "Community-submitted verified reports about living near data center infrastructure. Covers noise, generator testing, sleep disruption and other environmental observations.",
      "isPartOf":    { "@type": "WebSite", "name": "HumZones", "url": "https://humzones.com" },
      "audience":    { "@type": "Audience", "audienceType": "Residents and homeowners near data center facilities" },
    };
    injectHeadEl("script", "submitreport-jsonld", { type: "application/ld+json" }, JSON.stringify(pageSchema));

    return () => {
      [
        "submitreport-desc","submitreport-canonical",
        "submitreport-og-title","submitreport-og-desc","submitreport-og-url","submitreport-og-type","submitreport-og-site",
        "submitreport-tw-card","submitreport-tw-title","submitreport-tw-desc",
        "submitreport-jsonld",
      ].forEach(removeHeadEl);
    };
  }, []);

  // Cascading Country / State / City / Facility selector for the form. The
  // hero search above writes into the same state via pickFacility.
  const [fCountry, setFCountry] = useState("");
  const [fState, setFState]     = useState("");
  const [fCity, setFCity]       = useState("");
  const [selectedFacility, setSelectedFacility] = useState(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName]   = useState("");
  const [email, setEmail]         = useState("");
  const [duration, setDuration]   = useState("");
  const [symptoms, setSymptoms]   = useState([]);
  // Environmental observations collected alongside the symptoms list. These
  // are infrastructure-level observations (construction noise, generator
  // activity, etc.) rather than health claims, and write through to the
  // Reports.Observations column in Airtable.
  const [observations, setObservations] = useState([]);
  const [extraObservations, setExtraObservations] = useState("");
  const [reportText, setReportText] = useState("");
  const [declared, setDeclared]   = useState(false);
  const [human, setHuman]         = useState(false);
  const [hp, setHp]               = useState(""); // honeypot ("website" field)
  const [sending, setSending]     = useState(false);
  const [sent, setSent]           = useState(false);
  const [sentEmail, setSentEmail] = useState("");
  // Loading flag while the Reports-table duplicate query is in flight, plus
  // the result of that query when the user has already filed a report for
  // this facility within the last 3 months.
  const [checking, setChecking]               = useState(false);
  const [duplicateInfo, setDuplicateInfo]     = useState(null);

  const formRef = useRef(null);
  // Form-load timestamp for the 15-second minimum gate.
  const formLoadTimeRef = useRef(Date.now());

  // Reset every form field, drop any submission flags, restart the 15-second
  // gate, and smooth-scroll to the top of the page. Wired to the "Submit
  // Another Report" button that appears under the success card.
  const resetAll = () => {
    setCountry(""); setRegion(""); setCity(""); setFound(null);
    setFCountry(""); setFState(""); setFCity(""); setSelectedFacility(null);
    setFirstName(""); setLastName(""); setEmail("");
    setDuration(""); setSymptoms([]); setReportText("");
    setObservations([]); setExtraObservations("");
    setDeclared(false); setHuman(false); setHp("");
    setSending(false); setSent(false); setSentEmail("");
    setChecking(false); setDuplicateInfo(null);
    formLoadTimeRef.current = Date.now();
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Reset just the facility selectors and the duplicate banner so the user
  // can pick a different facility without re-typing their name or email.
  const resetFacilityOnly = () => {
    setCountry(""); setRegion(""); setCity(""); setFound(null);
    setFCountry(""); setFState(""); setFCity(""); setSelectedFacility(null);
    setDuplicateInfo(null);
    formLoadTimeRef.current = Date.now();
    setTimeout(() => { if (formRef.current) formRef.current.scrollIntoView({ behavior: "smooth", block: "start" }); }, 60);
  };

  // Query the Reports table for an existing row with the same email AND the
  // same facility name. Returns { date } when a row exists and was submitted
  // less than 3 months ago, or null in every other case (no row, older row,
  // or lookup failure - we fail open so a transient Airtable hiccup never
  // blocks a legitimate submission).
  const checkDuplicate = async () => {
    const eRaw = email.trim();
    const facName = selectedFacility ? (selectedFacility.Name || "") : "";
    if (!eRaw || !facName) return null;
    const eEsc = eRaw.toLowerCase().replace(/'/g, "\\'");
    const fEsc = facName.replace(/'/g, "\\'");
    const formula = encodeURIComponent(`AND(LOWER({Email})='${eEsc}',{Facility_Name}='${fEsc}')`);
    const url = `${APIURL}/tblBBaQ4NFCdaS6Tk?filterByFormula=${formula}&maxRecords=1&returnFieldsByFieldId=true`;
    try {
      const r = await fetch(url, { headers: HDR });
      if (!r.ok) {
        console.warn("[submit-report] duplicate-check non-ok:", r.status);
        return null;
      }
      const data = await r.json();
      const rec = (data.records || [])[0];
      if (!rec) return null;
      const dateStr = rec.fields && rec.fields["fldmqFjSvXE3dPMhx"];
      if (!dateStr) return null;
      const submittedAt = new Date(dateStr);
      if (Number.isNaN(submittedAt.getTime())) return null;
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - 3);
      if (submittedAt < cutoff) return null;
      return { date: dateStr };
    } catch (e) {
      console.warn("[submit-report] duplicate-check threw:", e);
      return null;
    }
  };
  const MAX_REPORT_CHARS = 3000;
  const MAX_EXTRA_OBS_CHARS = 500;
  const SYMPTOM_OPTIONS = [
    "Headaches","Sleep disruption","Dizziness or vertigo","Nausea",
    "Ear ringing (tinnitus)","Anxiety or panic","Diesel exhaust smell","Chest pressure or tightness",
  ];
  const OBSERVATION_OPTIONS = [
    "Construction noise","Generator activity","Traffic increases","Utility outages",
    "Nighttime lighting","Expansion sightings","New fencing or barriers","Delivery truck activity",
    "Vibration or ground rumble","Unusual odors","Increased security presence","Other infrastructure changes",
  ];
  const toggleSymptom     = (s) => setSymptoms(prev     => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  const toggleObservation = (o) => setObservations(prev => prev.includes(o) ? prev.filter(x => x !== o) : [...prev, o]);

  useEffect(() => {
    let alive = true;
    // Fetch straight from Airtable rather than via cachedFetch so the Address
    // field (fldM1eSScQK8HD0Fh) is guaranteed in every record. cachedFetch
    // keys its cache by table name only and ignores the requested fields, so
    // an Address-less cached set loaded by another page would otherwise be
    // served here and the confirmation card would fall back to the city.
    apiFetch("Facilities", { "fields[]": [...FACILITY_LIST_FIELDS, "Address"] })
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

  // Option lists for the cascading form selector, each filtered by the
  // selections above it.
  const formStates = fCountry
    ? [...new Set(facs.filter(f => f.Country === fCountry).map(f => f.State_Region).filter(Boolean))].sort()
    : [];
  const formCities = (fCountry && fState)
    ? [...new Set(facs.filter(f => f.Country === fCountry && f.State_Region === fState).map(f => f.City).filter(Boolean))].sort()
    : [];
  const formFacilities = (fCountry && fState && fCity)
    ? facs.filter(f => f.Country === fCountry && f.State_Region === fState && f.City === fCity)
          .sort((a, b) => (a.Name || "").localeCompare(b.Name || ""))
    : [];

  // Selecting a facility, whether from the hero results or the cascading
  // dropdowns, fills the whole selector and scrolls to the form.
  const pickFacility = (f) => {
    setFCountry(f.Country || "");
    setFState(f.State_Region || "");
    setFCity(f.City || "");
    setSelectedFacility(f);
    setTimeout(() => { if (formRef.current) formRef.current.scrollIntoView({ behavior: "smooth", block: "start" }); }, 60);
  };

  const canSubmit = !!selectedFacility && firstName.trim() && email.trim() && reportText.trim() && declared && human;

  const submit = async () => {
    if (!canSubmit) return;
    // Honeypot: bots fill the hidden "website" field. Silently accept so they
    // get no feedback.
    if (hp) { setSentEmail(email.trim()); setSent(true); return; }
    // 15-second minimum: a human cannot meaningfully fill the form faster.
    if (Date.now() - (formLoadTimeRef.current || 0) < 15000) { setSentEmail(email.trim()); setSent(true); return; }

    // Duplicate guard: one report per email per facility every 3 months. The
    // check fails open so an Airtable outage cannot block a real submission.
    setChecking(true);
    const dup = await checkDuplicate();
    setChecking(false);
    if (dup) { setDuplicateInfo(dup); return; }

    setSending(true);
    // Facility name, full address, city and country all come from the chosen
    // facility record so the verification email and the Reports table row
    // stay consistent with our database.
    const facName    = selectedFacility ? (selectedFacility.Name || "") : "";
    const facAddress = selectedFacility ? buildLocationString(selectedFacility) : "";
    const facCity    = selectedFacility ? (selectedFacility.City || "") : "";
    const facCountry = selectedFacility ? (selectedFacility.Country || "") : "";
    try {
      const r = await fetch("/api/send-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email:             email.trim(),
          firstName:         firstName.trim(),
          lastName:          lastName.trim(),
          facilityName:      facName,
          reportText,
          address:           facAddress,
          city:              facCity,
          country:           facCountry,
          symptoms:          symptoms.join(", "),
          duration:          duration.trim(),
          observations:      observations.join(", "),
          extraObservations: extraObservations.trim(),
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
  // Read-only confirmation field: looks like a filled form input but is locked.
  const roInp = {
    width:"100%", padding:"13px 16px", borderRadius:10, border:"1.5px solid #e2e8f0",
    fontSize:15, boxSizing:"border-box", outline:"none", fontFamily:"inherit",
    color:"#1e293b", background:"#f1f5f9",
  };

  return (
    <div style={{minHeight:"100vh",background:"#f1f5f9",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>
      {/* HERO */}
      <section style={{background:"linear-gradient(150deg,#020c1b 0%,#0f172a 45%,#1e0535 100%)",padding:"22px 24px 56px"}}>
        <div style={{maxWidth:1080,margin:"0 auto"}}>
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
          <p style={{fontSize:15,color:"#64748b",marginBottom:22,lineHeight:1.6}}>Select a facility to submit a report about it, or choose one using the dropdowns in the form below.</p>
          {found.length===0 ? (
            <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,padding:"22px",fontSize:15,color:"#64748b",lineHeight:1.65}}>No facilities found for that selection. If your facility is missing, contact us at <a href="mailto:hello@humzones.com" style={{color:"#f97316",fontWeight:700,textDecoration:"none"}}>hello@humzones.com</a> and we will add it to our database.</div>
          ) : (
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:16}}>
              {found.map(f=>(
                <div key={f.id} style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:16,padding:"20px",boxShadow:"0 2px 12px rgba(0,0,0,.05)",display:"flex",flexDirection:"column",gap:9}}>
                  <div style={{fontSize:16,fontWeight:800,color:"#0f172a",lineHeight:1.3}}>{f.Name||"Unnamed facility"}</div>
                  {f.Company && <div style={{fontSize:13,color:"#64748b"}}>{f.Company}</div>}
                  {f.Address && <div style={{fontSize:12,color:"#94a3b8",lineHeight:1.45}}>{f.Address}</div>}
                  <div style={{fontSize:13,color:"#94a3b8"}}>{[f.City,f.State_Region].filter(Boolean).join(", ")||"Location not on file"}</div>
                  <div><Chip label={exposureLabel(f.Risk_Level)} color={exposureColor(f.Risk_Level)} small/></div>
                  <button onClick={()=>pickFacility(f)} style={{marginTop:"auto",padding:"11px 16px",borderRadius:10,border:"none",background:"#f97316",color:"#fff",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit"}}>
                    Submit Report for This Facility
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* REPORT FORM */}
      <section ref={formRef} style={{maxWidth:760,margin:"0 auto",padding:"40px 24px 20px"}}>
        <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:18,padding:"32px 32px 34px",boxShadow:"0 4px 24px rgba(0,0,0,.07)"}}>
          <h2 style={{fontSize:24,fontWeight:900,color:"#0f172a",marginBottom:8}}>Your Report</h2>
          {duplicateInfo ? (
            <>
              <div style={{background:"#fff7ed",borderLeft:"4px solid #f97316",border:"1px solid #fed7aa",borderRadius:12,padding:"22px 22px 24px"}}>
                <div style={{fontSize:18,fontWeight:800,color:"#9a3412",marginBottom:10}}>Report Already Received</div>
                <p style={{fontSize:15,color:"#7c2d12",lineHeight:1.75,margin:"0 0 12px"}}>
                  Thank you for your commitment to your community. We have already received a report from your email address for this facility. Your voice has been heard and your report is part of our verified resident registry. We appreciate everything you are doing to raise awareness.
                </p>
                <p style={{fontSize:15,color:"#7c2d12",lineHeight:1.75,margin:0}}>
                  If your situation has changed significantly you are welcome to submit a new report in 3 months.
                </p>
              </div>
              <div style={{marginTop:18}}>
                <button onClick={resetFacilityOnly} style={{padding:"14px 28px",borderRadius:12,border:"none",background:"#f97316",color:"#fff",fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 4px 18px rgba(249,115,22,.35)"}}>
                  Submit Report for a Different Facility
                </button>
              </div>
            </>
          ) : sent ? (
            <>
              <div style={{background:"#f0fdf4",border:"2px solid #bbf7d0",borderRadius:14,padding:"22px"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                  <Icon name="check" size={22} color="#15803d"/>
                  <div style={{fontSize:18,fontWeight:800,color:"#15803d"}}>Almost done!</div>
                </div>
                <p style={{fontSize:15,color:"#166534",lineHeight:1.7,margin:0}}>We sent a verification email to <strong>{sentEmail||"your inbox"}</strong>. Click the link in that email to publish your report. Check your spam folder if you do not see it within a few minutes.</p>
              </div>
              <div style={{marginTop:18}}>
                <button onClick={resetAll} style={{padding:"13px 26px",borderRadius:12,border:"2px solid #f97316",background:"transparent",color:"#f97316",fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:"inherit"}}>
                  Submit Another Report
                </button>
              </div>
              <p style={{marginTop:16,fontSize:13,color:"#64748b",lineHeight:1.6}}>
                Want to help us reach more communities? Consider supporting HumZones.{" "}
                <a href="/donate" onClick={e=>{e.preventDefault();onNavigate("/donate");}} style={{color:"#f97316",fontWeight:700,textDecoration:"none"}}>Donate</a>
              </p>
              <p style={{marginTop:10,fontSize:13,color:"#64748b",lineHeight:1.6}}>
                Want weekly updates on data center infrastructure news?{" "}
                <a href="/newsletter" onClick={e=>{e.preventDefault();onNavigate("/newsletter");}} style={{color:"#f97316",fontWeight:700,textDecoration:"none"}}>Subscribe to Infrastructure Intelligence</a>
              </p>
            </>
          ) : (
            <>
              <p style={{fontSize:15,color:"#0f172a",fontWeight:800,marginBottom:8}}>Fields marked with an asterisk are required</p>
              <p style={{fontSize:14,color:"#64748b",lineHeight:1.7,marginBottom:24}}>Reports submitted here are reviewed by HumZones and may be shared with regulatory bodies as part of our verified resident health registry. A verified email address and signed declaration make your report credible to regulators and public health authorities.</p>
              {/* Honeypot field, hidden from humans, visible to bots. */}
              <input type="text" name="website" value={hp} onChange={e=>setHp(e.target.value)} tabIndex="-1" autoComplete="off" aria-hidden="true" style={{display:"none"}}/>

              {/* 1. Cascading facility selector: Country, State, City, Facility */}
              <CascadeSelect
                label="Country *"
                placeholder={loading ? "Loading countries..." : "Select a country"}
                options={countries.map(c=>({ value:c, label:c }))}
                value={fCountry}
                disabled={loading}
                onChange={v=>{ setFCountry(v); setFState(""); setFCity(""); setSelectedFacility(null); }}
              />

              {fCountry && (
                <CascadeSelect
                  label="State / Province *"
                  placeholder="Select a state or province"
                  options={formStates.map(s=>({ value:s, label:s }))}
                  value={fState}
                  onChange={v=>{ setFState(v); setFCity(""); setSelectedFacility(null); }}
                />
              )}

              {fCountry && fState && (
                <CascadeSelect
                  label="City *"
                  placeholder="Select a city"
                  options={formCities.map(c=>({ value:c, label:c }))}
                  value={fCity}
                  onChange={v=>{ setFCity(v); setSelectedFacility(null); }}
                />
              )}

              {fCountry && fState && fCity && (
                <>
                  <CascadeSelect
                    label="Select Your Facility *"
                    placeholder="Select a facility"
                    options={formFacilities.map(f=>({
                      value:    f.id,
                      label:    f.Name || "Unnamed facility",
                      sublabel: buildLocationString(f) || undefined,
                    }))}
                    value={selectedFacility ? selectedFacility.id : ""}
                    onChange={v=>setSelectedFacility(facs.find(f=>f.id===v) || null)}
                  />
                  <div style={{fontSize:13,color:"#64748b",lineHeight:1.6,margin:"-6px 0 16px"}}>
                    Cannot find your facility?{" "}
                    <a href="mailto:hello@humzones.com" style={{color:"#f97316",fontWeight:700,textDecoration:"none"}}>Contact us at hello@humzones.com</a>{" "}
                    and we will add it to our database.
                  </div>
                </>
              )}

              {/* Read-only confirmation of the chosen facility */}
              {selectedFacility && (
                <div style={{background:"#f8fafc",border:"1.5px solid #e2e8f0",borderRadius:14,padding:"18px 18px 20px",marginBottom:18}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,marginBottom:14,flexWrap:"wrap"}}>
                    <div style={{fontSize:13,fontWeight:800,color:"#0f172a",letterSpacing:".08em",textTransform:"uppercase"}}>Selected Facility</div>
                    <Chip label={exposureLabel(selectedFacility.Risk_Level)} color={exposureColor(selectedFacility.Risk_Level)} small/>
                  </div>
                  <div style={{marginBottom:12}}>
                    <label style={lbl}>Facility Name</label>
                    <input value={selectedFacility.Name || ""} readOnly style={roInp}/>
                  </div>
                  <div style={{marginBottom:12}}>
                    <label style={lbl}>Address</label>
                    <input value={selectedFacility.Address || "Address not on file"} readOnly style={roInp}/>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
                    <div>
                      <label style={lbl}>City</label>
                      <input value={selectedFacility.City || ""} readOnly style={roInp}/>
                    </div>
                    <div>
                      <label style={lbl}>State / Province</label>
                      <input value={selectedFacility.State_Region || ""} readOnly style={roInp}/>
                    </div>
                  </div>
                  <div>
                    <label style={lbl}>Country</label>
                    <input value={selectedFacility.Country || ""} readOnly style={roInp}/>
                  </div>
                </div>
              )}

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
                <div className="sym-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
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

              {/* 6b. Structured environmental observations. Same styling as
                  the symptoms checkboxes; these record infrastructure-level
                  observations rather than health claims. */}
              <div style={{marginBottom:16}}>
                <label style={{...lbl,marginBottom:4}}>What have you observed?</label>
                <p style={{fontSize:12,color:"#94a3b8",lineHeight:1.55,margin:"0 0 8px"}}>Select all that apply. These are environmental observations, not health claims.</p>
                <div className="sym-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  {OBSERVATION_OPTIONS.map(o=>{
                    const checked = observations.includes(o);
                    return (
                      <div key={o} onClick={()=>toggleObservation(o)} style={{display:"flex",alignItems:"center",gap:10,padding:"11px 14px",borderRadius:10,border:`1.5px solid ${checked?"#f97316":"#e2e8f0"}`,background:checked?"#fff7ed":"#f8fafc",cursor:"pointer",transition:"all .15s"}}>
                        <div style={{width:18,height:18,borderRadius:4,border:`2px solid ${checked?"#f97316":"#cbd5e1"}`,background:checked?"#f97316":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"all .15s"}}>
                          {checked && <Icon name="check" size={11} color="#fff"/>}
                        </div>
                        <span style={{fontSize:13,fontWeight:checked?600:400,color:checked?"#c2410c":"#374151"}}>{o}</span>
                      </div>
                    );
                  })}
                </div>
                <div style={{marginTop:12}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <label style={{...lbl,marginBottom:0}}>Anything else you observed? <span style={{color:"#94a3b8",fontWeight:400}}>(optional)</span></label>
                    <span style={{fontSize:12,fontWeight:600,color:extraObservations.length>MAX_EXTRA_OBS_CHARS*0.9?"#ef4444":"#94a3b8"}}>{extraObservations.length} / {MAX_EXTRA_OBS_CHARS}</span>
                  </div>
                  <textarea value={extraObservations} onChange={e=>{if(e.target.value.length<=MAX_EXTRA_OBS_CHARS)setExtraObservations(e.target.value);}} rows={3}
                    placeholder="Describe any other observations not listed above..."
                    style={{...inp(extraObservations),resize:"vertical",lineHeight:1.6}}/>
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

              <button onClick={submit} disabled={sending||checking||!canSubmit} style={{padding:"15px 38px",borderRadius:12,border:"none",background:canSubmit?"#f97316":"#e2e8f0",color:canSubmit?"#fff":"#94a3b8",fontSize:16,fontWeight:800,cursor:(canSubmit&&!sending&&!checking)?"pointer":"default",fontFamily:"inherit",boxShadow:canSubmit?"0 4px 20px rgba(249,115,22,.4)":"none",display:"inline-flex",alignItems:"center",gap:10}}>
                {(checking||sending) && (
                  <span className="spinning" style={{width:16,height:16,border:"2px solid rgba(255,255,255,.35)",borderTop:"2px solid #fff",borderRadius:"50%",display:"inline-block"}}/>
                )}
                {checking ? "Checking previous reports..." : sending ? "Submitting..." : "Submit Verified Report"}
              </button>
              <div style={{fontSize:13,color:"#94a3b8",lineHeight:1.55,marginTop:12}}>Reports reviewed within 48 hours. Email used for verification only, never displayed publicly.</div>
            </>
          )}
        </div>
      </section>

      {/* SHARE STRIP: same card the home page uses, so visitors can
          pass the submit-report link to neighbors who should also share
          what they have observed. */}
      <div style={{maxWidth:760,margin:"0 auto",padding:"0 24px 56px"}}>
        <ShareSection/>
      </div>

      {/* FOOTER (shared with the business pages, on a dark backdrop) */}
      <div style={{background:"#0a0f1e"}}>
        <Footer onNavigate={onNavigate} facilities={facs}/>
      </div>
    </div>
  );
};

const PageHero = ({ onNavigate, title, subtitle }) => (
  <section style={{background:"linear-gradient(150deg,#020c1b 0%,#0f172a 45%,#1e0535 100%)",padding:"22px 24px 60px"}}>
    <div style={{maxWidth:1100,margin:"0 auto"}}>
      <div style={{textAlign:"center",maxWidth:760,margin:"0 auto"}}>
        <h1 style={{fontSize:"clamp(32px,5.5vw,50px)",fontWeight:900,letterSpacing:"-.02em",color:"#fff",lineHeight:1.12,marginBottom:16}}>{title}</h1>
        {subtitle && <p style={{fontSize:18,color:"rgba(255,255,255,.72)",lineHeight:1.65}}>{subtitle}</p>}
      </div>
    </div>
  </section>
);

// ─── /contact: CONTACT PAGE ──────────────────────────────────────────────────
const ContactPage = ({ onNavigate }) => {
  const SUBJECTS = ["General Inquiry","Report an Error","Media Inquiry","Business Inquiry","Data Request","Support","Other"];
  const MAX_MSG = 2000;
  const [firstName,setFirstName] = useState("");
  const [lastName,setLastName]   = useState("");
  const [email,setEmail]         = useState("");
  const [subject,setSubject]     = useState("");
  const [message,setMessage]     = useState("");
  const [human,setHuman]         = useState(false);
  const [hp,setHp]               = useState("");
  const [sending,setSending]     = useState(false);
  const [sent,setSent]           = useState(false);
  const [sentName,setSentName]   = useState("");
  const formLoadRef = useRef(Date.now());

  const canSubmit = firstName.trim() && email.trim() && subject && message.trim() && human;

  const submit = async () => {
    if (!canSubmit) return;
    // Honeypot: bots fill the hidden field. Silently accept.
    if (hp) { setSentName(firstName.trim()); setSent(true); return; }
    // 10-second minimum gate.
    if (Date.now() - (formLoadRef.current || 0) < 10000) { setSentName(firstName.trim()); setSent(true); return; }
    setSending(true);
    try {
      const r = await fetch("/api/send-contact", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ firstName:firstName.trim(), lastName:lastName.trim(), email:email.trim(), subject, message }),
      });
      if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error || `Could not send message (${r.status})`); }
      setSentName(firstName.trim());
      setSent(true);
    } catch (e) {
      console.error("send-contact failed:", e);
      window.alert("We could not send your message. Please try again, or email hello@humzones.com directly.");
    } finally {
      setSending(false);
    }
  };

  const lbl = { fontSize:13, fontWeight:700, color:"#374151", display:"block", marginBottom:6 };
  const fld = (filled) => ({ width:"100%", padding:"13px 16px", borderRadius:10, border:`1.5px solid ${filled?"#3b82f6":"#e2e8f0"}`, fontSize:15, boxSizing:"border-box", outline:"none", fontFamily:"inherit", color:"#1e293b" });
  const infoHead = { fontSize:18, fontWeight:800, color:"#0f172a", marginBottom:8 };
  const infoText = { fontSize:15, color:"#475569", lineHeight:1.7, margin:0 };
  const divider = <div style={{borderTop:"1px solid #e2e8f0",margin:"24px 0"}}/>;

  return (
    <div style={{minHeight:"100vh",background:"#f1f5f9",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>
      <PageHero onNavigate={onNavigate} title="Contact Us"
        subtitle="We would love to hear from you. Whether you have a question about our data, a report to discuss, or a media inquiry, we are here to help."/>

      <section style={{background:"#fff",padding:"56px 24px"}}>
        <div className="nums-grid" style={{maxWidth:1080,margin:"0 auto",display:"grid",gridTemplateColumns:"1fr 1fr",gap:48,alignItems:"start"}}>
          {/* LEFT: contact information */}
          <div>
            <h2 style={{fontSize:"clamp(24px,3.5vw,30px)",fontWeight:900,color:"#0f172a",marginBottom:18,letterSpacing:"-.01em"}}>Get In Touch</h2>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
              <span style={{fontSize:22}}>&#9993;</span>
              <a href="mailto:hello@humzones.com" style={{fontSize:17,fontWeight:800,color:"#f97316",textDecoration:"none"}}>hello@humzones.com</a>
            </div>
            <p style={infoText}>We typically respond within 1 to 2 business days.</p>
            {divider}
            <h3 style={infoHead}>For Media Inquiries</h3>
            <p style={infoText}>Journalists and researchers are welcome to contact us for data access, interviews, and press materials. Please include your publication and deadline in your message.</p>
            {divider}
            <h3 style={infoHead}>For Business Inquiries</h3>
            <p style={infoText}>Interested in bulk reports or API access? Visit our Business Plans page or email us directly.</p>
            <button onClick={()=>onNavigate("/business")} style={{marginTop:14,padding:"12px 24px",borderRadius:10,border:"1.5px solid #f97316",background:"transparent",color:"#f97316",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit"}}>View Business Plans</button>
            {divider}
            <h3 style={infoHead}>Report an Error</h3>
            <p style={infoText}>If you believe any facility data is materially incorrect please let us know. We review all correction requests and update our database promptly.</p>
          </div>

          {/* RIGHT: contact form */}
          <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:18,padding:"30px 30px 32px",boxShadow:"0 4px 24px rgba(0,0,0,.07)"}}>
            {sent ? (
              <div style={{textAlign:"center",padding:"12px 4px"}}>
                <div style={{width:64,height:64,borderRadius:"50%",background:"linear-gradient(135deg,#10b981,#059669)",margin:"0 auto 16px",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <Icon name="check" size={30} color="#fff"/>
                </div>
                <h3 style={{fontSize:20,fontWeight:900,color:"#0f172a",marginBottom:10}}>Thank you {sentName}!</h3>
                <p style={{fontSize:15,color:"#475569",lineHeight:1.7,marginBottom:22}}>Your message has been sent. We will get back to you within 1 to 2 business days.</p>
                <button onClick={()=>onNavigate("/")} style={{padding:"14px 28px",borderRadius:12,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:15,fontWeight:900,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>Back to HumZones</button>
              </div>
            ) : (
              <>
                <h2 style={{fontSize:20,fontWeight:900,color:"#0f172a",marginBottom:18}}>Send Us a Message</h2>
                <input type="text" name="website" value={hp} onChange={e=>setHp(e.target.value)} tabIndex="-1" autoComplete="off" aria-hidden="true" style={{display:"none"}}/>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
                  <div><label style={lbl}>First Name *</label><input value={firstName} onChange={e=>setFirstName(e.target.value)} placeholder="Your first name" style={fld(firstName.trim())}/></div>
                  <div><label style={lbl}>Last Name</label><input value={lastName} onChange={e=>setLastName(e.target.value)} placeholder="Optional" style={fld(lastName.trim())}/></div>
                </div>
                <div style={{marginBottom:14}}>
                  <label style={lbl}>Email Address *</label>
                  <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" style={fld(email.trim())}/>
                </div>
                <div style={{marginBottom:14}}>
                  <label style={lbl}>Subject *</label>
                  <select value={subject} onChange={e=>setSubject(e.target.value)} style={{...fld(subject),cursor:"pointer"}}>
                    <option value="">Select a subject</option>
                    {SUBJECTS.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div style={{marginBottom:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <label style={{...lbl,marginBottom:0}}>Message *</label>
                    <span style={{fontSize:12,fontWeight:600,color:message.length>MAX_MSG*0.9?"#ef4444":"#94a3b8"}}>{message.length.toLocaleString()} / {MAX_MSG.toLocaleString()}</span>
                  </div>
                  <textarea value={message} onChange={e=>{if(e.target.value.length<=MAX_MSG)setMessage(e.target.value);}} rows={6}
                    placeholder="How can we help?" style={{...fld(message.trim()),resize:"vertical",lineHeight:1.7}}/>
                </div>
                <div onClick={()=>setHuman(v=>!v)} style={{display:"flex",alignItems:"center",gap:12,padding:"13px 16px",borderRadius:12,border:`2px solid ${human?"#f97316":"#e2e8f0"}`,background:human?"#fff7ed":"#f8fafc",cursor:"pointer",marginBottom:18}}>
                  <div style={{width:22,height:22,borderRadius:5,border:`2px solid ${human?"#f97316":"#94a3b8"}`,background:human?"#f97316":"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    {human && <Icon name="check" size={13} color="#fff"/>}
                  </div>
                  <div style={{fontSize:14,color:"#374151",fontWeight:human?600:400}}>I confirm I am a human and not a bot</div>
                </div>
                <button onClick={submit} disabled={sending||!canSubmit} style={{width:"100%",padding:"15px 24px",borderRadius:12,border:"none",background:canSubmit?"#f97316":"#e2e8f0",color:canSubmit?"#fff":"#94a3b8",fontSize:16,fontWeight:800,cursor:canSubmit?"pointer":"default",fontFamily:"inherit",boxShadow:canSubmit?"0 4px 20px rgba(249,115,22,.4)":"none"}}>
                  {sending?"Sending...":"Send Message"}
                </button>
              </>
            )}
          </div>
        </div>
      </section>

      <Footer onNavigate={onNavigate}/>
    </div>
  );
};

// ─── /about: ABOUT PAGE ──────────────────────────────────────────────────────
const AboutPage = ({ onNavigate, facilityCount }) => {
  const h2 = { fontSize:"clamp(26px,4vw,34px)", fontWeight:900, letterSpacing:"-.02em", marginBottom:18, lineHeight:1.2 };
  const para = (color) => ({ fontSize:16, lineHeight:1.8, color, whiteSpace:"pre-line", margin:0 });
  const btn = { padding:"14px 28px", borderRadius:12, border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:15, fontWeight:900, background:"linear-gradient(135deg,#ef4444,#f97316)", color:"#fff", boxShadow:"0 10px 28px rgba(249,115,22,.4)" };

  // SEO + social meta + AboutPage JSON-LD. Cleaned up on unmount.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = "About HumZones | Global Infrastructure Registry";

    injectHeadEl("meta", "about-desc",      { name: "description",         content: "HumZones tracks data center infrastructure worldwide so residents understand what is being built near their homes. Learn about our mission, methodology and the registry behind the data." });
    injectHeadEl("link", "about-canonical", { rel: "canonical",            href: "https://humzones.com/about" });
    injectHeadEl("meta", "about-og-title",  { property: "og:title",        content: "About HumZones | Data Center Registry" });
    injectHeadEl("meta", "about-og-desc",   { property: "og:description",  content: "HumZones tracks data center infrastructure so residents know what is being built near their homes. Our mission, methodology and data sources." });
    injectHeadEl("meta", "about-og-url",    { property: "og:url",          content: "https://humzones.com/about" });
    injectHeadEl("meta", "about-og-type",   { property: "og:type",         content: "website" });
    injectHeadEl("meta", "about-og-site",   { property: "og:site_name",    content: "HumZones" });
    injectHeadEl("meta", "about-tw-card",   { name: "twitter:card",        content: "summary" });
    injectHeadEl("meta", "about-tw-title",  { name: "twitter:title",       content: "About HumZones" });
    injectHeadEl("meta", "about-tw-desc",   { name: "twitter:description", content: "HumZones tracks data center infrastructure worldwide so residents know what is near their homes." });

    const aboutSchema = {
      "@context":    "https://schema.org",
      "@type":       "AboutPage",
      "name":        "About HumZones",
      "url":         "https://humzones.com/about",
      "description": "HumZones is the global data center health and infrastructure registry, making facility data accessible to residents and professionals worldwide.",
      "publisher":   { "@type": "Organization", "name": "HumZones Technologies Inc.", "url": "https://humzones.com" },
    };
    injectHeadEl("script", "about-jsonld", { type: "application/ld+json" }, JSON.stringify(aboutSchema));

    return () => {
      [
        "about-desc","about-canonical",
        "about-og-title","about-og-desc","about-og-url","about-og-type","about-og-site",
        "about-tw-card","about-tw-title","about-tw-desc",
        "about-jsonld",
      ].forEach(removeHeadEl);
    };
  }, []);
  const cards = [
    { icon:"database",  title:"We Track",   desc:"We maintain a growing database of data center facilities worldwide, compiled from public planning filings, utility records, operator disclosures and environmental assessments." },
    { icon:"search",    title:"We Analyze", desc:"We apply documented modeling formulas to estimate the environmental footprint of each facility including power draw, water consumption, noise levels and EMF exposure ranges." },
    { icon:"community", title:"We Publish", desc:"We make this information freely available to anyone who wants to understand the infrastructure near their home, workplace or investment property." },
  ];

  return (
    <div style={{minHeight:"100vh",background:"#f1f5f9",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>
      <PageHero onNavigate={onNavigate} title="About HumZones"
        subtitle="We believe every person has the right to know what infrastructure exists near their home and what it means for their community."/>

      {/* SECTION 1: Our Mission */}
      <section style={{background:"#fff",padding:"60px 24px"}}>
        <div style={{maxWidth:820,margin:"0 auto"}}>
          <h2 style={{...h2,color:"#0f172a"}}>Our Mission</h2>
          <p style={para("#475569")}>{"HumZones is the Global Data Center Health & Infrastructure Registry. We compile, organize and publish publicly available information about data center infrastructure worldwide so that residents, researchers, real estate professionals and community advocates have access to the same information that corporations and governments already have.\n\nData centers are the backbone of the modern internet. They power artificial intelligence, cloud computing, streaming services and global communications. They are also large industrial facilities that consume enormous amounts of power and water, generate continuous noise and electromagnetic fields, and are being built at an unprecedented rate in communities around the world.\n\nMost people have no idea what is near their home. We are changing that."}</p>
        </div>
      </section>

      {/* SECTION 2: What We Do */}
      <section style={{background:"#f1f5f9",padding:"60px 24px"}}>
        <div style={{maxWidth:1080,margin:"0 auto"}}>
          <h2 style={{...h2,color:"#0f172a",textAlign:"center",marginBottom:36}}>What We Do</h2>
          <div className="nums-grid" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:20}}>
            {cards.map(c=>(
              <div key={c.title} style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:16,padding:"28px 26px",boxShadow:"0 2px 12px rgba(0,0,0,.05)"}}>
                <div style={{marginBottom:14,lineHeight:1}}><Icon name={c.icon} size={36} color="#f97316"/></div>
                <div style={{fontSize:19,fontWeight:800,color:"#0f172a",marginBottom:10}}>{c.title}</div>
                <p style={{fontSize:15,color:"#475569",lineHeight:1.7,margin:0}}>{c.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* SECTION 3: Our Data */}
      <section style={{background:"#0f172a",padding:"60px 24px"}}>
        <div style={{maxWidth:820,margin:"0 auto"}}>
          <h2 style={{...h2,color:"#fff"}}>Our Data</h2>
          <p style={{...para("rgba(255,255,255,.78)"),marginBottom:14}}>HumZones currently tracks {facilityCountLabel(facilityCount)} facilities across the United States and internationally, with new facilities added regularly. Our database is compiled from:</p>
          <ul style={{margin:"0 0 14px 0",padding:"0 0 0 22px",color:"rgba(255,255,255,.78)",fontSize:16,lineHeight:1.9}}>
            <li>Municipal planning and zoning filings</li>
            <li>Utility interconnection applications</li>
            <li>Operator press releases and sustainability reports</li>
            <li>Environmental assessment documents</li>
            <li>Permitting databases and public records</li>
          </ul>
          <p style={para("rgba(255,255,255,.78)")}>All figures in our database are modeled estimates based on publicly available information. They are not certified measurements. We are transparent about our methodology and encourage scrutiny. Visit our methodology page for full details.</p>
          <button onClick={()=>onNavigate("/methodology")} style={{...btn,marginTop:24}}>Read Our Methodology</button>
        </div>
      </section>

      {/* SECTION 4: Community */}
      <section style={{background:"#fff",padding:"60px 24px"}}>
        <div style={{maxWidth:820,margin:"0 auto"}}>
          <h2 style={{...h2,color:"#0f172a"}}>Built With the Community</h2>
          <p style={para("#475569")}>HumZones is more than a database. It is a platform for community voices. Residents living near data centers can submit verified reports of their experiences, which are reviewed and published to help others understand what life is really like near these facilities. Every verified report strengthens our registry and contributes to a growing body of community-sourced evidence that complements our infrastructure data.</p>
          <button onClick={()=>onNavigate("/submit-report")} style={{...btn,marginTop:24}}>Submit Your Resident Report</button>
        </div>
      </section>

      {/* SECTION 5: Contact */}
      <section style={{background:"#0f172a",padding:"60px 24px",textAlign:"center"}}>
        <div style={{maxWidth:720,margin:"0 auto"}}>
          <h2 style={{...h2,color:"#fff"}}>Get In Touch</h2>
          <p style={{...para("rgba(255,255,255,.78)"),marginBottom:26}}>For general inquiries, media requests, data corrections or business questions contact us at hello@humzones.com or visit our contact page.</p>
          <div style={{display:"flex",gap:14,justifyContent:"center",flexWrap:"wrap"}}>
            <button onClick={()=>onNavigate("/contact")} style={btn}>Contact Us</button>
            <button onClick={()=>onNavigate("/business")} style={{padding:"14px 28px",borderRadius:12,border:"1.5px solid rgba(255,255,255,.3)",cursor:"pointer",fontFamily:"inherit",fontSize:15,fontWeight:900,background:"rgba(255,255,255,.06)",color:"#fff"}}>For Business</button>
          </div>
        </div>
      </section>

      <Footer onNavigate={onNavigate}/>
    </div>
  );
};

// ─── /why-it-matters: LEGITIMACY / WHY THIS MATTERS PAGE ─────────────────────
// Calm, factual, authoritative explainer of why data center infrastructure
// transparency matters. No fear-mongering, no advocacy. Six content blocks
// covering power, water, grid, land, transparency and planning windows, plus
// an FAQ accordion. Mirrors the visual language of /learn and /glossary.

const WHY_FAQ = [
  { q: "Does HumZones take a position on data center development?",
    a: "No. HumZones does not advocate for or against data center development. We believe communities deserve access to the same infrastructure information that developers and utilities already have. What communities do with that information is entirely their decision. Our role is to make the information accessible, not to tell people what to think about it." },
  { q: "Are the figures on this page certified measurements?",
    a: "No. The statistics and estimates referenced on this page are derived from publicly available sources including utility filings, grid operator reports, academic research and industry publications. Individual facility figures in the HumZones registry are modeled estimates, not certified measurements. We cite sources so you can verify everything we say." },
  { q: "How fast is the data center industry growing?",
    a: "Growth varies by region and by metric but the overall trajectory is consistent across every measure of data center activity. Power requests in utility interconnection queues, facility announcements, land purchases and construction permits all show significant and accelerating growth in data center infrastructure across the United States and globally." },
  { q: "What can residents do if they are concerned about a facility near them?",
    a: "The most effective action depends on where the facility is in its development process. For proposed or pending facilities, engagement with the local planning process is most effective. For operating facilities, documentation and ongoing monitoring matter most. Our resident guides at humzones.com/learn cover both in detail." },
  { q: "Is this information available without using HumZones?",
    a: "Yes. All of the underlying information that HumZones compiles is publicly available from government agencies, grid operators and planning departments. HumZones aggregates, translates and makes that information searchable in one place. If you prefer to access it directly, our guides at humzones.com/learn explain exactly where to look and how to read what you find." },
  { q: "Why does HumZones focus specifically on data centers?",
    a: "Data centers represent one of the fastest growing and least publicly understood categories of infrastructure development near residential areas. Other forms of industrial development have established public awareness and regulatory frameworks. Data center development has outpaced both. We focus here because the gap between developer knowledge and community knowledge is widest in this sector." },
];

const WHY_SECTIONS = [
  {
    id: "growth",
    iconName: "power",
    iconColor: "#f97316",
    iconBg: "rgba(249,115,22,.12)",
    heading: "The Fastest Growing Power Consumer in America",
    body: [
      "Data centers have become the fastest growing category of electricity consumption in the United States. What began as a back-office technology need has transformed into one of the most power-intensive industries on earth, driven by the explosive growth of artificial intelligence, cloud computing and streaming services.",
      "Virginia offers the clearest picture of what this growth looks like at scale. The state is home to more data center capacity than any other region in the world. Data centers there now consume more than 20 percent of all electricity generated in the state. The regional grid operator currently has tens of gigawatts of data center power requests waiting in its interconnection queue, with more arriving every month.",
      "This growth is not slowing. It is accelerating. Understanding where that growth is headed and what it means for your community is not a matter of fear. It is a matter of informed planning.",
    ],
    stat: {
      bg: "#0f172a",
      borderColor: "#f97316",
      headingColor: "#f97316",
      textColor: "#fff",
      label: "AT SCALE",
      text: "20%+ of Virginia's total electricity generation is consumed by data centers, a figure that continues to grow as new facilities come online.",
    },
  },
  {
    id: "water",
    iconName: "water",
    iconColor: "#2563eb",
    iconBg: "rgba(37,99,235,.12)",
    heading: "The Water Nobody Talks About",
    body: [
      "The electricity demand of data centers gets significant attention. The water demand gets almost none.",
      "Data centers that use evaporative cooling, one of the most common and energy-efficient cooling methods, remove heat by evaporating large quantities of water into the atmosphere. Unlike water that is returned to a river or aquifer after use, evaporated water is effectively removed from the local water cycle.",
      "A single large data center campus using evaporative cooling can consume several million gallons of water per day. In a region with multiple large campuses this adds up to a significant ongoing draw on municipal water supplies, particularly during summer months when cooling demands are highest and water supplies are often most stressed.",
      "This is not a theoretical concern. Utilities in Virginia and other high-density data center regions have begun factoring data center water demand into their long-term infrastructure planning.",
    ],
    stat: {
      bg: "#dbeafe",
      borderColor: "#2563eb",
      headingColor: "#1d4ed8",
      textColor: "#0f172a",
      label: "DAILY DRAW",
      text: "A large evaporative cooling data center can consume the equivalent daily water use of tens of thousands of households, continuously, every day of the year.",
    },
  },
  {
    id: "grid",
    iconName: "satellite",
    iconColor: "#f97316",
    iconBg: "rgba(249,115,22,.12)",
    heading: "What Happens to Your Power Grid",
    body: [
      "When a data center connects to the regional power grid, it joins as a new permanent load, a constant, large draw on shared infrastructure that all electricity customers in the region depend on.",
      "The interconnection queue, the official waiting list for large new power connections, has become one of the most closely watched indicators of where data center development is headed. Grid operators that once processed a handful of large load requests per year are now receiving hundreds. The queue in the Mid-Atlantic region alone contains enough pending requests to more than double regional power demand if all of them were built.",
      "Most will not be built. But the scale of speculation in the queue creates real challenges for grid operators, utilities and ultimately ratepayers. Utilities must plan and build transmission infrastructure for loads that may never materialize, and those costs flow through to electricity bills for every customer on the system.",
      "The interconnection queue is a public document. It is one of the earliest available signals that large new infrastructure is being planned near your community.",
    ],
    stat: {
      bg: "#0f172a",
      borderColor: "#f97316",
      headingColor: "#f97316",
      textColor: "#fff",
      label: "EARLY SIGNAL",
      text: "Interconnection requests often appear 12 to 36 months before construction begins, making them the earliest public warning signal available to communities.",
    },
  },
  {
    id: "land",
    iconName: "pin",
    iconColor: "#16a34a",
    iconBg: "rgba(22,163,74,.12)",
    heading: "Land That Does Not Come Back",
    body: [
      "A modern data center campus requires significant land. A single building might occupy 10 to 20 acres. A multi-building campus can cover 50 to 200 acres or more. Once that land is developed for industrial data center use, the economic and practical barriers to converting it back to other uses are extremely high.",
      "Data center development tends to cluster, and it tends to expand. What begins as a single facility on the edge of a community often becomes a campus, then a corridor. The communities that hosted the first wave of data center construction in Northern Virginia in the early 2000s now host dozens of facilities on thousands of acres of land that was previously agricultural or undeveloped.",
      "Land use decisions are made through local planning processes. Zoning changes, special use permits and site plan approvals all happen at the local government level and all have public comment periods. These are the points in the process where community voices can be heard, but only if residents know the process is happening.",
    ],
    stat: {
      bg: "#dcfce7",
      borderColor: "#16a34a",
      headingColor: "#15803d",
      textColor: "#0f172a",
      label: "FOOTPRINT",
      text: "A multi-building data center campus can occupy 50 to 200 or more acres of land permanently converted to industrial use.",
    },
  },
  {
    id: "transparency",
    iconName: "search",
    iconColor: "#f97316",
    iconBg: "rgba(249,115,22,.12)",
    heading: "The Information Asymmetry",
    body: [
      "Every significant data center project generates a trail of public documents before a single piece of equipment is installed. Interconnection applications filed with grid operators. Permit applications filed with local planning departments. Environmental assessments submitted to state agencies. Utility filings describing the infrastructure needed to serve the new load.",
      "These documents are public. But they are written in technical language, distributed across multiple agencies and jurisdictions, and require specialized knowledge to interpret. A resident who wants to understand what is being planned near their home would need to know which agencies to contact, what documents to request, and how to read utility filings that were written for engineers and regulators, not neighbors.",
      "Data center developers have teams of people who do exactly this work. Residents have nothing equivalent. That is the information asymmetry that HumZones exists to address. We track the public documents, translate the technical language and make the information accessible to anyone.",
    ],
    stat: {
      bg: "#fff7ed",
      borderColor: "#f97316",
      headingColor: "#c2410c",
      textColor: "#0f172a",
      label: "WHAT THIS MEANS",
      text: "The same public documents that developers monitor daily are available to any resident. They are just written in a language that assumes you already know what you are looking at.",
    },
  },
  {
    id: "window",
    iconName: "shield",
    iconColor: "#1e293b",
    iconBg: "rgba(30,41,59,.1)",
    heading: "The Window That Closes",
    body: [
      "Community engagement in infrastructure decisions is most effective before those decisions are made. This sounds obvious but has a specific and important meaning when it comes to data center development.",
      "Once a facility receives its local planning approvals, the practical options for community influence narrow dramatically. Legal challenges to approved projects are expensive, time-consuming and uncertain. Advocacy after approval is largely focused on mitigation, noise barriers, landscaping, operating restrictions, rather than the fundamental question of whether the project should exist.",
      "The window for meaningful community engagement is the period between when a project is first proposed and when it receives final approval. For data center projects this window typically spans 12 to 36 months. Within that window, communities have real influence. They can attend public hearings, submit comments that become part of the official record, engage with elected officials and advocate for specific conditions and protections.",
      "After that window closes, the facility gets built regardless of how residents feel about it.",
      "Knowing what is being planned, and knowing it early, is the prerequisite for effective community participation.",
    ],
    stat: {
      bg: "#f1f5f9",
      borderColor: "#1e293b",
      headingColor: "#0f172a",
      textColor: "#0f172a",
      label: "TIMING",
      text: "The window for meaningful community engagement on a data center project typically spans 12 to 36 months. After final approval, that window closes.",
    },
  },
];

const WhyItMattersPage = ({ onNavigate }) => {
  const [openFaq, setOpenFaq] = useState({});

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = "Why Data Center Transparency Matters | HumZones";

    injectHeadEl("meta", "why-desc",      { name: "description",         content: "Data centers are the fastest growing category of power consumption in America. Here is what that means for water supplies, power grids, land use and the communities that host them." });
    injectHeadEl("link", "why-canonical", { rel: "canonical",            href: "https://humzones.com/why-it-matters" });
    injectHeadEl("meta", "why-og-title",  { property: "og:title",        content: "Why Data Center Transparency Matters | HumZones" });
    injectHeadEl("meta", "why-og-desc",   { property: "og:description",  content: "Infrastructure is growing faster than public awareness. Here is what data center expansion means for power grids, water supplies, land use and the communities that host them." });
    injectHeadEl("meta", "why-og-url",    { property: "og:url",          content: "https://humzones.com/why-it-matters" });
    injectHeadEl("meta", "why-og-type",   { property: "og:type",         content: "website" });
    injectHeadEl("meta", "why-og-site",   { property: "og:site_name",    content: "HumZones" });
    injectHeadEl("meta", "why-tw-card",   { name: "twitter:card",        content: "summary" });
    injectHeadEl("meta", "why-tw-title",  { name: "twitter:title",       content: "Why Data Center Transparency Matters | HumZones" });
    injectHeadEl("meta", "why-tw-desc",   { name: "twitter:description", content: "What data center expansion means for power grids, water supplies, land use and communities." });

    const schema = [
      {
        "@context":    "https://schema.org",
        "@type":       "WebPage",
        "name":        "Why Data Center Transparency Matters",
        "url":         "https://humzones.com/why-it-matters",
        "description": "An evidence-based overview of data center infrastructure growth and its implications for power grids, water supplies, land use and community planning awareness.",
        "publisher":   { "@type": "Organization", "name": "HumZones Technologies Inc.", "url": "https://humzones.com" },
        "isPartOf":    { "@type": "WebSite",      "name": "HumZones",                   "url": "https://humzones.com" },
      },
      {
        "@context":   "https://schema.org",
        "@type":      "FAQPage",
        "mainEntity": [
          { "@type": "Question", "name": "How fast is data center power consumption growing?",
            "acceptedAnswer": { "@type": "Answer", "text": "Data centers are the fastest growing category of electricity consumption in the United States. Virginia alone now has data centers consuming over 20 percent of the state total electricity generation, with demand projected to grow significantly over the coming decade." } },
          { "@type": "Question", "name": "How much water do data centers use?",
            "acceptedAnswer": { "@type": "Answer", "text": "A single large data center using evaporative cooling can consume several million gallons of water per day. This water is primarily removed from the local water cycle through evaporation, which can stress municipal water supplies particularly in drought prone regions." } },
          { "@type": "Question", "name": "Why do residents have less information than developers?",
            "acceptedAnswer": { "@type": "Answer", "text": "Data center developers employ teams of engineers and lawyers to monitor interconnection queues, utility filings and planning applications. Residents have no equivalent resource. The information is publicly available but technical, scattered across multiple agencies and difficult to interpret without specialized knowledge." } },
          { "@type": "Question", "name": "Does HumZones take a position on data center development?",
            "acceptedAnswer": { "@type": "Answer", "text": "No. HumZones does not advocate for or against data center development. We believe residents deserve access to the same infrastructure information that developers and utilities already have. What communities do with that information is their decision." } },
          { "@type": "Question", "name": "What is an interconnection queue and why does it matter?",
            "acceptedAnswer": { "@type": "Answer", "text": "An interconnection queue is the official waiting list a company must join before connecting a large new electrical load to the power grid. These are public documents and represent the earliest available signal that a large facility is being planned near a community, often 12 to 36 months before construction begins." } },
          { "@type": "Question", "name": "What can residents do about data center development near them?",
            "acceptedAnswer": { "@type": "Answer", "text": "The most effective action is early engagement with the local planning process before approvals are granted. Attending public hearings, submitting written comments and organizing neighbors creates a documented record that officials must respond to. The window for meaningful engagement closes once a project receives approval." } },
        ],
      },
    ];
    injectHeadEl("script", "why-jsonld", { type: "application/ld+json" }, JSON.stringify(schema));

    return () => {
      [
        "why-desc","why-canonical",
        "why-og-title","why-og-desc","why-og-url","why-og-type","why-og-site",
        "why-tw-card","why-tw-title","why-tw-desc",
        "why-jsonld",
      ].forEach(removeHeadEl);
    };
  }, []);

  return (
    <div style={{minHeight:"100vh",background:"#f1f5f9",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>
      {/* HERO */}
      <section style={{background:"#1e293b",padding:"64px 24px 72px"}}>
        <div style={{maxWidth:820,margin:"0 auto",textAlign:"center"}}>
          <div style={{display:"inline-block",fontSize:12,color:"#f97316",letterSpacing:".18em",textTransform:"uppercase",fontWeight:800,marginBottom:16,padding:"6px 14px",borderRadius:30,background:"rgba(249,115,22,.12)",border:"1px solid rgba(249,115,22,.3)"}}>Why This Matters</div>
          <h1 style={{fontSize:"clamp(28px,4.4vw,40px)",fontWeight:900,letterSpacing:"-.02em",color:"#fff",lineHeight:1.15,marginBottom:18}}>
            Why This Matters
          </h1>
          <div style={{width:60,height:4,background:"#f97316",borderRadius:2,margin:"0 auto 22px"}}/>
          <p style={{fontSize:16,color:"rgba(255,255,255,.72)",lineHeight:1.7,maxWidth:680,margin:"0 auto"}}>
            Data center infrastructure is growing faster than public awareness. This page explains what that means for the communities that host it, in plain language, without agenda.
          </p>
        </div>
      </section>

      {/* INTRO */}
      <section style={{background:"#f1f5f9",padding:"40px 24px"}}>
        <div style={{maxWidth:820,margin:"0 auto"}}>
          <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,padding:"30px 30px 26px",boxShadow:"0 2px 12px rgba(0,0,0,.04)"}}>
            <p style={{fontSize:16,color:"#334155",lineHeight:1.75,margin:0}}>
              We built HumZones because a gap exists between the information that data center developers have and the information that communities have. Developers employ teams of engineers and lawyers who monitor interconnection queues, utility filings and planning applications as part of their daily work. Residents have none of that. The information is publicly available but scattered, technical and difficult to interpret without specialized knowledge. HumZones bridges that gap. This page explains why bridging it matters.
            </p>
            <p style={{fontSize:14,color:"#64748b",fontStyle:"italic",lineHeight:1.65,margin:"18px 0 0",paddingTop:18,borderTop:"1px solid #e2e8f0"}}>
              HumZones does not advocate for or against data center development. We believe communities deserve access to the same information that developers already have.
            </p>
          </div>
        </div>
      </section>

      {/* SIX CONTENT SECTIONS */}
      {WHY_SECTIONS.map((sec, i) => {
        const altBg = i % 2 === 0 ? "#fff" : "#f8fafc";
        return (
          <section key={sec.id} id={sec.id} style={{background:altBg,padding:"56px 24px",borderTop:"1px solid #e2e8f0"}}>
            <div style={{maxWidth:820,margin:"0 auto"}}>
              <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:16}}>
                <div style={{width:56,height:56,borderRadius:14,background:sec.iconBg,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                  <Icon name={sec.iconName} size={28} color={sec.iconColor}/>
                </div>
                <div style={{fontSize:11,color:"#94a3b8",letterSpacing:".18em",textTransform:"uppercase",fontWeight:800}}>Section {i + 1} of {WHY_SECTIONS.length}</div>
              </div>
              <h2 style={{fontSize:"clamp(20px,3vw,24px)",fontWeight:900,color:"#0f172a",letterSpacing:"-.01em",lineHeight:1.25,margin:"0 0 10px"}}>{sec.heading}</h2>
              <div style={{width:52,height:3,background:"#f97316",borderRadius:2,marginBottom:22}}/>
              {sec.body.map((para, idx) => (
                <p key={idx} style={{fontSize:16,color:"#475569",lineHeight:1.75,margin:idx === sec.body.length - 1 ? "0 0 24px" : "0 0 16px"}}>{para}</p>
              ))}
              <div style={{background:sec.stat.bg,border:`1px solid ${sec.stat.borderColor}`,borderLeft:`4px solid ${sec.stat.borderColor}`,borderRadius:12,padding:"20px 22px"}}>
                <div style={{fontSize:11,color:sec.stat.headingColor,letterSpacing:".18em",textTransform:"uppercase",fontWeight:800,marginBottom:8}}>{sec.stat.label}</div>
                <p style={{fontSize:15,color:sec.stat.textColor,lineHeight:1.7,margin:0,fontWeight:600}}>{sec.stat.text}</p>
              </div>
            </div>
          </section>
        );
      })}

      {/* FAQ */}
      <section style={{background:"#fff",padding:"60px 24px",borderTop:"1px solid #e2e8f0"}}>
        <div style={{maxWidth:820,margin:"0 auto"}}>
          <h2 style={{fontSize:20,fontWeight:800,color:"#0f172a",letterSpacing:"-.01em",margin:"0 0 6px"}}>Common Questions</h2>
          <div style={{width:48,height:3,background:"#f97316",borderRadius:2,marginBottom:22}}/>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {WHY_FAQ.map((f, i) => {
              const key = "why::" + i;
              const isOpen = !!openFaq[key];
              return (
                <div key={key} style={{border:"1px solid #e2e8f0",borderRadius:10,background:isOpen?"#f8fafc":"#fff",overflow:"hidden"}}>
                  <button
                    onClick={()=>setOpenFaq(p=>({...p,[key]:!p[key]}))}
                    aria-expanded={isOpen}
                    style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,padding:"14px 16px",background:"transparent",border:"none",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}
                  >
                    <span style={{fontSize:15,fontWeight:800,color:"#0f172a",lineHeight:1.4}}>{f.q}</span>
                    <span aria-hidden="true" style={{fontSize:18,fontWeight:900,color:"#f97316",flexShrink:0,lineHeight:1}}>{isOpen ? "−" : "+"}</span>
                  </button>
                  {isOpen && (
                    <div style={{padding:"0 16px 14px"}}>
                      <p style={{fontSize:14,color:"#475569",lineHeight:1.7,margin:0}}>{f.a}</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section style={{background:"#0f172a",padding:"60px 24px"}}>
        <div style={{maxWidth:820,margin:"0 auto",textAlign:"center"}}>
          <h2 style={{fontSize:24,fontWeight:900,color:"#fff",letterSpacing:"-.01em",margin:"0 0 12px",lineHeight:1.25}}>Start With What Is Near You</h2>
          <p style={{fontSize:14,color:"rgba(255,255,255,.7)",lineHeight:1.7,margin:"0 0 26px",maxWidth:560,marginLeft:"auto",marginRight:"auto"}}>
            Search your address to see what data center infrastructure exists within your chosen radius. Free to search.
          </p>
          <div style={{display:"flex",gap:14,justifyContent:"center",flexWrap:"wrap"}}>
            <button
              onClick={()=>onNavigate("/get-report")}
              style={{padding:"14px 28px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:15,fontWeight:900,background:"#f97316",color:"#fff",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}
            >Search My Address</button>
            <button
              onClick={()=>onNavigate("/learn")}
              style={{padding:"14px 28px",borderRadius:12,border:"1.5px solid #f97316",cursor:"pointer",fontFamily:"inherit",fontSize:15,fontWeight:900,background:"transparent",color:"#f97316"}}
            >Read Our Resident Guides</button>
          </div>
        </div>
      </section>

      <Footer onNavigate={onNavigate}/>
    </div>
  );
};

// ─── /faq: FREQUENTLY ASKED QUESTIONS ────────────────────────────────────────
// Built as a function so the database-size answer reflects the live count.
const buildFaqData = (facilityCountLabelText) => [
  { section:"About HumZones", items:[
    { q:"What is HumZones?", a:"HumZones is the Global Data Center Health & Infrastructure Registry. We compile publicly available information about data center facilities worldwide and make it accessible to residents, researchers, real estate professionals and community advocates." },
    { q:"Who is behind HumZones?", a:"HumZones is operated by HumZones Technologies Inc. We are a technology company focused on infrastructure transparency and community awareness." },
    { q:"Is HumZones free to use?", a:"Yes. The basic search and facility information is completely free. We also offer personalized area reports for $14.99 and business subscription plans for professionals who need bulk report access." },
  ]},
  { section:"Our Data", items:[
    { q:"Where does your data come from?", a:"Our facility data is compiled from publicly available sources including municipal planning filings, utility interconnection applications, operator press releases, sustainability reports, environmental assessment documents and permitting databases." },
    { q:"Are your figures accurate?", a:"All figures including power draw, noise levels, EMF exposure ranges, CO2 estimates and water consumption are modeled estimates derived from publicly available information using documented industry standard formulas. They are not certified field measurements. We are transparent about this on every page and in every report. See our methodology page for full details." },
    { q:"How often is the database updated?", a:`We add new facilities regularly as we process public records and submissions. The database currently tracks ${facilityCountLabelText} facilities and grows continuously.` },
    { q:"Can I submit a correction?", a:"Yes. If you believe any data is materially incorrect please contact us at hello@humzones.com or use our contact form. We review all correction requests promptly." },
  ]},
  { section:"Reports", items:[
    { q:"What is included in a HumZones Area Report?", a:"Your personalized report includes a complete list of all data center facilities within 100km of your address, distance from your location to each facility, infrastructure impact category, reported power draw, estimated noise levels, modeled EMF exposure ranges, estimated CO2 and water impact, infrastructure and community impact considerations, and practical awareness steps." },
    { q:"Can I retrieve my report after downloading it?", a:"Yes. Every report you purchase is saved to your account. Visit humzones.com/my-report and enter your purchase email address to retrieve any past report at any time." },
    { q:"Do you offer refunds?", a:"Reports are delivered instantly as digital downloads. Due to the nature of digital products all sales are final. If you experience a technical issue please contact hello@humzones.com and we will do our best to assist." },
    { q:"What is the Business Plan?", a:"Our business plans offer bulk report credits for professionals who need to generate multiple reports. Plans start at $99 per month for 10 reports. Visit humzones.com/business for full details." },
  ]},
  { section:"Community Reports", items:[
    { q:"How do I submit a resident report?", a:"Visit humzones.com/submit-report to find facilities near you and submit your experience. Your report will be verified by email and reviewed by our team before publication." },
    { q:"Will my personal information be shared?", a:"Only your first name is displayed with published reports. Your last name and email address are never shown publicly. See our privacy policy for full details." },
    { q:"How long does review take?", a:"We aim to review all submitted reports within 48 hours." },
  ]},
  { section:"Privacy and Security", items:[
    { q:"What data do you collect?", a:"We collect email addresses when you unlock search results, purchase a report or create a business account. We also collect location data when you use the Find Data Centers Near Me feature. See our privacy policy for full details." },
    { q:"Do you sell my data?", a:"No. We do not sell personal data to any third party under any circumstances." },
    { q:"How do I unsubscribe from emails?", a:"Every email we send includes an unsubscribe link at the bottom. You can also visit humzones.com/unsubscribe to opt out." },
  ]},
];

const FaqPage = ({ onNavigate, facilityCount }) => {
  const [open, setOpen] = useState({});
  const toggle = (key) => setOpen(prev => ({ ...prev, [key]: !prev[key] }));
  const faqData = buildFaqData(facilityCountLabel(facilityCount));

  return (
    <div style={{minHeight:"100vh",background:"#f1f5f9",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>
      <PageHero onNavigate={onNavigate} title="Frequently Asked Questions"
        subtitle="Everything you need to know about HumZones, our data and our reports."/>

      <section style={{background:"#fff",padding:"54px 24px"}}>
        <div style={{maxWidth:820,margin:"0 auto"}}>
          {faqData.map((sec,si)=>(
            <div key={sec.section} style={{marginBottom:34}}>
              <h2 style={{fontSize:20,fontWeight:900,color:"#0f172a",letterSpacing:"-.01em",marginBottom:14}}>{sec.section}</h2>
              <div style={{border:"1px solid #e2e8f0",borderRadius:14,overflow:"hidden"}}>
                {sec.items.map((it,qi)=>{
                  const key = `${si}-${qi}`;
                  const isOpen = !!open[key];
                  return (
                    <div key={key} style={{borderBottom:qi<sec.items.length-1?"1px solid #e2e8f0":"none"}}>
                      <button onClick={()=>toggle(key)} className="hz-faq-q" aria-expanded={isOpen}
                        style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,padding:"18px 20px",background:"#fff",border:"none",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
                        <span style={{fontSize:16,fontWeight:800,color:"#0f172a",lineHeight:1.4}}>{it.q}</span>
                        <span aria-hidden="true" style={{fontSize:24,fontWeight:900,color:"#f97316",lineHeight:1,flexShrink:0,width:22,textAlign:"center"}}>{isOpen?"−":"+"}</span>
                      </button>
                      <div style={{maxHeight:isOpen?600:0,overflow:"hidden",transition:"max-height .3s ease"}}>
                        <p style={{fontSize:15,color:"#64748b",lineHeight:1.8,margin:0,padding:"0 20px 20px"}}>{renderFaqAnswer(it.a, onNavigate)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <div style={{textAlign:"center",marginTop:10}}>
            <p style={{fontSize:15,color:"#64748b",marginBottom:14}}>Still have a question?</p>
            <button onClick={()=>onNavigate("/contact")} style={{padding:"14px 30px",borderRadius:12,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:15,fontWeight:900,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>Contact Us</button>
          </div>
        </div>
      </section>

      <Footer onNavigate={onNavigate}/>
    </div>
  );
};

// ─── /terms: TERMS OF SERVICE ────────────────────────────────────────────────
const TERMS_SECTIONS = [
  { h:"Acceptance of Terms", b:"By accessing or using humzones.com you agree to be bound by these Terms of Service and our Privacy Policy. If you do not agree to these terms please do not use our service. HumZones Technologies Inc. reserves the right to update these terms at any time. Continued use of the service after changes constitutes acceptance of the updated terms." },
  { h:"Description of Service", b:"HumZones provides an online platform for accessing publicly compiled information about data center infrastructure. We offer free facility search, personalized area reports for purchase, business subscription plans, and a community report submission system." },
  { h:"Informational Purpose Only", b:"All information provided by HumZones including facility data, modeled estimates, impact categories, and report content is for informational and public awareness purposes only. Nothing on this site constitutes medical, legal, scientific, environmental or financial advice. HumZones Technologies Inc. makes no warranties about the accuracy, completeness or fitness for any particular purpose of the information provided." },
  { h:"Purchased Reports", b:"Reports purchased through HumZones are digital products delivered instantly upon payment. All sales are final. No refunds will be issued for digital downloads. By purchasing a report you acknowledge that the content is based on modeled estimates compiled from public sources and does not represent certified measurements or professional assessments of any kind." },
  { h:"Business Subscriptions", b:"Business subscription plans are billed monthly or annually as selected. Monthly plans may be cancelled at any time and will not renew after the current billing period. Annual plans are billed for the full year and are non-refundable. Credits reset at the start of each billing period and unused credits do not roll over." },
  { h:"User Conduct", b:"You agree not to use HumZones to:\n- Submit false or misleading community reports\n- Attempt to access other users accounts or data\n- Use automated tools to scrape or extract data without permission\n- Use the service for any unlawful purpose\n- Attempt to interfere with the operation of the service" },
  { h:"Community Reports", b:"By submitting a community report you declare that the information is truthful to the best of your knowledge. You grant HumZones Technologies Inc. a non-exclusive license to publish your report (with first name only) on the platform. HumZones reserves the right to decline to publish any report that violates our guidelines or these terms." },
  { h:"Intellectual Property", b:"All content on humzones.com including the database, reports, design and code is the property of HumZones Technologies Inc. You may not reproduce, distribute or create derivative works without written permission." },
  { h:"Limitation of Liability", b:"HumZones Technologies Inc. shall not be liable for any direct, indirect, incidental, consequential or punitive damages arising from your use of or reliance on information provided through this service. Our total liability to you for any claim shall not exceed the amount you paid for the specific service giving rise to the claim." },
  { h:"Governing Law", b:"These terms are governed by the laws of Canada. Any disputes shall be resolved in the courts of Canada." },
  { h:"Contact", b:"For questions about these terms contact hello@humzones.com" },
];

const TermsPage = ({ onNavigate }) => (
  <div style={{minHeight:"100vh",background:"#f1f5f9",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>
    <PageHero onNavigate={onNavigate} title="Terms of Service" subtitle="Last updated: May 2026"/>

    <section style={{background:"#fff",padding:"54px 24px"}}>
      <div style={{maxWidth:820,margin:"0 auto"}}>
        {TERMS_SECTIONS.map((s,i)=>(
          <section key={s.h} style={{marginBottom:30}}>
            <div style={{display:"flex",alignItems:"baseline",gap:12,marginBottom:10}}>
              <div style={{fontSize:13,fontWeight:900,color:"#ef4444",letterSpacing:".06em",minWidth:26}}>{String(i+1).padStart(2,"0")}</div>
              <h2 style={{fontSize:15,color:"#0f172a",letterSpacing:".10em",textTransform:"uppercase",fontWeight:800,margin:0,lineHeight:1.4}}>{s.h}</h2>
            </div>
            <p style={{fontSize:16,color:"#475569",lineHeight:1.8,marginLeft:38,whiteSpace:"pre-line"}}>{s.b}</p>
          </section>
        ))}
        <div style={{borderTop:"1px solid #e2e8f0",marginTop:36,paddingTop:24,textAlign:"center"}}>
          <p style={{fontSize:14,color:"#475569",lineHeight:1.7,marginBottom:18}}>
            See also our full <a href="/disclaimer" onClick={e=>{e.preventDefault();onNavigate("/disclaimer");}} style={{color:"#f97316",fontWeight:700,textDecoration:"none"}}>Legal Disclaimer</a> at humzones.com/disclaimer
          </p>
          <button onClick={()=>onNavigate("/")} style={{padding:"14px 28px",borderRadius:12,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:15,fontWeight:900,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>Back to HumZones</button>
        </div>
      </div>
    </section>

    <Footer onNavigate={onNavigate}/>
  </div>
);

// ─── /disclaimer: LEGAL DISCLAIMER ───────────────────────────────────────────
const DISCLAIMER_SECTIONS = [
  { h:"Informational Purpose Only", b:"All information published on humzones.com including facility data, modeled estimates, infrastructure impact categories and report content is provided for general informational and public awareness purposes only. Nothing on this platform constitutes medical, legal, scientific, environmental, financial or real estate advice. You should consult appropriately qualified professionals before making any decision that relies on information obtained from this platform." },
  { h:"No Certified Measurements", b:"None of the figures published on humzones.com represent certified field measurements. All power draw, noise level, water consumption, CO2 and electromagnetic field figures are modeled estimates derived from publicly available information using documented formulas. Actual values may vary significantly by facility design, operating conditions and season.\n\nThe electromagnetic field exposure ranges published on this platform are modeled estimates only. They are not the result of any instrumentation, on-site testing, or certified measurement process. The term modeled EMF exposure range means a calculated approximation based on facility power draw and distance, not a reading from any measuring device. These ranges should not be cited as measured values in any legal, regulatory, medical or scientific context." },
  { h:"No Health Claims", b:"HumZones Technologies Inc. makes no claim that any facility listed on this platform causes, contributes to, or is associated with any health condition or outcome. Infrastructure impact categories are relative indicators of facility scale and proximity, not medical, scientific or regulatory determinations of harm.\n\nReferences on this platform to published research by organizations such as the World Health Organization (WHO), the International Agency for Research on Cancer (IARC), or other bodies are provided for general context only. Such references do not constitute an endorsement by those organizations of HumZones or any claim made on this platform. HumZones Technologies Inc. does not represent that any published research applies to any specific facility listed in our database." },
  { h:"Community Reports", b:"Community reports published on humzones.com are submitted by individual members of the public and represent solely the personal opinions, experiences and beliefs of their authors. HumZones Technologies Inc.:\n\n- Does not verify the accuracy of any statement made in a community report\n- Does not adopt or endorse any statement made in a community report\n- Does not represent that any community report reflects the views of HumZones Technologies Inc.\n- Does not guarantee that community reports are free from error, bias or inaccuracy\n- Reserves the right to decline to publish or to remove any community report at its sole discretion\n\nCommunity reports are published as a public service to facilitate community awareness and dialogue. They are not evidence of any wrongdoing by any facility operator and should not be characterized as such. Any person who believes a published community report contains false or defamatory information may contact hello@humzones.com to request review and removal." },
  { h:"Fair Comment and Public Interest", b:"The information published on humzones.com is published in the public interest for the purpose of promoting transparency about infrastructure development in residential communities. HumZones Technologies Inc. asserts its right to publish factual information compiled from public sources and to facilitate public discourse about matters of community concern.\n\nAll information published on this platform that was obtained from public sources is believed to be accurate at the time of publication. HumZones Technologies Inc. relies on the defense of fair comment, honest opinion, and responsible communication in publishing this information and facilitating community reports about matters of public interest.\n\nNothing in this disclaimer shall be construed as an admission that any information published on this platform is false, misleading or defamatory." },
  { h:"No Liability", b:"To the maximum extent permitted by applicable law, HumZones Technologies Inc. shall not be liable for any direct, indirect, incidental, special, consequential or punitive damages arising from your access to or use of this platform, or from your reliance on any information published here, whether based in contract, tort or any other legal theory.\n\nIn no event shall the total aggregate liability of HumZones Technologies Inc. to you for all claims arising from your use of this platform exceed the greater of (a) the total amount paid by you to HumZones Technologies Inc. in the twelve months preceding the claim or (b) one hundred Canadian dollars (CAD $100)." },
  { h:"No Partnership or Affiliation", b:"HumZones Technologies Inc. is not affiliated with, endorsed by, or in any way connected to any data center operator, technology company, utility company, real estate company, government agency or regulatory body mentioned on this platform. The listing of any facility on this platform does not imply any relationship between HumZones Technologies Inc. and the facility operator." },
  { h:"Accuracy of Publicly Available Information", b:"All facility information published on this platform including facility names, addresses, operator names and operational status has been compiled from sources that were publicly available at the time of compilation. HumZones Technologies Inc. has made reasonable efforts to ensure the accuracy of this information. However we cannot guarantee that all information is current, complete or free from error.\n\nFacility operators who believe their facility information is inaccurate are encouraged to contact us at hello@humzones.com. We will review and update information promptly upon receiving credible evidence of an inaccuracy. The existence of an inaccuracy does not give rise to any legal claim against HumZones Technologies Inc. provided we correct the inaccuracy within a reasonable time after receiving notice." },
  { h:"Assumption of Risk", b:"By accessing and using humzones.com you acknowledge that:\n\n1. You have read and understood this disclaimer in full\n2. You understand that all figures are modeled estimates not certified measurements\n3. You understand that infrastructure impact categories are relative indicators not scientific or medical determinations\n4. You will not rely on information from this platform as the sole basis for any medical, legal, financial, real estate or other significant decision without consulting qualified professionals\n5. You assume full responsibility for how you use and interpret information obtained from this platform\n6. You will not use information from this platform to harass, defame or make false accusations against any facility operator or individual" },
  { h:"Governing Law", b:"This disclaimer and your use of humzones.com are governed by the laws of Canada, without regard to its conflict of law provisions. Any dispute arising from or relating to this platform shall be resolved in the courts of Canada.\n\nYou agree that any claim against HumZones Technologies Inc. must be brought within one year of the date the claim arose or be forever barred. Class action lawsuits against HumZones Technologies Inc. are expressly waived to the maximum extent permitted by applicable law." },
  { h:"DMCA and Content Removal", b:"If you believe that content published on humzones.com infringes your intellectual property rights or contains false and defamatory statements about you or your organization please contact us immediately at hello@humzones.com with:\n\n- Your full name and contact information\n- A description of the content you believe is problematic\n- The specific URL where the content appears\n- A description of the basis for your claim\n\nWe will review all such requests within 5 business days and take appropriate action where warranted." },
];

const DisclaimerPage = ({ onNavigate }) => (
  <div style={{minHeight:"100vh",background:"#f1f5f9",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>
    <PageHero onNavigate={onNavigate} title="Legal Disclaimer" subtitle="Last updated: May 2026"/>

    <section style={{background:"#fff",padding:"54px 24px"}}>
      <div style={{maxWidth:820,margin:"0 auto"}}>
        {DISCLAIMER_SECTIONS.map((s,i)=>(
          <section key={s.h} style={{marginBottom:30}}>
            <div style={{display:"flex",alignItems:"baseline",gap:12,marginBottom:10}}>
              <div style={{fontSize:13,fontWeight:900,color:"#ef4444",letterSpacing:".06em",minWidth:26}}>{String(i+1).padStart(2,"0")}</div>
              <h2 style={{fontSize:15,color:"#0f172a",letterSpacing:".10em",textTransform:"uppercase",fontWeight:800,margin:0,lineHeight:1.4}}>{s.h}</h2>
            </div>
            <p style={{fontSize:16,color:"#475569",lineHeight:1.8,marginLeft:38,whiteSpace:"pre-line"}}>{s.b}</p>
          </section>
        ))}
        <div style={{borderTop:"1px solid #e2e8f0",marginTop:36,paddingTop:24,textAlign:"center"}}>
          <p style={{fontSize:14,color:"#475569",lineHeight:1.7,marginBottom:18}}>
            Questions about this disclaimer? Contact us at <a href="mailto:hello@humzones.com" style={{color:"#f97316",fontWeight:700,textDecoration:"none"}}>hello@humzones.com</a>
          </p>
          <button onClick={()=>onNavigate("/")} style={{padding:"14px 28px",borderRadius:12,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:15,fontWeight:900,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>Back to HumZones</button>
        </div>
      </div>
    </section>

    <Footer onNavigate={onNavigate}/>
  </div>
);

// ─── /learn: RESIDENT EXPLAINER ARTICLES ─────────────────────────────────────
// Narrative explainer articles for residents living near data center
// infrastructure. Distinct from the future /glossary page, which would
// focus on short term definitions. Articles are stored inline as block
// arrays so the page renders without any markdown parser. Clicking a
// card expands its full body inline; the URL hash is kept in sync so
// /learn#<slug> deep-links to a specific article.

const LEARN_CATEGORIES = ["Infrastructure", "Regulatory", "Data Centers", "Community"];

const LEARN_CATEGORY_COLOR = {
  "Infrastructure": { bg: "rgba(59,130,246,.12)",  border: "#3b82f6", text: "#1d4ed8" },
  "Regulatory":     { bg: "rgba(139,92,246,.12)",  border: "#8b5cf6", text: "#6d28d9" },
  "Data Centers":   { bg: "rgba(249,115,22,.12)",  border: "#f97316", text: "#c2410c" },
  "Community":      { bg: "rgba(34,197,94,.12)",   border: "#22c55e", text: "#15803d" },
};

const LEARN_ARTICLES = [
  {
    slug: "interconnection-queue",
    category: "Infrastructure",
    title: "What an Interconnection Queue Means for Your Neighborhood",
    readTime: "6 min read",
    preview: "When a company files to connect a massive new power load to the electric grid, that request joins a public waiting list. Here is how to find it and what it tells you about what is coming.",
    body: [
      { type: "p", text: "If you have noticed new construction near your home and wondered what is being built, one of the best early warning systems available to residents is something most people have never heard of: the interconnection queue." },
      { type: "h", text: "What is an interconnection queue?" },
      { type: "p", text: "When a company wants to connect a large new electrical load to the power grid, such as a data center, a factory, or a cryptocurrency mining operation, they cannot simply plug in. They have to submit a formal request to the regional grid operator and join a waiting list. That waiting list is called the interconnection queue." },
      { type: "p", text: "In the United States, the grid is managed by regional operators called ISOs and RTOs. The most relevant for the Mid-Atlantic region, which includes Northern Virginia and the highest concentration of data centers in the world, is PJM Interconnection. PJM's interconnection queue is a public document updated regularly and freely available online." },
      { type: "h", text: "Why does this matter for residents?" },
      { type: "p", text: "Here is the key insight: companies typically submit interconnection requests 12 to 36 months before construction begins. This means the queue is one of the earliest public signals that a large facility is being planned in your area, often years before it appears in local news or planning documents." },
      { type: "p", text: "A single interconnection request for 100MW or more in your county is a strong signal that a data center or similar facility is being planned. Multiple requests clustered in the same area suggest a development corridor is forming." },
      { type: "h", text: "How to read an interconnection queue entry" },
      { type: "p", text: "Each entry in PJM's queue includes:" },
      { type: "ul", items: [
        "The project name (often a code name that does not reveal the company)",
        "The requested capacity in megawatts",
        "The county or utility service territory",
        "The type of generation or load",
        "The current status of the request",
      ]},
      { type: "h", text: "What to look for near you" },
      { type: "p", text: "Search the PJM queue for your county name or the name of your local utility. Look for large load requests. Anything above 50MW is significant. A 500MW request is equivalent to the power demand of a small city." },
      { type: "p", text: "Remember that not every queue entry becomes a real project. Some are withdrawn. But clusters of large requests in a specific area are a reliable signal of developer interest and planned infrastructure growth." },
      { type: "h", text: "What you can do" },
      { type: "p", text: "Once you identify relevant queue entries, you can request more information through your state's public utilities commission, contact your local planning board, or file a public records request for associated permit applications. HumZones tracks planned facilities from interconnection data so you can stay informed without having to monitor the queue yourself." },
    ],
    faqs: [
      { q: "How do I find the interconnection queue for my area?",
        a: "In the Mid-Atlantic region, visit the PJM Interconnection website and search for their queue report. PJM publishes a downloadable spreadsheet updated regularly. Filter by the county or state you are interested in and look for large load requests above 50MW. Similar queues exist for other regions: MISO covers the Midwest, CAISO covers California, and ERCOT covers Texas." },
      { q: "Does every interconnection request become a real data center?",
        a: "No. A significant percentage of interconnection requests are withdrawn before construction begins. However, clusters of multiple large requests in the same area are a reliable signal of developer interest. A single request may not materialize but five requests in the same county almost certainly signals active development planning." },
      { q: "How long does it take from interconnection request to completed data center?",
        a: "Typically 2 to 5 years from the initial interconnection request to a fully operational facility. The interconnection study process alone can take 12 to 18 months. Construction of a large facility then takes another 18 to 36 months. This means requests filed today may not become operational facilities until 2028 or 2029." },
      { q: "Can residents object to an interconnection request?",
        a: "Interconnection requests are utility and grid operator processes, not local government processes, so residents cannot directly object to them the way they can object to a zoning application. However, the interconnection process often triggers related utility filings, such as substation permits and transmission line approvals, that do have public comment periods." },
    ],
  },
  {
    slug: "utility-filing",
    category: "Regulatory",
    title: "How to Read a Utility Filing",
    readTime: "8 min read",
    preview: "Utility companies file public documents every time major new infrastructure is planned. Most residents do not know these documents exist. Here is what to look for and how to find them.",
    body: [
      { type: "p", text: "Every time a utility company plans to build a new substation, upgrade a transmission line, or connect a major new power customer, they are required to file public documents with their state's public utilities commission. These documents contain detailed information about what is being built, where, and why, but they are written in technical language that most residents find impenetrable." },
      { type: "p", text: "This guide explains how to find these filings and what they actually mean." },
      { type: "h", text: "Where to find utility filings" },
      { type: "p", text: "Each state has a public utilities commission (sometimes called a public service commission) that maintains a database of all filings. In Virginia, this is the Virginia State Corporation Commission. In Maryland, it is the Maryland Public Service Commission. Most state commissions have online dockets that are searchable by utility name, project type, or geographic area." },
      { type: "p", text: "You can also find relevant filings on the websites of the major utilities themselves. Dominion Energy in Virginia publishes its integrated resource plans and major project filings publicly." },
      { type: "h", text: "Key documents to look for" },
      { type: "kv", k: "Integrated Resource Plan (IRP)", v: "A long-term plan that utilities file regularly showing how they expect to meet future electricity demand. These plans often include projections of large new loads, including data centers, years in advance." },
      { type: "kv", k: "Certificate of Public Convenience and Necessity (CPCN)", v: "Required for major new infrastructure like substations and transmission lines. If a utility is building a new substation near your home, there will be a CPCN filing. These documents include maps, environmental assessments, and descriptions of the planned infrastructure." },
      { type: "kv", k: "Large Load Interconnection Agreement", v: "When a major new power customer like a data center connects to the grid, the interconnection agreement between the utility and the customer is often a public document. These agreements specify the location, the capacity, and sometimes the identity of the customer." },
      { type: "h", text: "How to interpret the technical language" },
      { type: "kv", k: "Megawatt (MW)", v: "One megawatt powers approximately 750 average homes continuously. A filing mentioning a 200MW new load means enough electricity for 150,000 homes is being redirected to a single new customer." },
      { type: "kv", k: "Substation upgrade", v: "When a filing mentions upgrading an existing substation to a higher voltage or capacity, it typically means a large new power customer is being connected in that area." },
      { type: "kv", k: "Transmission line upgrade", v: "High-voltage transmission lines carry power across long distances. Upgrades to lines in your area often signal that the existing grid cannot handle the planned new demand without reinforcement." },
      { type: "h", text: "Filing for comment" },
      { type: "p", text: "Most utility filings have a public comment period. During this window, residents can submit written comments that become part of the official record. These comments are read by regulators and can influence project approvals." },
      { type: "p", text: "To submit a comment, find the docket number for the filing you are interested in and contact your state's public utilities commission for instructions. The process is simpler than it sounds. A clear, factual letter explaining your concerns is sufficient." },
    ],
    faqs: [
      { q: "What is the difference between a state utility commission and a local planning board?",
        a: "A state utility commission (like the Virginia State Corporation Commission) regulates the utilities themselves, approving new infrastructure like substations and transmission lines. A local planning board regulates land use, approving zoning changes and special use permits for specific buildings. A data center project typically requires approvals from both. The local planning board controls whether the building can be built. The utility commission controls whether the power infrastructure to serve it can be built." },
      { q: "How do I find the docket number for a utility filing?",
        a: "Visit your state's public utilities commission website and search for filings by the utility company name (such as Dominion Energy or Pepco) and the county or project name. Most commission websites have searchable docket databases. The docket number is typically a combination of numbers and letters assigned when the filing is submitted." },
      { q: "Do I need a lawyer to submit a comment on a utility filing?",
        a: "No. Public comments can be submitted by any member of the public without legal representation. A clear, factual letter explaining your concerns and your relationship to the affected area is sufficient. You do not need to use legal language. However, if you are seeking to formally intervene as a party in a proceeding, which gives you more rights but also more obligations, legal counsel is recommended." },
      { q: "Are utility filings available online?",
        a: "Most state utility commissions have moved to online docket systems where filings can be viewed and downloaded for free. Federal filings with FERC (the Federal Energy Regulatory Commission) are available through the FERC eLibrary. Some older documents may require an in-person visit or a formal records request." },
    ],
  },
  {
    slug: "why-data-centers-cluster",
    category: "Infrastructure",
    title: "Why Data Centers Cluster and What Comes Next",
    readTime: "5 min read",
    preview: "Northern Virginia has more data center capacity than anywhere else on earth. This did not happen by accident. Understanding why data centers cluster helps predict where they will expand next.",
    body: [
      { type: "p", text: "If you live in Northern Virginia, you may have noticed that data centers seem to be everywhere, and new ones keep appearing. This is not random. Data centers cluster for specific reasons, and understanding those reasons can help you anticipate where development is likely to spread." },
      { type: "h", text: "Why data centers concentrate in specific locations" },
      { type: "kv", k: "Power availability", v: "Data centers require enormous amounts of electricity delivered reliably. They locate where the grid has sufficient capacity and where utilities are willing to provide the power at competitive rates. Northern Virginia has historically had both." },
      { type: "kv", k: "Fiber infrastructure", v: "Data centers need to connect to each other and to the internet backbone. They cluster along existing fiber routes because building new long-distance fiber is expensive. Ashburn, Virginia sits at one of the most significant internet exchange points in the world, a legacy of early internet infrastructure decisions in the 1990s." },
      { type: "kv", k: "Zoning and incentives", v: "Virginia offered significant tax incentives for data center development for many years, making it financially attractive to build there. Local zoning that permits industrial use without requiring special approval also reduces development friction." },
      { type: "kv", k: "Labor market", v: "A concentration of data center facilities creates a local workforce with the specialized skills to operate them. This makes additional facilities more attractive to build in the same area." },
      { type: "h", text: "The cluster effect" },
      { type: "p", text: "Once a cluster forms, it becomes self-reinforcing. Each new facility makes the area more attractive for the next one. This is why Northern Virginia now has more data center capacity than any other region in the world, and why new facilities continue to be built there even as available land becomes scarce and power becomes constrained." },
      { type: "h", text: "Where expansion happens next" },
      { type: "p", text: "When a primary cluster runs out of land or power capacity, expansion moves outward in predictable patterns. Look for:" },
      { type: "ul", items: [
        "Locations within 50 to 100 miles of the primary cluster that have available land zoned for industrial use",
        "Areas where utilities are upgrading transmission infrastructure",
        "Counties that are actively marketing themselves to data center developers",
        "Areas along existing fiber routes",
      ]},
      { type: "p", text: "In the Mid-Atlantic region, expansion from the Northern Virginia core has been moving toward Prince William County, the Gainesville area, Richmond, and parts of Maryland and Pennsylvania." },
      { type: "h", text: "What this means for residents in emerging areas" },
      { type: "p", text: "If your community is near a primary data center cluster, or if you have noticed utility upgrades, large land purchases by unfamiliar companies, or rezoning applications for industrial use, your area may be in the path of expansion. The time to engage with local planning processes is before projects are approved, not after construction begins." },
    ],
    faqs: [
      { q: "Why is Northern Virginia the global hub for data centers?",
        a: "Several factors converged: the presence of early internet exchange infrastructure in Ashburn in the 1990s, abundant and relatively affordable power from Dominion Energy, permissive zoning for industrial development, significant state and local tax incentives that persisted for decades, and the resulting concentration of skilled labor. Once a cluster forms it becomes self-reinforcing, with each new facility making the area more attractive for the next one." },
      { q: "Are data center incentives still available in Virginia?",
        a: "Virginia eliminated its broad sales tax exemption for data center equipment purchases in 2022 for new projects, after determining that the incentive had cost the state billions in foregone revenue. However, some local incentives and negotiated agreements may still be available. Other states, including Georgia, Texas, and Indiana, have aggressively pursued data center development with their own incentive packages." },
      { q: "How can I tell if my area is in the path of data center expansion?",
        a: "Warning signs include large parcels of land being purchased by unfamiliar holding companies, utility companies filing for substation upgrades or new transmission lines, local governments receiving rezoning applications for industrial use on previously agricultural or residential land, and data center industry publications mentioning your county or region as an emerging market." },
      { q: "Do data centers bring economic benefits to communities?",
        a: "Data centers typically bring significant tax revenue and construction jobs but relatively few permanent jobs. A large facility may employ only 50 to 100 full-time workers. They place substantial demands on local power grids and water systems. The economic calculus varies significantly by community, and reasonable people disagree about whether the benefits outweigh the infrastructure impacts." },
    ],
  },
  {
    slug: "facility-status-explained",
    category: "Data Centers",
    title: "The Difference Between a Proposed, Approved and Operating Facility",
    readTime: "4 min read",
    preview: "Not every data center that is announced gets built. Understanding the stages of development helps you know how seriously to take a project and when to engage with the process.",
    body: [
      { type: "p", text: "When HumZones lists a facility as Proposed, Approved, Building, or Operating, these labels represent meaningfully different stages of development, with different implications for residents and different opportunities to influence the outcome." },
      { type: "h", text: "Proposed" },
      { type: "p", text: "A proposed facility is one that has been publicly announced or identified through public records but has not yet received the necessary approvals to begin construction. This stage typically involves:" },
      { type: "ul", items: [
        "Interconnection queue applications with the regional grid operator",
        "Pre-application meetings with local planning departments",
        "Land purchase or option agreements",
        "Zoning applications or requests for special use permits",
      ]},
      { type: "p", text: "Proposed facilities are the earliest stage at which residents can engage. Public comment periods, planning board meetings, and direct communication with elected officials are most effective at this stage. Once a project moves beyond this phase, the practical options for residents narrow significantly." },
      { type: "h", text: "Approved" },
      { type: "p", text: "An approved facility has received the necessary governmental and regulatory approvals to proceed but has not yet begun construction. This typically means:" },
      { type: "ul", items: [
        "The local planning board or board of supervisors has granted any required permits",
        "The utility interconnection agreement has been signed",
        "Environmental reviews have been completed",
      ]},
      { type: "p", text: "Approved projects are still in a stage where construction has not begun. However, overturning an approval is significantly harder than preventing one from being granted. Legal challenges are possible but expensive and uncertain." },
      { type: "h", text: "Building" },
      { type: "p", text: "A facility marked as Building is actively under construction. At this point, the project has cleared all major approvals and physical construction has begun. The primary options for residents at this stage relate to construction impacts (noise, traffic, dust) rather than the existence of the project itself." },
      { type: "p", text: "Construction timelines for large data centers typically run 18 to 36 months from groundbreaking to the first servers going online." },
      { type: "h", text: "Operating" },
      { type: "p", text: "An Operating facility is actively running and consuming power. These facilities are the most certain in terms of their impact on surrounding communities. The noise, the power consumption, the traffic patterns, and the visual presence are all present and ongoing." },
      { type: "p", text: "For operating facilities, resident options focus on monitoring and documentation: recording noise levels, tracking generator testing schedules, reporting concerns to local authorities, and contributing to the HumZones community report database so other residents can benefit from your experience." },
      { type: "h", text: "Why status matters for engagement" },
      { type: "p", text: "The practical lesson from understanding facility status is this: the earlier you engage in the process, the more options you have. A proposed facility that has not yet received planning approval can still be stopped, modified, or conditioned on community protections. An operating facility is a permanent part of your neighborhood's infrastructure." },
      { type: "p", text: "HumZones tracks facility status in real time so residents can know not just what is there, but what is coming." },
    ],
    faqs: [
      { q: "Where can I find the approval status of a data center near me?",
        a: "Check your local planning department's permit database, which is typically available online. Search for the facility address or the owner company name. The Virginia Department of Environmental Quality and similar state agencies maintain databases of environmental permits. HumZones also tracks facility status in our registry and updates it as new information becomes available." },
      { q: "Can an approved facility still be stopped?",
        a: "It is very difficult but not impossible. Legal challenges to approvals can be filed on grounds such as procedural errors, failure to comply with environmental review requirements, or conflicts with existing regulations. These challenges are expensive and uncertain. The most practical approach for residents is to engage during the approval process rather than after." },
      { q: "What happens if a facility never gets built after approval?",
        a: "Approvals typically have expiration periods. A special use permit might require construction to begin within 2 to 3 years or it expires. If a project is abandoned, any conditions attached to the approval become moot. The land remains as zoned, which may or may not be appropriate for the surrounding area. Residents can sometimes advocate for rezoning after a project is abandoned." },
      { q: "How does HumZones determine a facility's status?",
        a: "We compile status information from multiple public sources including local planning permit databases, utility interconnection records, operator press releases, news reporting, and satellite imagery. Status is updated periodically and marked with the date of last verification. Because our data comes from public sources, there may be a lag between real-world changes and our registry. If you notice an error please use our correction form." },
    ],
  },
  {
    slug: "what-residents-can-do",
    category: "Community",
    title: "What Residents Can Actually Do About Data Center Development",
    readTime: "7 min read",
    preview: "Feeling powerless when large infrastructure appears near your home is understandable. But residents have more tools available than most realize. Here is a practical guide.",
    body: [
      { type: "p", text: "When a data center appears near your home, it is easy to feel like the decision was made without you and cannot be changed. Sometimes that is true. But residents have more tools available than most realize, and using the right tool at the right time makes all the difference." },
      { type: "h", text: "Step 1: Know what is there" },
      { type: "p", text: "Before you can act, you need accurate information. HumZones provides modeled estimates of the infrastructure near your address including power draw, noise levels and water consumption. This gives you a factual baseline for any conversations with officials or neighbors." },
      { type: "h", text: "Step 2: Understand the status" },
      { type: "p", text: "Is the facility proposed, approved, under construction, or operating? Your options are very different depending on the answer. See our guide on facility status for a full explanation. For proposed facilities, the public process is open. For operating facilities, the focus shifts to monitoring and documentation." },
      { type: "h", text: "Step 3: Engage the local planning process" },
      { type: "p", text: "If a facility is in the proposed or approval stage, the most effective action is direct engagement with your local planning board or board of supervisors. Attend public hearings. Submit written comments for the record. Bring neighbors. Local elected officials respond to constituent engagement, particularly when it is organized and fact-based." },
      { type: "p", text: "When engaging the planning process:" },
      { type: "ul", items: [
        "Stick to factual, documented concerns",
        "Reference specific infrastructure impacts: power draw, noise, traffic, water",
        "Avoid health claims that are not supported by certified measurements",
        "Ask specific questions: What noise mitigation is required? How will water consumption be managed? What are the generator testing protocols?",
      ]},
      { type: "h", text: "Step 4: File public records requests" },
      { type: "p", text: "Much of the documentation around data center development is publicly available but not proactively disclosed. File FOIA requests for interconnection agreements, environmental assessments, special use permit applications, and any conditions attached to approvals." },
      { type: "h", text: "Step 5: Connect with neighbors" },
      { type: "p", text: "Individual voices matter. Organized voices matter more. Find neighbors who share your concerns and coordinate your engagement. Local community groups, neighborhood associations, and environmental organizations can amplify your efforts." },
      { type: "h", text: "Step 6: Document your experience" },
      { type: "p", text: "If you are already living near an operating facility, document your experience. Note the dates and times of generator testing. Record noise levels using a free decibel meter app on your phone. Document any changes you observe over time. This documentation serves two purposes: it supports any future regulatory or legal action, and it contributes to the public record that HumZones maintains on behalf of communities everywhere." },
      { type: "p", text: "Submit your verified experience to HumZones at humzones.com/submit-report. Your report becomes part of the public registry and helps other residents in your area understand what to expect." },
      { type: "h", text: "Step 7: Know your limits" },
      { type: "p", text: "Some battles cannot be won after a certain point in the process. If a facility is fully approved and funded, stopping it entirely may not be realistic. In those cases, focusing on conditions (noise barriers, generator testing restrictions, landscaping requirements, community benefit agreements) may be more productive than opposing the project outright." },
      { type: "p", text: "The residents who are most effective are those who engage early, stay fact-based, and build coalitions. HumZones exists to give you the information you need to do all three." },
    ],
    faqs: [
      { q: "What is the most effective thing residents can do to influence data center development?",
        a: "The most effective action is early engagement in the local planning process before approvals are granted. Attending public hearings, submitting written comments, and organizing neighbors creates a documented record that elected officials and regulators must respond to. Individual emails are less effective than coordinated group engagement. The time investment required to stop or modify a project is significant, but so is the potential impact." },
      { q: "Can residents demand noise limits or other conditions on a data center?",
        a: "Yes, in many jurisdictions residents can advocate for conditions to be attached to special use permits or development agreements. Common conditions include maximum noise levels measured at the property line, restrictions on generator testing hours, landscaping and buffering requirements, and commitments to use renewable energy. Having specific, measurable asks is more effective than general opposition." },
      { q: "Is there a national organization that helps residents facing data center development?",
        a: "Organized national advocacy specifically focused on data center infrastructure near residential areas is still emerging. Local community groups, environmental organizations, and neighborhood associations have been the primary vehicles for resident engagement. HumZones provides the data and documentation infrastructure to support these efforts. We are tracking the development of resident networks and will update this guide as the landscape evolves." },
      { q: "How do I document noise from a data center for regulatory purposes?",
        a: "Use a calibrated sound level meter app on your smartphone as a starting point. Apps like Decibel X are reasonably accurate for initial documentation. Record the date, time, weather conditions, your distance from the facility, and the measured level. Take readings at multiple times of day including overnight. For formal regulatory complaints, a professional acoustic assessment using calibrated equipment is more credible. Some noise ordinances specify measurement protocols that must be followed for complaints to be actionable." },
    ],
  },
  {
    slug: "talking-to-officials",
    category: "Community",
    title: "How to Talk to Your Local Officials About Data Centers",
    readTime: "5 min read",
    preview: "Most residents have never spoken at a planning board meeting or contacted an elected official. Here is a practical guide to making your voice heard effectively.",
    body: [
      { type: "p", text: "Talking to elected officials and planning board members can feel intimidating, especially about a technical topic like data center infrastructure. But local officials respond to constituent engagement, particularly when it is specific, fact-based, and organized. This guide explains how to do it effectively." },
      { type: "h", text: "Know who to contact" },
      { type: "p", text: "For proposed or pending facilities, the relevant officials depend on what stage of approval the project is in:" },
      { type: "kv", k: "Local planning board or planning commission", v: "Handles zoning changes, special use permits, and site plan approvals. This is often the most important body for residents to engage with on new data center projects." },
      { type: "kv", k: "Board of supervisors or county council", v: "The elected body that often has final say on major zoning decisions. Members are directly accountable to voters." },
      { type: "kv", k: "State legislators", v: "Relevant for issues of state policy such as tax incentives, utility regulation, and environmental standards. Less relevant for individual project decisions." },
      { type: "kv", k: "State utility commission", v: "Relevant when utility infrastructure (substations, transmission lines) associated with a project requires state approval." },
      { type: "h", text: "What to say" },
      { type: "p", text: "Effective constituent communication is specific, factual and personal. Generic opposition is easy to dismiss. Specific concerns backed by data are harder to ignore." },
      { type: "p", text: "Before contacting an official, know the basics:" },
      { type: "ul", items: [
        "The facility name, address, and current status",
        "What approvals are pending",
        "What your specific concerns are: noise, traffic, water, visual impact, grid strain",
        "What conditions or changes you are asking for",
      ]},
      { type: "p", text: "Lead with your identity as a constituent and neighbor, not with your conclusion. Officials respond to people, not position papers." },
      { type: "p", text: "Sample language for a planning board comment: \"My name is [name] and I live at [address], approximately [distance] from the proposed facility. I am concerned about [specific issue] and would like to ask the board to require [specific condition] as a condition of any approval. I have attached supporting documentation from [source].\"" },
      { type: "h", text: "Attending public hearings" },
      { type: "p", text: "Public hearings are your most direct opportunity to influence local decisions. To participate:" },
      { type: "ul", items: [
        "Check the planning department website or call the planning office to find hearing dates",
        "Sign up to speak in advance if required, since many boards require advance registration",
        "Prepare 2 to 3 minutes of remarks, since most boards limit speakers to 3 minutes",
        "Focus on facts and specific requests rather than general concerns",
        "Bring neighbors, since a room with 30 concerned residents makes a stronger impression than one",
      ]},
      { type: "h", text: "Following up" },
      { type: "p", text: "After a hearing, follow up in writing to confirm your concerns are in the official record. Ask for a written response. If you receive one, share it with neighbors." },
      { type: "p", text: "If the decision goes against your interests, ask about the appeals process. Most planning decisions can be appealed to a higher body within a specified time period." },
      { type: "h", text: "Using HumZones data" },
      { type: "p", text: "The modeled estimates in your HumZones report can provide useful context for official communications, including estimated power draw, noise levels, and water consumption for facilities in your area. Be clear that these are modeled estimates, not certified measurements, and frame them as questions rather than assertions. \"The HumZones registry estimates this facility draws approximately 120MW. Can you tell us what impact assessment was done for grid capacity in our area?\" is more effective than citing the number as a definitive fact." },
    ],
    faqs: [
      { q: "Do I need to be a registered voter in the jurisdiction to comment at a planning hearing?",
        a: "In most jurisdictions you do not need to be a registered voter. Any member of the public can attend and comment at planning hearings. Property owners, renters, and business owners in the affected area all typically have standing to comment. Check with your local planning department for specific rules." },
      { q: "What if the planning board seems to have already made up its mind?",
        a: "Even when a decision seems predetermined, public comments create a formal record. This record can be referenced in any subsequent legal challenge. It also signals to elected officials that constituents are watching. Long-term, sustained engagement shifts the political calculus even when individual hearings do not go your way." },
      { q: "Can I submit comments in writing instead of attending in person?",
        a: "Yes. Written comments submitted before a hearing cutoff date become part of the official record. Written submissions are often more detailed and better documented than in-person testimony. Both written and in-person comments carry weight. Check the planning department website for submission deadlines and formats." },
      { q: "What if I disagree with the outcome of a planning hearing?",
        a: "Most planning decisions can be appealed. The appeal process varies by jurisdiction but typically involves filing within 30 days of the decision with a higher board or a court. Grounds for appeal generally include procedural errors, failure to consider required factors, or conflict with existing law. Consult with a local land use attorney if you are considering an appeal." },
    ],
  },
];

// Renders a single body block into the right semantic markup. Kept local
// to the page so styling decisions stay co-located with the article shell.
const LearnBlock = ({ block }) => {
  if (block.type === "h") {
    return <h3 style={{fontSize:20,fontWeight:900,color:"#0f172a",letterSpacing:"-.01em",margin:"28px 0 10px"}}>{block.text}</h3>;
  }
  if (block.type === "p") {
    return <p style={{fontSize:16,color:"#334155",lineHeight:1.75,margin:"0 0 14px"}}>{block.text}</p>;
  }
  if (block.type === "ul") {
    return (
      <ul style={{margin:"0 0 16px",paddingLeft:22,color:"#334155",fontSize:16,lineHeight:1.7}}>
        {block.items.map((it, j) => <li key={j} style={{marginBottom:6}}>{it}</li>)}
      </ul>
    );
  }
  if (block.type === "kv") {
    return (
      <p style={{fontSize:16,color:"#334155",lineHeight:1.75,margin:"0 0 14px"}}>
        <strong style={{color:"#0f172a"}}>{block.k}:</strong> {block.v}
      </p>
    );
  }
  return null;
};

// Inject (or remove) a tagged DOM node inside document.head. Used by
// /learn and /glossary to drop JSON-LD and OpenGraph/Twitter meta tags
// on mount and clean them up on unmount so they do not leak between
// routes. Each call is keyed by a stable id stored in data-hz-head.
const injectHeadEl = (tagName, key, attrs, innerHtml) => {
  if (typeof document === "undefined") return null;
  let el = document.querySelector(`${tagName}[data-hz-head="${key}"]`);
  if (!el) {
    el = document.createElement(tagName);
    el.setAttribute("data-hz-head", key);
    document.head.appendChild(el);
  }
  Object.keys(attrs || {}).forEach(k => el.setAttribute(k, attrs[k]));
  if (innerHtml !== undefined && innerHtml !== null) el.text = innerHtml;
  return el;
};
const removeHeadEl = (key) => {
  if (typeof document === "undefined") return;
  const el = document.querySelector(`[data-hz-head="${key}"]`);
  if (el && el.parentNode) el.parentNode.removeChild(el);
};

// Mounted from the inline home-page JSX so the homepage gets the same
// mount/unmount-driven SEO injection pattern every named page uses.
// Renders nothing; the head tags are inserted as side effects.
const HomePageSEO = () => {
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = "HumZones | Find Data Centers Near Your Home";

    injectHeadEl("meta", "home-desc",      { name: "description",         content: "Search the global data center infrastructure registry. Find facilities near your address, understand power draw, noise and EMF estimates, and access professional reports for residents and businesses." });
    injectHeadEl("link", "home-canonical", { rel: "canonical",            href: "https://humzones.com/" });
    injectHeadEl("meta", "home-og-title",  { property: "og:title",        content: "HumZones | Find Data Centers Near Your Home" });
    injectHeadEl("meta", "home-og-desc",   { property: "og:description",  content: "The global data center infrastructure registry. Search facilities near any address and understand what is being built near your community." });
    injectHeadEl("meta", "home-og-url",    { property: "og:url",          content: "https://humzones.com/" });
    injectHeadEl("meta", "home-og-type",   { property: "og:type",         content: "website" });
    injectHeadEl("meta", "home-og-site",   { property: "og:site_name",    content: "HumZones" });
    injectHeadEl("meta", "home-tw-card",   { name: "twitter:card",        content: "summary" });
    injectHeadEl("meta", "home-tw-title",  { name: "twitter:title",       content: "HumZones | Find Data Centers Near Your Home" });
    injectHeadEl("meta", "home-tw-desc",   { name: "twitter:description", content: "Search the global data center registry. Find facilities near your address with power, noise and EMF estimates." });

    const orgSchema = {
      "@context":    "https://schema.org",
      "@type":       "Organization",
      "name":        "HumZones Technologies Inc.",
      "url":         "https://humzones.com",
      "logo":        "https://humzones.com/favicon.ico",
      "description": "Global data center health and infrastructure registry providing residents and professionals with accessible information about data center facilities near their communities.",
      "contactPoint": {
        "@type":       "ContactPoint",
        "email":       "hello@humzones.com",
        "contactType": "Customer Support",
      },
    };
    const siteSchema = {
      "@context":    "https://schema.org",
      "@type":       "WebSite",
      "name":        "HumZones",
      "url":         "https://humzones.com",
      "description": "Global data center infrastructure registry for residents and professionals",
      "potentialAction": {
        "@type":  "SearchAction",
        "target": { "@type": "EntryPoint", "urlTemplate": "https://humzones.com/?q={search_term_string}" },
        "query-input": "required name=search_term_string",
      },
    };
    const datasetSchema = {
      "@context":           "https://schema.org",
      "@type":              "Dataset",
      "name":               "HumZones Global Data Center Registry",
      "description":        "A continuously updated registry of data center facilities worldwide with modeled infrastructure estimates including power draw, noise levels, EMF ranges, water consumption and CO2 impact derived from publicly available sources.",
      "url":                "https://humzones.com",
      "creator":            { "@type": "Organization", "name": "HumZones Technologies Inc.", "url": "https://humzones.com" },
      "isAccessibleForFree": false,
      "variableMeasured": [
        "Power Draw (MW)",
        "Estimated Noise Level (dB)",
        "Modeled EMF at Fence Line (mG)",
        "Modeled EMF at 100 Meters (mG)",
        "Estimated Daily Water Consumption (gallons)",
        "Estimated Annual CO2 Impact (tons)",
      ],
      "spatialCoverage": { "@type": "Place", "name": "Global" },
    };
    injectHeadEl("script", "home-jsonld", { type: "application/ld+json" }, JSON.stringify([orgSchema, siteSchema, datasetSchema]));

    return () => {
      [
        "home-desc","home-canonical",
        "home-og-title","home-og-desc","home-og-url","home-og-type","home-og-site",
        "home-tw-card","home-tw-title","home-tw-desc",
        "home-jsonld",
      ].forEach(removeHeadEl);
    };
  }, []);
  return null;
};

const LearnPage = ({ onNavigate }) => {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");
  const [expandedSlug, setExpandedSlug] = useState("");
  const [helpful, setHelpful] = useState({}); // slug -> "up" | "down"
  const [copiedSlug, setCopiedSlug] = useState("");
  // FAQ accordion open state, keyed by "<slug>::<index>" so different
  // articles do not collide.
  const [openFaq, setOpenFaq] = useState({});

  // Read the URL hash on mount and auto-expand the matching article. Also
  // listen for hashchange so back/forward navigation works inside the
  // expanded view.
  useEffect(() => {
    const sync = () => {
      const h = (typeof window !== "undefined" && window.location.hash) || "";
      const slug = h.replace(/^#/, "").toLowerCase();
      if (slug && LEARN_ARTICLES.some(a => a.slug === slug)) {
        setExpandedSlug(slug);
      }
    };
    sync();
    if (typeof window !== "undefined") {
      window.addEventListener("hashchange", sync);
      return () => window.removeEventListener("hashchange", sync);
    }
    return undefined;
  }, []);

  // Drive the document title and meta description from the expanded
  // article when one is open, otherwise from the page defaults.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const expanded = LEARN_ARTICLES.find(a => a.slug === expandedSlug);
    const title = expanded
      ? `${expanded.title} | HumZones Learn`
      : "Data Center Resident Guides | HumZones Learn";
    document.title = title;
    injectHeadEl("meta", "learn-desc", { name: "description", content:
      expanded
        ? expanded.preview
        : "Plain language guides for residents near data center infrastructure. Interconnection queues, utility filings, facility status and how to engage local officials explained."
    });
  }, [expandedSlug]);

  // OpenGraph + Twitter meta tags. Stamped once on mount and cleaned up
  // on unmount so they do not bleed into other routes.
  useEffect(() => {
    injectHeadEl("link", "learn-canonical",      { rel: "canonical",            href: "https://humzones.com/learn" });
    injectHeadEl("meta", "learn-og-title",       { property: "og:title",        content: "Data Center Resident Guides | HumZones" });
    injectHeadEl("meta", "learn-og-description", { property: "og:description",  content: "Understand data center development near your community. Free guides for residents on interconnection queues, utility filings and planning boards." });
    injectHeadEl("meta", "learn-og-url",         { property: "og:url",          content: "https://humzones.com/learn" });
    injectHeadEl("meta", "learn-og-type",        { property: "og:type",         content: "website" });
    injectHeadEl("meta", "learn-og-site",        { property: "og:site_name",    content: "HumZones" });
    injectHeadEl("meta", "learn-tw-card",        { name: "twitter:card",        content: "summary" });
    injectHeadEl("meta", "learn-tw-title",       { name: "twitter:title",       content: "Data Center Resident Guides | HumZones" });
    injectHeadEl("meta", "learn-tw-description", { name: "twitter:description", content: "Free plain language guides for residents near data center infrastructure." });

    // JSON-LD blob: WebPage + Article schemas (one per article, injected
    // all at once so crawlers see every article without the user having
    // to expand them) + a single combined FAQPage covering every FAQ.
    const articleSchemas = LEARN_ARTICLES.map(a => ({
      "@context": "https://schema.org",
      "@type":    "Article",
      "headline": a.title,
      "description": a.preview,
      "url":         "https://humzones.com/learn#" + a.slug,
      "datePublished": "2026-01-01",
      "dateModified":  "2026-05-01",
      "author":    { "@type": "Organization", "name": "HumZones Technologies Inc." },
      "publisher": {
        "@type": "Organization",
        "name":  "HumZones Technologies Inc.",
        "logo":  { "@type": "ImageObject", "url": "https://humzones.com/favicon.ico" },
      },
      "mainEntityOfPage": { "@type": "WebPage", "@id": "https://humzones.com/learn#" + a.slug },
    }));
    const webPageSchema = {
      "@context": "https://schema.org",
      "@type":    "WebPage",
      "name":        "Resident Guides | Understanding Data Center Infrastructure | HumZones",
      "description": "Plain-language guides for residents living near data center infrastructure.",
      "url":         "https://humzones.com/learn",
      "publisher": {
        "@type": "Organization",
        "name":  "HumZones Technologies Inc.",
        "url":   "https://humzones.com",
      },
    };
    const faqSchema = {
      "@context": "https://schema.org",
      "@type":    "FAQPage",
      "mainEntity": LEARN_ARTICLES.flatMap(a => (a.faqs || []).map(f => ({
        "@type": "Question",
        "name":  f.q,
        "acceptedAnswer": { "@type": "Answer", "text": f.a },
      }))),
    };
    injectHeadEl("script", "learn-jsonld",     { type: "application/ld+json" }, JSON.stringify([webPageSchema, ...articleSchemas]));
    injectHeadEl("script", "learn-faq-jsonld", { type: "application/ld+json" }, JSON.stringify(faqSchema));

    return () => {
      [
        "learn-desc","learn-canonical",
        "learn-og-title","learn-og-description","learn-og-url","learn-og-type","learn-og-site",
        "learn-tw-card","learn-tw-title","learn-tw-description",
        "learn-jsonld","learn-faq-jsonld",
      ].forEach(removeHeadEl);
    };
  }, []);

  const expandArticle = (slug) => {
    setExpandedSlug(slug);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `/learn#${slug}`);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const collapseArticle = () => {
    setExpandedSlug("");
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", "/learn");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const copyShareLink = (slug) => {
    const url = `https://humzones.com/learn#${slug}`;
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => {
        setCopiedSlug(slug);
        setTimeout(() => setCopiedSlug(""), 2200);
      }).catch(() => {
        window.prompt("Copy this link:", url);
      });
    } else {
      window.prompt("Copy this link:", url);
    }
  };

  const q = search.trim().toLowerCase();
  const filtered = LEARN_ARTICLES.filter(a => {
    if (activeCategory !== "All" && a.category !== activeCategory) return false;
    if (!q) return true;
    return a.title.toLowerCase().includes(q) || a.preview.toLowerCase().includes(q);
  });

  const expanded = LEARN_ARTICLES.find(a => a.slug === expandedSlug) || null;
  const related = expanded
    ? LEARN_ARTICLES.filter(a => a.category === expanded.category && a.slug !== expanded.slug).slice(0, 2)
    : [];

  return (
    <div style={{minHeight:"100vh",background:"#f1f5f9",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>
      {/* HERO */}
      <section style={{background:"linear-gradient(150deg,#020c1b 0%,#0f172a 45%,#1e0535 100%)",padding:"56px 24px 64px"}}>
        <div style={{maxWidth:820,margin:"0 auto",textAlign:"center"}}>
          <div style={{display:"inline-block",fontSize:12,color:"#f97316",letterSpacing:".18em",textTransform:"uppercase",fontWeight:800,marginBottom:14,padding:"6px 14px",borderRadius:30,background:"rgba(249,115,22,.12)",border:"1px solid rgba(249,115,22,.3)"}}>Resident Guides</div>
          <h1 style={{fontSize:"clamp(30px,5vw,46px)",fontWeight:900,letterSpacing:"-.02em",color:"#fff",lineHeight:1.15,marginBottom:14}}>
            Understanding the Infrastructure Being Built Near Your Home
          </h1>
          <div style={{width:60,height:3,background:"#f97316",borderRadius:2,margin:"0 auto 22px"}}/>
          <p style={{fontSize:17,color:"rgba(255,255,255,.72)",lineHeight:1.65,maxWidth:680,margin:"0 auto"}}>
            Plain-language guides for residents, homeowners and community advocates. No engineering degree required.
          </p>
        </div>
      </section>

      {/* INTRO PARAGRAPH */}
      <section style={{maxWidth:880,margin:"0 auto",padding:"36px 24px 0"}}>
        <div style={{background:"#f1f5f9",border:"1px solid #e2e8f0",borderRadius:14,padding:"20px 22px"}}>
          <p style={{fontSize:16,color:"#475569",lineHeight:1.7,margin:0}}>
            Data center development is reshaping communities across the country. These guides explain what is happening, why it matters, and what you can do about it, in language anyone can understand.
          </p>
        </div>
      </section>

      {/* SEARCH + CATEGORY FILTERS (only when no article is expanded) */}
      {!expanded && (
        <section style={{maxWidth:880,margin:"0 auto",padding:"28px 24px 0"}}>
          <input
            value={search}
            onChange={e=>setSearch(e.target.value)}
            placeholder="Search guides by title or preview..."
            style={{width:"100%",padding:"14px 16px",borderRadius:12,border:"1.5px solid #e2e8f0",fontSize:15,fontFamily:"inherit",color:"#0f172a",background:"#fff",outline:"none",boxSizing:"border-box",marginBottom:14}}
          />
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {["All", ...LEARN_CATEGORIES].map(cat => {
              const active = activeCategory === cat;
              return (
                <button
                  key={cat}
                  onClick={()=>setActiveCategory(cat)}
                  style={{padding:"8px 16px",borderRadius:999,border:`1.5px solid ${active?"#f97316":"#e2e8f0"}`,background:active?"#f97316":"#fff",color:active?"#fff":"#475569",fontFamily:"inherit",fontSize:13,fontWeight:800,letterSpacing:".02em",cursor:"pointer"}}
                >
                  {cat}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* ARTICLE GRID (collapsed view) or EXPANDED ARTICLE */}
      <section style={{maxWidth:880,margin:"0 auto",padding:"24px 24px 48px"}}>
        {!expanded ? (
          <>
            {filtered.length === 0 ? (
              <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,padding:"30px 24px",textAlign:"center",color:"#64748b"}}>
                No guides match that search. Try a different keyword or clear the category filter.
              </div>
            ) : (
              <div className="learn-grid" style={{display:"grid",gridTemplateColumns:"repeat(2, 1fr)",gap:16}}>
                {filtered.map(a => {
                  const c = LEARN_CATEGORY_COLOR[a.category] || { bg:"#f1f5f9", border:"#cbd5e1", text:"#475569" };
                  return (
                    <article key={a.slug} className="learn-card" style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,padding:"22px 22px 18px",boxShadow:"0 2px 12px rgba(0,0,0,.04)",display:"flex",flexDirection:"column",gap:10,transition:"box-shadow .2s, transform .2s"}}>
                      <div>
                        <span style={{display:"inline-block",fontSize:11,fontWeight:800,letterSpacing:".08em",textTransform:"uppercase",padding:"4px 10px",borderRadius:999,background:c.bg,border:`1px solid ${c.border}`,color:c.text}}>{a.category}</span>
                      </div>
                      <h2 style={{fontSize:18,fontWeight:800,color:"#0f172a",letterSpacing:"-.01em",lineHeight:1.35,margin:0}}>{a.title}</h2>
                      <p style={{fontSize:14,color:"#64748b",lineHeight:1.65,margin:0}}>{a.preview}</p>
                      <button onClick={()=>expandArticle(a.slug)} style={{alignSelf:"flex-start",marginTop:6,padding:0,background:"transparent",border:"none",color:"#f97316",fontFamily:"inherit",fontSize:14,fontWeight:800,cursor:"pointer"}}>
                        Read Article &rarr;
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <article className="fade-in" style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:16,padding:"28px 28px 26px",boxShadow:"0 4px 22px rgba(0,0,0,.06)"}}>
            <button onClick={collapseArticle} style={{padding:0,background:"transparent",border:"none",color:"#64748b",fontFamily:"inherit",fontSize:13,fontWeight:700,cursor:"pointer",marginBottom:14}}>
              &larr; Back to all articles
            </button>
            {(() => {
              const c = LEARN_CATEGORY_COLOR[expanded.category] || { bg:"#f1f5f9", border:"#cbd5e1", text:"#475569" };
              return (
                <span style={{display:"inline-block",fontSize:11,fontWeight:800,letterSpacing:".08em",textTransform:"uppercase",padding:"4px 10px",borderRadius:999,background:c.bg,border:`1px solid ${c.border}`,color:c.text,marginBottom:12}}>{expanded.category}</span>
              );
            })()}
            <h2 style={{fontSize:"clamp(22px,3.4vw,32px)",fontWeight:900,color:"#0f172a",letterSpacing:"-.02em",lineHeight:1.2,margin:"0 0 22px"}}>{expanded.title}</h2>
            <div>
              {expanded.body.map((b, i) => <LearnBlock key={i} block={b}/>)}
            </div>

            {/* Share + helpful row */}
            <div style={{marginTop:28,padding:"18px 0 0",borderTop:"1px solid #e2e8f0",display:"flex",justifyContent:"space-between",alignItems:"center",gap:14,flexWrap:"wrap"}}>
              <button onClick={()=>copyShareLink(expanded.slug)} style={{padding:"10px 16px",borderRadius:10,border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569",fontFamily:"inherit",fontSize:13,fontWeight:800,cursor:"pointer"}}>
                {copiedSlug === expanded.slug ? "Link copied!" : "Share this article"}
              </button>
              <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <span style={{fontSize:13,color:"#64748b",fontWeight:700}}>Was this helpful?</span>
                <button
                  onClick={()=>setHelpful(p=>({...p,[expanded.slug]:"up"}))}
                  aria-label="Helpful"
                  style={{padding:"8px 12px",borderRadius:10,border:`1.5px solid ${helpful[expanded.slug]==="up"?"#22c55e":"#e2e8f0"}`,background:helpful[expanded.slug]==="up"?"rgba(34,197,94,.12)":"#fff",color:helpful[expanded.slug]==="up"?"#15803d":"#475569",fontFamily:"inherit",fontSize:14,fontWeight:800,cursor:"pointer"}}
                >
                  &#x1F44D;
                </button>
                <button
                  onClick={()=>setHelpful(p=>({...p,[expanded.slug]:"down"}))}
                  aria-label="Not helpful"
                  style={{padding:"8px 12px",borderRadius:10,border:`1.5px solid ${helpful[expanded.slug]==="down"?"#ef4444":"#e2e8f0"}`,background:helpful[expanded.slug]==="down"?"rgba(239,68,68,.12)":"#fff",color:helpful[expanded.slug]==="down"?"#b91c1c":"#475569",fontFamily:"inherit",fontSize:14,fontWeight:800,cursor:"pointer"}}
                >
                  &#x1F44E;
                </button>
              </div>
            </div>
            {helpful[expanded.slug] && (
              <div style={{marginTop:10,fontSize:13,color:"#64748b"}}>Thanks for the feedback.</div>
            )}

            {/* FAQ accordion. Each article carries 3-4 questions in its
                faqs array; these are also rolled into the combined
                FAQPage JSON-LD blob in the head injection above. */}
            {Array.isArray(expanded.faqs) && expanded.faqs.length > 0 && (
              <div style={{marginTop:30,paddingTop:22,borderTop:"1px solid #e2e8f0"}}>
                <h3 style={{fontSize:18,fontWeight:800,color:"#0f172a",letterSpacing:"-.01em",margin:"0 0 6px"}}>Frequently Asked Questions</h3>
                <div style={{width:48,height:3,background:"#f97316",borderRadius:2,marginBottom:18}}/>
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {expanded.faqs.map((f, i) => {
                    const key = expanded.slug + "::" + i;
                    const isOpen = !!openFaq[key];
                    return (
                      <div key={key} style={{border:"1px solid #e2e8f0",borderRadius:10,background:isOpen?"#f8fafc":"#fff",overflow:"hidden"}}>
                        <button
                          onClick={()=>setOpenFaq(p=>({...p,[key]:!p[key]}))}
                          aria-expanded={isOpen}
                          style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,padding:"14px 16px",background:"transparent",border:"none",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}
                        >
                          <span style={{fontSize:15,fontWeight:800,color:"#0f172a",lineHeight:1.4}}>{f.q}</span>
                          <span aria-hidden="true" style={{fontSize:18,fontWeight:900,color:"#f97316",flexShrink:0,lineHeight:1}}>{isOpen ? "−" : "+"}</span>
                        </button>
                        {isOpen && (
                          <div style={{padding:"0 16px 14px"}}>
                            <p style={{fontSize:14,color:"#475569",lineHeight:1.7,margin:0}}>{f.a}</p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Related articles */}
            {related.length > 0 && (
              <div style={{marginTop:30,paddingTop:22,borderTop:"1px solid #e2e8f0"}}>
                <div style={{fontSize:12,color:"#94a3b8",letterSpacing:".14em",textTransform:"uppercase",fontWeight:800,marginBottom:12}}>Related articles</div>
                <div className="learn-grid" style={{display:"grid",gridTemplateColumns:"repeat(2, 1fr)",gap:14}}>
                  {related.map(r => {
                    const rc = LEARN_CATEGORY_COLOR[r.category] || { bg:"#f1f5f9", border:"#cbd5e1", text:"#475569" };
                    return (
                      <button key={r.slug} onClick={()=>expandArticle(r.slug)} style={{textAlign:"left",background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:12,padding:"16px 16px 14px",cursor:"pointer",fontFamily:"inherit",display:"flex",flexDirection:"column",gap:8}}>
                        <span style={{display:"inline-block",alignSelf:"flex-start",fontSize:10,fontWeight:800,letterSpacing:".08em",textTransform:"uppercase",padding:"3px 9px",borderRadius:999,background:rc.bg,border:`1px solid ${rc.border}`,color:rc.text}}>{r.category}</span>
                        <span style={{fontSize:15,fontWeight:800,color:"#0f172a",lineHeight:1.35}}>{r.title}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </article>
        )}
      </section>

      {/* GLOSSARY CALLOUT */}
      <section style={{maxWidth:880,margin:"0 auto",padding:"0 24px 24px"}}>
        <div style={{background:"#fff7ed",border:"1px solid #fed7aa",borderLeft:"4px solid #f97316",borderRadius:12,padding:"18px 22px"}}>
          <p style={{fontSize:15,color:"#7c2d12",lineHeight:1.65,margin:0}}>
            Looking for quick definitions? Visit our Infrastructure Glossary at{" "}
            <a href="/glossary" onClick={e=>{e.preventDefault();onNavigate("/glossary");}} style={{color:"#c2410c",fontWeight:800,textDecoration:"none"}}>humzones.com/glossary</a>.
          </p>
        </div>
      </section>

      {/* NEWSLETTER CALLOUT */}
      <section style={{maxWidth:880,margin:"0 auto",padding:"0 24px 56px"}}>
        <div style={{background:"linear-gradient(150deg,#0a1628 0%,#0f172a 50%,#1e0535 100%)",borderRadius:12,padding:"32px",border:"1px solid rgba(249,115,22,.28)",marginTop:24}}>
          <h3 style={{fontSize:20,fontWeight:900,color:"#fff",letterSpacing:"-.01em",margin:"0 0 4px"}}>Get Infrastructure Intelligence</h3>
          <p style={{fontSize:14,color:"#f97316",fontWeight:700,margin:"0 0 10px"}}>Free every Monday and Thursday. Data center news in plain language.</p>
          <p style={{fontSize:13,color:"rgba(255,255,255,.7)",lineHeight:1.65,margin:"0 0 16px"}}>Mondays bring interconnection queue filings. Thursdays bring facility announcements and community impact stories. Translated for residents, not engineers.</p>
          <NewsletterSignupForm source="Learn Page" variant="light" showFirstName={false} compact/>
        </div>
      </section>

      {/* Inline media-query: collapse the grid to a single column on
          narrow viewports. */}
      <style>{`@media(max-width:680px){.learn-grid{grid-template-columns:1fr!important}}`}</style>

      <Footer onNavigate={onNavigate}/>
    </div>
  );
};

// ─── /glossary: INFRASTRUCTURE GLOSSARY ──────────────────────────────────────
// Plain-language definitions of the terminology residents encounter in
// utility filings, planning documents and news coverage of data center
// development. Each term carries a "What this means for you" panel that
// translates the definition into resident-level impact, plus an optional
// example. The page is a single component with client-side search and
// category filtering.

const GLOSSARY_CATEGORIES = ["Power & Energy", "Infrastructure", "Environmental", "Regulatory", "Data Centers"];

const GLOSSARY_CATEGORY_COLOR = {
  "Power & Energy":  { bg: "rgba(234,179,8,.12)",  border: "#eab308", text: "#854d0e" },
  "Infrastructure":  { bg: "rgba(59,130,246,.12)", border: "#3b82f6", text: "#1d4ed8" },
  "Environmental":   { bg: "rgba(34,197,94,.12)",  border: "#22c55e", text: "#15803d" },
  "Regulatory":      { bg: "rgba(139,92,246,.12)", border: "#8b5cf6", text: "#6d28d9" },
  "Data Centers":    { bg: "rgba(249,115,22,.12)", border: "#f97316", text: "#c2410c" },
};

const GLOSSARY_TERMS = [
  // Power & Energy
  { term: "Megawatt (MW)", category: "Power & Energy",
    definition: "A unit of electrical power equal to one million watts. Data centers are measured in megawatts of power capacity.",
    means: "A 100MW data center draws enough electricity to continuously power approximately 75,000 average American homes. When you see a facility listed as 500MW, that is the equivalent power demand of a mid-sized city, concentrated in a single building near your neighborhood.",
    example: "Amazon's Northern Virginia data centers collectively draw over 2,000MW." },
  { term: "Gigawatt (GW)", category: "Power & Energy",
    definition: "One thousand megawatts. Used to describe regional or national-scale power demand.",
    means: "The entire data center industry in Virginia now consumes over 20% of the state's total electricity generation. When planners talk about gigawatt-scale demand, they are describing infrastructure that reshapes entire regional power grids." },
  { term: "Power Draw", category: "Power & Energy",
    definition: "The amount of electricity a facility consumes during normal operation.",
    means: "Higher power draw generally means larger cooling systems, more diesel backup generators, more substation infrastructure nearby and greater strain on the local grid. All of these have direct environmental and noise implications for surrounding neighborhoods." },
  { term: "PUE (Power Usage Effectiveness)", category: "Power & Energy",
    definition: "A ratio measuring how efficiently a data center uses electricity. A PUE of 1.0 would be perfect efficiency. Most facilities operate between 1.2 and 1.5.",
    means: "A facility with a PUE of 1.5 uses 50% more electricity than its servers actually need. The rest goes to cooling, lighting and other overhead. Less efficient facilities generate more waste heat and require more cooling water." },
  { term: "Load Factor", category: "Power & Energy",
    definition: "The ratio of a facility's average power consumption to its maximum capacity.",
    means: "A high load factor means the facility is running near full capacity most of the time, which affects noise levels, cooling demand and grid strain in your area consistently rather than occasionally." },

  // Infrastructure
  { term: "Interconnection Queue", category: "Infrastructure",
    definition: "A formal waiting list that companies must join before connecting large new power loads to the electric grid. Managed by regional grid operators like PJM (Mid-Atlantic) or MISO (Midwest).",
    means: "When a company submits an interconnection request in your area, it is one of the earliest public signals that a large facility is being planned, often 12 to 36 months before construction begins. The interconnection queue is publicly available and is one of the primary sources HumZones uses to identify planned facilities before they appear in local news.",
    example: "PJM's interconnection queue for the Mid-Atlantic region contains hundreds of gigawatts of pending requests, many of them data centers in Northern Virginia." },
  { term: "Substation", category: "Infrastructure",
    definition: "An electrical facility that transforms voltage levels to distribute power across the grid. Large data centers typically require dedicated substations or significant upgrades to existing ones.",
    means: "New substations or substation upgrades near your home are often a sign that large-scale power infrastructure is being planned in your area. Substations produce a continuous low-frequency hum and require significant land." },
  { term: "Transmission Upgrade", category: "Infrastructure",
    definition: "Improvements to high-voltage power lines and related infrastructure to handle increased electricity demand.",
    means: "When utility companies file for transmission upgrades in a specific corridor, it frequently signals that large power consumers like data centers are being planned in that area. These filings are public documents." },
  { term: "Balancing Authority", category: "Infrastructure",
    definition: "An organization responsible for matching electricity supply with demand in real time across a defined geographic area. Examples include PJM, ERCOT and MISO.",
    means: "When data center clusters grow large enough, balancing authorities sometimes have to redesign entire regional grid segments to accommodate them. This can affect electricity reliability and rates for everyone in the region, not just people living near a specific facility." },
  { term: "Diesel Generator (Emergency Backup)", category: "Infrastructure",
    definition: "Large diesel-powered generators that data centers maintain to keep servers running during power outages. Facilities may have dozens of generators capable of running for days.",
    means: "Diesel generators produce significant exhaust, noise and particulate emissions when tested or activated. Many large data centers test their generators monthly, often at night. Regular generator testing is one of the most common complaints among residents near large facilities." },
  { term: "Cooling Tower", category: "Infrastructure",
    definition: "Large evaporative cooling systems that remove heat from data center equipment by evaporating water into the atmosphere.",
    means: "Cooling towers consume millions of gallons of water daily, produce visible water vapor plumes, and generate continuous operational noise. They are one of the primary sources of water consumption and noise in large data center campuses." },

  // Environmental
  { term: "WUE (Water Usage Effectiveness)", category: "Environmental",
    definition: "An industry standard metric measuring how much water a data center uses per unit of computing work performed. Measured in liters per kilowatt-hour.",
    means: "A large data center with a WUE of 1.5 and 100MW of power draw consumes approximately 1.3 million gallons of water per day. This water is primarily removed from the local hydrological cycle through evaporation, which can stress local water supplies in drought-prone areas." },
  { term: "CO2 Equivalent Emissions", category: "Environmental",
    definition: "A standardized measure of greenhouse gas emissions that converts different gases into their carbon dioxide equivalent for comparison purposes.",
    means: "The modeled CO2 estimates in HumZones reports are calculated by applying EPA regional emissions factors to a facility's reported power draw. A 100MW data center in a coal-heavy grid region produces approximately the same annual emissions as 80,000 cars." },
  { term: "Noise Floor", category: "Environmental",
    definition: "The baseline ambient noise level in a given area, typically measured in decibels (dB).",
    means: "Data center cooling systems operate 24 hours a day 7 days a week including overnight. Even a modest increase in the ambient noise floor (say from 45dB to 55dB) can significantly affect sleep quality for nearby residents, particularly because data center noise tends to be low-frequency and difficult to block with standard insulation." },
  { term: "EMF (Electromagnetic Field)", category: "Environmental",
    definition: "Invisible fields of energy associated with the use of electrical power and wireless technology. Measured in milliGauss (mG) near power infrastructure.",
    means: "The EMF figures in HumZones reports are modeled estimates based on facility power draw and distance. They are not certified measurements. Research by WHO and IARC has examined potential associations between long-term EMF exposure and health outcomes. HumZones makes no health claims; we provide estimates so residents can ask informed questions." },

  // Regulatory
  { term: "FOIA (Freedom of Information Act)", category: "Regulatory",
    definition: "A federal law that gives the public the right to request access to records from any federal agency.",
    means: "Many of the documents HumZones relies on (interconnection applications, environmental assessments, utility filings) are obtained through FOIA requests or state-level public records laws. You can also request these documents yourself. HumZones can help you understand what to look for." },
  { term: "Special Use Permit (SUP)", category: "Regulatory",
    definition: "A local government approval required for certain land uses that are not automatically permitted under existing zoning, including data centers in some jurisdictions.",
    means: "If a data center requires a Special Use Permit in your area, there will be a public hearing before it is approved. This is your opportunity to attend, speak and have your concerns entered into the public record." },
  { term: "Zoning Classification", category: "Regulatory",
    definition: "A local government designation that determines what types of buildings and activities are permitted on a given piece of land.",
    means: "Data centers are typically classified as industrial or commercial uses. Many jurisdictions have updated their zoning codes to either encourage or restrict data center development. Checking the zoning classification of land near your home can give you early warning of potential development." },
  { term: "Environmental Impact Assessment (EIA)", category: "Regulatory",
    definition: "A study required for certain large projects that evaluates their potential environmental effects before approval.",
    means: "Not all data centers require a full EIA, and requirements vary by jurisdiction and project size. When an EIA is required it is a public document that residents can review and comment on." },

  // Data Centers
  { term: "Hyperscale Data Center", category: "Data Centers",
    definition: "A data center exceeding 100MW of power capacity, typically operated by a major cloud provider such as Amazon Web Services, Microsoft Azure, Google Cloud or Meta.",
    means: "Hyperscale facilities are among the largest buildings on earth by power consumption. A single hyperscale campus can contain multiple buildings each drawing 100MW or more. Northern Virginia is home to the highest concentration of hyperscale infrastructure in the world." },
  { term: "Colocation Facility (Colo)", category: "Data Centers",
    definition: "A data center that rents space, power and cooling to multiple companies rather than being operated for a single user.",
    means: "Colocation facilities like those operated by Equinix, Digital Realty and Iron Mountain may have dozens of tenants including financial institutions, government agencies and cloud providers. They are often located in dense urban or suburban areas." },
  { term: "Edge Data Center", category: "Data Centers",
    definition: "Smaller data centers located closer to end users to reduce latency, rather than in large centralized campuses.",
    means: "As edge computing grows, smaller data centers are being built in more neighborhoods, including areas that previously had no such infrastructure. These facilities are often harder to identify through traditional means because they are smaller and attract less public attention." },
  { term: "Data Center Campus", category: "Data Centers",
    definition: "A collection of multiple data center buildings operated together on the same site or in close geographic proximity.",
    means: "What may appear to be a single data center building often becomes a multi-building campus over time as operators expand capacity. Campus development means the initial footprint (noise, power, traffic, water) grows significantly after the first building opens." },
  { term: "PUE Certification", category: "Data Centers",
    definition: "Independent verification of a data center's Power Usage Effectiveness rating by a third party.",
    means: "Unlike certified measurements, most environmental figures associated with data centers (including those in HumZones reports) are self-reported or modeled estimates. There is currently no mandatory independent certification regime for data center environmental impact in the United States." },
];

const GlossaryPage = ({ onNavigate }) => {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");
  // Per-card open/close state for the "What this means for you" block so
  // mobile viewers can collapse long cards and scan the list quickly.
  // Desktop tends to leave them open by default via the inline media
  // query on the toggle button.
  const [openMeans, setOpenMeans] = useState({}); // term -> bool override
  const [showBackToTop, setShowBackToTop] = useState(false);

  // Page title + meta tags + DefinedTermSet JSON-LD for the glossary.
  // Cleaned up on unmount so the tags do not leak into other pages.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = "Data Center Glossary | Plain Language Guide | HumZones";

    injectHeadEl("meta", "glossary-desc",           { name: "description",         content: "Plain language definitions of data center infrastructure terms. Interconnection queues, megawatts, balancing authorities, WUE, hyperscale and more explained for residents not engineers." });
    injectHeadEl("link", "glossary-canonical",      { rel: "canonical",            href: "https://humzones.com/glossary" });
    injectHeadEl("meta", "glossary-og-title",       { property: "og:title",        content: "Data Center Glossary | HumZones" });
    injectHeadEl("meta", "glossary-og-description", { property: "og:description",  content: "Translate data center jargon into plain language. Interconnection queues, megawatts, balancing authorities and more explained for residents." });
    injectHeadEl("meta", "glossary-og-url",         { property: "og:url",          content: "https://humzones.com/glossary" });
    injectHeadEl("meta", "glossary-og-type",        { property: "og:type",         content: "website" });
    injectHeadEl("meta", "glossary-og-site",        { property: "og:site_name",    content: "HumZones" });
    injectHeadEl("meta", "glossary-tw-card",        { name: "twitter:card",        content: "summary" });
    injectHeadEl("meta", "glossary-tw-title",       { name: "twitter:title",       content: "Data Center Glossary | HumZones" });
    injectHeadEl("meta", "glossary-tw-description", { name: "twitter:description", content: "Plain language definitions of data center infrastructure terms for residents." });

    const definedTermSet = {
      "@context": "https://schema.org",
      "@type":    "DefinedTermSet",
      "name":        "Data Center Infrastructure Glossary",
      "description": "Plain language definitions of data center infrastructure terms for residents",
      "url":         "https://humzones.com/glossary",
      "hasDefinedTerm": [
        {
          "@type":      "DefinedTerm",
          "name":        "Megawatt (MW)",
          "description": "A unit of electrical power equal to one million watts. A 100MW data center draws enough electricity to continuously power approximately 75,000 average American homes.",
          "inDefinedTermSet": "https://humzones.com/glossary",
        },
        {
          "@type":      "DefinedTerm",
          "name":        "Interconnection Queue",
          "description": "A formal waiting list that companies must join before connecting large new power loads to the electric grid. One of the earliest public signals that a large facility is being planned.",
          "inDefinedTermSet": "https://humzones.com/glossary",
        },
        {
          "@type":      "DefinedTerm",
          "name":        "Balancing Authority",
          "description": "An organization responsible for matching electricity supply with demand in real time across a defined geographic area such as PJM or ERCOT.",
          "inDefinedTermSet": "https://humzones.com/glossary",
        },
        {
          "@type":      "DefinedTerm",
          "name":        "WUE (Water Usage Effectiveness)",
          "description": "An industry standard metric measuring how much water a data center uses per unit of computing work. A large data center can consume over one million gallons of water per day.",
          "inDefinedTermSet": "https://humzones.com/glossary",
        },
        {
          "@type":      "DefinedTerm",
          "name":        "Hyperscale Data Center",
          "description": "A data center exceeding 100MW of power capacity typically operated by Amazon, Microsoft, Google or Meta.",
          "inDefinedTermSet": "https://humzones.com/glossary",
        },
        {
          "@type":      "DefinedTerm",
          "name":        "Diesel Generator (Emergency Backup)",
          "description": "Large diesel-powered generators that data centers maintain during power outages. May be tested monthly producing significant noise and exhaust emissions near residential areas.",
          "inDefinedTermSet": "https://humzones.com/glossary",
        },
        {
          "@type":      "DefinedTerm",
          "name":        "Cooling Tower",
          "description": "Large evaporative systems that remove heat by evaporating water. Can consume millions of gallons daily and produce continuous operational noise.",
          "inDefinedTermSet": "https://humzones.com/glossary",
        },
        {
          "@type":      "DefinedTerm",
          "name":        "Colocation Facility",
          "description": "A data center that rents space and power to multiple companies rather than a single operator. Often located in dense urban or suburban areas.",
          "inDefinedTermSet": "https://humzones.com/glossary",
        },
        {
          "@type":      "DefinedTerm",
          "name":        "PUE (Power Usage Effectiveness)",
          "description": "A ratio measuring how efficiently a data center uses electricity. A PUE of 1.5 means 50% more electricity is consumed than the servers actually need.",
          "inDefinedTermSet": "https://humzones.com/glossary",
        },
        {
          "@type":      "DefinedTerm",
          "name":        "Special Use Permit",
          "description": "A local government approval required for certain land uses including data centers in some jurisdictions. Typically requires a public hearing giving residents an opportunity to comment.",
          "inDefinedTermSet": "https://humzones.com/glossary",
        },
      ],
    };
    injectHeadEl("script", "glossary-jsonld", { type: "application/ld+json" }, JSON.stringify(definedTermSet));

    return () => {
      [
        "glossary-desc","glossary-canonical",
        "glossary-og-title","glossary-og-description","glossary-og-url","glossary-og-type","glossary-og-site",
        "glossary-tw-card","glossary-tw-title","glossary-tw-description",
        "glossary-jsonld",
      ].forEach(removeHeadEl);
    };
  }, []);

  // Show the back-to-top button once the user has scrolled past roughly
  // three rows of glossary cards.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onScroll = () => setShowBackToTop(window.scrollY > 900);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = GLOSSARY_TERMS.filter(t => {
    if (activeCategory !== "All" && t.category !== activeCategory) return false;
    if (!q) return true;
    return t.term.toLowerCase().includes(q) ||
           t.definition.toLowerCase().includes(q) ||
           (t.means || "").toLowerCase().includes(q);
  });

  return (
    <div style={{minHeight:"100vh",background:"#f1f5f9",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>
      {/* HERO */}
      <section style={{background:"linear-gradient(150deg,#020c1b 0%,#0f172a 45%,#1e0535 100%)",padding:"56px 24px 60px"}}>
        <div style={{maxWidth:820,margin:"0 auto",textAlign:"center"}}>
          <div style={{display:"inline-block",fontSize:12,color:"#f97316",letterSpacing:".18em",textTransform:"uppercase",fontWeight:800,marginBottom:14,padding:"6px 14px",borderRadius:30,background:"rgba(249,115,22,.12)",border:"1px solid rgba(249,115,22,.3)"}}>Infrastructure Glossary</div>
          <h1 style={{fontSize:"clamp(26px,4vw,34px)",fontWeight:900,letterSpacing:"-.02em",color:"#fff",lineHeight:1.2,marginBottom:14}}>
            Understanding the Language of Data Center Infrastructure
          </h1>
          <div style={{width:60,height:3,background:"#f97316",borderRadius:2,margin:"0 auto 20px"}}/>
          <p style={{fontSize:16,color:"rgba(255,255,255,.72)",lineHeight:1.65,maxWidth:680,margin:"0 auto"}}>
            Data center development comes with a vocabulary most people were never meant to understand. We translate it.
          </p>
        </div>
      </section>

      {/* INTRO BOX */}
      <section style={{maxWidth:880,margin:"0 auto",padding:"36px 24px 0"}}>
        <div style={{background:"#f1f5f9",border:"1px solid #e2e8f0",borderRadius:12,padding:"22px 24px"}}>
          <p style={{fontSize:15,color:"#475569",lineHeight:1.7,margin:0}}>
            When a utility filing mentions a 500MW interconnection request near your neighborhood, what does that actually mean for the people who live there? HumZones exists to answer that question. Below are the most common terms you will encounter in planning documents, news articles and utility filings, explained in plain language.
          </p>
        </div>
      </section>

      {/* SEARCH + CATEGORY PILLS */}
      <section style={{maxWidth:880,margin:"0 auto",padding:"24px 24px 0"}}>
        <input
          value={search}
          onChange={e=>setSearch(e.target.value)}
          placeholder="Search terms..."
          style={{width:"100%",padding:"14px 16px",borderRadius:12,border:"1.5px solid #e2e8f0",fontSize:15,fontFamily:"inherit",color:"#0f172a",background:"#fff",outline:"none",boxSizing:"border-box",marginBottom:14}}
        />
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {["All", ...GLOSSARY_CATEGORIES].map(cat => {
            const active = activeCategory === cat;
            return (
              <button
                key={cat}
                onClick={()=>setActiveCategory(cat)}
                style={{padding:"8px 16px",borderRadius:999,border:`1.5px solid ${active?"#f97316":"#e2e8f0"}`,background:active?"#f97316":"#fff",color:active?"#fff":"#475569",fontFamily:"inherit",fontSize:13,fontWeight:800,letterSpacing:".02em",cursor:"pointer"}}
              >
                {cat}
              </button>
            );
          })}
        </div>
      </section>

      {/* GLOSSARY CARDS */}
      <section style={{maxWidth:880,margin:"0 auto",padding:"22px 24px 16px"}}>
        {filtered.length === 0 ? (
          <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,padding:"30px 24px",textAlign:"center",color:"#64748b"}}>
            No terms match that search. Try a different keyword or clear the category filter.
          </div>
        ) : (
          <div className="glossary-grid" style={{display:"grid",gridTemplateColumns:"repeat(2, 1fr)",gap:14}}>
            {filtered.map(t => {
              const c = GLOSSARY_CATEGORY_COLOR[t.category] || { bg:"#f1f5f9", border:"#cbd5e1", text:"#475569" };
              const isOpen = openMeans[t.term] !== false; // default open
              return (
                <article key={t.term} className="glossary-card" style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,padding:"20px 22px 18px",boxShadow:"0 2px 10px rgba(0,0,0,.04)",display:"flex",flexDirection:"column",gap:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,flexWrap:"wrap"}}>
                    <h3 style={{fontSize:16,fontWeight:800,color:"#0f172a",letterSpacing:"-.01em",margin:0,lineHeight:1.3,flex:"1 1 auto"}}>{t.term}</h3>
                    <span style={{display:"inline-block",fontSize:10,fontWeight:800,letterSpacing:".08em",textTransform:"uppercase",padding:"3px 9px",borderRadius:999,background:c.bg,border:`1px solid ${c.border}`,color:c.text,whiteSpace:"nowrap"}}>{t.category}</span>
                  </div>
                  <p style={{fontSize:14,color:"#475569",lineHeight:1.65,margin:0}}>{t.definition}</p>
                  <button
                    className="glossary-toggle"
                    onClick={()=>setOpenMeans(p=>({...p,[t.term]: !(p[t.term] !== false)}))}
                    style={{display:"none",alignSelf:"flex-start",padding:0,background:"transparent",border:"none",color:"#f97316",fontFamily:"inherit",fontSize:13,fontWeight:800,cursor:"pointer"}}
                  >
                    {isOpen ? "Hide what this means ▲" : "What this means for you ▼"}
                  </button>
                  {isOpen && (
                    <div style={{background:"#fff7ed",borderLeft:"3px solid #f97316",borderRadius:8,padding:"12px 14px"}}>
                      <div style={{fontSize:11,color:"#c2410c",letterSpacing:".10em",textTransform:"uppercase",fontWeight:800,marginBottom:6}}>What this means for you</div>
                      <p style={{fontSize:13,color:"#7c2d12",lineHeight:1.65,margin:0}}>{t.means}</p>
                    </div>
                  )}
                  {t.example && (
                    <p style={{fontSize:12,color:"#94a3b8",fontStyle:"italic",lineHeight:1.55,margin:0}}>Example: {t.example}</p>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* CALLOUT TO /learn */}
      <section style={{maxWidth:880,margin:"0 auto",padding:"22px 24px 24px"}}>
        <div style={{background:"#fff7ed",border:"1px solid #fed7aa",borderLeft:"4px solid #f97316",borderRadius:12,padding:"18px 22px"}}>
          <p style={{fontSize:15,color:"#7c2d12",lineHeight:1.65,margin:0}}>
            Want to go deeper? Read our resident guides at{" "}
            <a href="/learn" onClick={e=>{e.preventDefault();onNavigate("/learn");}} style={{color:"#c2410c",fontWeight:800,textDecoration:"none"}}>humzones.com/learn</a>.
          </p>
        </div>
      </section>

      {/* NEWSLETTER CALLOUT */}
      <section style={{maxWidth:880,margin:"0 auto",padding:"0 24px 56px"}}>
        <div style={{background:"linear-gradient(150deg,#0a1628 0%,#0f172a 50%,#1e0535 100%)",borderRadius:12,padding:"32px",border:"1px solid rgba(249,115,22,.28)",marginTop:24}}>
          <h3 style={{fontSize:20,fontWeight:900,color:"#fff",letterSpacing:"-.01em",margin:"0 0 4px"}}>Get Infrastructure Intelligence</h3>
          <p style={{fontSize:14,color:"#f97316",fontWeight:700,margin:"0 0 10px"}}>Free every Monday and Thursday. Data center news in plain language.</p>
          <p style={{fontSize:13,color:"rgba(255,255,255,.7)",lineHeight:1.65,margin:"0 0 16px"}}>Mondays bring interconnection queue filings. Thursdays bring facility announcements and community impact stories. Translated for residents, not engineers.</p>
          <NewsletterSignupForm source="Glossary Page" variant="light" showFirstName={false} compact/>
        </div>
      </section>

      {/* BACK TO TOP */}
      {showBackToTop && (
        <button
          onClick={()=>{ if (typeof window !== "undefined") window.scrollTo({top:0,behavior:"smooth"}); }}
          aria-label="Back to top"
          style={{position:"fixed",bottom:24,right:24,zIndex:200,padding:"12px 18px",borderRadius:30,border:"none",background:"#0f172a",color:"#fff",fontFamily:"inherit",fontSize:13,fontWeight:800,letterSpacing:".02em",cursor:"pointer",boxShadow:"0 14px 32px rgba(0,0,0,.32)",display:"inline-flex",alignItems:"center",gap:8}}
        >
          &uarr; Back to top
        </button>
      )}

      {/* Collapse to one column on mobile, and reveal the per-card
          "What this means" toggle button only on narrow viewports. */}
      <style>{`
        @media(max-width:680px){
          .glossary-grid{grid-template-columns:1fr!important}
          .glossary-toggle{display:inline-block!important}
        }
      `}</style>

      <Footer onNavigate={onNavigate}/>
    </div>
  );
};

// ─── /donate: DONATIONS PAGE ─────────────────────────────────────────────────
// Stripe Payment Link URLs for one-time and recurring donations. Each link
// must be configured in the Stripe dashboard to redirect on success to
// /donate-thank-you with type, amount, and session_id query params, e.g.
//   https://humzones.com/donate-thank-you?type=one-time&amount=25&session_id={CHECKOUT_SESSION_ID}
// Swap the placeholder strings below with the live Payment Link URLs.
const DONATE_LINKS = {
  oneTime: {
    5:   "STRIPE_DONATE_OT_5",
    10:  "STRIPE_DONATE_OT_10",
    25:  "STRIPE_DONATE_OT_25",
    50:  "STRIPE_DONATE_OT_50",
    100: "STRIPE_DONATE_OT_100",
    custom: "STRIPE_DONATE_OT_CUSTOM",
  },
  monthly: {
    3:   "STRIPE_DONATE_MO_3",
    5:   "STRIPE_DONATE_MO_5",
    10:  "STRIPE_DONATE_MO_10",
    15:  "STRIPE_DONATE_MO_15",
    25:  "STRIPE_DONATE_MO_25",
    custom: "STRIPE_DONATE_MO_CUSTOM",
  },
};

// Airtable Donations table identifiers. Field IDs are used so column
// renames in Airtable cannot break the POST.
const DONATIONS_TABLE = "tblM7lnzFRgLCMDrE";
const DONATIONS_FIELD = {
  Email:             "fldsKVLLaXxDkXDuy",
  Amount:            "fld7tNLBOXDUoNb8X",
  Type:              "fldKA7PN2HLwKH5eS",
  Date:              "fld3KtugwMn3x8KQN",
  Stripe_Session_ID: "fldk56iasW2i0xM0Z",
};

const DonatePage = ({ onNavigate, facilityCount }) => {
  const [mode, setMode] = useState("oneTime"); // "oneTime" or "monthly"
  const [selected, setSelected] = useState(null); // a preset number or "custom"
  const [customAmount, setCustomAmount] = useState("");

  // SEO + social meta. Cleaned up on unmount.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = "Support HumZones | Help Keep Communities Informed";

    injectHeadEl("meta", "donate-desc",      { name: "description",         content: "Support HumZones, the independent data center infrastructure registry. Your donation funds database expansion, research and keeps the site free for residents worldwide." });
    injectHeadEl("link", "donate-canonical", { rel: "canonical",            href: "https://humzones.com/donate" });
    injectHeadEl("meta", "donate-og-title",  { property: "og:title",        content: "Support HumZones | Independent Registry" });
    injectHeadEl("meta", "donate-og-desc",   { property: "og:description",  content: "Help fund the global data center infrastructure registry. One-time or monthly. Every dollar helps reach more communities." });
    injectHeadEl("meta", "donate-og-url",    { property: "og:url",          content: "https://humzones.com/donate" });
    injectHeadEl("meta", "donate-og-type",   { property: "og:type",         content: "website" });
    injectHeadEl("meta", "donate-og-site",   { property: "og:site_name",    content: "HumZones" });
    injectHeadEl("meta", "donate-tw-card",   { name: "twitter:card",        content: "summary" });
    injectHeadEl("meta", "donate-tw-title",  { name: "twitter:title",       content: "Support HumZones" });
    injectHeadEl("meta", "donate-tw-desc",   { name: "twitter:description", content: "Help fund the independent data center infrastructure registry. One-time or monthly donations." });

    return () => {
      [
        "donate-desc","donate-canonical",
        "donate-og-title","donate-og-desc","donate-og-url","donate-og-type","donate-og-site",
        "donate-tw-card","donate-tw-title","donate-tw-desc",
      ].forEach(removeHeadEl);
    };
  }, []);

  // Reset the picked tier whenever the mode toggles so an old selection
  // from the other cadence never carries over.
  const switchMode = (m) => {
    if (m === mode) return;
    setMode(m);
    setSelected(null);
    setCustomAmount("");
  };

  const presets = mode === "oneTime"
    ? [5, 10, 25, 50, 100]
    : [3, 5, 10, 15, 25];

  // Each Stripe Payment Link is configured with its own success URL that
  // already carries ?type=...&amount=... so the thank-you page can render
  // the right copy regardless of which link was clicked. We only append
  // client_reference_id here when we have an email to attach (logged-in
  // business users); anonymous donors keep flowing without it.
  const startCheckout = () => {
    let url = null;
    if (selected === "custom") {
      const v = parseFloat(customAmount);
      if (!Number.isFinite(v) || v <= 0) return;
      url = DONATE_LINKS[mode].custom;
    } else if (typeof selected === "number") {
      url = DONATE_LINKS[mode][selected];
    } else {
      return;
    }
    if (!url) return;
    let email = "";
    try {
      const acct = readBusinessAccount();
      if (acct && acct.email) email = acct.email;
    } catch {}
    if (email) {
      const join = url.includes("?") ? "&" : "?";
      url = url + join + "client_reference_id=" + encodeURIComponent(email);
    }
    window.location.href = url;
  };

  const isReady = (selected === "custom" && parseFloat(customAmount) > 0) || typeof selected === "number";
  const effectiveAmount = selected === "custom" ? customAmount : selected;
  const ctaLabel = mode === "monthly"
    ? "Start $" + (effectiveAmount || "0") + "/mo"
    : "Donate $" + (effectiveAmount || "0") + " Now";

  // Dynamic facility count mirrors the home page stats strip. Falls back
  // to a neutral phrase until the Airtable fetch lands so the page never
  // shows a hard-coded number.
  const missionStat = (Number.isFinite(facilityCount) && facilityCount > 0)
    ? "Over " + facilityCount.toLocaleString() + " facilities tracked. Millions of people live near data center infrastructure without knowing it. Every dollar helps us reach more communities."
    : "Thousands of facilities tracked. Millions of people live near data center infrastructure without knowing it. Every dollar helps us reach more communities.";

  // Icons are pulled from the shared Icon component so the donate tiles
  // visually match the rest of the site (stroked SVGs in HumZones orange).
  const fundBoxes = [
    { icon: "database", title: "Database Growth",  desc: "Expanding our registry to cover more facilities worldwide." },
    { icon: "search",   title: "Research",         desc: "Sourcing and verifying facility data from public records." },
    { icon: "monitor",  title: "Infrastructure",   desc: "Server costs, hosting and keeping the site fast and free." },
    { icon: "scales",   title: "Legal Protection", desc: "Protecting the community voice against pressure campaigns." },
  ];

  const pillStyle = (active) => ({
    flex: 1,
    padding: "14px 22px",
    borderRadius: 999,
    border: active ? "2px solid #f97316" : "2px solid #e2e8f0",
    background: active ? "#f97316" : "#fff",
    color: active ? "#fff" : "#475569",
    fontSize: 15,
    fontWeight: 800,
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "all .15s",
  });

  const amountCardStyle = (active) => ({
    background: active ? "#f97316" : "#fff",
    border: active ? "2px solid #f97316" : "2px solid #e2e8f0",
    borderRadius: 14,
    padding: "20px 12px",
    textAlign: "center",
    cursor: "pointer",
    fontFamily: "inherit",
    transition: "all .15s",
    color: active ? "#fff" : "#0f172a",
  });

  return (
    <div style={{minHeight:"100vh",background:"#f8fafc",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>
      {/* HERO */}
      <section style={{background:"linear-gradient(150deg,#020c1b 0%,#0f172a 45%,#1e0535 100%)",padding:"60px 24px 70px"}}>
        <div style={{maxWidth:820,margin:"0 auto",textAlign:"center"}}>
          <div style={{display:"inline-block",fontSize:12,color:"#f97316",letterSpacing:".18em",textTransform:"uppercase",fontWeight:800,marginBottom:14,padding:"6px 14px",borderRadius:30,background:"rgba(249,115,22,.12)",border:"1px solid rgba(249,115,22,.3)"}}>Support HumZones</div>
          <h1 style={{fontSize:"clamp(34px,5.5vw,52px)",fontWeight:900,letterSpacing:"-.02em",color:"#fff",lineHeight:1.1,marginBottom:14}}>
            Help Us Keep Communities Informed
          </h1>
          <div style={{width:60,height:3,background:"#f97316",borderRadius:2,margin:"0 auto 22px"}}/>
          <p style={{fontSize:17,color:"rgba(255,255,255,.78)",lineHeight:1.65,maxWidth:680,margin:"0 auto"}}>
            HumZones is an independent public awareness project. We track data center infrastructure so residents can understand what is being built near their homes. Your support keeps the database growing and the lights on.
          </p>
        </div>
      </section>

      {/* WHAT DONATIONS FUND */}
      <section style={{maxWidth:1100,margin:"0 auto",padding:"48px 24px 12px"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:18}}>
          {fundBoxes.map(b => (
            <div key={b.title} style={{background:"#f1f5f9",border:"1px solid #e2e8f0",borderRadius:14,padding:"22px 20px"}}>
              <div style={{marginBottom:10,lineHeight:1}}><Icon name={b.icon} size={32} color="#f97316"/></div>
              <div style={{fontSize:15,fontWeight:800,color:"#0f172a",marginBottom:6}}>{b.title}</div>
              <div style={{fontSize:13,color:"#64748b",lineHeight:1.55}}>{b.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* DONATE PANEL */}
      <section style={{maxWidth:720,margin:"0 auto",padding:"40px 24px"}}>
        <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:18,padding:"28px 28px 30px",boxShadow:"0 8px 32px rgba(15,23,42,.06)"}}>
          {/* One-time vs monthly toggle */}
          <div style={{display:"flex",gap:10,marginBottom:24}}>
            <button onClick={()=>switchMode("oneTime")} style={pillStyle(mode === "oneTime")}>Give Once</button>
            <button onClick={()=>switchMode("monthly")} style={pillStyle(mode === "monthly")}>Give Monthly</button>
          </div>

          {/* Amount grid: 2 rows x 3 columns */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
            {presets.map(n => {
              const active = selected === n;
              return (
                <button key={n} onClick={()=>{setSelected(n);setCustomAmount("");}} style={amountCardStyle(active)}>
                  <div style={{fontSize:24,fontWeight:900,letterSpacing:"-.01em"}}>${n}</div>
                  <div style={{fontSize:11,color:active?"rgba(255,255,255,.85)":"#94a3b8",marginTop:4,fontWeight:600}}>
                    {mode === "monthly" ? "per month" : "one-time gift"}
                  </div>
                </button>
              );
            })}
            {/* Custom button slot */}
            <button onClick={()=>setSelected("custom")} style={amountCardStyle(selected === "custom")}>
              <div style={{fontSize:18,fontWeight:900,letterSpacing:"-.01em"}}>Custom</div>
              <div style={{fontSize:11,color:selected==="custom"?"rgba(255,255,255,.85)":"#94a3b8",marginTop:4,fontWeight:600}}>
                {mode === "monthly" ? "your amount/mo" : "your amount"}
              </div>
            </button>
          </div>

          {/* Custom amount input (revealed when Custom is selected) */}
          {selected === "custom" && (
            <div style={{marginTop:16}}>
              <label style={{fontSize:13,fontWeight:700,color:"#0f172a",display:"block",marginBottom:6}}>
                Enter your amount {mode === "monthly" ? "(per month)" : ""}
              </label>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:20,fontWeight:900,color:"#0f172a"}}>$</span>
                <input
                  type="number" min="1" step="1"
                  value={customAmount}
                  onChange={e=>setCustomAmount(e.target.value)}
                  placeholder="50"
                  style={{flex:1,padding:"12px 14px",borderRadius:10,border:"1.5px solid #e2e8f0",fontSize:16,fontFamily:"inherit",outline:"none"}}
                />
              </div>
            </div>
          )}

          {/* CTA */}
          {isReady && (
            <button
              onClick={startCheckout}
              style={{width:"100%",marginTop:22,padding:"16px 24px",borderRadius:14,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:16,fontWeight:900,letterSpacing:".02em",cursor:"pointer",fontFamily:"inherit",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}
            >
              {ctaLabel}
            </button>
          )}
        </div>

        {/* Transparency note */}
        <div style={{marginTop:22,background:"#f1f5f9",borderLeft:"3px solid #3b82f6",borderRadius:8,padding:"14px 16px"}}>
          <p style={{fontSize:13,color:"#1e3a8a",lineHeight:1.6,margin:0}}>
            We are transparent about how donations are used. HumZones is independently operated. Donations help cover server costs, data research and database maintenance. No donation data is ever sold. You can cancel a monthly donation at any time by contacting{" "}
            <a href="mailto:hello@humzones.com" style={{color:"#f97316",fontWeight:700,textDecoration:"none"}}>hello@humzones.com</a>.
          </p>
        </div>

        {/* Mission stat */}
        <div style={{marginTop:22,textAlign:"center",padding:"18px 4px"}}>
          <p style={{fontSize:14,color:"#475569",lineHeight:1.65,margin:0}}>
            {missionStat}
          </p>
        </div>
      </section>

      <Footer onNavigate={onNavigate}/>
    </div>
  );
};

// ─── /donate-thank-you: POST-CHECKOUT CONFIRMATION ───────────────────────────
const DonateThankYouPage = ({ onNavigate }) => {
  // Stripe's Payment Link success URLs are pre-configured with
  // ?type=one-time&amount=AMOUNT&session_id={CHECKOUT_SESSION_ID}, so we
  // can read everything directly from the URL. client_reference_id, if
  // present, carries the donor's email (passed through by the donate
  // page when the user is signed in to a business account).
  const params = useMemo(() => new URLSearchParams(typeof window !== "undefined" ? window.location.search : ""), []);
  const sessionId = params.get("session_id") || "";
  const typeParam = (params.get("type") || "").toLowerCase();
  const amountParam = params.get("amount") || "";
  const emailParam = params.get("email") || params.get("client_reference_id") || "";
  const isMonthly = typeParam === "monthly";
  const amountNum = parseFloat(amountParam);

  // useRef guard prevents the Airtable POST from firing twice under
  // React 18 StrictMode (which mounts effects twice in development).
  const savedRef = useRef(false);
  useEffect(() => {
    if (savedRef.current) return;
    if (!sessionId) return;
    savedRef.current = true;
    const today = new Date().toISOString().slice(0, 10);
    const fields = {
      [DONATIONS_FIELD.Date]: today,
      [DONATIONS_FIELD.Type]: isMonthly ? "Monthly" : "One-Time",
      [DONATIONS_FIELD.Stripe_Session_ID]: sessionId,
    };
    if (Number.isFinite(amountNum) && amountNum > 0) {
      fields[DONATIONS_FIELD.Amount] = amountNum;
    }
    if (emailParam) fields[DONATIONS_FIELD.Email] = emailParam;
    fetch(`${APIURL}/${DONATIONS_TABLE}?returnFieldsByFieldId=true`, {
      method: "POST",
      headers: HDR,
      body: JSON.stringify({ fields }),
    }).catch(e => console.warn("[HumZones] Donations save failed:", e));
  }, [sessionId, amountNum, typeParam, isMonthly, emailParam]);

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",color:"#fff"}}>
      <main style={{maxWidth:620,margin:"0 auto",padding:"60px 24px 80px",textAlign:"center"}}>
        <div style={{width:90,height:90,borderRadius:"50%",background:"linear-gradient(135deg,#ef4444,#f97316)",margin:"0 auto 22px",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 18px 50px rgba(249,115,22,.45)"}}>
          <svg width="44" height="44" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
            <path d="M12 21s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 5.65-7 10-7 10z"/>
          </svg>
        </div>
        <h1 style={{fontSize:30,fontWeight:900,letterSpacing:"-.01em",marginBottom:14}}>Thank You for Supporting HumZones</h1>
        {isMonthly ? (
          <p style={{fontSize:16,color:"rgba(255,255,255,.78)",lineHeight:1.65,marginBottom:24,maxWidth:520,marginLeft:"auto",marginRight:"auto"}}>
            {amountParam ? "Your $" + amountParam + "/month" : "Your monthly"} support means we can plan ahead and keep the database growing. You can cancel anytime by emailing{" "}
            <a href="mailto:hello@humzones.com" style={{color:"#f97316",fontWeight:700,textDecoration:"none"}}>hello@humzones.com</a>.
          </p>
        ) : (
          <p style={{fontSize:16,color:"rgba(255,255,255,.78)",lineHeight:1.65,marginBottom:24,maxWidth:520,marginLeft:"auto",marginRight:"auto"}}>
            {amountParam ? "Your $" + amountParam : "Your"} contribution helps us keep communities informed about the infrastructure being built near their homes.
          </p>
        )}
        <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap",marginTop:8}}>
          <button onClick={()=>onNavigate("/")} style={{padding:"14px 28px",borderRadius:12,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:15,fontWeight:900,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>
            Return Home
          </button>
          <button onClick={()=>onNavigate("/submit-report")} style={{padding:"14px 26px",borderRadius:12,border:"1.5px solid rgba(255,255,255,.25)",background:"transparent",color:"#fff",fontSize:15,fontWeight:800,cursor:"pointer",fontFamily:"inherit"}}>
            Submit Your Experience
          </button>
        </div>
      </main>
      <Footer onNavigate={onNavigate}/>
    </div>
  );
};

// ─── /newsletter: INFRASTRUCTURE INTELLIGENCE NEWSLETTER ─────────────────────
// Public landing page that explains the weekly briefing, captures signups
// (double opt-in via /api/newsletter with type=subscribe), and lists the three most
// recent Sent issues from Airtable. The full /newsletter/:n viewer below
// hangs off this same routing branch.

const NL_ISSUES_TABLE = "tbl3pKjNdgxJGYr0u";
const NL_ISSUE_F = {
  Issue_Title:    "fld7MRgeaH0NCJBIs",
  Issue_Number:   "fldFU6TiYG0FmF9S8",
  Date_Published: "fldqlKArTdhOkKcYI",
  Subject_Line:   "fld57sICLof4DTx33",
  Content_HTML:   "fld4Ege6wX7ijRXiw",
  Status:         "fldKd6AJRxqqzeYJs",
};

// Format an ISO date as "Month DD, YYYY" without pulling in a date lib.
const formatLongDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return months[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear();
};

// Shared signup form. Three layouts so we can drop it on the dark hero
// (variant="dark"), inside a light panel (variant="light"), or inside the
// compact footer column (variant="footer"). Returns the same /api/newsletter
// (type=subscribe) call regardless. Sets localStorage humzones_nl_subscribed on success so
// other in-page prompts can hide themselves.
const NewsletterSignupForm = ({ source, variant = "dark", showFirstName = true, compact = false }) => {
  const [email, setEmail]         = useState("");
  const [firstName, setFirstName] = useState("");
  const [status, setStatus]       = useState("idle"); // idle | submitting | success | error
  const [errMsg, setErrMsg]       = useState("");

  const submit = async () => {
    if (status === "submitting" || status === "success") return;
    const e = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(e)) {
      setStatus("error");
      setErrMsg("Please enter a valid email address.");
      return;
    }
    try { if (sessionStorage.getItem("humzones_nl_submitted") === e) {
      setStatus("success");
      return;
    } } catch {}
    setStatus("submitting");
    setErrMsg("");
    try {
      const r = await fetch("/api/newsletter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "subscribe", email: e, firstName: firstName.trim(), source }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Subscription failed");
      try {
        sessionStorage.setItem("humzones_nl_submitted", e);
        localStorage.setItem("humzones_nl_subscribed", "1");
      } catch {}
      setStatus("success");
    } catch (err) {
      console.error("newsletter subscribe failed:", err);
      setStatus("error");
      setErrMsg("Something went wrong. Please try again or email hello@humzones.com");
    }
  };

  const onKey = (ev) => { if (ev.key === "Enter") submit(); };

  if (status === "success") {
    if (variant === "footer") {
      return <div style={{fontSize:12,color:"#86efac",fontWeight:700,marginTop:4}}>Subscribed! Check your inbox.</div>;
    }
    if (variant === "light") {
      return <div style={{fontSize:14,color:"#15803d",fontWeight:800,padding:"10px 0"}}>Subscribed! Check your inbox to confirm.</div>;
    }
    return (
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"14px 16px",borderRadius:12,background:"rgba(34,197,94,.12)",border:"1px solid rgba(34,197,94,.4)",color:"#86efac",fontWeight:700,fontSize:14}}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#86efac" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
        Almost done! Check your inbox to confirm your subscription.
      </div>
    );
  }

  if (variant === "footer") {
    return (
      <div>
        <input
          type="email"
          value={email}
          onChange={ev=>setEmail(ev.target.value)}
          onKeyDown={onKey}
          placeholder="Your email"
          aria-label="Your email"
          style={{width:"100%",boxSizing:"border-box",background:"#1e293b",border:"1px solid rgba(255,255,255,.16)",color:"#fff",fontSize:12,padding:"8px 10px",borderRadius:6,outline:"none",marginBottom:6,fontFamily:"inherit"}}
        />
        <button
          onClick={submit}
          disabled={status === "submitting"}
          style={{width:"100%",padding:"10px",borderRadius:6,border:"none",background:"#f97316",color:"#fff",fontSize:12,fontWeight:800,cursor:status==="submitting"?"wait":"pointer",fontFamily:"inherit",opacity:status==="submitting"?.7:1}}
        >
          {status === "submitting" ? "Subscribing..." : "Subscribe"}
        </button>
        {status === "error" && <div style={{fontSize:11,color:"#fca5a5",marginTop:6}}>Please try again.</div>}
      </div>
    );
  }

  if (variant === "light") {
    // Inline pill: input + button side-by-side, used on light backgrounds
    // (report-success callout). Compact mode tightens padding.
    return (
      <div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <input
            type="email"
            value={email}
            onChange={ev=>setEmail(ev.target.value)}
            onKeyDown={onKey}
            placeholder="Your email"
            aria-label="Your email"
            style={{flex:"1 1 220px",minWidth:0,boxSizing:"border-box",background:"#fff",border:"1px solid #cbd5e1",color:"#0f172a",fontSize:13,padding:compact?"9px 12px":"11px 14px",borderRadius:8,outline:"none",fontFamily:"inherit"}}
          />
          <button
            onClick={submit}
            disabled={status === "submitting"}
            style={{padding:compact?"9px 16px":"11px 18px",borderRadius:8,border:"none",background:"#f97316",color:"#fff",fontSize:13,fontWeight:800,cursor:status==="submitting"?"wait":"pointer",fontFamily:"inherit",opacity:status==="submitting"?.7:1}}
          >
            {status === "submitting" ? "..." : "Subscribe"}
          </button>
        </div>
        {status === "error" && <div style={{fontSize:12,color:"#b91c1c",marginTop:6,fontWeight:700}}>{errMsg}</div>}
      </div>
    );
  }

  // Dark variant: stacked, with the small disclaimer line. Used on the
  // /newsletter hero and the bottom callouts on /learn and /glossary.
  return (
    <div>
      {showFirstName && (
        <input
          type="text"
          value={firstName}
          onChange={ev=>setFirstName(ev.target.value)}
          onKeyDown={onKey}
          placeholder="First name (optional)"
          aria-label="First name (optional)"
          style={{width:"100%",boxSizing:"border-box",background:"rgba(255,255,255,.08)",border:"1.5px solid rgba(255,255,255,.18)",color:"#fff",fontSize:15,padding:"14px 16px",borderRadius:12,outline:"none",marginBottom:10,fontFamily:"inherit"}}
        />
      )}
      <input
        type="email"
        value={email}
        onChange={ev=>setEmail(ev.target.value)}
        onKeyDown={onKey}
        placeholder="Your email address"
        aria-label="Your email address"
        style={{width:"100%",boxSizing:"border-box",background:"rgba(255,255,255,.08)",border:"1.5px solid rgba(255,255,255,.18)",color:"#fff",fontSize:15,padding:"14px 16px",borderRadius:12,outline:"none",marginBottom:10,fontFamily:"inherit"}}
      />
      <button
        onClick={submit}
        disabled={status === "submitting"}
        style={{width:"100%",padding:"14px 22px",borderRadius:12,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:15,fontWeight:900,letterSpacing:".02em",cursor:status==="submitting"?"wait":"pointer",fontFamily:"inherit",boxShadow:"0 10px 28px rgba(249,115,22,.4)",opacity:status==="submitting"?.75:1}}
      >
        {status === "submitting" ? "Subscribing..." : "Subscribe Free"}
      </button>
      <p style={{fontSize:12,color:"rgba(255,255,255,.55)",marginTop:10,textAlign:"center"}}>Weekly. Free. Unsubscribe anytime. Data center topics only.</p>
      {status === "error" && <div style={{fontSize:13,color:"#fca5a5",marginTop:6,fontWeight:700,textAlign:"center"}}>{errMsg}</div>}
    </div>
  );
};

const NewsletterPage = ({ onNavigate }) => {
  const [recent, setRecent] = useState([]);    // recent Sent issues
  const [loading, setLoading] = useState(true);

  // SEO + social meta + Periodical JSON-LD for the index page. Stamped on
  // mount and cleaned up on unmount so they do not leak into other routes.
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = "Infrastructure Intelligence Newsletter | HumZones";

    injectHeadEl("meta", "nl-index-desc",     { name: "description",         content: "Free weekly data center infrastructure news in plain language. Interconnection queue filings, facility announcements and community impact stories every Monday and Thursday." });
    injectHeadEl("link", "nl-index-canonical",{ rel: "canonical",            href: "https://humzones.com/newsletter" });
    injectHeadEl("meta", "nl-index-og-title", { property: "og:title",        content: "Infrastructure Intelligence | HumZones Newsletter" });
    injectHeadEl("meta", "nl-index-og-desc",  { property: "og:description",  content: "Free weekly data center news translated for residents. Interconnection filings, facility announcements and community stories." });
    injectHeadEl("meta", "nl-index-og-url",   { property: "og:url",          content: "https://humzones.com/newsletter" });
    injectHeadEl("meta", "nl-index-og-type",  { property: "og:type",         content: "website" });
    injectHeadEl("meta", "nl-index-og-site",  { property: "og:site_name",    content: "HumZones" });
    injectHeadEl("meta", "nl-index-tw-card",  { name: "twitter:card",        content: "summary" });
    injectHeadEl("meta", "nl-index-tw-title", { name: "twitter:title",       content: "Infrastructure Intelligence | HumZones" });
    injectHeadEl("meta", "nl-index-tw-desc",  { name: "twitter:description", content: "Free weekly data center news in plain language for residents." });

    const periodicalSchema = {
      "@context":            "https://schema.org",
      "@type":               "Periodical",
      "name":                "Infrastructure Intelligence",
      "description":         "A free weekly newsletter translating data center infrastructure news into plain language for residents.",
      "url":                 "https://humzones.com/newsletter",
      "publisher": {
        "@type": "Organization",
        "name":  "HumZones Technologies Inc.",
        "url":   "https://humzones.com",
      },
      "inLanguage":          "en-US",
      "isAccessibleForFree": true,
    };
    injectHeadEl("script", "nl-index-jsonld", { type: "application/ld+json" }, JSON.stringify(periodicalSchema));

    return () => {
      [
        "nl-index-desc","nl-index-canonical","nl-index-og-title","nl-index-og-desc","nl-index-og-url",
        "nl-index-og-type","nl-index-og-site","nl-index-tw-card","nl-index-tw-title",
        "nl-index-tw-desc","nl-index-jsonld",
      ].forEach(removeHeadEl);
    };
  }, []);

  // Fetch the three newest Sent issues. Status is a single-select; the
  // formula relies on its plain text value.
  useEffect(() => {
    const formula = encodeURIComponent("{Status} = 'Sent'");
    const url = `${APIURL}/${NL_ISSUES_TABLE}?filterByFormula=${formula}&pageSize=3&sort%5B0%5D%5Bfield%5D=Issue_Number&sort%5B0%5D%5Bdirection%5D=desc&returnFieldsByFieldId=true`;
    fetch(url, { headers: HDR })
      .then(r => r.json())
      .then(d => setRecent((d && d.records) || []))
      .catch(e => console.warn("[newsletter] recent issues fetch failed:", e))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{minHeight:"100vh",background:"#f1f5f9",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>
      {/* HERO */}
      <section style={{background:"linear-gradient(150deg,#020c1b 0%,#0f172a 45%,#1e0535 100%)",padding:"56px 24px 60px"}}>
        <div style={{maxWidth:760,margin:"0 auto",textAlign:"center"}}>
          <h1 style={{fontSize:"clamp(26px,4vw,34px)",fontWeight:900,letterSpacing:"-.02em",color:"#fff",lineHeight:1.2,marginBottom:10}}>Infrastructure Intelligence</h1>
          <p style={{fontSize:16,color:"#f97316",fontWeight:700,margin:"0 0 16px"}}>A free weekly briefing for residents and community advocates</p>
          <p style={{fontSize:15,color:"rgba(255,255,255,.72)",lineHeight:1.7,maxWidth:620,margin:"0 auto"}}>
            Every week we research interconnection queues, utility filings, planning boards and data center industry news to tell you what is happening near communities like yours, in plain language. No jargon. No agenda. Just what is being built and what it means.
          </p>
        </div>
      </section>

      {/* PREVIEW CARDS */}
      <section style={{maxWidth:1000,margin:"0 auto",padding:"36px 24px 0"}}>
        <div className="nl-preview-grid" style={{display:"grid",gridTemplateColumns:"repeat(3, 1fr)",gap:14}}>
          {[
            { t: "What Filed This Week", d: "New interconnection requests and utility permit applications translated into plain English." },
            { t: "Facilities in the News", d: "Data center announcements, expansions and community impact stories from the past 7 days." },
            { t: "By the Numbers", d: "Key statistics from this week translated into human-scale comparisons that anyone can understand." },
          ].map(card => (
            <div key={card.t} style={{background:"#f1f5f9",border:"1px solid #e2e8f0",borderRadius:14,padding:"20px 20px 18px"}}>
              <div style={{fontSize:15,fontWeight:800,color:"#0f172a",letterSpacing:"-.01em",marginBottom:8}}>{card.t}</div>
              <p style={{fontSize:13,color:"#475569",lineHeight:1.65,margin:0}}>{card.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* SIGNUP */}
      <section style={{maxWidth:520,margin:"0 auto",padding:"32px 24px 0"}}>
        <div style={{background:"linear-gradient(150deg,#0f172a 0%,#1e0535 100%)",border:"1px solid rgba(249,115,22,.32)",borderRadius:16,padding:"26px 26px 22px",boxShadow:"0 18px 40px rgba(0,0,0,.18)"}}>
          <NewsletterSignupForm source="Newsletter Page" variant="dark" showFirstName/>
        </div>
      </section>

      {/* RECENT ISSUES */}
      <section style={{maxWidth:760,margin:"0 auto",padding:"40px 24px 56px"}}>
        <h2 style={{fontSize:20,fontWeight:900,color:"#0f172a",letterSpacing:"-.01em",margin:"0 0 16px"}}>Recent Issues</h2>
        {loading ? (
          <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,padding:"22px 24px",color:"#64748b",fontSize:14}}>Loading...</div>
        ) : recent.length === 0 ? (
          <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,padding:"22px 24px",color:"#475569",fontSize:14,lineHeight:1.6}}>
            Issue 1 arrives this Monday. Subscribe above to be first to receive it.
          </div>
        ) : (
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {recent.map(rec => {
              const f = rec.fields || {};
              const num = f[NL_ISSUE_F.Issue_Number];
              return (
                <div key={rec.id} style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,padding:"18px 20px",boxShadow:"0 2px 10px rgba(0,0,0,.04)"}}>
                  <div style={{fontSize:11,color:"#94a3b8",fontWeight:800,letterSpacing:".10em",textTransform:"uppercase",marginBottom:6}}>Issue #{num} &middot; {formatLongDate(f[NL_ISSUE_F.Date_Published])}</div>
                  <div style={{fontSize:16,fontWeight:800,color:"#0f172a",marginBottom:8,lineHeight:1.35}}>{f[NL_ISSUE_F.Issue_Title] || "Issue #" + num}</div>
                  <a href={"/newsletter/" + num} onClick={e=>{e.preventDefault();onNavigate("/newsletter/" + num);}} style={{color:"#f97316",fontWeight:800,fontSize:13,textDecoration:"none"}}>Read this issue &rarr;</a>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <style>{`@media(max-width:680px){.nl-preview-grid{grid-template-columns:1fr!important}}`}</style>

      <Footer onNavigate={onNavigate}/>
    </div>
  );
};

const NewsletterIssuePage = ({ onNavigate, issueNumber }) => {
  const [issue, setIssue] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | notfound | error
  const [alreadySubscribed, setAlreadySubscribed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try { setAlreadySubscribed(localStorage.getItem("humzones_nl_subscribed") === "1"); } catch {}
  }, []);

  useEffect(() => {
    const n = parseInt(issueNumber, 10);
    if (!Number.isFinite(n)) { setStatus("notfound"); return; }
    const formula = encodeURIComponent(`AND({Issue_Number} = ${n}, {Status} = 'Sent')`);
    const url = `${APIURL}/${NL_ISSUES_TABLE}?filterByFormula=${formula}&maxRecords=1&returnFieldsByFieldId=true`;
    fetch(url, { headers: HDR })
      .then(r => r.json())
      .then(d => {
        const rec = (d && d.records || [])[0];
        if (!rec) { setStatus("notfound"); return; }
        setIssue(rec);
        setStatus("ready");
        if (typeof document !== "undefined") {
          const title = (rec.fields || {})[NL_ISSUE_F.Issue_Title] || ("Issue #" + n);
          document.title = title + " | Infrastructure Intelligence by HumZones";
        }
      })
      .catch(e => { console.warn("[newsletter] issue fetch failed:", e); setStatus("error"); });
  }, [issueNumber]);

  // SEO + social meta + NewsArticle JSON-LD. Stamped once the issue is
  // loaded and cleaned up on unmount or when the issue number changes.
  useEffect(() => {
    if (status !== "ready" || !issue) return;
    const fields  = issue.fields || {};
    const title   = fields[NL_ISSUE_F.Issue_Title] || ("Issue #" + issueNumber);
    const number  = fields[NL_ISSUE_F.Issue_Number] || issueNumber;
    const datePub = fields[NL_ISSUE_F.Date_Published] || "";
    const longDate = datePub ? formatLongDate(datePub) : "";
    const url = "https://humzones.com/newsletter/" + number;

    const desc = title + " - Issue #" + number + (longDate ? ", " + longDate : "") +
      ". Data center infrastructure news translated for residents by HumZones.";
    const ogShort = "Data center infrastructure news in plain language for residents. Issue #" +
      number + " from Infrastructure Intelligence by HumZones.";
    const twShort = "Data center infrastructure news in plain language. Issue #" +
      number + " from HumZones.";

    injectHeadEl("meta", "nl-issue-desc",     { name: "description",          content: desc });
    injectHeadEl("meta", "nl-issue-og-title", { property: "og:title",         content: title + " | Infrastructure Intelligence" });
    injectHeadEl("meta", "nl-issue-og-desc",  { property: "og:description",   content: ogShort });
    injectHeadEl("meta", "nl-issue-og-url",   { property: "og:url",           content: url });
    injectHeadEl("meta", "nl-issue-og-type",  { property: "og:type",          content: "article" });
    injectHeadEl("meta", "nl-issue-og-site",  { property: "og:site_name",     content: "HumZones" });
    injectHeadEl("meta", "nl-issue-tw-card",  { name: "twitter:card",         content: "summary" });
    injectHeadEl("meta", "nl-issue-tw-title", { name: "twitter:title",        content: title + " | Infrastructure Intelligence" });
    injectHeadEl("meta", "nl-issue-tw-desc",  { name: "twitter:description",  content: twShort });

    const articleSchema = {
      "@context": "https://schema.org",
      "@type":    "NewsArticle",
      "headline": title,
      "description": "Infrastructure Intelligence Issue #" + number +
        " - data center news translated for residents by HumZones.",
      "url": url,
      "datePublished": datePub,
      "dateModified":  datePub,
      "author": {
        "@type": "Organization",
        "name": "HumZones Technologies Inc.",
        "url":  "https://humzones.com",
      },
      "publisher": {
        "@type": "Organization",
        "name": "HumZones Technologies Inc.",
        "url":  "https://humzones.com",
        "logo": { "@type": "ImageObject", "url": "https://humzones.com/favicon.ico" },
      },
      "isPartOf": {
        "@type": "Periodical",
        "name": "Infrastructure Intelligence",
        "url":  "https://humzones.com/newsletter",
      },
      "mainEntityOfPage": { "@type": "WebPage", "@id": url },
    };
    injectHeadEl("script", "nl-issue-jsonld", { type: "application/ld+json" }, JSON.stringify(articleSchema));

    return () => {
      [
        "nl-issue-desc","nl-issue-og-title","nl-issue-og-desc","nl-issue-og-url",
        "nl-issue-og-type","nl-issue-og-site","nl-issue-tw-card","nl-issue-tw-title",
        "nl-issue-tw-desc","nl-issue-jsonld",
      ].forEach(removeHeadEl);
    };
  }, [issue, issueNumber, status]);

  const f = (issue && issue.fields) || {};
  const shareUrl  = "https://humzones.com/newsletter/" + (f[NL_ISSUE_F.Issue_Number] || issueNumber);
  const shareText = (f[NL_ISSUE_F.Issue_Title] || "Infrastructure Intelligence") + " via @HumZones";
  const issueHTML = String(f[NL_ISSUE_F.Content_HTML] || "").split("[UNSUBSCRIBE_LINK]").join("https://humzones.com/unsubscribe");
  const processedHTML = issueHTML.replace(/<a\s/gi, '<a target="_blank" rel="noopener noreferrer" ');
  const onCopyShare = () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  return (
    <div style={{minHeight:"100vh",background:"#f1f5f9",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>
      <section style={{background:"linear-gradient(150deg,#020c1b 0%,#0f172a 45%,#1e0535 100%)",padding:"40px 24px 36px"}}>
        <div style={{maxWidth:680,margin:"0 auto"}}>
          <a href="/newsletter" onClick={e=>{e.preventDefault();onNavigate("/newsletter");}} style={{display:"inline-block",fontSize:13,color:"rgba(255,255,255,.7)",fontWeight:700,textDecoration:"none",marginBottom:14}}>&larr; Back to newsletter</a>
          {status === "ready" && (
            <>
              <div style={{display:"inline-block",fontSize:11,color:"#f97316",letterSpacing:".18em",textTransform:"uppercase",fontWeight:800,marginBottom:10,padding:"5px 12px",borderRadius:30,background:"rgba(249,115,22,.12)",border:"1px solid rgba(249,115,22,.3)"}}>Issue #{f[NL_ISSUE_F.Issue_Number]}</div>
              <h1 style={{fontSize:"clamp(22px,3.5vw,30px)",fontWeight:900,letterSpacing:"-.02em",color:"#fff",lineHeight:1.2,margin:"0 0 8px"}}>{f[NL_ISSUE_F.Issue_Title]}</h1>
              <p style={{fontSize:13,color:"rgba(255,255,255,.6)",margin:0}}>{formatLongDate(f[NL_ISSUE_F.Date_Published])}</p>
            </>
          )}
          {status === "loading" && <p style={{color:"rgba(255,255,255,.7)"}}>Loading issue...</p>}
        </div>
      </section>

      <section style={{maxWidth:680,margin:"0 auto",padding:"30px 24px 8px"}}>
        {status === "notfound" ? (
          <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,padding:"24px",color:"#475569",fontSize:15,lineHeight:1.65}}>
            This issue was not found. View all issues at <a href="/newsletter" onClick={e=>{e.preventDefault();onNavigate("/newsletter");}} style={{color:"#f97316",fontWeight:800,textDecoration:"none"}}>/newsletter</a>.
          </div>
        ) : status === "error" ? (
          <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,padding:"24px",color:"#475569",fontSize:15,lineHeight:1.65}}>
            We could not load this issue. Please try again or visit <a href="/newsletter" onClick={e=>{e.preventDefault();onNavigate("/newsletter");}} style={{color:"#f97316",fontWeight:800,textDecoration:"none"}}>/newsletter</a>.
          </div>
        ) : status === "ready" ? (
          <div
            style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,padding:"6px 6px 12px",boxShadow:"0 2px 12px rgba(0,0,0,.05)"}}
            dangerouslySetInnerHTML={{ __html: processedHTML }}
            onClick={(e) => {
              if (e.target.tagName === "A" && e.target.href) {
                e.preventDefault();
                window.open(e.target.href, "_blank", "noopener,noreferrer");
              }
            }}
          />
        ) : null}
      </section>

      {status === "ready" && (
        <section style={{maxWidth:680,margin:"0 auto",padding:"22px 24px 0"}}>
          <div style={{fontSize:13,color:"#94a3b8",fontWeight:700,marginBottom:10}}>Share this issue</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <a
              href={"https://twitter.com/intent/tweet?text=" + encodeURIComponent(shareText) + "&url=" + encodeURIComponent(shareUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className="hz-nl-share"
              style={{padding:"8px 14px",borderRadius:6,border:"1px solid #e2e8f0",background:"#fff",color:"#475569",fontSize:13,fontWeight:700,textDecoration:"none"}}
            >Share on X</a>
            <a
              href={"https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(shareUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className="hz-nl-share"
              style={{padding:"8px 14px",borderRadius:6,border:"1px solid #e2e8f0",background:"#fff",color:"#475569",fontSize:13,fontWeight:700,textDecoration:"none"}}
            >Share on Facebook</a>
            <button
              type="button"
              onClick={onCopyShare}
              className="hz-nl-share"
              style={{padding:"8px 14px",borderRadius:6,border:"1px solid #e2e8f0",background:"#fff",color:"#475569",fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}
            >{copied ? "Copied!" : "Copy Link"}</button>
          </div>
        </section>
      )}

      {status === "ready" && !alreadySubscribed && (
        <section style={{maxWidth:680,margin:"0 auto",padding:"22px 24px 56px"}}>
          <div style={{background:"#fff7ed",border:"1px solid #fed7aa",borderLeft:"4px solid #f97316",borderRadius:12,padding:"18px 22px"}}>
            <p style={{fontSize:14,color:"#7c2d12",lineHeight:1.6,margin:"0 0 12px",fontWeight:700}}>Enjoyed this issue? Subscribe to get Infrastructure Intelligence every Monday and Thursday.</p>
            <NewsletterSignupForm source="Newsletter Issue Page" variant="light" showFirstName={false} compact/>
          </div>
        </section>
      )}

      <Footer onNavigate={onNavigate}/>
    </div>
  );
};

const NewsletterConfirmPage = ({ onNavigate }) => {
  const [status, setStatus] = useState("working"); // working | ok | already | invalid
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token") || "";
    const email = params.get("email") || "";
    if (!token || !email) { setStatus("invalid"); return; }
    fetch("/api/newsletter", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "confirm", token, email }),
    })
      .then(r => r.json())
      .then(d => {
        if (d && d.status === "ok")               { setStatus("ok"); try { localStorage.setItem("humzones_nl_subscribed","1"); } catch {} }
        else if (d && d.status === "already_confirmed") { setStatus("already"); try { localStorage.setItem("humzones_nl_subscribed","1"); } catch {} }
        else                                       { setStatus("invalid"); }
      })
      .catch(e => { console.error("newsletter confirm error:", e); setStatus("invalid"); });
  }, []);

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(150deg,#020c1b 0%,#0f172a 50%,#1e0535 100%)",color:"#fff"}}>
      <main style={{maxWidth:560,margin:"0 auto",padding:"60px 24px 80px",textAlign:"center"}}>
        {status === "working" && (
          <>
            <div className="spinning" style={{width:36,height:36,border:"3px solid rgba(255,255,255,.18)",borderTop:"3px solid #f97316",borderRadius:"50%",margin:"0 auto 18px"}}/>
            <p style={{fontSize:15,color:"rgba(255,255,255,.7)"}}>Confirming your subscription...</p>
          </>
        )}
        {(status === "ok" || status === "already") && (
          <div style={{background:"rgba(15,23,42,.55)",border:"1px solid rgba(249,115,22,.32)",borderRadius:16,padding:"30px 26px"}}>
            <div style={{width:80,height:80,borderRadius:"50%",background:"linear-gradient(135deg,#ef4444,#f97316)",margin:"0 auto 20px",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 18px 50px rgba(249,115,22,.4)"}}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <h1 style={{fontSize:24,fontWeight:900,color:"#fff",margin:"0 0 12px"}}>You are subscribed!</h1>
            <p style={{fontSize:15,color:"rgba(255,255,255,.78)",lineHeight:1.65,margin:"0 auto 22px",maxWidth:480}}>
              Infrastructure Intelligence arrives every Monday and Thursday morning. Mondays bring interconnection queue filings. Thursdays bring facility news and community impact stories. All in plain language.
            </p>
            <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap"}}>
              <button onClick={()=>onNavigate("/newsletter")} style={{padding:"13px 22px",borderRadius:12,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:14,fontWeight:900,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>
                Read Recent Issues
              </button>
              <button onClick={()=>onNavigate("/")} style={{padding:"13px 22px",borderRadius:12,border:"1px solid rgba(255,255,255,.22)",background:"transparent",color:"#fff",fontSize:14,fontWeight:800,cursor:"pointer",fontFamily:"inherit"}}>
                Return Home
              </button>
            </div>
          </div>
        )}
        {status === "invalid" && (
          <div style={{background:"rgba(15,23,42,.55)",border:"1px solid rgba(239,68,68,.32)",borderRadius:16,padding:"30px 26px"}}>
            <h1 style={{fontSize:22,fontWeight:900,color:"#fff",margin:"0 0 12px"}}>This confirmation link has expired or is not valid.</h1>
            <p style={{fontSize:15,color:"rgba(255,255,255,.78)",lineHeight:1.65,margin:"0 auto 22px",maxWidth:480}}>
              Please subscribe again at humzones.com/newsletter.
            </p>
            <button onClick={()=>onNavigate("/newsletter")} style={{padding:"13px 22px",borderRadius:12,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:14,fontWeight:900,cursor:"pointer",fontFamily:"inherit",boxShadow:"0 10px 28px rgba(249,115,22,.4)"}}>
              Go to Newsletter
            </button>
          </div>
        )}
      </main>
      <Footer onNavigate={onNavigate}/>
    </div>
  );
};

// ─── SCROLL TO TOP ───────────────────────────────────────────────────────────
// Scrolls the window to the top whenever the active route changes, so footer
// links and other cross-page navigation always land at the top of the
// destination page rather than keeping the previous scroll position.
const ScrollToTop = ({ path }) => {
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [path]);
  return null;
};

// ─── FAQ ANSWER LINKS ────────────────────────────────────────────────────────
// FAQ answers mention other site pages and the support email as plain text.
// renderFaqAnswer splits an answer on those known references and turns each
// one into a clickable orange link.
const FAQ_LINK_TOKENS = [
  { token: "humzones.com/methodology",   to: "/methodology" },
  { token: "humzones.com/submit-report", to: "/submit-report" },
  { token: "humzones.com/my-report",     to: "/my-report" },
  { token: "humzones.com/business",      to: "/business" },
  { token: "humzones.com/unsubscribe",   to: "/unsubscribe" },
  { token: "methodology page",           to: "/methodology" },
  { token: "hello@humzones.com",         mailto: true },
  { token: "personalized area reports for $14.99", to: "/get-report" },
  { token: "business subscription plans",          to: "/business" },
];
const renderFaqAnswer = (text, onNavigate) => {
  const escaped = FAQ_LINK_TOKENS.map(l => l.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp("(" + escaped.join("|") + ")", "g");
  const linkStyle = { color:"#f97316", fontWeight:700, textDecoration:"none" };
  return text.split(re).map((part, i) => {
    const hit = FAQ_LINK_TOKENS.find(l => l.token === part);
    if (!hit) return part;
    if (hit.mailto) return <a key={i} href={`mailto:${part}`} style={linkStyle}>{part}</a>;
    return (
      <a key={i} href={hit.to} onClick={e=>{e.preventDefault();onNavigate(hit.to);}} style={linkStyle}>{part}</a>
    );
  });
};

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
// ─── GLOBAL HEADER ───────────────────────────────────────────────────────────
// Site-wide sticky nav with mega menu dropdowns. Mounted once at the top of
// App so it sits above every route. The Back arrow only renders when the
// user is not on the home route and delegates to window.history.back so the
// router's existing popstate listener stays in charge of the path state.
// Mega menu open state is hover-driven and reset on every route change.
const GH_MENU = {
  explore: {
    label: "Explore",
    layout: 3,
    columns: [
      { head: "FIND DATA CENTERS", items: [
        { title: "Find Near Me",         desc: "Search facilities near your address",      action: "nearme" },
        { title: "Get My Report",        desc: "Full personalized area report",            to: "/get-report" },
        { title: "Search by Location",   desc: "Browse by country, state and city",        to: "/" },
      ]},
      { head: "OUR DATABASE", items: [
        { title: "Interactive Map",      desc: "Visual map of all tracked facilities",     action: "map" },
        { title: "1,143+ Facilities",    desc: "Growing global registry",                  to: "/" },
        { title: "Live Registry Status", desc: "Operating, building and proposed",         action: "registry" },
      ]},
      { head: "LEARN", items: [
        { title: "Why It Matters",       desc: "Why infrastructure transparency matters",  to: "/why-it-matters" },
        { title: "Resident Guides",      desc: "Plain-language explainers for residents",  to: "/learn" },
        { title: "Infrastructure Glossary", desc: "Data center terminology in plain language", to: "/glossary" },
        { title: "Methodology",          desc: "How we research and model data",           to: "/methodology" },
        { title: "FAQ",                  desc: "Common questions answered",                to: "/faq" },
        { title: "About HumZones",       desc: "Our mission and story",                    to: "/about" },
      ]},
    ],
  },
  reports: {
    label: "Reports",
    layout: 3,
    columns: [
      { head: "PERSONAL REPORTS", items: [
        { title: "Get My Report",        desc: "Instant PDF for any address",              to: "/get-report" },
        { title: "Download Sample",      desc: "Preview before you buy",                   action: "sample" },
        { title: "What Is Included",     desc: "See full report contents",                 action: "contents" },
      ]},
      { head: "BUSINESS PLANS", items: [
        { title: "Starter $99/month",       desc: "10 reports per month",                  action: "plan", planId: "plan-starter" },
        { title: "Professional $249/month", desc: "30 reports per month",                  action: "plan", planId: "plan-professional" },
        { title: "Enterprise $599/month",   desc: "200 reports per month",                 action: "plan", planId: "plan-enterprise" },
      ]},
      { head: "YOUR REPORTS", items: [
        { title: "Retrieve My Report",   desc: "Access past purchases",                    to: "/my-report" },
        { title: "Business Dashboard",   desc: "Manage your subscription",                 to: "/business-dashboard" },
        { title: "Business Login",       desc: "Sign in to your account",                  to: "/business-login" },
      ]},
    ],
  },
  business: {
    label: "Business",
    layout: 2,
    columns: [
      { head: "PLANS & PRICING", items: [
        { title: "View All Plans",       desc: "Compare Starter, Professional, Enterprise", to: "/business" },
        { title: "Annual Plans",         desc: "Save 2 months with annual billing",        action: "annual" },
        { title: "Sample Report",        desc: "See what professionals receive",           action: "sample" },
      ]},
      { head: "YOUR ACCOUNT", items: [
        { title: "Business Login",       desc: "Sign in with magic link",                  to: "/business-login" },
        { title: "My Dashboard",         desc: "Credits and report history",               to: "/business-dashboard" },
        { title: "My Profile",           desc: "Manage your account",                      to: "/business-profile" },
        { title: "Account Recovery",     desc: "Forgot your login email?",                 to: "/business-recover" },
      ]},
    ],
  },
  community: {
    label: "Community",
    layout: 2,
    columns: [
      { head: "PARTICIPATE", items: [
        { title: "📰 Newsletter",        desc: "Free weekly Infrastructure Intelligence",  to: "/newsletter" },
        { title: "Submit Your Report",   desc: "Share your experience",                    to: "/submit-report" },
        { title: "Community Reports",    desc: "Browse facilities and resident reports",   to: "/submit-report" },
        { title: "Contact Us",           desc: "Get in touch with our team",               to: "/contact" },
        { title: "Donate",               desc: "Support the registry",                     to: "/donate", accent: "heart" },
      ]},
      { head: "RESEARCH", items: [
        { title: "Methodology",          desc: "Our research approach",                    to: "/methodology" },
        { title: "Research Sources",     desc: "WHO, IARC, arXiv and more",                to: "/methodology" },
        { title: "About HumZones",       desc: "Our mission and story",                    to: "/about" },
      ]},
    ],
  },
  company: {
    label: "Company",
    layout: 2,
    columns: [
      { head: "COMPANY", items: [
        { title: "About Us",             desc: "Who we are and why we built this",         to: "/about" },
        { title: "Contact Us",           desc: "We would love to hear from you",           to: "/contact" },
        { title: "Methodology",          desc: "How our data works",                       to: "/methodology" },
      ]},
      { head: "LEGAL", items: [
        { title: "Privacy Policy",       desc: "How we handle your data",                  to: "/privacy" },
        { title: "Terms of Service",     desc: "Our terms and conditions",                 to: "/terms" },
        { title: "Legal Disclaimer",     desc: "Important legal information",              to: "/disclaimer" },
      ]},
    ],
  },
};
const GH_KEYS = ["explore","reports","business","community","company"];

const GhChev = () => (
  <svg className="hz-gh-nav-chev" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="6 9 12 15 18 9"/>
  </svg>
);

const GlobalHeader = ({ onNavigate, path }) => {
  const [open, setOpen]             = useState(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sampleBusy, setSampleBusy] = useState(false);

  // Tiny close delay so the cursor can cross the gap between a nav button
  // and its mega menu without the menu collapsing mid-traverse. The
  // dropdown's onMouseEnter cancels this pending close, so a real exit
  // still feels instant.
  const closeTimerRef = useRef(null);
  const cancelClose = () => {
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => setOpen(null), 160);
  };
  const openMenu = (key) => { cancelClose(); setOpen(key); };

  // Close every menu when the route changes.
  useEffect(() => { cancelClose(); setOpen(null); setMobileOpen(false); }, [path]);
  // Tear down any pending close timer on unmount.
  useEffect(() => () => cancelClose(), []);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    if (!mobileOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [mobileOpen]);

  const goNearMe = () => {
    setOpen(null); setMobileOpen(false);
    const scroll = () => {
      const el = document.getElementById("near-me");
      if (el) el.scrollIntoView({ behavior:"smooth", block:"start" });
    };
    if (path !== "/") { onNavigate("/"); setTimeout(scroll, 350); }
    else scroll();
  };

  const goRegistry = () => {
    setOpen(null); setMobileOpen(false);
    const scroll = () => {
      const el = document.getElementById("live-registry-status");
      if (el) el.scrollIntoView({ behavior:"smooth", block:"start" });
    };
    if (path !== "/") { onNavigate("/"); setTimeout(scroll, 350); }
    else scroll();
  };

  const goMap = () => {
    setOpen(null); setMobileOpen(false);
    const scroll = () => {
      const el = document.getElementById("interactive-map");
      if (el) el.scrollIntoView({ behavior:"smooth", block:"start" });
    };
    if (path !== "/") { onNavigate("/"); setTimeout(scroll, 350); }
    else scroll();
  };

  const goContents = () => {
    setOpen(null); setMobileOpen(false);
    const scroll = () => {
      const el = document.getElementById("report-contents");
      if (el) el.scrollIntoView({ behavior:"smooth", block:"start" });
    };
    if (path !== "/business") { onNavigate("/business"); setTimeout(scroll, 350); }
    else scroll();
  };

  const goPlan = (id) => {
    setOpen(null); setMobileOpen(false);
    const scroll = () => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior:"smooth", block:"start" });
    };
    if (path !== "/business") { onNavigate("/business"); setTimeout(scroll, 350); }
    else scroll();
  };

  const goAnnual = () => {
    setOpen(null); setMobileOpen(false);
    // Flag is read by BusinessPlansPage on first mount; the event covers the
    // case where the page is already mounted and would otherwise ignore the
    // flag entirely.
    try { sessionStorage.setItem("hz_business_annual", "1"); } catch {}
    if (path !== "/business") onNavigate("/business");
    else window.dispatchEvent(new CustomEvent("hz:business-annual"));
  };

  const runSample = async () => {
    if (sampleBusy) return;
    setSampleBusy(true);
    try {
      const { doc } = await generateSamplePersonalReportPDF();
      doc.save("HumZones-Sample-Report.pdf");
      setOpen(null); setMobileOpen(false);
    } catch (e) {
      console.error("Sample report generation failed:", e);
      window.alert("We could not generate the sample report. Please try again.");
    } finally { setSampleBusy(false); }
  };

  const handleItem = (item) => {
    if (item.action === "nearme")   return goNearMe();
    if (item.action === "registry") return goRegistry();
    if (item.action === "map")      return goMap();
    if (item.action === "contents") return goContents();
    if (item.action === "plan")     return goPlan(item.planId);
    if (item.action === "annual")   return goAnnual();
    if (item.action === "sample")   return runSample();
    if (item.to) { setOpen(null); setMobileOpen(false); onNavigate(item.to); }
  };

  const cur = open ? GH_MENU[open] : null;

  return (
    <header className="hz-gh-shell" role="banner">
      <div className="hz-gh-inner">
        <div className="hz-gh-left">
          {path !== "/" && (
            <button type="button" className="hz-gh-back" aria-label="Go back" onClick={()=>{ if (typeof window !== "undefined") window.history.back(); }}>
              &larr;
            </button>
          )}
          <button type="button" className="hz-gh-logo" onClick={()=>onNavigate("/")} aria-label="HumZones home">
            <span className="hz-gh-logo-title">HumZones<sup className="hz-gh-logo-sup">TM</sup></span>
            <span className="hz-gh-logo-tag">Global Data Center Health &amp; Infrastructure Registry</span>
          </button>
        </div>

        <nav className="hz-gh-nav" aria-label="Primary">
          {GH_KEYS.map(key => (
            <div
              key={key}
              style={{position:"relative",height:"100%",display:"flex",alignItems:"center"}}
              onMouseEnter={()=>openMenu(key)}
              onMouseLeave={scheduleClose}
            >
              <button type="button" className={`hz-gh-nav-btn${open===key?" is-open":""}`} aria-expanded={open===key} onFocus={()=>openMenu(key)} onBlur={scheduleClose}>
                {GH_MENU[key].label}<GhChev/>
              </button>
            </div>
          ))}
        </nav>

        <div className="hz-gh-right">
          <a href="/business-login" onClick={e=>{e.preventDefault();onNavigate("/business-login");}} className="hz-gh-login">Login</a>
          <a href="/get-report" onClick={e=>{e.preventDefault();onNavigate("/get-report");}} className="hz-gh-cta">Get My Report</a>
          <button type="button" className="hz-gh-burger" aria-label="Open menu" onClick={()=>setMobileOpen(true)}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <line x1="3" y1="6" x2="21" y2="6"/>
              <line x1="3" y1="12" x2="21" y2="12"/>
              <line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </button>
        </div>
      </div>

      {cur && (
        <div className="hz-gh-mega" onMouseEnter={cancelClose} onMouseLeave={scheduleClose}>
          <div className={`hz-gh-mega-inner ${cur.layout===3?"hz-gh-mega-3":"hz-gh-mega-2"}`}>
            {cur.columns.map(col => (
              <div key={col.head}>
                <div className="hz-gh-mega-col-head">{col.head}</div>
                {col.items.map(item => (
                  <button
                    key={item.title}
                    type="button"
                    className="hz-gh-mega-link"
                    onClick={()=>handleItem(item)}
                    disabled={item.action==="sample" && sampleBusy}
                  >
                    <span className="hz-gh-mega-link-title">
                      {item.accent === "heart" && <span aria-hidden="true" style={{color:"#f97316",marginRight:6}}>♥</span>}
                      {item.action==="sample" && sampleBusy ? "Generating Sample..." : item.title}
                    </span>
                    <span className="hz-gh-mega-link-desc">{item.desc}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {mobileOpen && (
        <>
          <div className="hz-gh-backdrop" onClick={()=>setMobileOpen(false)}/>
          <aside className="hz-gh-mobile" role="dialog" aria-label="Site menu">
            <div className="hz-gh-mobile-head">
              <span style={{color:"#fff",fontWeight:800,fontSize:18}}>HumZones</span>
              <button type="button" className="hz-gh-mobile-close" aria-label="Close menu" onClick={()=>setMobileOpen(false)}>&times;</button>
            </div>
            {GH_KEYS.map(key => (
              <div key={key} className="hz-gh-mobile-section">
                <div className="hz-gh-mobile-section-head">{GH_MENU[key].label}</div>
                {GH_MENU[key].columns.flatMap(col => col.items).map(item => (
                  <button
                    key={item.title}
                    type="button"
                    className="hz-gh-mobile-link"
                    onClick={()=>handleItem(item)}
                    disabled={item.action==="sample" && sampleBusy}
                  >
                    {item.accent === "heart" && <span aria-hidden="true" style={{color:"#f97316",marginRight:6}}>♥</span>}
                    {item.action==="sample" && sampleBusy ? "Generating Sample..." : item.title}
                  </button>
                ))}
              </div>
            ))}
            <div className="hz-gh-mobile-foot">
              <a href="/business-login" className="hz-gh-mobile-login" onClick={e=>{e.preventDefault();onNavigate("/business-login");}}>Login</a>
              <a href="/get-report" className="hz-gh-mobile-cta" onClick={e=>{e.preventDefault();onNavigate("/get-report");}}>Get My Report</a>
            </div>
          </aside>
        </>
      )}
    </header>
  );
};

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

  // Auto-logout machinery for logged-in business sessions. Two effects:
  // (1) any user activity bumps lastActiveAt on a 60s throttle so an
  //     actively-used tab stays signed in; (2) every 60s we re-check the
  //     stored session and, if it's gone stale while sitting on a guarded
  //     page, redirect to /business-login. readBusinessAccount itself sets
  //     the SESSION_EXPIRED_KEY flag that the login page reads to render a
  //     "Signed out for your security" banner.
  useEffect(() => {
    let lastTouch = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - lastTouch < 60 * 1000) return;
      lastTouch = now;
      touchBusinessAccount();
    };
    const events = ["mousemove","keydown","touchstart","click"];
    events.forEach(e => window.addEventListener(e, onActivity, { passive: true }));
    return () => events.forEach(e => window.removeEventListener(e, onActivity));
  }, []);

  useEffect(() => {
    const GUARDED = ["/business-dashboard","/business-generate","/business-profile"];
    const tick = () => {
      if (!GUARDED.includes(window.location.pathname)) return;
      if (readBusinessAccount() === null) navigate("/business-login");
    };
    const id = setInterval(tick, 60 * 1000);
    return () => clearInterval(id);
  }, []);

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
      ? `Based on your answers, you are in a HIGH impact situation. Your combination of ${a.dist==="Less than 0.25 miles"?"very close proximity (under a quarter mile)":a.dist==="0.25 to 0.5 miles"?"close proximity (under half a mile)":"moderate proximity"}${a.kids==="Yes"?", children in your household":""}${a.preg==="Yes"?", and pregnancy":""} creates a compounding risk profile that warrants immediate and serious attention. The research is unambiguous: people in your situation face measurably elevated exposure to three separate categories of documented health hazards. First, power-frequency EMF from substations and high-voltage lines at this distance regularly exceeds the 3 to 4 milligauss threshold where epidemiological studies found elevated childhood leukemia rates. Second, diesel PM2.5 from monthly generator tests is a WHO Group 1 carcinogen with no established safe exposure level. Third, chronic low-frequency noise operates below the threshold of normal hearing measurement but penetrates walls and disrupts sleep architecture over time. Each of these independently carries documented health risks. Together, as a combined chronic exposure, they represent a situation that deserves professional environmental assessment, formal regulatory complaints, and a conversation with your doctor.`
      : score>=3
      ? `Based on your answers, you are in a MODERATE impact situation. Your proximity and household circumstances place you within the documented impact range of this facility. ${a.dist==="0.25 to 0.5 miles"?"At under half a mile, you are well within the zone where low-frequency noise, diesel exhaust during generator tests, and elevated EMF have been measured and documented.":a.dist==="0.5 to 1 mile"?"At under one mile, low-frequency sound from cooling systems and generator operations reaches your home, particularly at night when ambient noise drops.":"At your distance, the primary concerns are low-frequency noise at night, diesel exhaust during monthly generator tests, and substation EMF if you are near the electrical infrastructure."} While your risk is lower than those closest to the fence line, the cumulative effects of long-term exposure to industrial noise, diesel exhaust during monthly generator tests, and elevated EMF are real and worth taking seriously. Residents at this distance have documented sleep disruption, intermittent headaches, and heightened anxiety linked to generator test events. Monitoring, documentation, and precautionary steps are appropriate right now, and you have standing to file formal noise and air quality concerns with your local authority.`
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
    {val:`~${(statVals[0]/1e9).toFixed(2).replace(/\.?0+$/,"")} Billion`,    label:"Gallons of water consumed by data centers daily"},
    {val:`~${(statVals[1]/1e6).toFixed(1)} Million`,                         label:"Americans living within 1 mile of a major data center"},
    {val:`~${(statVals[2]/1e12).toFixed(2).replace(/\.?0+$/,"")} Trillion`,  label:"Watts of power consumed by data centers globally"},
    {val:loading?"---":statVals[3],                                          label:"Facilities in our database"},
  ];

  return (
    <>
      <style>{CSS}</style>
      <ScrollToTop path={path}/>
      <GlobalHeader onNavigate={navigate} path={path}/>
      {path === "/methodology" ? (
        <MethodologyPage onBack={()=>navigate("/")} onNavigate={navigate}/>
      ) : path === "/get-report" ? (
        <GetReportPage onNavigate={navigate}/>
      ) : path === "/report-landing" ? (
        <ReportLandingPage onBack={()=>navigate("/")} onNavigate={navigate}/>
      ) : path === "/report-success" ? (
        <ReportSuccessPage onBack={()=>navigate("/")} onNavigate={navigate}/>
      ) : path === "/verify-report" ? (
        <VerifyReportPage onNavigate={navigate}/>
      ) : path === "/business" ? (
        <BusinessPlansPage onNavigate={navigate} facilityCount={facs.length} facs={facs}/>
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
      ) : path === "/contact" ? (
        <ContactPage onNavigate={navigate}/>
      ) : path === "/about" ? (
        <AboutPage onNavigate={navigate} facilityCount={facs.length}/>
      ) : path === "/why-it-matters" ? (
        <WhyItMattersPage onNavigate={navigate}/>
      ) : path === "/faq" ? (
        <FaqPage onNavigate={navigate} facilityCount={facs.length}/>
      ) : path === "/terms" ? (
        <TermsPage onNavigate={navigate}/>
      ) : path === "/disclaimer" ? (
        <DisclaimerPage onNavigate={navigate}/>
      ) : path === "/donate" ? (
        <DonatePage onNavigate={navigate} facilityCount={facs.length}/>
      ) : path === "/learn" ? (
        <LearnPage onNavigate={navigate}/>
      ) : path === "/glossary" ? (
        <GlossaryPage onNavigate={navigate}/>
      ) : path === "/newsletter" ? (
        <NewsletterPage onNavigate={navigate}/>
      ) : path.startsWith("/newsletter/") ? (
        <NewsletterIssuePage onNavigate={navigate} issueNumber={path.slice("/newsletter/".length)}/>
      ) : path === "/newsletter-confirm" ? (
        <NewsletterConfirmPage onNavigate={navigate}/>
      ) : path === "/donate-thank-you" ? (
        <DonateThankYouPage onNavigate={navigate}/>
      ) : (
      <div style={{minHeight:"100vh",background:"#f1f5f9",width:"100%",maxWidth:"100vw",overflowX:"hidden"}}>

        <HomePageSEO/>

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

          {/* Secondary path for residents. Sits under the country/region/city
              search so a visitor who is not here to look up a facility but to
              report on one has a clear and equally visible entry point. */}
          <div style={{marginTop:28,display:"flex",alignItems:"center",gap:14,flexWrap:"wrap",justifyContent:"center",position:"relative",zIndex:1}}>
            <span style={{fontSize:14,color:"rgba(255,255,255,.68)",fontWeight:600,letterSpacing:".01em"}}>
              Lived or worked near a data center?
            </span>
            <a href="/submit-report" onClick={e=>{e.preventDefault();navigate("/submit-report");}} style={{display:"inline-flex",alignItems:"center",gap:8,padding:"12px 22px",borderRadius:30,border:"1.5px solid rgba(249,115,22,.55)",background:"rgba(249,115,22,.12)",color:"#fed7aa",fontSize:14,fontWeight:800,letterSpacing:".02em",textDecoration:"none",fontFamily:"inherit",transition:"background .15s, border-color .15s"}}>
              Submit Your Resident Report &rarr;
            </a>
          </div>

          <p style={{marginTop:24,fontSize:13,color:"rgba(255,255,255,.55)",fontWeight:500,letterSpacing:".02em",textAlign:"center",position:"relative",zIndex:1,margin:"24px 0 0"}}>
            Independently operated.{" "}
            <a href="/donate" onClick={e=>{e.preventDefault();navigate("/donate");}} style={{color:"#f97316",fontWeight:700,textDecoration:"none"}}>Support our mission</a>
          </p>

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

        {/* RESIDENT REPORT BAND: a full-width call-out between the stats
            strip and the main content so visitors who scroll past the
            hero search are reminded that submitting their experience is
            an equally important reason this site exists. */}
        <section aria-labelledby="resident-report-band-title" style={{background:"linear-gradient(135deg,#0a1628 0%,#0f172a 45%,#1e0535 100%)",borderBottom:"1px solid rgba(249,115,22,.18)",padding:"52px 24px"}}>
          <div style={{maxWidth:880,margin:"0 auto",textAlign:"center"}}>
            <div style={{display:"inline-block",fontSize:12,color:"#f97316",letterSpacing:".18em",textTransform:"uppercase",fontWeight:800,marginBottom:14,padding:"6px 14px",borderRadius:30,background:"rgba(249,115,22,.12)",border:"1px solid rgba(249,115,22,.3)"}}>Resident Voice</div>
            <h2 id="resident-report-band-title" style={{fontSize:"clamp(26px,4vw,36px)",fontWeight:900,color:"#fff",lineHeight:1.2,letterSpacing:"-.015em",margin:"0 0 12px"}}>
              Lived or worked near one of these facilities?
            </h2>
            <p style={{fontSize:16,color:"rgba(255,255,255,.72)",lineHeight:1.65,maxWidth:640,margin:"0 auto 24px"}}>
              Your firsthand experience helps regulators, researchers, and other residents understand the real-world impact of data center infrastructure. Reports are verified by email and reviewed before publication.
            </p>
            <a href="/submit-report" onClick={e=>{e.preventDefault();navigate("/submit-report");}} style={{display:"inline-flex",alignItems:"center",gap:8,padding:"15px 30px",borderRadius:14,border:"none",background:"linear-gradient(135deg,#ef4444,#f97316)",color:"#fff",fontSize:16,fontWeight:900,letterSpacing:".02em",textDecoration:"none",fontFamily:"inherit",boxShadow:"0 12px 32px rgba(249,115,22,.4)"}}>
              Submit Your Resident Report &rarr;
            </a>
          </div>
        </section>

        {/* MAIN */}
        <main className="main" ref={topRef} style={{maxWidth:1040,margin:"0 auto",padding:"36px 24px 32px",width:"100%",boxSizing:"border-box",overflowX:"hidden"}}>

          {/* FIND DATA CENTERS NEAR ME */}
          <section id="near-me" className="near-panel" style={{background:"#fff",borderRadius:16,boxShadow:"0 20px 60px rgba(0,0,0,0.2)",padding:"26px 26px 22px",marginBottom:28,scrollMarginTop:24}}>
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
                    <div style={{fontSize:13,color:"#64748b",fontWeight:600,marginTop:2,display:"inline-flex",alignItems:"center"}}>
                      {f.Power_MW>=1000?`${(f.Power_MW/1000).toFixed(1)} GW`:`${f.Power_MW||"?"}MW`}
                      {!locked && <InfoTip label="About power draw">{METRIC_TIP.power(f.Power_MW)}</InfoTip>}
                    </div>
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

          {/* INTERACTIVE WORLD MAP: sits between the Find Data Centers Near Me
              feature and the social share prompt. */}
          {!dc && <MapSection facilities={facs} loading={loading} onSelectFacility={pickFac}/>}

          {/* SOCIAL SHARE: lives directly below the Find Data Centers Near Me
              feature so the prompt to share lands after the buyer has seen
              their own results, upsell banner and email gate. */}
          {!dc && <ShareSection/>}

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
                    {icon:"power",label:"Reported Power Draw",       value:dc.Power_MW>=1000?`${(dc.Power_MW/1000).toFixed(1)} GW`:`${dc.Power_MW||"?"}MW`,color:rc,                                                                tip:METRIC_TIP.power(dc.Power_MW)},
                    {icon:"noise",label:"Estimated Noise Level",     value:`${dc.Noise_DB||"?"} dB`,                                                            color:dc.Noise_DB>=70?"#ef4444":dc.Noise_DB>=60?"#f97316":"#3b82f6", tip:METRIC_TIP.noise},
                    {icon:"emf",  label:"Modeled EMF Range at Fence",value:`${dc.EMF_Fence_High||"?"} mG`,                                                       color:dc.EMF_Fence_High>=4?"#ef4444":"#10b981",                       tip:METRIC_TIP.emfFence},
                    {icon:"water",label:"Estimated Daily Water Draw",value:dc.Water_Gal_Day>0?`${fmt(dc.Water_Gal_Day)} gal`:"Near zero",                        color:"#3b82f6",                                                      tip:METRIC_TIP.water},
                  ].map(s=>(
                    <div key={s.label} style={{background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:14,padding:"16px 18px",textAlign:"center"}}>
                      <div style={{display:"flex",justifyContent:"center",marginBottom:10}}><Icon name={s.icon} size={22} color={s.color}/></div>
                      <div style={{fontSize:22,fontWeight:900,color:s.color,marginBottom:4,letterSpacing:"-.02em"}}>{s.value}</div>
                      <div style={{fontSize:12,color:"#94a3b8",textTransform:"uppercase",letterSpacing:".06em",fontWeight:700,display:"inline-flex",alignItems:"center",justifyContent:"center"}}>
                        {s.label}
                        <InfoTip label={"About " + s.label.toLowerCase()}>{s.tip}</InfoTip>
                      </div>
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

        <Footer onNavigate={navigate} facilities={facs}/>

      </div>
      )}
      {/* SCROLL TO TOP BUTTON. Rendered outside the route ternary so it
          is available on every page, desktop and mobile. Pinned to the
          bottom left so it never collides with the chat bubble in the
          bottom right corner. */}
      {showScrollTop && (
        <button
          onClick={()=>window.scrollTo({top:0,behavior:"smooth"})}
          style={{
            position:"fixed",
            bottom:24,
            left:24,
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
      <CookieConsent onNavigate={navigate}/>
      <ChatWidget onNavigate={navigate}/>
    </>
  );
}
