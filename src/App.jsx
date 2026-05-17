import { useState, useEffect, useRef } from "react";

// ─── AIRTABLE CONFIG ──────────────────────────────────────────────────────────
const AIRTABLE_BASE_ID = "app2FUPqq8VQSwQ64";
const AIRTABLE_API_KEY = import.meta.env.VITE_AIRTABLE_KEY;
const AIRTABLE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

const headers = {
  Authorization: `Bearer ${AIRTABLE_API_KEY}`,
  "Content-Type": "application/json",
};

const fetchFacilities = async () => {
  try {
    let all = [];
    let offset = null;
    do {
      const url = new URL(`${AIRTABLE_URL}/Facilities`);
      url.searchParams.set("pageSize", "100");
      if (offset) url.searchParams.set("offset", offset);
      const res = await fetch(url.toString(), { headers });
      const data = await res.json();
      if (data.records) all = [...all, ...data.records];
      offset = data.offset || null;
    } while (offset);
    return all.map(r => ({ id: r.id, ...r.fields }));
  } catch (e) {
    console.error(e);
    return [];
  }
};

const fetchReports = async (facilityName) => {
  try {
    const url = new URL(`${AIRTABLE_URL}/Reports`);
    url.searchParams.set("filterByFormula", `{Facility} = "${facilityName}"`);
    const res = await fetch(url.toString(), { headers });
    const data = await res.json();
    return (data.records || []).map(r => ({ id: r.id, ...r.fields }));
  } catch (e) { return []; }
};

const submitReport = async (facilityName, reporter, text, city, country) => {
  try {
    const res = await fetch(`${AIRTABLE_URL}/Reports`, {
      method: "POST", headers,
      body: JSON.stringify({ fields: {
        Reporter: reporter || "Anonymous",
        Facility: facilityName,
        Report_Text: text,
        City: city, Country: country,
        Date_Submitted: new Date().toISOString().split("T")[0],
        Approved: false,
      }}),
    });
    return res.ok;
  } catch (e) { return false; }
};

// ─── STATIC DATA ──────────────────────────────────────────────────────────────
const STATUS_META = {
  OPERATING: { label: "Operating",           color: "#ef4444" },
  BUILDING:  { label: "Under Construction",  color: "#f97316" },
  PROPOSED:  { label: "Proposed",            color: "#3b82f6" },
  APPROVED:  { label: "Approved",            color: "#8b5cf6" },
};

const RISK_COLOR = { HIGH: "#ef4444", MODERATE: "#f97316", "LOW-MODERATE": "#3b82f6" };

const SYMPTOMS = {
  HIGH: [
    { emoji: "🔊", label: "The Constant Hum", sev: 5, desc: "A low drone like a refrigerator that never turns off — felt in the chest, through walls, through floors. Reported audible up to 4 miles in quiet areas. Worst between 2–4am." },
    { emoji: "🤕", label: "Chronic Headaches", sev: 5, desc: "The most commonly reported symptom. Residents describe waking with headaches, improving when they leave home, and worsening the longer they stay indoors near the facility." },
    { emoji: "😵‍💫", label: "Dizziness & Vertigo", sev: 4, desc: "Infrasound — vibration below conscious hearing — disrupts the body's balance system. Documented in Granbury TX where residents reported vertigo severe enough to affect daily life." },
    { emoji: "🤢", label: "Nausea", sev: 4, desc: "Linked to infrasound exposure. A National Library of Medicine study found infrasound can affect cardiac function within one hour of exposure above 100 dB." },
    { emoji: "😴", label: "Sleep Destroyed", sev: 5, desc: "Low-frequency noise penetrates walls better than higher frequencies. Residents report never reaching deep sleep, waking at 2–4am, and cumulative exhaustion." },
    { emoji: "😰", label: "Anxiety & Panic", sev: 4, desc: "Persistent vibration activates fight-or-flight even without a conscious sound cue. One Virginia resident: \"It triggers an anxiety attack every time they do load testing.\"" },
    { emoji: "👂", label: "Tinnitus", sev: 3, desc: "Multiple facilities have residents reporting permanent ear ringing. In Granbury TX residents sued for irreversible hearing damage." },
    { emoji: "💨", label: "Diesel Exhaust", sev: 4, desc: "Monthly generator tests release diesel exhaust — a Group 1 carcinogen. Residents describe 30–60 minute episodes of black smoke, worse downwind." },
  ],
  MODERATE: [
    { emoji: "🔊", label: "Background Hum", sev: 3, desc: "Persistent low-frequency sound, most noticeable at night. Some describe pressure rather than sound." },
    { emoji: "🤕", label: "Intermittent Headaches", sev: 3, desc: "Correlate with generator test cycles and changes in facility load." },
    { emoji: "😴", label: "Disrupted Sleep", sev: 3, desc: "Generator tests (30–90 minutes, up to 105 dB) and continuous cooling noise affect sleep quality." },
    { emoji: "💨", label: "Occasional Exhaust", sev: 2, desc: "During monthly generator tests. Diesel particulate matter is a classified carcinogen — no safe level exists." },
  ],
  "LOW-MODERATE": [
    { emoji: "🔊", label: "Mild Noise", sev: 2, desc: "Present 24/7 but less intrusive. Low-frequency components travel further than measured dB suggests." },
    { emoji: "💨", label: "Diesel During Tests", sev: 2, desc: "Monthly generator tests still produce diesel exhaust for 30–60 minutes." },
  ],
};

const LONG_TERM = [
  { emoji: "🔬", title: "Cancer Risk", color: "#ef4444", short: "Diesel exhaust is a Group 1 carcinogen. EMF classified 'possibly carcinogenic' by WHO.", long: "Two pathways elevate cancer risk. Diesel PM2.5 from backup generators is in the same carcinogen class as asbestos. Separately, the WHO's IARC classified power-frequency magnetic fields 'possibly carcinogenic' (Group 2B) in 2002, with evidence for childhood leukemia at exposures starting at just 3–4 milligauss. The legal US limit is 2,000 mG — 500x higher than where studies found risk.", stat: "~1,300 projected premature US deaths annually from data center pollution by 2030", src: "arXiv 2412.06288, 2025" },
  { emoji: "❤️", title: "Heart Disease", color: "#f97316", short: "Chronic noise raises blood pressure. Air pollution inflames blood vessels.", long: "Chronic environmental noise keeps the body in low-grade stress. Over years this elevates blood pressure and increases heart attack and stroke risk. Diesel PM2.5 directly inflames arterial walls.", stat: "Long-term exposure linked to hypertension, cardiovascular disease, and stroke", src: "US News / ScienceDirect, 2025" },
  { emoji: "🫁", title: "Lungs & Breathing", color: "#eab308", short: "PM2.5 enters your bloodstream through your lungs. There is no safe level.", long: "Fine particulate matter (PM2.5) from diesel generators is small enough to cross from lungs into the bloodstream. The Harvard Six Cities Study found no safe exposure level. It worsens asthma, COPD, and lung function.", stat: "600,000+ projected asthma cases per year from US data centers by 2030", src: "arXiv 2412.06288, 2025" },
  { emoji: "🧠", title: "Mental Health", color: "#8b5cf6", short: "Chronic noise, lost sleep, feeling powerless — documented anxiety and depression.", long: "The combination of chronic sleep loss, constant vibration, and feeling ignored by authorities creates a documented mental health burden. Residents near data center clusters report increased anxiety, helplessness, and depression.", stat: "Chronic industrial noise independently linked to anxiety and depression", src: "US News, Apr 2026" },
  { emoji: "🤰", title: "Reproductive Health", color: "#3b82f6", short: "ELF magnetic fields linked to miscarriage. Air pollution linked to premature birth.", long: "ELF magnetic fields have been studied in relation to miscarriage risk, with some studies finding elevated risk near high-voltage infrastructure. PM2.5 is independently associated with premature birth and low birth weight.", stat: "ELF-EMF exposure linked to miscarriage in peer-reviewed studies", src: "EH Sciences / BioInitiative" },
  { emoji: "😴", title: "Sleep & Brain", color: "#10b981", short: "Chronic sleep loss degrades immunity, memory, and lifespan.", long: "Chronic sleep deprivation raises diabetes and obesity risk, impairs memory and cognition, and is independently linked to shortened lifespan. Low-frequency noise has been reported audible up to 4.5 miles in quiet environments.", stat: "Infrasound shown to affect cardiac function within 1 hour above 100 dB", src: "US National Library of Medicine" },
];

const KIDS = [
  { emoji: "🧬", label: "Childhood Leukemia", sev: "SERIOUS", color: "#ef4444", desc: "WHO/IARC classified power-frequency magnetic fields 'possibly carcinogenic' specifically because of studies linking childhood residential exposure to elevated leukemia rates — at just 3–4 milligauss." },
  { emoji: "🫁", label: "Asthma & Lungs", sev: "DOCUMENTED", color: "#f97316", desc: "Diesel particulate matter is a known asthma trigger in children. A 2025 model projects data centers could cause over one-third of all US asthma deaths by 2030." },
  { emoji: "🧠", label: "Brain Development & ADHD", sev: "EMERGING", color: "#eab308", desc: "ELF-EMF has been linked in studies to ADHD and cognitive dysfunction in children. Chronic sleep disruption from noise independently impairs developing brains." },
  { emoji: "😴", label: "Sleep & Growth", sev: "HIGH CONCERN", color: "#8b5cf6", desc: "Children need more sleep — it's when growth hormone is released. Low-frequency noise prevents deep sleep even at levels adults barely notice." },
  { emoji: "👂", label: "Hearing Damage", sev: "DOCUMENTED CASES", color: "#3b82f6", desc: "The Granbury TX case involved children claiming permanent hearing damage. Children's hearing is still developing and more sensitive than adults." },
];

const QUIZ_Q = [
  { q: "How far do you live from the facility?", key: "dist", opts: ["Less than 0.25 miles", "0.25 – 0.5 miles", "0.5 – 1 mile", "More than 1 mile"] },
  { q: "Are there children under 12 in your household?", key: "kids", opts: ["Yes", "No"] },
  { q: "Is anyone in your home pregnant or trying to conceive?", key: "preg", opts: ["Yes", "No", "Not sure"] },
  { q: "Does anyone have asthma, COPD, or heart disease?", key: "health", opts: ["Yes", "No", "Not sure"] },
  { q: "How long have you lived at this address?", key: "dur", opts: ["Less than 1 year", "1 – 3 years", "3 – 10 years", "More than 10 years"] },
];

const fmt = n => n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n/1_000).toFixed(0)}K` : `${n}`;

// ─── COMPONENTS ───────────────────────────────────────────────────────────────
const SevBar = ({ level, max = 5, color }) => (
  <div style={{ display: "flex", gap: 4, margin: "8px 0" }}>
    {Array.from({ length: max }).map((_, i) => (
      <div key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i < level ? color : "#e5e7eb" }} />
    ))}
  </div>
);

const Badge = ({ label, color }) => (
  <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 20, background: color + "18", color, border: `1px solid ${color}33`, letterSpacing: "0.04em" }}>
    {label}
  </span>
);

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
const TABS = [
  { id: "feel",     label: "What You'll Feel" },
  { id: "quiz",     label: "Your Risk Quiz"   },
  { id: "longterm", label: "Long-Term Health" },
  { id: "kids",     label: "Kids & Families"  },
  { id: "numbers",  label: "By the Numbers"   },
  { id: "act",      label: "What To Do"       },
  { id: "reports",  label: "Community"        },
];

export default function App() {
  const [facilities, setFacilities]   = useState([]);
  const [loading, setLoading]         = useState(true);
  const [country, setCountry]         = useState("");
  const [countryInput, setCountryInput] = useState("");
  const [showCountryDrop, setShowCountryDrop] = useState(false);
  const [cityInput, setCityInput]     = useState("");
  const [showCityDrop, setShowCityDrop] = useState(false);
  const [sel, setSel]                 = useState(null);
  const [tab, setTab]                 = useState("feel");
  const [reports, setReports]         = useState([]);
  const [draft, setDraft]             = useState("");
  const [reporter, setReporter]       = useState("");
  const [submitting, setSubmitting]   = useState(false);
  const [submitOk, setSubmitOk]       = useState(false);
  const [expandLong, setExpandLong]   = useState(null);
  const [expandKid, setExpandKid]     = useState(null);
  const [quizStep, setQuizStep]       = useState(0);
  const [quizAns, setQuizAns]         = useState({});
  const [quizResult, setQuizResult]   = useState(null);
  const [imgError, setImgError]       = useState(false);
  const countryRef = useRef(null);
  const cityRef    = useRef(null);
  const topRef     = useRef(null);

  useEffect(() => {
    fetchFacilities().then(d => { setFacilities(d); setLoading(false); });
  }, []);

  useEffect(() => {
    const h = (e) => {
      if (countryRef.current && !countryRef.current.contains(e.target)) setShowCountryDrop(false);
      if (cityRef.current && !cityRef.current.contains(e.target)) setShowCityDrop(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const dc = sel ? facilities.find(f => f.id === sel) : null;
  const rc = dc ? (RISK_COLOR[dc.Risk_Level] || "#6b7280") : "#6b7280";
  const sm = dc ? (STATUS_META[dc.Facility_Status] || STATUS_META.OPERATING) : null;
  const symptoms = dc ? (SYMPTOMS[dc.Risk_Level] || SYMPTOMS["LOW-MODERATE"]) : [];

  useEffect(() => {
    if (!dc) return;
    setReports([]);
    fetchReports(dc.Name).then(setReports);
  }, [sel]);

  const countries = [...new Set(facilities.map(f => f.Country).filter(Boolean))].sort();
  const countryMatches = countryInput
    ? countries.filter(c => c.toLowerCase().includes(countryInput.toLowerCase()))
    : countries;

  const citiesInCountry = country
    ? [...new Map(facilities.filter(f => f.Country === country).map(f => [f.City, f])).values()]
    : [];

  const cityMatches = cityInput
    ? citiesInCountry.filter(f => f.City?.toLowerCase().includes(cityInput.toLowerCase()))
    : citiesInCountry;

  const cityGroups = cityMatches.reduce((acc, f) => {
    if (!acc[f.City]) acc[f.City] = [];
    acc[f.City].push(f);
    return acc;
  }, {});

  const selectCountry = (c) => {
    setCountry(c);
    setCountryInput(c);
    setShowCountryDrop(false);
    setCityInput("");
    setSel(null);
  };

  const selectFacility = (id) => {
    setSel(id); setTab("feel");
    setQuizStep(0); setQuizResult(null); setQuizAns({});
    setExpandLong(null); setExpandKid(null);
    setSubmitOk(false); setImgError(false);
    setTimeout(() => topRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  };

  const computeQuiz = (a) => {
    let score = 0; const flags = [];
    if (a.dist === "Less than 0.25 miles") { score += 3; flags.push("Very close proximity — highest EMF, noise, and air quality impact zone"); }
    else if (a.dist === "0.25 – 0.5 miles") { score += 2; flags.push("Close — within significant noise and air quality impact zone"); }
    else if (a.dist === "0.5 – 1 mile") { score += 1; flags.push("Moderate — within documented low-frequency noise range"); }
    if (a.kids === "Yes") { score += 2; flags.push("Children present — higher vulnerability to all environmental impacts"); }
    if (a.preg === "Yes") { score += 2; flags.push("Pregnancy — elevated concern for EMF and air pollution"); }
    if (a.health === "Yes") { score += 2; flags.push("Existing health conditions — pollution and noise compound these"); }
    if (a.dur === "More than 10 years") { score += 1; flags.push("Long-term resident — chronic exposure accumulates over time"); }
    const level = score >= 6 ? "HIGH" : score >= 3 ? "MODERATE" : "LOWER";
    const advice = score >= 6
      ? "Your situation warrants immediate action. Request an independent EMF survey, file formal complaints with your local zoning board and state environmental agency, and speak with your doctor."
      : score >= 3
      ? "Your situation warrants monitoring. Document symptoms, keep windows closed on generator test days, and learn your local zoning board's complaint process."
      : "Your risk is lower but not zero. Stay informed about expansions and document any symptoms you notice.";
    return { level, score, flags, advice };
  };

  const handleSubmit = async () => {
    if (!draft.trim() || !dc) return;
    setSubmitting(true);
    const ok = await submitReport(dc.Name, reporter, draft, dc.City, dc.Country);
    if (ok) { setSubmitOk(true); setDraft(""); setReporter(""); const updated = await fetchReports(dc.Name); setReports(updated); }
    setSubmitting(false);
  };

  // Image search URL for the facility
  const imgSearchUrl = dc ? `https://source.unsplash.com/800x400/?data+center+server+${encodeURIComponent(dc.Company || "technology")}` : null;

  const S = {
    page: { fontFamily: "'DM Sans', 'Helvetica Neue', Arial, sans-serif", background: "#f8f9fa", minHeight: "100vh", color: "#1a1a2e" },
    // Banner
    banner: { background: "linear-gradient(135deg, #0a0f1e 0%, #1a1040 50%, #0d1a3a 100%)", padding: "60px 24px 50px", textAlign: "center", position: "relative", overflow: "hidden" },
    bannerGlow: { position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 600, height: 300, background: "radial-gradient(ellipse, #ef444433 0%, transparent 70%)", pointerEvents: "none" },
    tagline: { fontFamily: "'Impact', 'Arial Black', sans-serif", fontSize: "clamp(32px, 6vw, 68px)", color: "#ffffff", letterSpacing: "0.02em", lineHeight: 1.1, margin: "0 0 12px", textShadow: "0 0 40px #ef444466" },
    taglineAccent: { color: "#ef4444" },
    subtitle: { fontSize: 16, color: "#94a3b8", marginBottom: 36, maxWidth: 500, margin: "0 auto 36px" },
    // Search bar area
    searchArea: { display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", maxWidth: 800, margin: "0 auto" },
    searchBox: { position: "relative", flex: 1, minWidth: 240 },
    searchInput: { width: "100%", padding: "16px 20px", fontSize: 15, borderRadius: 12, border: "none", background: "rgba(255,255,255,0.12)", color: "#fff", backdropFilter: "blur(10px)", outline: "none", cursor: "pointer", boxSizing: "border-box", letterSpacing: "0.01em" },
    dropdown: { position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, background: "#fff", borderRadius: 12, boxShadow: "0 20px 60px rgba(0,0,0,0.2)", zIndex: 200, maxHeight: 360, overflowY: "auto" },
    dropItem: { padding: "12px 18px", fontSize: 14, color: "#374151", cursor: "pointer", borderBottom: "1px solid #f3f4f6", transition: "background 0.1s" },
    // Stats strip
    statsStrip: { background: "#fff", borderBottom: "1px solid #e5e7eb", padding: "16px 24px", display: "flex", justifyContent: "center", gap: 48, flexWrap: "wrap" },
    statItem: { textAlign: "center" },
    statNum: { fontSize: 22, fontWeight: 800, color: "#ef4444", display: "block", fontFamily: "'Impact', sans-serif" },
    statLabel: { fontSize: 11, color: "#9ca3af", letterSpacing: "0.06em", textTransform: "uppercase" },
    // Main content
    main: { maxWidth: 960, margin: "0 auto", padding: "32px 24px" },
    // Facility card
    facilityCard: { background: "#fff", borderRadius: 16, overflow: "hidden", boxShadow: "0 4px 24px rgba(0,0,0,0.08)", marginBottom: 24 },
    facilityImage: { width: "100%", height: 240, objectFit: "cover", background: "#e5e7eb" },
    facilityImagePlaceholder: { width: "100%", height: 240, background: "linear-gradient(135deg, #1a1a2e, #0d1a3a)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 48 },
    facilityHeader: { padding: "24px 28px" },
    facilityName: { fontSize: 24, fontWeight: 800, color: "#1a1a2e", margin: "0 0 6px", letterSpacing: "-0.01em" },
    facilityMeta: { fontSize: 13, color: "#6b7280", marginBottom: 16 },
    facilityStats: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 },
    statCard: { background: "#f8f9fa", borderRadius: 10, padding: "14px 16px", textAlign: "center" },
    statCardNum: { fontSize: 20, fontWeight: 800, marginBottom: 4 },
    statCardLabel: { fontSize: 10, color: "#9ca3af", letterSpacing: "0.06em", textTransform: "uppercase" },
    // Tabs
    tabs: { display: "flex", gap: 8, flexWrap: "wrap", margin: "0 0 24px", padding: "0 28px" },
    tab: (active, color) => ({
      padding: "10px 18px", borderRadius: 20, fontSize: 13, fontWeight: 600,
      border: `2px solid ${active ? color : "#e5e7eb"}`,
      background: active ? color : "#fff",
      color: active ? "#fff" : "#6b7280",
      cursor: "pointer", transition: "all 0.15s", letterSpacing: "0.01em",
    }),
    // Content area
    content: { padding: "0 28px 28px" },
    card: { background: "#f8f9fa", borderRadius: 12, padding: "18px 20px", marginBottom: 12 },
    // Symptom card
    symptomGrid: { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 },
    symptomCard: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "18px 20px", transition: "border-color 0.2s, box-shadow 0.2s" },
    // Accordion
    accordion: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, marginBottom: 10, overflow: "hidden" },
    accordionHeader: { padding: "18px 22px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", transition: "background 0.15s" },
    // Quiz
    quizBtn: { width: "100%", padding: "14px 18px", borderRadius: 10, border: "1px solid #e5e7eb", background: "#fff", color: "#374151", fontSize: 14, cursor: "pointer", textAlign: "left", marginBottom: 8, transition: "all 0.15s", fontFamily: "inherit" },
    // Action steps
    stepNum: (color) => ({ width: 28, height: 28, borderRadius: "50%", background: color + "18", color, fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }),
  };

  return (
    <div style={S.page}>

      {/* ── BANNER ── */}
      <div style={S.banner}>
        <div style={S.bannerGlow} />
        <h1 style={S.tagline}>
          ARE YOU IN THE <span style={S.taglineAccent}>HUM</span>ZONE?
        </h1>
        <p style={{ ...S.subtitle, marginTop: 12 }}>
          Search your country and city to find data centers near you — and what they mean for your health.
        </p>

        {/* ── SEARCH BARS ── */}
        <div style={S.searchArea}>

          {/* Country */}
          <div ref={countryRef} style={S.searchBox}>
            <input
              value={countryInput}
              onChange={e => { setCountryInput(e.target.value); setShowCountryDrop(true); }}
              onFocus={() => setShowCountryDrop(true)}
              placeholder="🌍  Select a country…"
              style={S.searchInput}
            />
            {showCountryDrop && (
              <div style={S.dropdown}>
                {countryMatches.length === 0 && <div style={{ ...S.dropItem, color: "#9ca3af", fontStyle: "italic" }}>No countries found</div>}
                {countryMatches.map(c => (
                  <div key={c}
                    style={S.dropItem}
                    onClick={() => selectCountry(c)}
                    onMouseEnter={e => e.currentTarget.style.background = "#f3f4f6"}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    {c}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* City */}
          <div ref={cityRef} style={{ ...S.searchBox, opacity: country ? 1 : 0.5, pointerEvents: country ? "all" : "none" }}>
            <input
              value={cityInput}
              onChange={e => { setCityInput(e.target.value); setShowCityDrop(true); }}
              onFocus={() => setShowCityDrop(true)}
              placeholder={country ? `📍  Cities in ${country}…` : "📍  Select country first"}
              style={S.searchInput}
            />
            {showCityDrop && country && (
              <div style={S.dropdown}>
                {Object.keys(cityGroups).length === 0 && <div style={{ ...S.dropItem, color: "#9ca3af", fontStyle: "italic" }}>No cities found</div>}
                {Object.entries(cityGroups).map(([city, facs]) => (
                  <div key={city}>
                    <div style={{ padding: "8px 18px 4px", fontSize: 11, color: "#9ca3af", letterSpacing: "0.1em", textTransform: "uppercase", borderTop: "1px solid #f3f4f6", background: "#f9fafb" }}>
                      📍 {city}
                    </div>
                    {facs.map(f => {
                      const sm2 = STATUS_META[f.Facility_Status] || STATUS_META.OPERATING;
                      const rc2 = RISK_COLOR[f.Risk_Level] || "#6b7280";
                      return (
                        <div key={f.id}
                          style={{ ...S.dropItem, paddingLeft: 28 }}
                          onClick={() => { setCityInput(city); setShowCityDrop(false); selectFacility(f.id); }}
                          onMouseEnter={e => e.currentTarget.style.background = "#f3f4f6"}
                          onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div>
                              <div style={{ fontWeight: 600, color: "#1a1a2e", marginBottom: 2 }}>{f.Name}</div>
                              <div style={{ fontSize: 12, color: "#9ca3af" }}>{f.Company} · {f.Power_MW >= 1000 ? `${(f.Power_MW/1000).toFixed(1)} GW` : `${f.Power_MW} MW`}</div>
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-end" }}>
                              <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 8, background: sm2.color + "18", color: sm2.color, fontWeight: 700, whiteSpace: "nowrap" }}>● {sm2.label}</span>
                              <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 8, background: rc2 + "18", color: rc2, fontWeight: 700 }}>{f.Risk_Level}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>

        {/* Change search link */}
        {country && (
          <button onClick={() => { setCountry(""); setCountryInput(""); setCityInput(""); setSel(null); }}
            style={{ marginTop: 16, background: "transparent", border: "1px solid rgba(255,255,255,0.2)", color: "#94a3b8", padding: "8px 18px", borderRadius: 20, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
            ✕ Clear search
          </button>
        )}
      </div>

      {/* ── STATS STRIP ── */}
      {!dc && (
        <div style={S.statsStrip}>
          {[
            { n: "~1,300", l: "projected US deaths/year by 2030" },
            { n: "$20B+",  l: "annual public health burden" },
            { n: "600K",   l: "projected asthma cases/year" },
            { n: loading ? "..." : facilities.length, l: "facilities in our database" },
          ].map((s, i) => (
            <div key={i} style={S.statItem}>
              <span style={S.statNum}>{s.n}</span>
              <span style={S.statLabel}>{s.l}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── MAIN CONTENT ── */}
      <div style={S.main} ref={topRef}>

        {!dc && !loading && (
          <div style={{ textAlign: "center", padding: "60px 24px", color: "#9ca3af" }}>
            <div style={{ fontSize: 64, marginBottom: 16 }}>🌍</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#374151", marginBottom: 8 }}>Search for a data center near you</div>
            <div style={{ fontSize: 14, maxWidth: 440, margin: "0 auto", lineHeight: 1.7 }}>
              Select your country above, then your city to find data centers in your area and understand their real health impact.
            </div>
          </div>
        )}

        {loading && (
          <div style={{ textAlign: "center", padding: 60, color: "#9ca3af" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
            <div>Loading global facility data…</div>
          </div>
        )}

        {dc && (
          <div style={S.facilityCard}>

            {/* Facility image */}
            {!imgError ? (
              <img
                src={`https://source.unsplash.com/800x300/?data+center,server+farm,${encodeURIComponent(dc.Company || "technology")}`}
                alt={dc.Name}
                style={S.facilityImage}
                onError={() => setImgError(true)}
              />
            ) : (
              <div style={S.facilityImagePlaceholder}>🏭</div>
            )}

            {/* Facility header */}
            <div style={S.facilityHeader}>
              <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                <Badge label={`● ${sm.label}`} color={sm.color} />
                <Badge label={`${dc.Risk_Level} RISK`} color={rc} />
                <Badge label={dc.Company} color="#6b7280" />
              </div>
              <h2 style={S.facilityName}>{dc.Name}</h2>
              <div style={S.facilityMeta}>{dc.Address}</div>
              {dc.Nearby_Info && <div style={{ fontSize: 13, color: "#6b7280", marginBottom: 16, fontStyle: "italic" }}>Nearby: {dc.Nearby_Info}</div>}

              {/* Quick stats */}
              <div style={S.facilityStats}>
                {[
                  { label: "Power Draw", value: dc.Power_MW >= 1000 ? `${(dc.Power_MW/1000).toFixed(1)} GW` : `${dc.Power_MW || "?"} MW`, color: rc },
                  { label: "Noise Level", value: `${dc.Noise_DB || "?"} dB`, color: dc.Noise_DB >= 70 ? "#ef4444" : dc.Noise_DB >= 60 ? "#f97316" : "#3b82f6" },
                  { label: "EMF at Fence", value: `${dc.EMF_Fence_High || "?"} mG`, color: dc.EMF_Fence_High >= 4 ? "#ef4444" : "#10b981" },
                  { label: "Water/Day", value: dc.Water_Gal_Day > 0 ? `${fmt(dc.Water_Gal_Day)} gal` : "Near zero", color: "#3b82f6" },
                ].map(s => (
                  <div key={s.label} style={S.statCard}>
                    <div style={{ ...S.statCardNum, color: s.color }}>{s.value}</div>
                    <div style={S.statCardLabel}>{s.label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Tabs */}
            <div style={S.tabs}>
              {TABS.map(t => (
                <button key={t.id} onClick={() => setTab(t.id)} style={S.tab(tab === t.id, rc)}>
                  {t.label}{t.id === "reports" && reports.length > 0 ? ` (${reports.length})` : ""}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div style={S.content}>

              {/* ── WHAT YOU'LL FEEL ── */}
              {tab === "feel" && (
                <div>
                  <div style={{ ...S.card, background: rc + "0d", border: `1px solid ${rc}22`, marginBottom: 20 }}>
                    <div style={{ fontSize: 11, color: rc, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>Based on documented reports at comparable facilities</div>
                    <p style={{ fontSize: 14, color: "#374151", lineHeight: 1.75, margin: 0 }}>Every symptom below has been reported by real people living near data centers of this scale — from lawsuits, news investigations, and community testimonies across the US and internationally.</p>
                  </div>
                  <div style={S.symptomGrid}>
                    {symptoms.map((s, i) => (
                      <div key={i} style={S.symptomCard}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = rc; e.currentTarget.style.boxShadow = `0 4px 16px ${rc}22`; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = "#e5e7eb"; e.currentTarget.style.boxShadow = "none"; }}>
                        <div style={{ fontSize: 28, marginBottom: 8 }}>{s.emoji}</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: "#1a1a2e", marginBottom: 4 }}>{s.label}</div>
                        <SevBar level={s.sev} color={rc} />
                        <p style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.7, margin: "8px 0 0" }}>{s.desc}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── QUIZ ── */}
              {tab === "quiz" && (
                <div>
                  <h3 style={{ fontSize: 20, fontWeight: 800, color: "#1a1a2e", margin: "0 0 8px" }}>Your Personal Risk Assessment</h3>
                  <p style={{ fontSize: 14, color: "#6b7280", margin: "0 0 24px", lineHeight: 1.7 }}>Answer five questions to get a plain-language assessment of your personal risk based on your proximity and household situation.</p>

                  {quizResult ? (
                    <div>
                      <div style={{ ...S.card, background: (RISK_COLOR[quizResult.level] || "#6b7280") + "0d", border: `1px solid ${(RISK_COLOR[quizResult.level] || "#6b7280")}22`, marginBottom: 16 }}>
                        <div style={{ fontSize: 11, color: "#6b7280", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>Your Personal Risk Level</div>
                        <div style={{ fontSize: 40, fontWeight: 800, color: RISK_COLOR[quizResult.level] || "#6b7280", marginBottom: 12, fontFamily: "'Impact', sans-serif" }}>{quizResult.level}</div>
                        <p style={{ fontSize: 14, color: "#374151", lineHeight: 1.75, margin: "0 0 16px" }}>{quizResult.advice}</p>
                        <div style={{ fontSize: 12, color: "#6b7280", fontWeight: 700, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.08em" }}>Why this rating:</div>
                        {quizResult.flags.map((f, i) => (
                          <div key={i} style={{ fontSize: 13, color: "#374151", padding: "6px 0", borderBottom: i < quizResult.flags.length - 1 ? "1px solid #e5e7eb" : "none" }}>— {f}</div>
                        ))}
                      </div>
                      <button onClick={() => { setQuizStep(0); setQuizResult(null); setQuizAns({}); }}
                        style={{ ...S.quizBtn, color: rc, borderColor: rc, fontWeight: 700 }}>↩ Retake Quiz</button>
                    </div>
                  ) : (
                    <div>
                      <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>Question {quizStep + 1} of {QUIZ_Q.length}</div>
                      <div style={S.card}>
                        <p style={{ fontSize: 16, color: "#1a1a2e", fontWeight: 600, margin: "0 0 20px" }}>{QUIZ_Q[quizStep].q}</p>
                        {QUIZ_Q[quizStep].opts.map(opt => (
                          <button key={opt} style={S.quizBtn}
                            onClick={() => {
                              const a = { ...quizAns, [QUIZ_Q[quizStep].key]: opt };
                              setQuizAns(a);
                              if (quizStep < QUIZ_Q.length - 1) setQuizStep(s => s + 1);
                              else setQuizResult(computeQuiz(a));
                            }}
                            onMouseEnter={e => { e.currentTarget.style.borderColor = rc; e.currentTarget.style.color = rc; }}
                            onMouseLeave={e => { e.currentTarget.style.borderColor = "#e5e7eb"; e.currentTarget.style.color = "#374151"; }}>
                            {opt}
                          </button>
                        ))}
                      </div>
                      <div style={{ height: 4, background: "#e5e7eb", borderRadius: 2 }}>
                        <div style={{ height: 4, width: `${(quizStep / QUIZ_Q.length) * 100}%`, background: rc, borderRadius: 2, transition: "width 0.3s" }} />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── LONG TERM ── */}
              {tab === "longterm" && (
                <div>
                  <div style={{ ...S.card, background: "#fef2f2", border: "1px solid #fecaca", marginBottom: 16 }}>
                    <div style={{ fontSize: 11, color: "#ef4444", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>⚠ Long-Term Health Risks</div>
                    <p style={{ fontSize: 14, color: "#7f1d1d", lineHeight: 1.75, margin: 0 }}>A 2025 peer-reviewed study estimated data center pollution causes a public health burden of over $20 billion annually by 2030. Click any risk below to read the full explanation.</p>
                  </div>
                  {LONG_TERM.map((r, i) => (
                    <div key={i} style={S.accordion}>
                      <div style={S.accordionHeader} onClick={() => setExpandLong(expandLong === i ? null : i)}
                        onMouseEnter={e => e.currentTarget.style.background = "#f9fafb"}
                        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                          <span style={{ fontSize: 24 }}>{r.emoji}</span>
                          <div>
                            <div style={{ fontSize: 15, fontWeight: 700, color: "#1a1a2e", marginBottom: 3 }}>{r.title}</div>
                            <div style={{ fontSize: 13, color: "#6b7280" }}>{r.short}</div>
                          </div>
                        </div>
                        <div style={{ fontSize: 20, color: "#9ca3af", fontWeight: 300 }}>{expandLong === i ? "−" : "+"}</div>
                      </div>
                      {expandLong === i && (
                        <div style={{ padding: "0 22px 20px", borderTop: "1px solid #f3f4f6" }}>
                          <p style={{ fontSize: 14, color: "#374151", lineHeight: 1.85, margin: "16px 0" }}>{r.long}</p>
                          <div style={{ background: r.color + "0d", border: `1px solid ${r.color}22`, borderRadius: 10, padding: "12px 16px" }}>
                            <div style={{ fontSize: 13, color: r.color, fontWeight: 600, marginBottom: 4 }}>📊 {r.stat}</div>
                            <div style={{ fontSize: 11, color: "#9ca3af" }}>Source: {r.src}</div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* ── KIDS ── */}
              {tab === "kids" && (
                <div>
                  <div style={{ ...S.card, background: "#fffbeb", border: "1px solid #fde68a", marginBottom: 16 }}>
                    <div style={{ fontSize: 11, color: "#d97706", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>👧 Why Children Are More Vulnerable</div>
                    <p style={{ fontSize: 14, color: "#78350f", lineHeight: 1.75, margin: 0 }}>Children breathe more air per pound of body weight, sleep longer — meaning more hours of noise exposure — and have developing systems more sensitive to environmental disruption than adults.</p>
                  </div>
                  {KIDS.map((k, i) => (
                    <div key={i} style={S.accordion}>
                      <div style={S.accordionHeader} onClick={() => setExpandKid(expandKid === i ? null : i)}
                        onMouseEnter={e => e.currentTarget.style.background = "#f9fafb"}
                        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                          <span style={{ fontSize: 24 }}>{k.emoji}</span>
                          <div>
                            <div style={{ fontSize: 15, fontWeight: 700, color: "#1a1a2e", marginBottom: 4 }}>{k.label}</div>
                            <Badge label={k.sev} color={k.color} />
                          </div>
                        </div>
                        <div style={{ fontSize: 20, color: "#9ca3af", fontWeight: 300 }}>{expandKid === i ? "−" : "+"}</div>
                      </div>
                      {expandKid === i && (
                        <div style={{ padding: "0 22px 20px", borderTop: "1px solid #f3f4f6" }}>
                          <p style={{ fontSize: 14, color: "#374151", lineHeight: 1.85, margin: "16px 0 0" }}>{k.desc}</p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* ── NUMBERS ── */}
              {tab === "numbers" && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  {[
                    { label: "Power Draw", value: dc.Power_MW >= 1000 ? `${(dc.Power_MW/1000).toFixed(1)} GW` : `${dc.Power_MW || "?"} MW`, plain: dc.Power_MW ? `Enough to power ${fmt(Math.round(dc.Power_MW * 1000 / 1.25))} average homes — continuously, 24 hours a day.` : "Power data pending.", color: rc },
                    { label: "CO₂ Per Year", value: dc.CO2_Tons_Year > 0 ? `${fmt(dc.CO2_Tons_Year)} tons` : "Near zero", plain: dc.CO2_Tons_Year > 0 ? `Same as ${fmt(Math.round(dc.CO2_Tons_Year / 4.6))} cars driven for a full year.` : "Low carbon — renewable energy source.", color: dc.CO2_Tons_Year > 200000 ? "#ef4444" : "#10b981" },
                    { label: "Water Per Day", value: dc.Water_Gal_Day > 0 ? `${fmt(dc.Water_Gal_Day)} gal` : "Near zero", plain: dc.Water_Gal_Day > 0 ? `Same as ${fmt(Math.round(dc.Water_Gal_Day / 80))} households' daily water use.` : "Air-cooled — minimal water draw.", color: dc.Water_Gal_Day > 500000 ? "#ef4444" : "#10b981" },
                    { label: "Noise at Perimeter", value: `${dc.Noise_DB || "?"} dB`, plain: dc.Noise_DB >= 70 ? "Like a vacuum cleaner running nonstop — including 2am. Low frequencies travel further than this number suggests." : "Moderate but continuous low-frequency noise penetrates walls.", color: dc.Noise_DB >= 70 ? "#ef4444" : dc.Noise_DB >= 60 ? "#f97316" : "#3b82f6" },
                    { label: "EMF at Fence Line", value: `up to ${dc.EMF_Fence_High || "?"} mG`, plain: dc.EMF_Fence_High >= 4 ? "Studies link childhood leukemia risk to 3–4 mG. The legal US limit is 2,000 mG — legal does not mean safe." : "Below the 3–4 mG concern threshold. Still worth monitoring near schools.", color: dc.EMF_Fence_High >= 4 ? "#ef4444" : "#10b981" },
                    { label: "EMF at 100 Meters", value: `~${dc.EMF_100m || "?"} mG`, plain: dc.EMF_100m >= 3 ? "Still above the level linked to childhood leukemia risk. If you live within 100m of the substation, take this seriously." : dc.EMF_100m >= 1 ? "Within the zone where a 2026 study found health associations." : "Below precautionary thresholds at this distance.", color: dc.EMF_100m >= 3 ? "#ef4444" : dc.EMF_100m >= 1 ? "#f97316" : "#10b981" },
                  ].map(s => (
                    <div key={s.label} style={{ background: "#fff", border: `1px solid ${s.color}22`, borderRadius: 12, padding: "18px 20px" }}>
                      <div style={{ fontSize: 11, color: "#9ca3af", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>{s.label}</div>
                      <div style={{ fontSize: 26, fontWeight: 800, color: s.color, marginBottom: 10, fontFamily: "'Impact', sans-serif" }}>{s.value}</div>
                      <p style={{ fontSize: 13, color: "#6b7280", lineHeight: 1.65, margin: 0 }}>{s.plain}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* ── WHAT TO DO ── */}
              {tab === "act" && (
                <div>
                  <h3 style={{ fontSize: 20, fontWeight: 800, color: "#1a1a2e", margin: "0 0 8px" }}>You're Not Powerless</h3>
                  <p style={{ fontSize: 14, color: "#6b7280", margin: "0 0 24px", lineHeight: 1.7 }}>Every data center regulation that exists was won by residents who organized, documented, and demanded accountability.</p>
                  {[
                    { emoji: "📋", title: "Document everything — starting today", color: "#ef4444", steps: ["Write down symptoms: headaches, sleep issues, dizziness, ear ringing, anxiety. Include dates and times.", "Note when you smell diesel exhaust — this is likely a generator test. Record date, time, wind direction, duration.", "Photograph or video any visible smoke or unusual emissions.", "Keep a log even in your phone notes app. Patterns matter more than any single data point."] },
                    { emoji: "📣", title: "File formal complaints", color: "#f97316", steps: ["Contact your city or county zoning board — data center noise falls under industrial use permits.", "File with your state or provincial environmental agency.", "File with your national environmental protection body for air quality concerns.", "Contact your elected representative in writing — a paper trail matters."] },
                    { emoji: "📡", title: "Request independent monitoring", color: "#eab308", steps: ["Request an independent EMF survey of your property from a certified environmental health firm.", "Ask your local health department to monitor air quality near the facility, especially during generator tests.", "If a school is nearby, contact the school board — they have legal standing to demand environmental assessments."] },
                    { emoji: "👥", title: "Organize with neighbors", color: "#8b5cf6", steps: ["One complaint is easier to ignore than fifty. Start a neighborhood group or find existing advocacy groups.", "Look for community coalitions that have pushed back on industrial development in your region.", "Earthjustice (earthjustice.org) and the Environmental Defense Fund have resources for communities."] },
                    { emoji: "🏠", title: "Protect your family right now", color: "#3b82f6", steps: ["Keep windows closed on generator test days — often monthly. Request the facility's test schedule.", "Air purifiers with HEPA filtration reduce indoor PM2.5 from diesel exhaust.", "Speak with your doctor about any symptoms — getting them on medical record matters if legal action becomes necessary.", "White noise machines can mask low-frequency intrusion for better sleep."] },
                  ].map((s, i) => (
                    <div key={i} style={{ ...S.accordion, marginBottom: 12 }}>
                      <div style={{ padding: "18px 22px", borderBottom: "1px solid #f3f4f6" }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <span style={{ fontSize: 22 }}>{s.emoji}</span>
                          <div style={{ fontSize: 15, fontWeight: 700, color: "#1a1a2e" }}>{s.title}</div>
                        </div>
                      </div>
                      {s.steps.map((step, j) => (
                        <div key={j} style={{ display: "flex", gap: 12, padding: "12px 22px", borderBottom: j < s.steps.length - 1 ? "1px solid #f9fafb" : "none" }}>
                          <div style={S.stepNum(s.color)}>{j + 1}</div>
                          <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.7 }}>{step}</div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {/* ── COMMUNITY ── */}
              {tab === "reports" && (
                <div>
                  <h3 style={{ fontSize: 20, fontWeight: 800, color: "#1a1a2e", margin: "0 0 8px" }}>Community Reports</h3>
                  <p style={{ fontSize: 14, color: "#6b7280", margin: "0 0 24px", lineHeight: 1.7 }}>One person's symptom diary is anecdote. Three hundred people's diaries near the same facility, all spiking on generator test days, is a public health study. Your report matters.</p>

                  {reports.length === 0 && <div style={{ fontSize: 14, color: "#9ca3af", fontStyle: "italic", margin: "0 0 24px" }}>No reports yet for this facility. Be the first.</div>}

                  {reports.map((r, i) => (
                    <div key={i} style={{ ...S.accordion, marginBottom: 10 }}>
                      <div style={{ padding: "16px 20px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: rc }}>{r.Reporter || "Anonymous"}</span>
                          <span style={{ fontSize: 12, color: "#9ca3af" }}>{r.Date_Submitted}</span>
                        </div>
                        <p style={{ fontSize: 14, color: "#374151", lineHeight: 1.75, margin: 0 }}>{r.Report_Text}</p>
                      </div>
                    </div>
                  ))}

                  <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 16, padding: "24px" }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#1a1a2e", marginBottom: 16, textTransform: "uppercase", letterSpacing: "0.06em" }}>Add Your Report</div>
                    {submitOk ? (
                      <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 10, padding: "16px 18px" }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: "#15803d", marginBottom: 4 }}>✓ Report submitted</div>
                        <div style={{ fontSize: 13, color: "#166534" }}>Thank you. Your report will be reviewed and published shortly.</div>
                        <button onClick={() => setSubmitOk(false)} style={{ marginTop: 12, fontSize: 12, padding: "8px 16px", borderRadius: 8, border: "1px solid #bbf7d0", background: "transparent", color: "#15803d", cursor: "pointer", fontFamily: "inherit" }}>Submit another</button>
                      </div>
                    ) : (
                      <>
                        <input value={reporter} onChange={e => setReporter(e.target.value)} placeholder="Your name or Anonymous"
                          style={{ width: "100%", padding: "12px 14px", borderRadius: 10, border: "1px solid #e5e7eb", fontSize: 14, marginBottom: 10, boxSizing: "border-box", outline: "none", fontFamily: "inherit" }} />
                        <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={5}
                          placeholder="What do you notice? Sounds, smells, symptoms, health changes since the facility opened. Every detail matters."
                          style={{ width: "100%", padding: "12px 14px", borderRadius: 10, border: "1px solid #e5e7eb", fontSize: 14, resize: "vertical", outline: "none", boxSizing: "border-box", fontFamily: "inherit", lineHeight: 1.7 }} />
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
                          <button onClick={handleSubmit} disabled={submitting || !draft.trim()}
                            style={{ padding: "12px 28px", borderRadius: 10, border: "none", background: draft.trim() ? rc : "#e5e7eb", color: draft.trim() ? "#fff" : "#9ca3af", fontSize: 14, fontWeight: 700, cursor: draft.trim() ? "pointer" : "default", fontFamily: "inherit", transition: "all 0.2s" }}>
                            {submitting ? "Submitting…" : "Submit Report"}
                          </button>
                          <div style={{ fontSize: 11, color: "#9ca3af", maxWidth: 260, lineHeight: 1.5 }}>Reports are reviewed before publishing. Anonymous option available.</div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

            </div>
          </div>
        )}
      </div>

      {/* ── FOOTER ── */}
      <div style={{ background: "#0a0f1e", color: "#475569", textAlign: "center", padding: "24px", fontSize: 12, lineHeight: 1.7 }}>
        <div style={{ color: "#fff", fontSize: 16, fontWeight: 700, fontFamily: "'Impact', sans-serif", marginBottom: 6, letterSpacing: "0.04em" }}>HUMZONES</div>
        <div>Global Data Center Health Registry · Sources: Epoch AI (CC-BY) · EH Sciences · IARC · US News · arXiv</div>
        <div style={{ marginTop: 6 }}>© 2026 HumZones · humzones.com · Built for residents, not the industry</div>
      </div>

    </div>
  );
}
