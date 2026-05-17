import { useState, useEffect, useRef, useCallback } from "react";

// ─── AIRTABLE CONNECTION ───────────────────────────────────────────────────────
const BASE   = "app2FUPqq8VQSwQ64";
const KEY    = import.meta.env.VITE_AIRTABLE_KEY;
const APIURL = `https://api.airtable.com/v0/${BASE}`;
const HDR    = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function apiFetch(table, params = {}) {
  let all = [], offset = null;
  do {
    const url = new URL(`${APIURL}/${table}`);
    Object.entries(params).forEach(([k,v]) => url.searchParams.set(k,v));
    if (offset) url.searchParams.set("offset", offset);
    url.searchParams.set("pageSize", "100");
    try {
      const r = await fetch(url.toString(), { headers: HDR });
      if (!r.ok) break;
      const d = await r.json();
      all = [...all, ...(d.records||[])];
      offset = d.offset || null;
    } catch { break; }
  } while (offset);
  return all.map(r => ({ id: r.id, ...r.fields }));
}

async function postReport(fields) {
  if (fields._hp) return false; // honeypot
  try {
    const r = await fetch(`${APIURL}/Reports`, {
      method: "POST",
      headers: HDR,
      body: JSON.stringify({ fields }),
    });
    return r.ok;
  } catch { return false; }
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
    {icon:"sound",  t:"The Constant Hum",         s:5, d:"A low drone like a refrigerator that never turns off, felt in the chest, through walls, through floors. Reported audible up to 4 miles in quiet areas. Worst between 2 and 4am when all other noise dies away."},
    {icon:"head",   t:"Chronic Headaches",         s:5, d:"The most commonly reported symptom. Residents describe waking with headaches that improve when they leave home and worsen the longer they stay indoors near the facility."},
    {icon:"dizzy",  t:"Dizziness and Vertigo",     s:4, d:"Infrasound, vibration below conscious hearing, disrupts the body's balance system. Documented in Granbury TX where residents reported vertigo severe enough to affect daily life."},
    {icon:"nausea", t:"Nausea",                    s:4, d:"Linked to infrasound exposure. A National Library of Medicine study found infrasound can affect cardiac function within one hour of exposure above 100 dB."},
    {icon:"sleep",  t:"Sleep Destroyed",           s:5, d:"Low-frequency noise penetrates walls better than high frequencies. Residents report never reaching deep sleep, waking at 2 to 4am, and cumulative exhaustion that compounds every other health issue."},
    {icon:"anxiety",t:"Anxiety and Panic Attacks", s:4, d:"Persistent vibration activates fight-or-flight even without a conscious sound cue. One Virginia resident said it triggers an anxiety attack every time they do load testing."},
    {icon:"ear",    t:"Tinnitus (Ear Ringing)",    s:3, d:"Multiple facilities have residents reporting permanent ear ringing. In Granbury TX, residents sued for irreversible hearing damage including children."},
    {icon:"smoke",  t:"Diesel Exhaust Smell",      s:4, d:"Monthly generator tests release diesel exhaust, a Group 1 carcinogen. Residents describe 30 to 60 minute episodes of visible black smoke and strong exhaust odor, worst downwind."},
  ],
  MODERATE:[
    {icon:"sound",  t:"Background Hum",            s:3, d:"Persistent low-frequency sound, most noticeable at night. Some describe it as pressure rather than sound."},
    {icon:"head",   t:"Intermittent Headaches",    s:3, d:"Correlate with generator test cycles. Some residents notice it tracks with wind direction."},
    {icon:"sleep",  t:"Disrupted Sleep",           s:3, d:"Generator tests lasting 30 to 90 minutes at up to 105 dB and continuous cooling noise affect sleep quality."},
    {icon:"smoke",  t:"Occasional Exhaust Odor",   s:2, d:"During monthly generator tests. Diesel particulate matter is a classified carcinogen. There is no established safe level."},
  ],
  "LOW-MODERATE":[
    {icon:"sound",  t:"Mild Background Noise",     s:2, d:"Present 24/7 but less intrusive. Low-frequency components travel further than measured dB suggests."},
    {icon:"smoke",  t:"Diesel During Tests",       s:2, d:"Monthly generator tests still produce diesel exhaust for 30 to 60 minutes. Keep windows closed if you notice the smell."},
  ],
};

const LONGTERM = [
  {icon:"cancer",c:"#ef4444",t:"Cancer Risk",         sh:"Diesel exhaust is a Group 1 carcinogen. EMF classified possibly carcinogenic by WHO.",lo:"Two separate pathways elevate cancer risk. Diesel PM2.5 from backup generators is in the same carcinogen class as asbestos, directly linked to lung cancer. The WHO's IARC classified power-frequency magnetic fields possibly carcinogenic (Group 2B) in 2002, with the strongest evidence for childhood leukemia at exposures starting at just 3 to 4 milligauss. The legal US limit is 2,000 mG, which is 500 times higher than where studies found risk.",stat:"Around 1,300 projected premature US deaths annually from data center pollution by 2030",src:"arXiv 2412.06288, 2025",url:"https://arxiv.org/abs/2412.06288"},
  {icon:"heart", c:"#f97316",t:"Heart Disease",        sh:"Chronic noise raises blood pressure. Air pollution inflames blood vessels. Both compound over years.",lo:"Chronic environmental noise keeps the body in low-grade stress. Over years this elevates blood pressure and increases heart attack and stroke risk. Diesel PM2.5 directly inflames arterial walls. Multiple peer-reviewed studies link proximity to industrial noise to increased cardiovascular mortality.",stat:"Long-term exposure linked to hypertension, cardiovascular disease, and stroke",src:"ScienceDirect, 2025",url:"https://www.sciencedirect.com"},
  {icon:"lung",  c:"#eab308",t:"Lungs and Breathing", sh:"PM2.5 enters your bloodstream through your lungs. There is no safe level of exposure.",lo:"Fine particulate matter from diesel generators is small enough to cross from lungs into the bloodstream. The Harvard Six Cities Study found no safe exposure level. It worsens asthma, COPD, and overall lung function. Children and elderly are most vulnerable.",stat:"600,000 or more projected asthma cases per year from US data centers by 2030",src:"arXiv 2412.06288, 2025",url:"https://arxiv.org/abs/2412.06288"},
  {icon:"brain", c:"#8b5cf6",t:"Mental Health",        sh:"Chronic noise, lost sleep, feeling powerless. Documented anxiety, depression, and stress.",lo:"The combination of chronic sleep loss, constant low-level vibration, and feeling ignored by authorities creates a documented mental health burden. Residents near data center clusters in Virginia, Texas, and Arizona report increased anxiety, helplessness, and depression.",stat:"Chronic industrial noise independently linked to anxiety and depression",src:"US News, April 2026",url:"https://www.usnews.com"},
  {icon:"baby",  c:"#3b82f6",t:"Reproductive Health", sh:"ELF magnetic fields linked to miscarriage. Air pollution linked to premature birth.",lo:"ELF magnetic fields have been studied in relation to miscarriage risk, with some studies finding elevated risk near high-voltage infrastructure. PM2.5 is independently associated with premature birth and low birth weight.",stat:"ELF-EMF exposure linked to miscarriage in peer-reviewed studies",src:"BioInitiative Report",url:"https://www.bioinitiative.org"},
  {icon:"moon",  c:"#10b981",t:"Sleep and Brain",      sh:"Chronic sleep loss degrades immunity, memory, heart health, and lifespan.",lo:"Chronic sleep deprivation raises diabetes and obesity risk, impairs memory and cognition, and is independently associated with shortened lifespan. Low-frequency noise has been reported audible up to 4.5 miles in quiet environments.",stat:"Infrasound shown to affect cardiac function within 1 hour above 100 dB",src:"US National Library of Medicine",url:"https://pubmed.ncbi.nlm.nih.gov"},
];

const KIDS = [
  {icon:"dna",   t:"Childhood Leukemia",         sev:"SERIOUS",         c:"#ef4444",d:"WHO and IARC classified power-frequency magnetic fields possibly carcinogenic because of studies linking childhood residential exposure to elevated leukemia rates at just 3 to 4 milligauss. Children's developing cells are far more sensitive to environmental disruption than adults."},
  {icon:"lung",  t:"Asthma and Lungs",           sev:"DOCUMENTED",      c:"#f97316",d:"Diesel particulate matter is a known asthma trigger in children. Kids with asthma living downwind of generator exhaust face increased attack frequency. A 2025 model projects data centers could cause over one-third of all US asthma deaths by 2030."},
  {icon:"brain", t:"Brain Development and ADHD", sev:"EMERGING",        c:"#eab308",d:"ELF-EMF has been linked in studies to ADHD and cognitive dysfunction in children. Chronic sleep disruption from environmental noise independently impairs developing brains, affecting memory, attention, and emotional regulation."},
  {icon:"sleep", t:"Sleep and Growth",           sev:"HIGH CONCERN",    c:"#8b5cf6",d:"Children need more sleep than adults. It is when growth hormone is released and memories consolidate. Low-frequency noise prevents deep sleep even at levels adults barely notice."},
  {icon:"ear",   t:"Hearing Damage",             sev:"DOCUMENTED CASES",c:"#3b82f6",d:"The Granbury TX case involved residents including children claiming permanent hearing damage and tinnitus. Children's hearing is still developing and more sensitive. Sustained exposure above 70 dB causes progressive damage."},
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
  {id:"reports", label:"Community",         icon:"community"},
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

  .a1{animation:fadeUp .55s ease both}
  .a2{animation:fadeUp .55s .1s ease both}
  .a3{animation:fadeUp .55s .2s ease both}
  .a4{animation:fadeUp .55s .3s ease both}
  .floating{animation:floatAnim 5s ease-in-out infinite}
  .spinning{animation:spin 1s linear infinite}

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
    .hero h1{font-size:34px!important}
    .search-row{flex-direction:column!important}
    .stats-row{gap:20px!important;padding:20px 16px!important}
    .sym-grid{grid-template-columns:1fr!important}
    .nums-grid{grid-template-columns:1fr!important}
    .fac-stats{grid-template-columns:1fr 1fr!important}
    .tabs-row{padding:12px 14px!important}
    .tab-content{padding:20px 16px 28px!important}
    .fac-header{padding:20px 16px!important}
    .main{padding:20px 16px 48px!important}
    .rings{display:none!important}
    .stat-val{font-size:24px!important}
    .addr-bar{flex-direction:column!important;align-items:flex-start!important;gap:10px!important}
  }
  @media(max-width:480px){
    .hero h1{font-size:26px!important}
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

  // Curated data center / server room images: always relevant, always professional
  const DC_IMGS = [
    "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=900&q=80",
    "https://images.unsplash.com/photo-1573164713988-8665fc963095?w=900&q=80",
    "https://images.unsplash.com/photo-1544197150-b99a580bb7a8?w=900&q=80",
    "https://images.unsplash.com/photo-1606765962248-7ff407b51667?w=900&q=80",
    "https://images.unsplash.com/photo-1580584126903-c17d41830450?w=900&q=80",
    "https://images.unsplash.com/photo-1597852074816-d933c7d2b988?w=900&q=80",
    "https://images.unsplash.com/photo-1531482615713-2afd69097998?w=900&q=80",
    "https://images.unsplash.com/photo-1587440871875-191322ee64b0?w=900&q=80",
  ];
  const fallbackUrl = (() => {
    let hash = 0;
    const name = dc?.Name || "facility";
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) & 0xffff;
    return DC_IMGS[hash % DC_IMGS.length];
  })();

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
          <img src={fallbackUrl} alt={`Data center facility`}
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

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [facs,setFacs]           = useState([]);
  const [loading,setLoading]     = useState(true);
  const [country,setCountry]     = useState("");
  const [cInput,setCInput]       = useState("");
  const [showCD,setShowCD]       = useState(false);
  const [cityTxt,setCityTxt]     = useState("");
  const [showCityD,setShowCityD] = useState(false);
  const [cDropPos,setCDropPos]   = useState({top:0,left:0,width:0});
  const [cityDropPos,setCityDropPos] = useState({top:0,left:0,width:0});
  const [sel,setSel]             = useState(null);
  const [tab,setTab]             = useState("feel");
  const [reps,setReps]           = useState([]);
  const [draft,setDraft]         = useState("");
  const [repName,setRepName]     = useState("");
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
  const [statVals,setStatVals]   = useState([0,0,0,0]);
  const cRef    = useRef(null);
  const ciRef   = useRef(null);
  const cDropRef  = useRef(null);
  const cityDropRef = useRef(null);
  const topRef  = useRef(null);

  useEffect(()=>{
    apiFetch("Facilities").then(d=>{ setFacs(d); setLoading(false); });
  },[]);

  useEffect(()=>{
    if(loading) return;
    const targets=[1300,20,600000,facs.length];
    let frame=0;
    const iv=setInterval(()=>{
      frame++;
      const e=1-Math.pow(1-frame/80,3);
      setStatVals(targets.map(t=>Math.round(t*e)));
      if(frame>=80){ clearInterval(iv); setStatVals(targets); }
    },2400/80);
    return ()=>clearInterval(iv);
  },[loading,facs.length]);

  // Calculate dropdown position: called right when dropdown opens
  const openCDrop = useCallback(()=>{
    if(!cRef.current) return;
    const r = cRef.current.getBoundingClientRect();
    setCDropPos({top:r.bottom+8, left:r.left, width:r.width});
    setShowCD(true);
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
      if(showCityD && ciRef.current){
        const r = ciRef.current.getBoundingClientRect();
        setCityDropPos({top:r.bottom+8, left:r.left, width:r.width});
      }
    };
    const h = e => {
      const inCInput  = cRef.current   && cRef.current.contains(e.target);
      const inCDrop   = cDropRef.current && cDropRef.current.contains(e.target);
      const inCiInput = ciRef.current  && ciRef.current.contains(e.target);
      const inCiDrop  = cityDropRef.current && cityDropRef.current.contains(e.target);
      if(!inCInput  && !inCDrop)  setShowCD(false);
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
  },[showCD, showCityD]);

  const dc       = sel ? facs.find(f=>f.id===sel) : null;
  const rc       = dc ? (RISK_C[dc.Risk_Level]||"#64748b") : "#64748b";
  const symptoms = dc ? (SYMPTOMS[dc.Risk_Level]||SYMPTOMS["LOW-MODERATE"]) : [];
  const mapsUrl  = dc ? getGoogleMapsUrl(dc.Latitude, dc.Longitude, dc.Address, dc.Name) : "#";
  const locStr   = dc ? buildLocationString(dc) : "";

  useEffect(()=>{
    if(!dc) return;
    setReps([]);
    apiFetch("Reports",{filterByFormula:`{Facility} = "${dc.Name}"`}).then(setReps);
  },[sel]);

  const countries   = [...new Set(facs.map(f=>f.Country).filter(Boolean))].sort();
  const cMatches    = cInput ? countries.filter(c=>c.toLowerCase().includes(cInput.toLowerCase())) : countries;
  const citiesInC   = country ? [...new Map(facs.filter(f=>f.Country===country).map(f=>[f.City,f])).values()] : [];
  const cityMatches = cityTxt ? citiesInC.filter(f=>f.City?.toLowerCase().includes(cityTxt.toLowerCase())) : citiesInC;
  const cityGroups  = cityMatches.reduce((a,f)=>{ if(!a[f.City])a[f.City]=[]; a[f.City].push(f); return a; },{});

  const pickCountry = c => { setCountry(c); setCInput(c); setShowCD(false); setCityTxt(""); setSel(null); };
  const clearAll    = () => { setCountry(""); setCInput(""); setCityTxt(""); setSel(null); setShowCD(false); setShowCityD(false); };
  const pickFac     = id => {
    setSel(id); setTab("feel");
    setQStep(0); setQRes(null); setQAns({});
    setXLong(null); setXKid(null); setSent(false);
    setTimeout(()=>topRef.current?.scrollIntoView({behavior:"smooth"}),100);
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

  const sendReport = async () => {
    if(!draft.trim()||!dc) return;
    if(hp) return; // honeypot triggered: bot detected
    setSending(true);
    const ok = await postReport({
      Reporter:repName||"Anonymous",
      Facility:dc.Name,
      Report_Text:draft,
      City:dc.City,
      Country:dc.Country,
      Date_Submitted:new Date().toISOString().split("T")[0],
      Approved:false,
    });
    if(ok){ setSent(true); setDraft(""); setRepName(""); apiFetch("Reports",{filterByFormula:`{Facility} = "${dc.Name}"`}).then(setReps); }
    setSending(false);
  };

  const STATS=[
    {val:`~${statVals[0].toLocaleString()}`,label:"Projected US deaths/year by 2030"},
    {val:`$${statVals[1]}B+`,               label:"Annual public health burden"},
    {val:statVals[2]>=600000?"600K":fmt(statVals[2]),label:"Projected asthma cases/year"},
    {val:loading?"...":facs.length,         label:"Facilities in our database"},
  ];

  return (
    <>
      <style>{CSS}</style>
      <div style={{minHeight:"100vh",background:"#f1f5f9"}}>

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

          {/* SEARCH: dropdowns use fixed positioning to float above everything */}
          <div className="a4 search-row" style={{display:"flex",gap:14,width:"100%",maxWidth:740,position:"relative",zIndex:100}}>

            {/* Country */}
            <div ref={cRef} style={{flex:1,position:"relative"}}>
              <div style={{position:"relative",display:"flex",alignItems:"center"}}>
                <span style={{position:"absolute",left:18,zIndex:2,pointerEvents:"none",display:"flex"}}>
                  <Icon name="globe" size={20} color="rgba(255,255,255,.7)"/>
                </span>
                <input className="srch" value={cInput}
                  onChange={e=>{setCInput(e.target.value);openCDrop();}}
                  onFocus={openCDrop}
                  placeholder="Select a country..."
                  style={{width:"100%",padding:"20px 18px 20px 52px",fontSize:17,fontWeight:500,fontFamily:"inherit",borderRadius:16,border:"1.5px solid rgba(255,255,255,.18)",background:"rgba(255,255,255,.11)",color:"#fff",backdropFilter:"blur(16px)",boxSizing:"border-box",boxShadow:"0 8px 32px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.12)"}}
                />
              </div>
            </div>

            {/* City */}
            <div ref={ciRef} style={{flex:1,position:"relative",opacity:country?1:.45,pointerEvents:country?"all":"none",transition:"opacity .2s"}}>
              <div style={{position:"relative",display:"flex",alignItems:"center"}}>
                <span style={{position:"absolute",left:18,zIndex:2,pointerEvents:"none",display:"flex"}}>
                  <Icon name="pin" size={20} color="rgba(255,255,255,.7)"/>
                </span>
                <input className="srch" value={cityTxt}
                  onChange={e=>{setCityTxt(e.target.value);openCityDrop();}}
                  onFocus={openCityDrop}
                  placeholder={country?`Cities in ${country}...`:"Select country first"}
                  style={{width:"100%",padding:"20px 18px 20px 52px",fontSize:17,fontWeight:500,fontFamily:"inherit",borderRadius:16,border:"1.5px solid rgba(255,255,255,.18)",background:"rgba(255,255,255,.11)",color:"#fff",backdropFilter:"blur(16px)",boxSizing:"border-box",boxShadow:"0 8px 32px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.12)"}}
                />
              </div>
            </div>
          </div>

          {country && (
            <button className="a4 clear-btn" onClick={clearAll} style={{marginTop:20,background:"rgba(255,255,255,.09)",border:"1px solid rgba(255,255,255,.18)",color:"rgba(255,255,255,.7)",padding:"10px 24px",borderRadius:24,fontSize:15,position:"relative",zIndex:1,display:"flex",alignItems:"center",gap:8}}>
              <Icon name="close" size={16} color="rgba(255,255,255,.7)"/> Clear search
            </button>
          )}

          {!dc && (
            <div className="floating" style={{position:"absolute",bottom:36,left:"50%",transform:"translateX(-50%)",color:"rgba(255,255,255,.25)",fontSize:14,zIndex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
              <span>scroll to learn more</span>
              <Icon name="chevDown" size={20} color="rgba(255,255,255,.25)"/>
            </div>
          )}
        </section>

        {/* FIXED DROPDOWNS: rendered at root level, float above everything */}
        {showCD && (
          <div ref={cDropRef} style={{position:"fixed",top:cDropPos.top,left:cDropPos.left,width:cDropPos.width,background:"#fff",borderRadius:16,boxShadow:"0 28px 72px rgba(0,0,0,.32)",zIndex:9999,border:"1px solid #e2e8f0",overflow:"hidden"}}>
            <div className="scroll-inner" style={{maxHeight:"min(340px, 60vh)",overflowY:"auto"}}>
              {cMatches.length===0 && <div style={{padding:"16px 20px",color:"#94a3b8",fontSize:16,fontStyle:"italic"}}>No countries found</div>}
              {cMatches.map(c=>(
                <div key={c} className="drop-item" style={{padding:"15px 20px",fontSize:16,color:"#1e293b",borderBottom:"1px solid #f1f5f9",fontWeight:500}} onClick={()=>pickCountry(c)}>{c}</div>
              ))}
            </div>
          </div>
        )}

        {showCityD && country && (
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
                    return(
                      <div key={f.id} className="drop-item" style={{padding:"14px 20px 14px 28px",borderBottom:"1px solid #f1f5f9"}} onClick={()=>{setCityTxt(city);setShowCityD(false);pickFac(f.id);}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10}}>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{fontSize:15,fontWeight:700,color:"#1e293b",marginBottom:3,lineHeight:1.3}}>{f.Name}</div>
                            <div style={{fontSize:13,color:"#64748b",fontWeight:500}}>{f.Company} &middot; {f.Power_MW>=1000?`${(f.Power_MW/1000).toFixed(1)} GW`:`${f.Power_MW||"?"}MW`}</div>
                            {f.City && f.State_Region && <div style={{fontSize:12,color:"#94a3b8",marginTop:2}}>{f.City}, {f.State_Region}</div>}
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
        <div className="stats-row" style={{background:"#fff",borderBottom:"1px solid #e2e8f0",padding:"24px 32px",display:"flex",justifyContent:"center",alignItems:"center",gap:56,flexWrap:"wrap"}}>
          {STATS.map((s,i)=>(
            <div key={i} style={{textAlign:"center"}}>
              <div className="stat-val" style={{fontSize:32,fontWeight:900,letterSpacing:"-.02em",display:"block",lineHeight:1.1,background:"linear-gradient(135deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>{s.val}</div>
              <div style={{fontSize:13,color:"#94a3b8",letterSpacing:".06em",textTransform:"uppercase",fontWeight:700,marginTop:5}}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* MAIN */}
        <main className="main" ref={topRef} style={{maxWidth:1040,margin:"0 auto",padding:"36px 24px 72px"}}>

          {!dc && !loading && (
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

          {loading && (
            <div style={{textAlign:"center",padding:80,color:"#94a3b8"}}>
              <div className="spinning" style={{width:48,height:48,border:"3px solid #e2e8f0",borderTop:"3px solid #ef4444",borderRadius:"50%",margin:"0 auto 16px"}}/>
              <div style={{fontSize:17,fontWeight:600}}>Loading global facility data...</div>
            </div>
          )}

          {dc && (
            <div style={{background:"#fff",borderRadius:24,overflow:"hidden",boxShadow:"0 8px 48px rgba(0,0,0,.10)"}}>

              {/* OPENSTREETMAP IMAGE */}
              <FacilityMapImage dc={dc} rc={rc}/>

              {/* ADDRESS BAR + GOOGLE MAPS */}
              <div className="addr-bar" style={{background:"#f8fafc",borderBottom:"1px solid #e2e8f0",padding:"14px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,flexWrap:"wrap"}}>
                <div style={{display:"flex",alignItems:"flex-start",gap:10,flex:1,minWidth:0}}>
                  <Icon name="pin" size={18} color="#94a3b8" style={{flexShrink:0,marginTop:2}}/>
                  <div>
                    <div style={{fontSize:15,color:"#1e293b",fontWeight:600,lineHeight:1.4}}>{locStr || "Address not on file"}</div>
                    {dc.Latitude && dc.Longitude && (
                      <div style={{fontSize:12,color:"#94a3b8",marginTop:2}}>Coordinates: {parseFloat(dc.Latitude).toFixed(4)}, {parseFloat(dc.Longitude).toFixed(4)}</div>
                    )}
                  </div>
                </div>
                <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="map-btn"
                  style={{display:"inline-flex",alignItems:"center",gap:8,background:"#3b82f6",color:"#fff",padding:"11px 22px",borderRadius:10,fontSize:14,fontWeight:700,textDecoration:"none",flexShrink:0,boxShadow:"0 2px 8px rgba(59,130,246,.35)"}}>
                  <Icon name="navigate" size={16} color="#fff"/>
                  Open in Google Maps
                </a>
              </div>

              {/* HEADER */}
              <div className="fac-header" style={{padding:"24px 28px 20px"}}>
                <h2 style={{fontSize:24,fontWeight:900,color:"#0f172a",marginBottom:6,letterSpacing:"-.02em",lineHeight:1.2}}>{dc.Name}</h2>
                {dc.Company && <div style={{fontSize:15,color:"#64748b",marginBottom:4,fontWeight:600}}>{dc.Company}</div>}
                {dc.Nearby_Info && <div style={{fontSize:15,color:"#64748b",marginBottom:6,fontStyle:"italic"}}>{dc.Nearby_Info}</div>}
                {dc.Opened && <div style={{fontSize:14,color:"#94a3b8",marginBottom:20}}>Opened / Status: {dc.Opened}</div>}

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

              {/* TABS */}
              <div style={{borderTop:"1px solid #f1f5f9",background:"#fafafa"}}>
                <div className="tabs-row" style={{display:"flex",gap:8,padding:"18px 24px",overflowX:"auto",flexWrap:"wrap"}}>
                  {TABS.map(t=>(
                    <button key={t.id} className="tab-btn" onClick={()=>setTab(t.id)}
                      style={{display:"flex",alignItems:"center",gap:7,padding:"11px 20px",borderRadius:22,fontSize:14,fontWeight:700,border:`2px solid ${tab===t.id?rc:"#e2e8f0"}`,background:tab===t.id?rc:"#fff",color:tab===t.id?"#fff":"#64748b",boxShadow:tab===t.id?`0 4px 16px ${rc}44`:"none"}}>
                      <Icon name={t.icon} size={16} color={tab===t.id?"#fff":"#64748b"}/>
                      {t.label}{t.id==="reports"&&reps.length>0?` (${reps.length})`:""}
                    </button>
                  ))}
                </div>
              </div>

              {/* TAB CONTENT */}
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

                {tab==="quiz" && (
                  <div>
                    <h3 style={{fontSize:22,fontWeight:900,color:"#0f172a",marginBottom:10}}>Your Personal Risk Assessment</h3>
                    <p style={{fontSize:16,color:"#64748b",marginBottom:28,lineHeight:1.75}}>Answer five questions to receive a detailed, personalized assessment based on your proximity and household situation.</p>

                    {/* RESULTS */}
                    {qRes && !qEmailStep && (
                      <div>
                        {/* Risk level header */}
                        <div style={{background:(RISK_C[qRes.level]||"#64748b")+"0d",border:`2px solid ${(RISK_C[qRes.level]||"#64748b")}22`,borderRadius:18,padding:"28px",marginBottom:20}}>
                          <div style={{fontSize:13,color:"#94a3b8",fontWeight:800,letterSpacing:".1em",textTransform:"uppercase",marginBottom:12}}>Your Personal Risk Level</div>
                          <div style={{fontSize:60,fontWeight:900,color:RISK_C[qRes.level]||"#64748b",letterSpacing:"-.02em",marginBottom:16,lineHeight:1}}>{qRes.level}</div>
                          <p style={{fontSize:16,color:"#374151",lineHeight:1.85,marginBottom:0}}>{qRes.summary}</p>
                        </div>

                        {/* Full details: only visible after email entered */}
                        {qEmailSent && (
                          <div>
                            {/* Green confirmation bubble sits right above the detailed content */}
                            <div style={{background:"#f0fdf4",border:"1.5px solid #bbf7d0",borderRadius:12,padding:"14px 18px",marginBottom:20,display:"flex",alignItems:"center",gap:10}}>
                              <Icon name="check" size={18} color="#15803d"/>
                              <div style={{fontSize:14,color:"#166534",fontWeight:700}}>Your full report is unlocked. Your email has been saved privately.</div>
                            </div>
                            <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:16,padding:"22px 24px",marginBottom:16,boxShadow:"0 2px 8px rgba(0,0,0,.04)"}}>
                              <div style={{fontSize:13,color:"#94a3b8",fontWeight:800,textTransform:"uppercase",letterSpacing:".08em",marginBottom:14}}>What this means for your situation</div>
                              {qRes.flags.map((f,i)=>(
                                <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start",padding:"10px 0",borderBottom:i<qRes.flags.length-1?"1px solid #f8fafc":"none"}}>
                                  <div style={{width:28,height:28,borderRadius:"50%",background:(RISK_C[qRes.level]||"#64748b")+"14",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                                    <Icon name="alert" size={14} color={RISK_C[qRes.level]||"#64748b"}/>
                                  </div>
                                  <div style={{fontSize:15,color:"#374151",lineHeight:1.7}}>{f}</div>
                                </div>
                              ))}
                            </div>

                            {qRes.actions && qRes.actions.length>0 && (
                              <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:16,padding:"22px 24px",marginBottom:20,boxShadow:"0 2px 8px rgba(0,0,0,.04)"}}>
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

                        {/* Email gate: required to unlock full details */}
                        {!qEmailSent && (
                          <div style={{background:"linear-gradient(135deg,#0f172a,#1e0535)",borderRadius:16,padding:"28px",marginBottom:20,border:"1px solid rgba(255,255,255,.08)"}}>
                            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                              <div style={{width:36,height:36,borderRadius:10,background:rc+"33",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                                <Icon name="doc" size={20} color={rc}/>
                              </div>
                              <div style={{fontSize:18,fontWeight:800,color:"#fff"}}>Your full report is ready</div>
                            </div>
                            <div style={{fontSize:15,color:"rgba(255,255,255,.65)",marginBottom:22,lineHeight:1.7}}>
                              Enter your email to unlock your complete risk breakdown and personalized action plan. We store your email privately and will not contact you again.
                            </div>
                            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                              <input value={qEmail} onChange={e=>setQEmail(e.target.value)}
                                placeholder="Enter your email address"
                                type="email"
                                onKeyDown={e=>{ if(e.key==="Enter"&&qEmail.trim()) saveQuizEmail(); }}
                                style={{flex:1,minWidth:220,padding:"14px 18px",borderRadius:12,border:`1.5px solid ${qEmail.trim()?"rgba(255,255,255,.4)":"rgba(255,255,255,.15)"}`,background:"rgba(255,255,255,.1)",color:"#fff",fontSize:16,outline:"none",fontFamily:"inherit",transition:"border-color .2s"}}/>
                              <button
                                onClick={()=>{ if(qEmail.trim()) saveQuizEmail(); }}
                                disabled={!qEmail.trim()}
                                style={{padding:"14px 28px",borderRadius:12,border:"none",background:qEmail.trim()?rc:"rgba(255,255,255,.12)",color:qEmail.trim()?"#fff":"rgba(255,255,255,.3)",fontSize:16,fontWeight:800,cursor:qEmail.trim()?"pointer":"default",fontFamily:"inherit",transition:"all .2s",whiteSpace:"nowrap",boxShadow:qEmail.trim()?`0 4px 16px ${rc}55`:"none"}}>
                                Unlock My Report
                              </button>
                            </div>
                            <div style={{fontSize:12,color:"rgba(255,255,255,.3)",marginTop:12}}>
                              Stored privately. We will not send you anything else.
                            </div>
                          </div>
                        )}




                        <button onClick={()=>{setQStep(0);setQRes(null);setQAns({});setQEmailStep(false);setQEmailSent(false);setQEmail("");}}
                          style={{padding:"12px 26px",borderRadius:12,border:`2px solid ${rc}`,background:"transparent",color:rc,fontSize:15,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                          Retake Quiz
                        </button>
                      </div>
                    )}

                    {/* QUESTIONS */}
                    {!qRes && (
                      <div>
                        <div style={{fontSize:14,color:"#94a3b8",fontWeight:700,textTransform:"uppercase",letterSpacing:".08em",marginBottom:16}}>Question {qStep+1} of {QUIZ.length}</div>
                        <div style={{background:"#f8fafc",borderRadius:16,padding:"26px",marginBottom:18}}>
                          <p style={{fontSize:18,color:"#0f172a",fontWeight:700,marginBottom:22,lineHeight:1.55}}>{QUIZ[qStep].q}</p>
                          {QUIZ[qStep].o.map(opt=>(
                            <button key={opt} className="q-opt"
                              style={{display:"block",width:"100%",padding:"16px 20px",borderRadius:12,border:"2px solid #e2e8f0",background:"#fff",color:"#374151",fontSize:16,marginBottom:10,boxShadow:"0 1px 4px rgba(0,0,0,.05)",fontWeight:500}}
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
                        {xKid===i && (<div style={{padding:"0 24px 24px",borderTop:"1px solid #f1f5f9"}}><p style={{fontSize:16,color:"#374151",lineHeight:1.9,margin:"18px 0 0"}}>{k.d}</p></div>)}
                      </div>
                    ))}
                    <div style={{background:"#f0fdf4",border:"2px solid #bbf7d0",borderRadius:16,padding:"20px 24px",marginTop:12}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}><Icon name="megaphone" size={20} color="#15803d"/><span style={{fontSize:13,color:"#15803d",fontWeight:800,letterSpacing:".08em",textTransform:"uppercase"}}>What Parents Are Demanding</span></div>
                      {["Mandatory independent EMF and air quality monitoring before and after construction","Minimum setback requirements from schools, daycare centers, and playgrounds","Real-time public air quality data near each facility","Advance notice of generator test schedules so parents can keep children indoors","Community right-to-know reporting on all emission events"].map((p,i)=>(
                        <div key={i} style={{display:"flex",gap:12,padding:"9px 0",borderBottom:i<4?"1px solid #dcfce7":"none",alignItems:"flex-start"}}><Icon name="check" size={18} color="#15803d"/><div style={{fontSize:15,color:"#166534",lineHeight:1.65}}>{p}</div></div>
                      ))}
                    </div>
                  </div>
                )}

                {tab==="numbers" && (
                  <div className="nums-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                    {[
                      {icon:"power",label:"Power Draw",    value:dc.Power_MW>=1000?`${(dc.Power_MW/1000).toFixed(1)} GW`:`${dc.Power_MW||"?"}MW`,plain:dc.Power_MW?`Enough to power ${fmt(Math.round(dc.Power_MW*1000/1.25))} average homes continuously, 24 hours a day, 365 days a year.`:"Power data pending verification.",color:rc},
                      {icon:"co2",  label:"CO2 Per Year",  value:dc.CO2_Tons_Year>0?`${fmt(dc.CO2_Tons_Year)} tons`:"Near zero",plain:dc.CO2_Tons_Year>0?`Same as ${fmt(Math.round(dc.CO2_Tons_Year/4.6))} cars driven for a full year.`:"Powered by renewable energy.",color:dc.CO2_Tons_Year>200000?"#ef4444":"#10b981"},
                      {icon:"water",label:"Water Per Day", value:dc.Water_Gal_Day>0?`${fmt(dc.Water_Gal_Day)} gal`:"Near zero",plain:dc.Water_Gal_Day>0?`Same daily water use as ${fmt(Math.round(dc.Water_Gal_Day/80))} households. Permanently removed from the local water cycle.`:"Air-cooled design. Minimal water consumption.",color:dc.Water_Gal_Day>500000?"#ef4444":"#10b981"},
                      {icon:"noise",label:"Perimeter Noise",value:`${dc.Noise_DB||"?"} dB`,plain:dc.Noise_DB>=70?"Like a vacuum cleaner running nonstop including 2am. Low-frequency components travel further than this number suggests.":"Moderate but continuous. Low-frequency components penetrate walls.",color:dc.Noise_DB>=70?"#ef4444":dc.Noise_DB>=60?"#f97316":"#3b82f6"},
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

                {tab==="act" && (
                  <div>
                    <h3 style={{fontSize:22,fontWeight:900,color:"#0f172a",marginBottom:10}}>You Are Not Powerless</h3>
                    <p style={{fontSize:16,color:"#64748b",marginBottom:28,lineHeight:1.75}}>Every data center regulation that exists was won by residents who organized, documented, and demanded accountability.</p>
                    {[
                      {icon:"doc",      t:"Document everything starting today", c:"#ef4444",steps:["Write down symptoms: headaches, sleep issues, dizziness, ear ringing, anxiety. Include dates and times.","Note when you smell diesel exhaust. This is likely a generator test. Record date, time, wind direction, duration.","Photograph or video any visible smoke or unusual emissions.","Keep a log even in a phone notes app. Patterns matter more than any single data point."]},
                      {icon:"megaphone",t:"File formal complaints",             c:"#f97316",steps:["Contact your city or county zoning board. Data center noise falls under industrial use permits.","File with your state or provincial environmental agency. Search for your state Department of Environmental Quality.","File with your national environmental protection body for air quality concerns.","Contact your elected representative in writing. A paper trail matters."]},
                      {icon:"monitor",  t:"Request independent monitoring",     c:"#eab308",steps:["Request an independent EMF survey of your property from a certified environmental health firm.","Ask your local health department to monitor air quality near the facility during generator tests.","If a school is nearby, contact the school board. They have legal standing to demand environmental assessments."]},
                      {icon:"group",    t:"Organize with neighbors",             c:"#8b5cf6",steps:["One complaint is easier to ignore than fifty. Start a neighborhood group or find existing local advocacy groups.","Coalitions in Prince William County VA and Loudoun County VA have successfully pushed back on data center ordinances.","Earthjustice at earthjustice.org and the Environmental Defense Fund have resources for impacted communities."]},
                      {icon:"shield",   t:"Protect your family right now",       c:"#3b82f6",steps:["Keep windows closed on generator test days which happen monthly. Request the facility test schedule in writing.","Air purifiers with HEPA filtration reduce indoor PM2.5 from diesel exhaust.","Speak with your doctor about any symptoms. Getting them on medical record matters if legal action is ever needed.","White noise machines can mask low-frequency intrusion for better sleep."]},
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
                    <p style={{fontSize:16,color:"#64748b",marginBottom:28,lineHeight:1.75}}>One person's symptom diary is anecdote. Three hundred people's diaries near the same facility, all spiking on generator test days, is a public health study. Your report matters.</p>
                    {reps.length===0 && <div style={{fontSize:16,color:"#94a3b8",fontStyle:"italic",marginBottom:28,padding:"16px 0"}}>No reports yet for this facility. Be the first to share your experience.</div>}
                    {reps.map((r,i)=>(
                      <div key={i} style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:16,padding:"20px 24px",marginBottom:12,boxShadow:"0 2px 8px rgba(0,0,0,.04)"}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                          <span style={{fontSize:15,fontWeight:800,color:rc,display:"flex",alignItems:"center",gap:6}}><Icon name="community" size={16} color={rc}/> {r.Reporter||"Anonymous"}</span>
                          <span style={{fontSize:14,color:"#94a3b8"}}>{r.Date_Submitted}</span>
                        </div>
                        <p style={{fontSize:16,color:"#374151",lineHeight:1.85,margin:0}}>{r.Report_Text}</p>
                      </div>
                    ))}
                    <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:18,padding:"28px",boxShadow:"0 4px 16px rgba(0,0,0,.06)",marginTop:8}}>
                      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20}}><Icon name="doc" size={20} color="#1e293b"/><div style={{fontSize:16,fontWeight:800,color:"#1e293b",textTransform:"uppercase",letterSpacing:".06em"}}>Add Your Report</div></div>
                      {/* Honeypot field: hidden from humans */}
                      <input className="hz-trap" tabIndex="-1" autoComplete="off" value={hp} onChange={e=>setHp(e.target.value)} aria-hidden="true"/>
                      {sent ? (
                        <div style={{background:"#f0fdf4",border:"1.5px solid #bbf7d0",borderRadius:14,padding:"20px 22px"}}>
                          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}><Icon name="check" size={20} color="#15803d"/><div style={{fontSize:17,fontWeight:800,color:"#15803d"}}>Report submitted. Thank you.</div></div>
                          <div style={{fontSize:15,color:"#166534",lineHeight:1.7}}>Your report will be reviewed and published shortly. Community data like yours builds the evidence base for regulatory action.</div>
                          <button onClick={()=>setSent(false)} style={{marginTop:14,fontSize:14,padding:"10px 20px",borderRadius:10,border:"1.5px solid #bbf7d0",background:"transparent",color:"#15803d",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>Submit another</button>
                        </div>
                      ) : (
                        <>
                          <input value={repName} onChange={e=>setRepName(e.target.value)} placeholder="Your name or Anonymous" style={{width:"100%",padding:"14px 18px",borderRadius:12,border:"1.5px solid #e2e8f0",fontSize:16,marginBottom:12,boxSizing:"border-box",outline:"none",fontFamily:"inherit",color:"#1e293b"}}/>
                          <textarea value={draft} onChange={e=>setDraft(e.target.value)} rows={5} placeholder="What do you notice? Sounds, smells, symptoms, health changes since the facility opened. Any detail, however small, is useful." style={{width:"100%",padding:"14px 18px",borderRadius:12,border:"1.5px solid #e2e8f0",fontSize:16,resize:"vertical",outline:"none",boxSizing:"border-box",fontFamily:"inherit",lineHeight:1.75,color:"#1e293b"}}/>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:16,gap:16,flexWrap:"wrap"}}>
                            <button onClick={sendReport} disabled={sending||!draft.trim()} style={{padding:"14px 32px",borderRadius:12,border:"none",background:draft.trim()?rc:"#e2e8f0",color:draft.trim()?"#fff":"#94a3b8",fontSize:16,fontWeight:800,cursor:draft.trim()?"pointer":"default",fontFamily:"inherit",transition:"all .2s",boxShadow:draft.trim()?`0 4px 16px ${rc}44`:"none"}}>
                              {sending?"Submitting...":"Submit Report"}
                            </button>
                            <div style={{fontSize:14,color:"#94a3b8",maxWidth:300,lineHeight:1.55}}>Reports reviewed before publishing. Anonymous option available. Data supports regulatory filings.</div>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}

              </div>
            </div>
          )}
        </main>

        {/* FOOTER */}
        <footer style={{background:"#0a0f1e",padding:"48px 24px 36px",textAlign:"center"}}>
          <div style={{marginBottom:8}}>
            <span style={{fontSize:26,fontWeight:900,letterSpacing:".08em",background:"linear-gradient(90deg,#ef4444,#f97316)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HumZones</span>
            <sup style={{fontSize:14,color:"#f97316",fontWeight:700,verticalAlign:"super",marginLeft:2}}>TM</sup>
          </div>
          <div style={{fontSize:16,color:"#64748b",marginBottom:22}}>Global Data Center Health Registry</div>
          <div style={{display:"flex",justifyContent:"center",gap:20,flexWrap:"wrap",marginBottom:28}}>
            {[
              {t:"Epoch AI (CC-BY)",url:"https://epoch.ai/data/data-centers"},
              {t:"EH Sciences",    url:"https://ehsciences.org"},
              {t:"IARC / WHO",     url:"https://www.iarc.who.int"},
              {t:"arXiv 2025",     url:"https://arxiv.org/abs/2412.06288"},
              {t:"BioInitiative",  url:"https://www.bioinitiative.org"},
              {t:"PubMed",         url:"https://pubmed.ncbi.nlm.nih.gov"},
            ].map(s=>(
              <a key={s.t} href={s.url} target="_blank" rel="noopener noreferrer" className="ext-link"
                style={{color:"#3b82f6",display:"flex",alignItems:"center",gap:4,fontSize:15,fontWeight:600}}>
                {s.t} <Icon name="external" size={13} color="#3b82f6"/>
              </a>
            ))}
          </div>
          <div style={{fontSize:15,color:"#94a3b8",borderTop:"1px solid #1e293b",paddingTop:20,lineHeight:1.8}}>
            &copy; 2026 HumZones&trade; &middot; humzones.com &middot; Built for residents, not the industry
          </div>
          <div style={{fontSize:13,color:"#475569",marginTop:6}}>
            HumZones is a trademark of HumZones Global Health Registry. All rights reserved.
          </div>
        </footer>

      </div>
    </>
  );
}
