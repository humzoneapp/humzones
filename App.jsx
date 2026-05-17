import { useState, useEffect, useRef, useCallback } from "react";

// ─── AIRTABLE CONFIG ──────────────────────────────────────────────────────────
const AIRTABLE_BASE_ID = "app2FUPqq8VQSwQ64";
const AIRTABLE_API_KEY = "HUMZONES_API_TOKEN_HERE";
const AIRTABLE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

const airtableHeaders = {
  Authorization: `Bearer ${AIRTABLE_API_KEY}`,
  "Content-Type": "application/json",
};

// ─── AIRTABLE API FUNCTIONS ───────────────────────────────────────────────────
const fetchFacilities = async () => {
  try {
    let allRecords = [];
    let offset = null;
    do {
      const url = new URL(`${AIRTABLE_URL}/Facilities`);
      url.searchParams.set("pageSize", "100");
      if (offset) url.searchParams.set("offset", offset);
      const res = await fetch(url.toString(), { headers: airtableHeaders });
      const data = await res.json();
      if (data.records) allRecords = [...allRecords, ...data.records];
      offset = data.offset || null;
    } while (offset);
    return allRecords.map((r) => ({ id: r.id, ...r.fields }));
  } catch (err) {
    console.error("Error fetching facilities:", err);
    return [];
  }
};

const fetchReports = async (facilityId) => {
  try {
    const url = new URL(`${AIRTABLE_URL}/Reports`);
    url.searchParams.set("filterByFormula", `{Facility} = "${facilityId}"`);
    url.searchParams.set("sort[0][field]", "Date_Submitted");
    url.searchParams.set("sort[0][direction]", "desc");
    const res = await fetch(url.toString(), { headers: airtableHeaders });
    const data = await res.json();
    return (data.records || []).map((r) => ({ id: r.id, ...r.fields }));
  } catch (err) {
    console.error("Error fetching reports:", err);
    return [];
  }
};

const submitReport = async (facilityId, facilityName, reporterName, reportText, city, country) => {
  try {
    const res = await fetch(`${AIRTABLE_URL}/Reports`, {
      method: "POST",
      headers: airtableHeaders,
      body: JSON.stringify({
        fields: {
          Reporter: reporterName || "Anonymous",
          Facility: facilityName,
          Report_Text: reportText,
          City: city,
          Country: country,
          Date_Submitted: new Date().toISOString().split("T")[0],
          Approved: false,
        },
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("Error submitting report:", err);
    return false;
  }
};

// ─── STATIC HEALTH DATA ───────────────────────────────────────────────────────
const SYMPTOMS = {
  HIGH: [
    { icon: "🔊", label: "The Constant Hum", sev: 5, desc: "A low drone like a refrigerator that never turns off — felt in the chest, through walls, through floors. Reported audible up to 4 miles in quiet areas. Worst at 2–4am when all other noise stops." },
    { icon: "🤕", label: "Chronic Headaches", sev: 5, desc: "The most reported symptom. Residents describe waking with them, improving when they leave home, worsening the longer they stay indoors near the facility." },
    { icon: "😵‍💫", label: "Dizziness & Vertigo", sev: 4, desc: "Infrasound — vibration below conscious hearing — disrupts the body's balance system. Documented in Granbury TX where residents reported vertigo severe enough to affect daily life." },
    { icon: "🤢", label: "Nausea", sev: 4, desc: "Linked to infrasound exposure. A National Library of Medicine study found infrasound can affect cardiac function within one hour of exposure above 100 dB." },
    { icon: "😴", label: "Sleep Destroyed", sev: 5, desc: "Low-frequency noise penetrates walls better than higher frequencies. Residents report never reaching deep sleep, waking at 2–4am, and cumulative exhaustion that compounds every other health issue." },
    { icon: "😰", label: "Anxiety & Panic", sev: 4, desc: "Persistent vibration activates fight-or-flight even without a conscious sound cue. One Virginia resident: \"It triggers an anxiety attack every time they do load testing.\"" },
    { icon: "👂", label: "Tinnitus (Ear Ringing)", sev: 3, desc: "Multiple facilities have residents reporting permanent tinnitus. In Granbury TX residents sued for irreversible hearing damage including children." },
    { icon: "💨", label: "Diesel Exhaust Smell", sev: 4, desc: "Monthly generator tests release diesel exhaust — a Group 1 carcinogen. Residents describe 30–60 minute episodes of black smoke and strong exhaust odor, worse downwind." },
  ],
  MODERATE: [
    { icon: "🔊", label: "Background Hum", sev: 3, desc: "Persistent low-frequency sound, most noticeable at night. Some describe pressure rather than sound. Can travel hundreds of meters depending on terrain." },
    { icon: "🤕", label: "Intermittent Headaches", sev: 3, desc: "Correlate with generator test cycles. Some residents notice it tracks with wind direction carrying diesel exhaust plumes." },
    { icon: "😴", label: "Disrupted Sleep", sev: 3, desc: "Generator tests (30–90 minutes, up to 105 dB) and continuous cooling noise affect sleep quality, especially for light sleepers and children." },
    { icon: "💨", label: "Occasional Exhaust Odor", sev: 2, desc: "During monthly generator tests. Diesel particulate matter is a classified carcinogen regardless of concentration — there is no established safe level." },
  ],
  "LOW-MODERATE": [
    { icon: "🔊", label: "Mild Background Noise", sev: 2, desc: "Present 24/7 but less intrusive. Low-frequency components travel further than measured dB suggests, particularly in quiet rural or suburban areas." },
    { icon: "💨", label: "Diesel During Tests", sev: 2, desc: "Monthly generator tests still produce diesel exhaust for 30–60 minutes. Keep windows closed on test days if you notice the smell." },
  ],
};

const LONG_TERM = [
  { icon: "🔬", cat: "Cancer Risk", color: "#f87171", short: "Diesel exhaust is a Group 1 carcinogen. Power-line EMF is classified 'possibly carcinogenic' by WHO.", long: "Two separate pathways elevate cancer risk. Diesel PM2.5 from backup generators is in the same carcinogen class as asbestos — directly linked to lung cancer. Separately, the WHO's IARC classified power-frequency magnetic fields 'possibly carcinogenic' (Group 2B) in 2002, with the strongest evidence for childhood leukemia at exposures starting at just 3–4 milligauss. The legal US limit is 2,000 mG — 500x higher than where studies found risk.", stat: "~1,300 projected premature US deaths annually from data center pollution by 2030", src: "arXiv 2412.06288, 2025" },
  { icon: "❤️", cat: "Heart Disease", color: "#fb923c", short: "Chronic noise raises blood pressure. Air pollution inflames blood vessels. Both compound over years.", long: "Chronic environmental noise keeps the body in low-grade stress. Over years this elevates blood pressure and increases heart attack and stroke risk. Diesel PM2.5 directly inflames arterial walls. Multiple peer-reviewed studies link proximity to industrial noise sources to increased cardiovascular mortality.", stat: "Long-term exposure linked to hypertension, cardiovascular disease, and stroke", src: "US News / ScienceDirect, 2025" },
  { icon: "🫁", cat: "Lung & Breathing", color: "#facc15", short: "PM2.5 enters your bloodstream through your lungs. There is no safe level of exposure.", long: "Fine particulate matter (PM2.5) from diesel generators is small enough to cross from lungs into the bloodstream. The Harvard Six Cities Study found no safe exposure level. It worsens asthma, COPD, and lung function — children and elderly most vulnerable.", stat: "600,000+ projected asthma symptom cases per year from US data centers by 2030", src: "arXiv 2412.06288, 2025" },
  { icon: "🧠", cat: "Mental Health", color: "#a78bfa", short: "Chronic noise, lost sleep, feeling powerless — documented anxiety, depression, and stress.", long: "The combination of chronic sleep loss, constant low-level vibration, and feeling ignored by authorities creates a documented mental health burden. Residents near data center clusters in Virginia, Texas, and Arizona report increased anxiety, helplessness, and depression.", stat: "Chronic industrial noise independently linked to anxiety and depression", src: "US News, Apr 2026" },
  { icon: "🤰", cat: "Reproductive Health", color: "#60a5fa", short: "ELF magnetic fields linked to miscarriage. Air pollution linked to premature birth.", long: "ELF magnetic fields have been studied in relation to miscarriage risk with some studies finding elevated risk at exposures reachable near high-voltage infrastructure. PM2.5 air pollution is independently associated with premature birth and low birth weight.", stat: "ELF-EMF exposure linked to miscarriage in peer-reviewed studies", src: "EH Sciences / BioInitiative Report" },
  { icon: "😴", cat: "Sleep & Brain", color: "#34d399", short: "Chronic sleep loss degrades immunity, memory, heart health — and lifespan.", long: "Chronic sleep deprivation raises diabetes and obesity risk, impairs memory and cognition, and is independently associated with shortened lifespan. Low-frequency noise has been reported audible up to 4.5 miles in quiet environments. Inside homes it exceeds safe sleep thresholds even when outdoor dB appears acceptable.", stat: "Infrasound shown to affect cardiac function within 1 hour above 100 dB", src: "US National Library of Medicine" },
];

const KIDS = [
  { icon: "🧬", label: "Childhood Leukemia", sev: "SERIOUS", color: "#f87171", desc: "WHO/IARC classified power-frequency magnetic fields 'possibly carcinogenic' specifically because of studies linking childhood residential exposure to elevated leukemia rates — at just 3–4 milligauss. Children's developing cells are far more sensitive to environmental disruption than adults." },
  { icon: "🫁", label: "Asthma & Lungs", sev: "DOCUMENTED", color: "#fb923c", desc: "Diesel particulate matter is a known asthma trigger in children. Kids with asthma living downwind of generator exhaust face increased attack frequency. A 2025 model projects data centers could cause over one-third of all US asthma deaths by 2030." },
  { icon: "🧠", label: "Brain Development & ADHD", sev: "EMERGING", color: "#facc15", desc: "ELF-EMF has been linked in studies to ADHD and cognitive dysfunction in children. Chronic sleep disruption from environmental noise independently impairs developing brains — affecting memory, attention, and emotional regulation." },
  { icon: "😴", label: "Sleep & Growth", sev: "HIGH CONCERN", color: "#a78bfa", desc: "Children need more sleep than adults — it's when growth hormone is released and memories consolidate. Low-frequency noise prevents deep sleep even at levels adults barely notice. Parents near data centers report children waking repeatedly and complaining of ear pressure." },
  { icon: "👂", label: "Hearing Damage", sev: "DOCUMENTED CASES", color: "#60a5fa", desc: "The Granbury TX case involved residents including children claiming permanent hearing damage and tinnitus. Children's hearing is still developing and more sensitive. Sustained exposure above 70 dB causes progressive damage over time." },
];

const QUIZ_Q = [
  { q: "How far do you live from this facility or its substation?", key: "dist", opts: ["Less than 0.25 miles", "0.25 – 0.5 miles", "0.5 – 1 mile", "More than 1 mile"] },
  { q: "Are there children under 12 in your household?", key: "kids", opts: ["Yes", "No"] },
  { q: "Is anyone in your home pregnant, or trying to conceive?", key: "preg", opts: ["Yes", "No", "Not sure"] },
  { q: "Does anyone in your home have asthma, COPD, or heart disease?", key: "health", opts: ["Yes", "No", "Not sure"] },
  { q: "How long have you lived at this address?", key: "dur", opts: ["Less than 1 year", "1 – 3 years", "3 – 10 years", "More than 10 years"] },
];

// ─── STATUS & RISK META ───────────────────────────────────────────────────────
const STATUS_META = {
  OPERATING: { label: "Operating", color: "#f87171", dot: "#f87171" },
  BUILDING: { label: "Under Construction", color: "#fb923c", dot: "#fb923c" },
  PROPOSED: { label: "Proposed", color: "#60a5fa", dot: "#60a5fa" },
  APPROVED: { label: "Approved", color: "#a78bfa", dot: "#a78bfa" },
};

const RISK_META = {
  HIGH: { color: "#f87171", bg: "#180808", border: "#320e0e" },
  MODERATE: { color: "#fb923c", bg: "#180e06", border: "#321a0a" },
  "LOW-MODERATE": { color: "#60a5fa", bg: "#060e1a", border: "#0a1a32" },
};

const fmt = (n) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(0)}K` : `${n}`;

// ─── COMPONENTS ───────────────────────────────────────────────────────────────
const SevBar = ({ level, max = 5, color }) => (
  <div style={{ display: "flex", gap: 3, marginTop: 6 }}>
    {Array.from({ length: max }).map((_, i) => (
      <div key={i} style={{ flex: 1, height: 3, borderRadius: 2, background: i < level ? color : "#1e1e2e", transition: "background 0.2s" }} />
    ))}
  </div>
);

const Pill = ({ label, color }) => (
  <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 10px", borderRadius: 20, background: color + "22", color, border: `1px solid ${color}33`, letterSpacing: "0.06em" }}>{label}</span>
);

const Card = ({ children, style = {}, ...props }) => (
  <div style={{ background: "#0c0c14", border: "1px solid #1a1a2e", borderRadius: 12, padding: "18px 20px", marginBottom: 12, ...style }} {...props}>
    {children}
  </div>
);

const LoadingSpinner = ({ message = "Loading..." }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 60, color: "#333" }}>
    <div style={{ width: 40, height: 40, border: "2px solid #1a1a2e", borderTop: "2px solid #f87171", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
    <div style={{ fontSize: 12, letterSpacing: "0.1em" }}>{message}</div>
    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
  </div>
);

// ─── LOCATION SEARCH ──────────────────────────────────────────────────────────
function LocationSearch({ facilities, onSelect }) {
  const [country, setCountry] = useState("");
  const [cityInput, setCityInput] = useState("");
  const [showCountryDrop, setShowCountryDrop] = useState(false);
  const [showCityDrop, setShowCityDrop] = useState(false);
  const cityRef = useRef(null);
  const countryRef = useRef(null);

  const countries = [...new Set(facilities.map((f) => f.Country).filter(Boolean))].sort();
  const countryMatches = countries.filter((c) => c.toLowerCase().includes(country.toLowerCase()));

  const citiesForCountry = country
    ? [...new Map(facilities.filter((f) => f.Country === country).map((f) => [f.City, f])).values()]
    : [];

  const filteredCities = cityInput
    ? citiesForCountry.filter((f) => f.City?.toLowerCase().includes(cityInput.toLowerCase()))
    : citiesForCountry;

  const cityGroups = filteredCities.reduce((acc, f) => {
    if (!acc[f.City]) acc[f.City] = [];
    acc[f.City].push(f);
    return acc;
  }, {});

  useEffect(() => {
    const handler = (e) => {
      if (cityRef.current && !cityRef.current.contains(e.target)) setShowCityDrop(false);
      if (countryRef.current && !countryRef.current.contains(e.target)) setShowCountryDrop(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selectCountry = (c) => { setCountry(c); setShowCountryDrop(false); setCityInput(""); };

  return (
    <div style={{ padding: "18px 20px", borderBottom: "1px solid #12121e", background: "#08080f" }}>
      <div style={{ fontSize: 9, color: "#2a2a3a", letterSpacing: "0.16em", marginBottom: 14, textTransform: "uppercase" }}>Find a Data Center</div>

      {/* Country */}
      <div ref={countryRef} style={{ position: "relative", marginBottom: 10 }}>
        <div style={{ fontSize: 8, color: "#252535", letterSpacing: "0.1em", marginBottom: 5, textTransform: "uppercase" }}>Country</div>
        <div onClick={() => setShowCountryDrop((v) => !v)}
          style={{ display: "flex", alignItems: "center", gap: 8, background: "#0f0f1c", border: `1px solid ${country ? "#a78bfa44" : "#1e1e2e"}`, borderRadius: 8, padding: "10px 12px", cursor: "pointer", transition: "border-color 0.2s" }}>
          <span style={{ fontSize: 14 }}>🌍</span>
          <span style={{ flex: 1, fontSize: 12, color: country ? "#ccc" : "#2e2e3e", fontFamily: "Georgia, serif" }}>{country || "Select country…"}</span>
          <span style={{ fontSize: 10, color: "#333" }}>▾</span>
        </div>
        {showCountryDrop && (
          <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: "#0f0f1c", border: "1px solid #1e1e2e", borderRadius: 8, zIndex: 100, maxHeight: 220, overflowY: "auto", boxShadow: "0 8px 32px #00000099" }}>
            <div style={{ padding: "8px 12px", borderBottom: "1px solid #141420" }}>
              <input autoFocus value={country} onChange={(e) => setCountry(e.target.value)} placeholder="Type to filter…"
                style={{ width: "100%", background: "transparent", border: "none", outline: "none", fontSize: 11, color: "#aaa", fontFamily: "inherit" }} />
            </div>
            {countryMatches.length === 0 && (
              <div style={{ padding: "14px 16px", fontSize: 11, color: "#252535", fontStyle: "italic" }}>No countries found</div>
            )}
            {countryMatches.map((c) => (
              <div key={c} onClick={() => selectCountry(c)}
                style={{ padding: "10px 14px", fontSize: 12, color: "#888", cursor: "pointer", fontFamily: "Georgia, serif", borderBottom: "1px solid #0e0e1a", transition: "all 0.1s" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "#141420"; e.currentTarget.style.color = "#ccc"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#888"; }}>
                {c}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* City */}
      <div ref={cityRef} style={{ position: "relative", opacity: country ? 1 : 0.35, pointerEvents: country ? "all" : "none", transition: "opacity 0.2s" }}>
        <div style={{ fontSize: 8, color: "#252535", letterSpacing: "0.1em", marginBottom: 5, textTransform: "uppercase" }}>City / Location</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#0f0f1c", border: `1px solid ${cityInput ? "#60a5fa44" : "#1e1e2e"}`, borderRadius: 8, padding: "10px 12px", transition: "border-color 0.2s" }}>
          <span style={{ fontSize: 14 }}>📍</span>
          <input value={cityInput} onChange={(e) => { setCityInput(e.target.value); setShowCityDrop(true); }} onFocus={() => setShowCityDrop(true)}
            placeholder={country ? `Cities in ${country}…` : "Select country first"}
            style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontSize: 12, color: "#ccc", fontFamily: "Georgia, serif" }} />
          {cityInput && <span onClick={() => setCityInput("")} style={{ cursor: "pointer", color: "#333", fontSize: 14 }}>✕</span>}
        </div>

        {showCityDrop && country && (
          <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: "#0d0d1a", border: "1px solid #1e1e2e", borderRadius: 8, zIndex: 100, maxHeight: 360, overflowY: "auto", boxShadow: "0 8px 32px #00000099" }}>
            {Object.keys(cityGroups).length === 0 && (
              <div style={{ padding: "14px 16px", fontSize: 11, color: "#252535", fontStyle: "italic" }}>No cities match</div>
            )}
            {Object.entries(cityGroups).map(([city, facs]) => (
              <div key={city}>
                <div style={{ padding: "8px 14px 4px", fontSize: 9, color: "#2e2e3e", letterSpacing: "0.12em", textTransform: "uppercase", borderTop: "1px solid #111118" }}>
                  📍 {city}
                </div>
                {facs.map((f) => {
                  const sm = STATUS_META[f.Facility_Status] || STATUS_META.OPERATING;
                  const rm = RISK_META[f.Risk_Level] || RISK_META.MODERATE;
                  return (
                    <div key={f.id} onClick={() => { setShowCityDrop(false); setCityInput(city); onSelect(f.id); }}
                      style={{ padding: "10px 16px 10px 24px", cursor: "pointer", borderBottom: "1px solid #0d0d18", transition: "all 0.1s" }}
                      onMouseEnter={(e) => e.currentTarget.style.background = "#111120"}
                      onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 11, color: "#aaa", marginBottom: 3, lineHeight: 1.3, fontFamily: "Georgia, serif" }}>{f.Name}</div>
                          <div style={{ fontSize: 9, color: "#2a2a3a" }}>{f.Company}</div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-end", marginLeft: 8 }}>
                          <span style={{ fontSize: 7, padding: "1px 6px", borderRadius: 8, background: sm.color + "22", color: sm.color, fontWeight: 700, whiteSpace: "nowrap" }}>
                            ● {sm.label}
                          </span>
                          <span style={{ fontSize: 7, padding: "1px 6px", borderRadius: 8, background: rm.color + "18", color: rm.color, fontWeight: 700 }}>
                            {f.Risk_Level}
                          </span>
                        </div>
                      </div>
                      <div style={{ fontSize: 9, color: "#282838", marginTop: 4 }}>
                        {f.Power_MW >= 1000 ? `${(f.Power_MW / 1000).toFixed(1)} GW` : `${f.Power_MW || "?"} MW`} · {f.Noise_DB || "?"} dB
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Status legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 12px", marginTop: 14 }}>
        {Object.entries(STATUS_META).map(([k, v]) => (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: v.dot, boxShadow: `0 0 4px ${v.dot}88` }} />
            <span style={{ fontSize: 8, color: "#252535" }}>{v.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
const TABS = [
  { id: "feel", label: "What You'll Feel", emoji: "🔊" },
  { id: "quiz", label: "Your Risk", emoji: "🎯" },
  { id: "longterm", label: "Long-Term Health", emoji: "❤️" },
  { id: "kids", label: "Kids & Families", emoji: "👧" },
  { id: "numbers", label: "By the Numbers", emoji: "📊" },
  { id: "act", label: "What To Do", emoji: "✊" },
  { id: "reports", label: "Community", emoji: "💬" },
];

export default function App() {
  const [facilities, setFacilities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState(null);
  const [tab, setTab] = useState("feel");
  const [reports, setReports] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [expandedLong, setExpandedLong] = useState(null);
  const [expandedKid, setExpandedKid] = useState(null);
  const [draft, setDraft] = useState("");
  const [reporterName, setReporterName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [quizStep, setQuizStep] = useState(0);
  const [quizAnswers, setQuizAnswers] = useState({});
  const [quizResult, setQuizResult] = useState(null);
  const mainRef = useRef(null);

  // Load facilities from Airtable on mount
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const data = await fetchFacilities();
      setFacilities(data);
      setLoading(false);
    };
    load();
  }, []);

  const dc = sel ? facilities.find((f) => f.id === sel) : null;
  const rm = dc ? (RISK_META[dc.Risk_Level] || RISK_META.MODERATE) : null;
  const sm = dc ? (STATUS_META[dc.Facility_Status] || STATUS_META.OPERATING) : null;
  const symptoms = dc ? (SYMPTOMS[dc.Risk_Level] || SYMPTOMS["LOW-MODERATE"]) : [];

  // Load reports when facility selected
  useEffect(() => {
    if (!dc) return;
    const load = async () => {
      setReportsLoading(true);
      const data = await fetchReports(dc.Name);
      setReports(data);
      setReportsLoading(false);
    };
    load();
  }, [sel]);

  const selectFacility = (id) => {
    setSel(id); setTab("feel");
    setQuizStep(0); setQuizResult(null); setQuizAnswers({});
    setExpandedLong(null); setExpandedKid(null);
    setSubmitSuccess(false);
    if (mainRef.current) mainRef.current.scrollTop = 0;
  };

  const computeQuiz = (a) => {
    let score = 0; const flags = [];
    if (a.dist === "Less than 0.25 miles") { score += 3; flags.push("Very close — highest EMF, noise, and air quality impact zone"); }
    else if (a.dist === "0.25 – 0.5 miles") { score += 2; flags.push("Close — within significant noise and air quality impact zone"); }
    else if (a.dist === "0.5 – 1 mile") { score += 1; flags.push("Moderate — within documented low-frequency noise range"); }
    if (a.kids === "Yes") { score += 2; flags.push("Children present — higher vulnerability to EMF, air, and noise impacts"); }
    if (a.preg === "Yes") { score += 2; flags.push("Pregnancy — elevated concern for EMF and air pollution exposure"); }
    if (a.health === "Yes") { score += 2; flags.push("Existing health conditions — air pollution and noise compound these"); }
    if (a.dur === "More than 10 years") { score += 1; flags.push("Long-term resident — chronic exposure risk accumulates over time"); }
    const level = score >= 6 ? "HIGH" : score >= 3 ? "MODERATE" : "LOWER";
    const advice = score >= 6
      ? "Your situation warrants immediate action. Request an independent EMF survey, file formal complaints with your local zoning board and state environmental agency, and speak with your doctor."
      : score >= 3
      ? "Your situation warrants monitoring. Document any symptoms, keep windows closed on generator test days, and familiarize yourself with your local zoning board's noise complaint process."
      : "Your risk is lower, but not zero. Stay informed about planned expansions and document any symptoms you notice over time.";
    return { level, score, flags, advice };
  };

  const handleSubmitReport = async () => {
    if (!draft.trim() || !dc) return;
    setSubmitting(true);
    const ok = await submitReport(dc.id, dc.Name, reporterName, draft, dc.City, dc.Country);
    if (ok) {
      setSubmitSuccess(true);
      setDraft("");
      setReporterName("");
      // Refresh reports
      const updated = await fetchReports(dc.Name);
      setReports(updated);
    }
    setSubmitting(false);
  };

  // ── RENDER ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", background: "#060608", minHeight: "100vh", color: "#c8c4bc", display: "flex", flexDirection: "column" }}>

      {/* ── HEADER ── */}
      <header style={{ background: "linear-gradient(180deg,#0a0a12 0%,#070710 100%)", borderBottom: "1px solid #14141e", padding: "0 28px", height: 62, display: "flex", alignItems: "center", gap: 18, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", gap: 5 }}>
            {["#f87171", "#fb923c", "#60a5fa"].map((c, i) => (
              <div key={i} style={{ width: 9, height: 9, borderRadius: "50%", background: c, boxShadow: `0 0 8px ${c}99` }} />
            ))}
          </div>
          <span style={{ fontSize: 18, fontWeight: 700, color: "#f0ece4", letterSpacing: "0.02em" }}>HumZones</span>
          <span style={{ fontSize: 10, color: "#252535", fontStyle: "italic", marginLeft: 4 }}>Global Data Center Health Registry</span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 16, alignItems: "center" }}>
          {!loading && (
            <span style={{ fontSize: 9, color: "#1e1e2e", letterSpacing: "0.08em" }}>
              {facilities.length} facilities indexed globally
            </span>
          )}
          {Object.entries(STATUS_META).map(([k, v]) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: v.dot, boxShadow: `0 0 4px ${v.dot}88` }} />
              <span style={{ fontSize: 8, color: "#1e1e2e", letterSpacing: "0.06em" }}>{v.label}</span>
            </div>
          ))}
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden", maxHeight: "calc(100vh - 62px)" }}>

        {/* ── SIDEBAR ── */}
        <aside style={{ width: 296, borderRight: "1px solid #12121a", display: "flex", flexDirection: "column", flexShrink: 0, background: "#07070e" }}>
          {loading ? (
            <div style={{ padding: 30 }}>
              <LoadingSpinner message="Loading global facilities…" />
            </div>
          ) : (
            <LocationSearch facilities={facilities} onSelect={selectFacility} />
          )}

          {/* Selected facility quick stats */}
          {dc && rm && (
            <div style={{ padding: "14px 20px", borderBottom: "1px solid #10101a", background: rm.bg }}>
              <div style={{ fontSize: 8, color: rm.color, letterSpacing: "0.1em", marginBottom: 6, textTransform: "uppercase" }}>Viewing</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#ccc", lineHeight: 1.3, marginBottom: 3 }}>{dc.Name}</div>
              <div style={{ fontSize: 9, color: "#2a2a3a", fontStyle: "italic", marginBottom: 10 }}>{dc.City}, {dc.State_Region}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {[
                  { emoji: "⚡", label: "Power", value: dc.Power_MW >= 1000 ? `${(dc.Power_MW / 1000).toFixed(1)} GW` : `${dc.Power_MW || "?"} MW`, color: rm.color },
                  { emoji: "🔊", label: "Noise", value: `${dc.Noise_DB || "?"} dB`, color: dc.Noise_DB >= 70 ? "#f87171" : dc.Noise_DB >= 60 ? "#facc15" : "#60a5fa" },
                  { emoji: "⚠️", label: "EMF Peak", value: `${dc.EMF_Fence_High || "?"} mG`, color: dc.EMF_Fence_High >= 4 ? "#f87171" : "#60a5fa" },
                  { emoji: "💧", label: "Water/day", value: dc.Water_Gal_Day > 0 ? `${fmt(dc.Water_Gal_Day)} gal` : "Near 0", color: "#60a5fa" },
                ].map((s) => (
                  <div key={s.label} style={{ background: "#0e0e18", borderRadius: 8, padding: "10px 12px", border: "1px solid #181828" }}>
                    <div style={{ fontSize: 7, color: "#252535", letterSpacing: "0.08em", marginBottom: 4, textTransform: "uppercase" }}>{s.emoji} {s.label}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: s.color }}>{s.value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!dc && !loading && (
            <div style={{ padding: "20px 20px", flex: 1 }}>
              <div style={{ fontSize: 10, color: "#1a1a2a", fontStyle: "italic", lineHeight: 1.8, marginBottom: 20 }}>
                Search by country and city to find data centers near you.
              </div>
              <div style={{ fontSize: 8, color: "#1a1a2a", letterSpacing: "0.1em", marginBottom: 10, textTransform: "uppercase" }}>In the database</div>
              {Object.entries(STATUS_META).map(([k, v]) => (
                <div key={k} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #0e0e18" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: v.dot }} />
                    <span style={{ fontSize: 10, color: "#252535" }}>{v.label}</span>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: v.color }}>
                    {facilities.filter((f) => f.Facility_Status === k).length}
                  </span>
                </div>
              ))}
            </div>
          )}
        </aside>

        {/* ── MAIN PANEL ── */}
        <main ref={mainRef} style={{ flex: 1, overflowY: "auto", background: "#070708" }}>
          {!dc ? (
            /* ── LANDING ── */
            <div style={{ padding: "56px 52px", maxWidth: 680 }}>
              <div style={{ fontSize: 10, color: "#1e1e2e", letterSpacing: "0.2em", marginBottom: 14, textTransform: "uppercase" }}>Welcome to</div>
              <h1 style={{ fontSize: 42, fontWeight: 800, color: "#e8e4da", lineHeight: 1.1, marginBottom: 18, letterSpacing: "-0.02em", margin: "0 0 18px" }}>
                HumZones
              </h1>
              <p style={{ fontSize: 15, color: "#3a3a4a", lineHeight: 1.85, marginBottom: 36, fontStyle: "italic", margin: "0 0 36px" }}>
                The internet runs on data centers. You may live next to one — or one may be coming. Find out what that means for your health, your children, and your community.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 40 }}>
                {[
                  { n: "~1,300", l: "projected US deaths per year from data center pollution by 2030" },
                  { n: "$20B+", l: "annual projected public health burden from data center emissions" },
                  { n: "600K", l: "projected asthma cases per year from data center air pollution" },
                  { n: "0", l: "federal laws specifically protecting residents near data centers from EMF" },
                ].map((s, i) => (
                  <div key={i} style={{ background: "#0c0c14", border: "1px solid #181828", borderRadius: 12, padding: "20px 22px" }}>
                    <div style={{ fontSize: 30, fontWeight: 800, color: "#f87171", marginBottom: 8, letterSpacing: "-0.02em" }}>{s.n}</div>
                    <div style={{ fontSize: 11, color: "#2e2e3e", lineHeight: 1.6 }}>{s.l}</div>
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 11, color: "#1a1a2a", fontStyle: "italic" }}>← Use the search on the left to find a data center near you.</p>
              {loading && <LoadingSpinner message="Loading global facility data…" />}
            </div>
          ) : (
            <>
              {/* ── FACILITY HEADER ── */}
              <div style={{ background: rm.bg, borderBottom: `1px solid ${rm.border}`, padding: "24px 32px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div>
                    <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <Pill label={`● ${sm.label}`} color={sm.color} />
                      <Pill label={`${dc.Risk_Level} RISK`} color={rm.color} />
                      <span style={{ fontSize: 9, color: "#2a2a3a", fontStyle: "italic" }}>{dc.Company}</span>
                    </div>
                    <h2 style={{ fontSize: 20, fontWeight: 800, color: "#ece8e0", margin: "0 0 6px", letterSpacing: "-0.01em", lineHeight: 1.2 }}>{dc.Name}</h2>
                    <div style={{ fontSize: 10, color: "#2a2a3a", marginBottom: 3 }}>{dc.Address}</div>
                    <div style={{ fontSize: 9, color: "#222232", fontStyle: "italic", marginBottom: 3 }}>Nearby: {dc.Nearby_Info || dc.Nearby}</div>
                    <div style={{ fontSize: 9, color: "#1a1a28" }}>Status: {dc.Opened || dc.Date_Opened}</div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 20 }}>
                    <div style={{ fontSize: 34, fontWeight: 800, color: rm.color, letterSpacing: "-0.03em", lineHeight: 1 }}>
                      {dc.Power_MW >= 1000 ? `${(dc.Power_MW / 1000).toFixed(1)} GW` : `${dc.Power_MW || "?"} MW`}
                    </div>
                    <div style={{ fontSize: 9, color: "#252535", marginTop: 5 }}>total power draw</div>
                    <div style={{ fontSize: 10, color: "#2a2a3a", marginTop: 8 }}>{dc.Noise_DB} dB perimeter · {dc.Substations} substation{dc.Substations > 1 ? "s" : ""}</div>
                    {dc.Source_URL && (
                      <a href={dc.Source_URL} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 8, color: "#1e2e4e", textDecoration: "none", display: "block", marginTop: 6 }}>
                        ↗ Source listing
                      </a>
                    )}
                  </div>
                </div>
              </div>

              {/* ── TABS ── */}
              <nav style={{ display: "flex", borderBottom: "1px solid #111118", padding: "0 32px", background: "#08080c", overflowX: "auto" }}>
                {TABS.map((t) => (
                  <button key={t.id} onClick={() => setTab(t.id)} style={{
                    display: "flex", alignItems: "center", gap: 5,
                    background: "none", border: "none",
                    borderBottom: tab === t.id ? `2px solid ${rm.color}` : "2px solid transparent",
                    color: tab === t.id ? rm.color : "#252535",
                    padding: "11px 13px", fontSize: 9, letterSpacing: "0.07em", cursor: "pointer",
                    fontFamily: "inherit", textTransform: "uppercase", whiteSpace: "nowrap", transition: "color 0.15s"
                  }}>
                    <span>{t.emoji}</span> {t.label}
                    {t.id === "reports" && reports.length > 0 && (
                      <span style={{ fontSize: 8, padding: "1px 5px", borderRadius: 10, background: rm.color + "22", color: rm.color, marginLeft: 3 }}>
                        {reports.length}
                      </span>
                    )}
                  </button>
                ))}
              </nav>

              <div style={{ padding: "28px 32px", maxWidth: 860 }}>

                {/* ── WHAT YOU'LL FEEL ── */}
                {tab === "feel" && (
                  <div>
                    <Card style={{ background: rm.bg, border: `1px solid ${rm.border}` }}>
                      <div style={{ fontSize: 10, color: rm.color, letterSpacing: "0.1em", marginBottom: 8, textTransform: "uppercase" }}>
                        Based on documented reports at comparable facilities
                      </div>
                      <p style={{ fontSize: 13, color: "#3a3a4a", lineHeight: 1.85, margin: 0 }}>
                        Every symptom below has been reported by real people living near data centers of this scale — from lawsuits, news investigations, and community testimonies across the US and internationally.
                      </p>
                    </Card>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      {symptoms.map((s, i) => (
                        <Card key={i} style={{ transition: "border-color 0.2s", cursor: "default" }}
                          onMouseEnter={(e) => e.currentTarget.style.borderColor = rm.color + "55"}
                          onMouseLeave={(e) => e.currentTarget.style.borderColor = "#1a1a2e"}>
                          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
                            <span style={{ fontSize: 22 }}>{s.icon}</span>
                            <div style={{ fontSize: 12, fontWeight: 700, color: "#ddd" }}>{s.label}</div>
                          </div>
                          <SevBar level={s.sev} color={rm.color} />
                          <p style={{ fontSize: 11, color: "#404050", lineHeight: 1.8, margin: "10px 0 0" }}>{s.desc}</p>
                        </Card>
                      ))}
                    </div>
                    <div style={{ fontSize: 9, color: "#1a1a2a", marginTop: 16, fontStyle: "italic", lineHeight: 1.7 }}>
                      Severity bars indicate frequency of reporting at comparable facilities. Individual experience depends on distance, building construction, terrain, and personal sensitivity.
                    </div>
                  </div>
                )}

                {/* ── QUIZ ── */}
                {tab === "quiz" && (
                  <div>
                    <h3 style={{ fontSize: 16, fontWeight: 700, color: "#d4d0c8", margin: "0 0 8px" }}>Your Personal Risk Assessment</h3>
                    <p style={{ fontSize: 12, color: "#303040", marginBottom: 24, lineHeight: 1.7, fontStyle: "italic", margin: "0 0 24px" }}>
                      Answer five questions to receive a personalized assessment based on your proximity and household situation.
                    </p>
                    {quizResult ? (
                      <div>
                        <Card style={{ background: RISK_META[quizResult.level]?.bg || "#0c0c14", border: `1px solid ${RISK_META[quizResult.level]?.border || "#1a1a2e"}` }}>
                          <div style={{ fontSize: 9, color: "#252535", letterSpacing: "0.12em", marginBottom: 10, textTransform: "uppercase" }}>Your Personal Risk Level</div>
                          <div style={{ fontSize: 34, fontWeight: 800, color: RISK_META[quizResult.level]?.color || "#888", marginBottom: 16, letterSpacing: "-0.02em" }}>{quizResult.level}</div>
                          <p style={{ fontSize: 12, color: "#404050", lineHeight: 1.85, marginBottom: 20, margin: "0 0 20px" }}>{quizResult.advice}</p>
                          <div style={{ fontSize: 9, color: "#222232", letterSpacing: "0.1em", marginBottom: 10, textTransform: "uppercase" }}>Why this rating:</div>
                          {quizResult.flags.map((f, i) => (
                            <div key={i} style={{ fontSize: 11, color: "#404050", padding: "6px 0", borderBottom: i < quizResult.flags.length - 1 ? "1px solid #141428" : "none", lineHeight: 1.6 }}>— {f}</div>
                          ))}
                        </Card>
                        <button onClick={() => { setQuizStep(0); setQuizResult(null); setQuizAnswers({}); }}
                          style={{ fontSize: 11, padding: "10px 22px", borderRadius: 8, border: `1px solid ${rm.color}44`, background: "transparent", color: rm.color, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.08em", marginTop: 8 }}>
                          ↩ Retake Quiz
                        </button>
                      </div>
                    ) : (
                      <div>
                        <div style={{ fontSize: 9, color: "#222232", marginBottom: 16, letterSpacing: "0.1em", textTransform: "uppercase" }}>Question {quizStep + 1} of {QUIZ_Q.length}</div>
                        <Card>
                          <p style={{ fontSize: 14, color: "#ccc", lineHeight: 1.65, margin: "0 0 20px" }}>{QUIZ_Q[quizStep].q}</p>
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {QUIZ_Q[quizStep].opts.map((opt) => (
                              <button key={opt} onClick={() => {
                                const a = { ...quizAnswers, [QUIZ_Q[quizStep].key]: opt };
                                setQuizAnswers(a);
                                if (quizStep < QUIZ_Q.length - 1) setQuizStep((s) => s + 1);
                                else setQuizResult(computeQuiz(a));
                              }}
                                style={{ fontSize: 12, padding: "13px 18px", borderRadius: 8, border: "1px solid #1e1e2e", background: "#0a0a12", color: "#888", cursor: "pointer", fontFamily: "Georgia, serif", textAlign: "left", transition: "all 0.15s" }}
                                onMouseEnter={(e) => { e.currentTarget.style.borderColor = rm.color + "66"; e.currentTarget.style.color = "#ccc"; }}
                                onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#1e1e2e"; e.currentTarget.style.color = "#888"; }}>
                                {opt}
                              </button>
                            ))}
                          </div>
                        </Card>
                        <div style={{ height: 3, background: "#111120", borderRadius: 2, marginTop: 4 }}>
                          <div style={{ height: 3, width: `${(quizStep / QUIZ_Q.length) * 100}%`, background: rm.color, borderRadius: 2, transition: "width 0.3s" }} />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ── LONG TERM ── */}
                {tab === "longterm" && (
                  <div>
                    <Card style={{ background: "#100810", border: "1px solid #281028" }}>
                      <div style={{ fontSize: 10, color: "#f87171", letterSpacing: "0.1em", marginBottom: 8, textTransform: "uppercase" }}>⚠ Long-Term Health Risks — What Research Shows</div>
                      <p style={{ fontSize: 13, color: "#3a2838", lineHeight: 1.85, margin: 0 }}>
                        A 2025 peer-reviewed study estimated data center pollution causes a public health burden of over $20 billion annually by 2030. Click any risk below to read the full explanation.
                      </p>
                    </Card>
                    {LONG_TERM.map((r, i) => (
                      <div key={i} style={{ background: "#0c0c14", border: "1px solid #1a1a2e", borderRadius: 12, marginBottom: 10, overflow: "hidden" }}>
                        <div onClick={() => setExpandedLong(expandedLong === i ? null : i)}
                          style={{ padding: "18px 22px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", transition: "background 0.15s" }}
                          onMouseEnter={(e) => e.currentTarget.style.background = "#101020"}
                          onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                            <span style={{ fontSize: 22 }}>{r.icon}</span>
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 700, color: "#ccc", marginBottom: 3 }}>{r.cat}</div>
                              <div style={{ fontSize: 11, color: "#343444", lineHeight: 1.5 }}>{r.short}</div>
                            </div>
                          </div>
                          <div style={{ fontSize: 18, color: "#252535", flexShrink: 0, marginLeft: 14, fontWeight: 300 }}>{expandedLong === i ? "−" : "+"}</div>
                        </div>
                        {expandedLong === i && (
                          <div style={{ padding: "0 22px 22px", borderTop: "1px solid #141428" }}>
                            <p style={{ fontSize: 12, color: "#404050", lineHeight: 1.9, margin: "16px 0" }}>{r.long}</p>
                            <div style={{ background: r.color + "0d", border: `1px solid ${r.color}22`, borderRadius: 8, padding: "12px 16px" }}>
                              <div style={{ fontSize: 11, color: r.color + "cc", lineHeight: 1.6 }}>📊 {r.stat}</div>
                              <div style={{ fontSize: 8, color: "#1e1e2e", marginTop: 4, fontStyle: "italic" }}>Source: {r.src}</div>
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
                    <Card style={{ background: "#0d0d0a", border: "1px solid #22221a" }}>
                      <div style={{ fontSize: 10, color: "#facc15", letterSpacing: "0.1em", marginBottom: 8, textTransform: "uppercase" }}>👧 Why Children Are More Vulnerable</div>
                      <p style={{ fontSize: 13, color: "#3a3a28", lineHeight: 1.85, margin: 0 }}>
                        Children breathe more air per pound of body weight. They sleep longer — meaning more hours of noise exposure. Their developing systems are more sensitive to environmental disruption than adults.
                      </p>
                    </Card>
                    {KIDS.map((k, i) => (
                      <div key={i} style={{ background: "#0c0c14", border: "1px solid #1a1a2e", borderRadius: 12, marginBottom: 10, overflow: "hidden" }}>
                        <div onClick={() => setExpandedKid(expandedKid === i ? null : i)}
                          style={{ padding: "18px 22px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", transition: "background 0.15s" }}
                          onMouseEnter={(e) => e.currentTarget.style.background = "#101020"}
                          onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                            <span style={{ fontSize: 22 }}>{k.icon}</span>
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 700, color: "#ccc", marginBottom: 4 }}>{k.label}</div>
                              <Pill label={k.sev} color={k.color} />
                            </div>
                          </div>
                          <div style={{ fontSize: 18, color: "#252535", flexShrink: 0, marginLeft: 14, fontWeight: 300 }}>{expandedKid === i ? "−" : "+"}</div>
                        </div>
                        {expandedKid === i && (
                          <div style={{ padding: "0 22px 22px", borderTop: "1px solid #141428" }}>
                            <p style={{ fontSize: 12, color: "#404050", lineHeight: 1.9, margin: "16px 0 0" }}>{k.desc}</p>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* ── NUMBERS ── */}
                {tab === "numbers" && (
                  <div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }}>
                      {[
                        {
                          emoji: "⚡", label: "Power Draw",
                          value: dc.Power_MW >= 1000 ? `${(dc.Power_MW / 1000).toFixed(1)} GW` : `${dc.Power_MW || "?"} MW`,
                          plain: dc.Power_MW ? `Enough to power ${fmt(Math.round(dc.Power_MW * 1000 / 1.25))} average homes — continuously, 24 hours a day, 365 days a year.` : "Power data not yet available for this facility.",
                          color: rm.color
                        },
                        {
                          emoji: "💨", label: "CO₂ Per Year",
                          value: dc.CO2_Tons_Year > 0 ? `${fmt(dc.CO2_Tons_Year)} tons` : "Near zero",
                          plain: dc.CO2_Tons_Year > 0 ? `Same as ${fmt(Math.round(dc.CO2_Tons_Year / 4.6))} passenger cars driven for a full year.` : "Powered by renewable energy — very low carbon footprint.",
                          color: dc.CO2_Tons_Year > 200000 ? "#f87171" : "#4ade80"
                        },
                        {
                          emoji: "💧", label: "Water Per Day",
                          value: dc.Water_Gal_Day > 0 ? `${fmt(dc.Water_Gal_Day)} gal` : "Near zero",
                          plain: dc.Water_Gal_Day > 0 ? `Same daily usage as ${fmt(Math.round(dc.Water_Gal_Day / 80))} households. Permanently removed from the local water cycle.` : "Air-cooled design — minimal water consumption.",
                          color: dc.Water_Gal_Day > 500000 ? "#f87171" : "#4ade80"
                        },
                        {
                          emoji: "🔊", label: "Perimeter Noise",
                          value: `${dc.Noise_DB || "?"} dB`,
                          plain: dc.Noise_DB >= 70 ? "Like a vacuum cleaner — running nonstop including 2am. Low-frequency components travel further than this number suggests." : dc.Noise_DB >= 60 ? "Like normal conversation — but 24/7, with low-frequency components penetrating walls." : "Moderate, but low-frequency components still travel beyond what measured dB indicates.",
                          color: dc.Noise_DB >= 70 ? "#f87171" : dc.Noise_DB >= 60 ? "#facc15" : "#60a5fa"
                        },
                        {
                          emoji: "⚠️", label: "EMF at Fence Line",
                          value: `up to ${dc.EMF_Fence_High || "?"} mG`,
                          plain: dc.EMF_Fence_High >= 4 ? "Studies link childhood leukemia risk to 3–4 mG. The legal US limit is 2,000 mG — so this is completely legal, and potentially harmful." : "Below the 3–4 mG concern threshold at the fence line. Still worth monitoring near schools.",
                          color: dc.EMF_Fence_High >= 4 ? "#f87171" : "#4ade80"
                        },
                        {
                          emoji: "📡", label: "EMF at 100 Meters",
                          value: `~${dc.EMF_100m || "?"} mG`,
                          plain: dc.EMF_100m >= 3 ? "Still above the level linked to childhood leukemia in epidemiological studies. If you live within 100m of the substation, take this seriously." : dc.EMF_100m >= 1 ? "Within the 1–3 mG zone where a 2026 study found health associations." : "Below precautionary thresholds at this distance.",
                          color: dc.EMF_100m >= 3 ? "#f87171" : dc.EMF_100m >= 1 ? "#facc15" : "#4ade80"
                        },
                      ].map((s) => (
                        <Card key={s.label} style={{ background: s.color + "08", border: `1px solid ${s.color}18` }}>
                          <div style={{ fontSize: 9, color: "#252535", letterSpacing: "0.1em", marginBottom: 8, textTransform: "uppercase" }}>{s.emoji} {s.label}</div>
                          <div style={{ fontSize: 22, fontWeight: 800, color: s.color, marginBottom: 8, letterSpacing: "-0.01em" }}>{s.value}</div>
                          <p style={{ fontSize: 11, color: "#303040", lineHeight: 1.65, margin: 0 }}>{s.plain}</p>
                        </Card>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── WHAT TO DO ── */}
                {tab === "act" && (
                  <div>
                    <h3 style={{ fontSize: 16, fontWeight: 700, color: "#d4d0c8", margin: "0 0 8px" }}>You're Not Powerless</h3>
                    <p style={{ fontSize: 12, color: "#303040", marginBottom: 24, lineHeight: 1.7, fontStyle: "italic", margin: "0 0 24px" }}>
                      Every data center regulation that exists was won by residents who organized, documented, and demanded accountability. Here's where to start.
                    </p>
                    {[
                      { emoji: "📋", title: "Document everything — starting today", color: "#f87171", steps: ["Write down any symptoms: headaches, sleep issues, dizziness, ear ringing, anxiety. Include dates and times.", "Note when you smell diesel exhaust — this is likely a generator test. Date, time, wind direction, duration.", "Photograph or video any visible smoke or unusual emissions.", "Keep a log — even a phone notes app. Patterns matter more than any single data point."] },
                      { emoji: "📣", title: "File formal complaints", color: "#fb923c", steps: ["Contact your city or county zoning board — data center noise complaints fall under industrial use permits.", "File with your state or provincial environmental agency.", "File with your national environmental protection body for air quality concerns.", "Contact your elected representative in writing — a paper trail matters."] },
                      { emoji: "📡", title: "Request independent monitoring", color: "#facc15", steps: ["Request an independent EMF survey of your property from a certified environmental health firm.", "Ask your local health department to monitor air quality near the facility, especially during generator tests.", "If a school is nearby, contact the school board — they have legal standing to demand environmental assessments."] },
                      { emoji: "👥", title: "Organize with neighbors", color: "#a78bfa", steps: ["One complaint is easier to ignore than fifty. Start a neighborhood group or join existing local advocacy groups.", "Look for community coalitions in your area that have pushed back on industrial development.", "Earthjustice (earthjustice.org) and the Environmental Defense Fund have resources for communities facing industrial neighbors."] },
                      { emoji: "🏠", title: "Protect your family right now", color: "#60a5fa", steps: ["Keep windows closed on generator test days — often monthly. Request the facility's test schedule in writing.", "Air purifiers with HEPA filtration reduce indoor PM2.5 from diesel exhaust.", "Speak with your doctor about any symptoms — getting them on medical record matters if legal action becomes necessary.", "White noise machines can mask some low-frequency intrusion for better sleep."] },
                    ].map((s, i) => (
                      <Card key={i}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
                          <span style={{ fontSize: 20 }}>{s.emoji}</span>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#ccc" }}>{s.title}</div>
                        </div>
                        {s.steps.map((step, j) => (
                          <div key={j} style={{ display: "flex", gap: 10, padding: "8px 0", borderBottom: j < s.steps.length - 1 ? "1px solid #141428" : "none" }}>
                            <div style={{ width: 20, height: 20, borderRadius: "50%", background: s.color + "1a", color: s.color, fontSize: 9, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, flexShrink: 0, marginTop: 1 }}>{j + 1}</div>
                            <div style={{ fontSize: 11, color: "#404050", lineHeight: 1.75 }}>{step}</div>
                          </div>
                        ))}
                      </Card>
                    ))}
                  </div>
                )}

                {/* ── COMMUNITY REPORTS ── */}
                {tab === "reports" && (
                  <div>
                    <h3 style={{ fontSize: 16, fontWeight: 700, color: "#d4d0c8", margin: "0 0 8px" }}>Community Reports</h3>
                    <p style={{ fontSize: 12, color: "#303040", marginBottom: 24, lineHeight: 1.7, fontStyle: "italic", margin: "0 0 24px" }}>
                      One person's symptom diary is anecdote. Three hundred people's symptom diaries near the same facility, all spiking on generator test days, is a public health study. Your report matters.
                    </p>

                    {/* Existing reports */}
                    {reportsLoading ? (
                      <LoadingSpinner message="Loading community reports…" />
                    ) : reports.length === 0 ? (
                      <div style={{ fontSize: 11, color: "#1e1e2e", fontStyle: "italic", marginBottom: 20, padding: "16px 0" }}>
                        No community reports yet for this facility. Be the first to share your experience.
                      </div>
                    ) : (
                      reports.map((r, i) => (
                        <Card key={i}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                            <span style={{ fontSize: 10, color: rm.color, fontWeight: 700 }}>{r.Reporter || "Anonymous"}</span>
                            <span style={{ fontSize: 9, color: "#1e1e2e", fontStyle: "italic" }}>{r.Date_Submitted}</span>
                          </div>
                          <p style={{ fontSize: 12, color: "#454555", lineHeight: 1.85, margin: 0 }}>{r.Report_Text}</p>
                        </Card>
                      ))
                    )}

                    {/* Submit form */}
                    <Card style={{ marginTop: 12 }}>
                      <div style={{ fontSize: 10, color: "#252535", letterSpacing: "0.1em", marginBottom: 14, textTransform: "uppercase" }}>Add Your Report</div>

                      {submitSuccess ? (
                        <div style={{ background: "#082808", border: "1px solid #104010", borderRadius: 8, padding: "16px 18px" }}>
                          <div style={{ fontSize: 13, color: "#4ade80", marginBottom: 6 }}>✓ Report submitted successfully</div>
                          <div style={{ fontSize: 11, color: "#2e4e2e", lineHeight: 1.6 }}>Thank you for contributing to HumZones. Your report will be reviewed and published shortly. Community data like yours helps build the evidence base for regulatory action.</div>
                          <button onClick={() => setSubmitSuccess(false)}
                            style={{ marginTop: 12, fontSize: 10, padding: "8px 16px", borderRadius: 6, border: "1px solid #104010", background: "transparent", color: "#4ade80", cursor: "pointer", fontFamily: "inherit" }}>
                            Submit another report
                          </button>
                        </div>
                      ) : (
                        <>
                          <input value={reporterName} onChange={(e) => setReporterName(e.target.value)}
                            placeholder="Your name or 'Anonymous'"
                            style={{ width: "100%", background: "#080810", border: "1px solid #1a1a2e", borderRadius: 8, padding: "10px 12px", color: "#888", fontSize: 12, fontFamily: "Georgia, serif", outline: "none", boxSizing: "border-box", marginBottom: 10 }} />
                          <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
                            placeholder="What do you notice? Sounds, smells, symptoms, health changes, anything relevant to living near this facility. Every detail matters."
                            rows={5}
                            style={{ width: "100%", background: "#080810", border: "1px solid #1a1a2e", borderRadius: 8, padding: "12px 14px", color: "#888", fontSize: 12, fontFamily: "Georgia, serif", resize: "vertical", outline: "none", boxSizing: "border-box", lineHeight: 1.75 }} />
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
                            <button onClick={handleSubmitReport} disabled={submitting || !draft.trim()}
                              style={{ fontSize: 11, padding: "11px 26px", borderRadius: 8, border: "none", background: draft.trim() ? rm.color : "#1a1a2e", color: draft.trim() ? "#000" : "#333", fontFamily: "inherit", fontWeight: 700, letterSpacing: "0.08em", cursor: draft.trim() ? "pointer" : "default", transition: "all 0.2s" }}>
                              {submitting ? "Submitting…" : "Submit Report"}
                            </button>
                            <p style={{ fontSize: 9, color: "#141428", fontStyle: "italic", maxWidth: 280, lineHeight: 1.5, margin: 0 }}>
                              Reports are reviewed before publishing. Anonymous option available. Aggregated data supports regulatory filings.
                            </p>
                          </div>
                        </>
                      )}
                    </Card>
                  </div>
                )}

              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
