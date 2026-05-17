import { useState, useEffect, useRef } from "react";

// ─── AIRTABLE ─────────────────────────────────────────────────────────────────
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
    const r = await fetch(url, { headers: HDR });
    const d = await r.json();
    all = [...all, ...(d.records||[])];
    offset = d.offset || null;
  } while (offset);
  return all.map(r => ({ id: r.id, ...r.fields }));
}

async function postReport(fields) {
  const r = await fetch(`${APIURL}/Reports`, {
    method:"POST", headers: HDR,
    body: JSON.stringify({ fields }),
  });
  return r.ok;
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const STATUS = {
  OPERATING: { label:"Operating",          color:"#f87171" },
  BUILDING:  { label:"Under Construction", color:"#fb923c" },
  PROPOSED:  { label:"Proposed",           color:"#60a5fa" },
  APPROVED:  { label:"Approved",           color:"#a78bfa" },
};

const RISK_C = { HIGH:"#ef4444", MODERATE:"#f97316", "LOW-MODERATE":"#3b82f6" };

const SYMPTOMS = {
  HIGH:[
    {e:"🔊",t:"The Constant Hum",s:5,d:"A low drone like a refrigerator that never turns off — felt in the chest, through walls, through floors. Reported audible up to 4 miles in quiet areas. Worst between 2–4am when all other noise dies away."},
    {e:"🤕",t:"Chronic Headaches",s:5,d:"The most commonly reported symptom. Residents describe waking with headaches that improve when they leave home and worsen the longer they stay indoors near the facility."},
    {e:"😵‍💫",t:"Dizziness & Vertigo",s:4,d:"Infrasound — vibration below conscious hearing — disrupts the body's balance system. Documented in Granbury TX where residents reported vertigo severe enough to affect daily life."},
    {e:"🤢",t:"Nausea",s:4,d:"Linked to infrasound exposure. A National Library of Medicine study found infrasound can affect cardiac function within one hour of exposure above 100 dB."},
    {e:"😴",t:"Sleep Destroyed",s:5,d:"Low-frequency noise penetrates walls better than high frequencies. Residents report never reaching deep sleep, waking at 2–4am, and cumulative exhaustion that compounds every other health issue."},
    {e:"😰",t:"Anxiety & Panic Attacks",s:4,d:"Persistent vibration activates fight-or-flight even without a conscious sound cue. One Virginia resident: \"It triggers an anxiety attack every time they do load testing.\""},
    {e:"👂",t:"Tinnitus (Ear Ringing)",s:3,d:"Multiple facilities have residents reporting permanent ear ringing. In Granbury TX, residents sued for irreversible hearing damage including children."},
    {e:"💨",t:"Diesel Exhaust Smell",s:4,d:"Monthly generator tests release diesel exhaust — a Group 1 carcinogen. Residents describe 30–60 minute episodes of visible black smoke and strong exhaust odor, worst downwind."},
  ],
  MODERATE:[
    {e:"🔊",t:"Background Hum",s:3,d:"Persistent low-frequency sound, most noticeable at night. Some describe it as pressure rather than sound. Can travel hundreds of meters depending on terrain."},
    {e:"🤕",t:"Intermittent Headaches",s:3,d:"Correlate with generator test cycles. Some residents notice it tracks with wind direction carrying diesel exhaust plumes."},
    {e:"😴",t:"Disrupted Sleep",s:3,d:"Generator tests (30–90 minutes, up to 105 dB) and continuous cooling noise affect sleep quality, especially for light sleepers and children."},
    {e:"💨",t:"Occasional Exhaust Odor",s:2,d:"During monthly generator tests. Diesel particulate matter is a classified carcinogen regardless of concentration — there is no established safe level."},
  ],
  "LOW-MODERATE":[
    {e:"🔊",t:"Mild Background Noise",s:2,d:"Present 24/7 but less intrusive. Low-frequency components travel further than measured dB suggests, particularly in quiet rural or suburban areas."},
    {e:"💨",t:"Diesel During Tests",s:2,d:"Monthly generator tests still produce diesel exhaust for 30–60 minutes. Keep windows closed if you notice the smell."},
  ],
};

const LONGTERM = [
  {e:"🔬",t:"Cancer Risk",c:"#ef4444",
   sh:"Diesel exhaust is a Group 1 carcinogen. EMF classified 'possibly carcinogenic' by WHO.",
   lo:"Two separate pathways elevate cancer risk. Diesel PM2.5 from backup generators is in the same carcinogen class as asbestos — directly linked to lung cancer. Separately, the WHO's IARC classified power-frequency magnetic fields 'possibly carcinogenic' (Group 2B) in 2002, with the strongest evidence for childhood leukemia at exposures starting at just 3–4 milligauss. The legal US limit is 2,000 mG — 500× higher than where studies found risk.",
   stat:"~1,300 projected premature US deaths annually from data center pollution by 2030",src:"arXiv 2412.06288, 2025"},
  {e:"❤️",t:"Heart Disease",c:"#f97316",
   sh:"Chronic noise raises blood pressure. Air pollution inflames blood vessels. Both compound over years.",
   lo:"Chronic environmental noise keeps the body in low-grade stress. Over years this elevates blood pressure and increases heart attack and stroke risk independently of other factors. Diesel PM2.5 directly inflames arterial walls. Multiple peer-reviewed studies link proximity to industrial noise to increased cardiovascular mortality.",
   stat:"Long-term exposure linked to hypertension, cardiovascular disease, and stroke",src:"US News / ScienceDirect, 2025"},
  {e:"🫁",t:"Lungs & Breathing",c:"#eab308",
   sh:"PM2.5 enters your bloodstream through your lungs. There is no safe level of exposure.",
   lo:"Fine particulate matter (PM2.5) from diesel generators is small enough to cross from lungs into the bloodstream. The Harvard Six Cities Study found no safe exposure level. It worsens asthma, COPD, and overall lung function — children and elderly most vulnerable.",
   stat:"600,000+ projected asthma symptom cases per year from US data centers by 2030",src:"arXiv 2412.06288, 2025"},
  {e:"🧠",t:"Mental Health",c:"#8b5cf6",
   sh:"Chronic noise, lost sleep, feeling powerless — documented anxiety, depression, and stress.",
   lo:"The combination of chronic sleep loss, constant low-level vibration, and feeling ignored by authorities creates a documented mental health burden. Residents near data center clusters in Virginia, Texas, and Arizona report increased anxiety, helplessness, and depression.",
   stat:"Chronic industrial noise independently linked to anxiety and depression",src:"US News, Apr 2026"},
  {e:"🤰",t:"Reproductive Health",c:"#3b82f6",
   sh:"ELF magnetic fields linked to miscarriage. Air pollution linked to premature birth.",
   lo:"ELF magnetic fields have been studied in relation to miscarriage risk, with some studies finding elevated risk at exposures reachable near high-voltage infrastructure. PM2.5 air pollution is independently associated with premature birth and low birth weight.",
   stat:"ELF-EMF exposure linked to miscarriage in peer-reviewed studies",src:"EH Sciences / BioInitiative"},
  {e:"😴",t:"Sleep & Brain",c:"#10b981",
   sh:"Chronic sleep loss degrades immunity, memory, heart health — and lifespan.",
   lo:"Chronic sleep deprivation raises diabetes and obesity risk, impairs memory and cognition, and is independently associated with shortened lifespan. Low-frequency noise has been reported audible up to 4.5 miles in quiet environments.",
   stat:"Infrasound shown to affect cardiac function within 1 hour above 100 dB",src:"US National Library of Medicine"},
];

const KIDS = [
  {e:"🧬",t:"Childhood Leukemia",sev:"SERIOUS",c:"#ef4444",d:"WHO/IARC classified power-frequency magnetic fields 'possibly carcinogenic' specifically because of studies linking childhood residential exposure to elevated leukemia rates — at just 3–4 milligauss. Children's developing cells are far more sensitive to environmental disruption than adults."},
  {e:"🫁",t:"Asthma & Lungs",sev:"DOCUMENTED",c:"#f97316",d:"Diesel particulate matter is a known asthma trigger in children. Kids with asthma living downwind of generator exhaust face increased attack frequency. A 2025 model projects data centers could cause over one-third of all US asthma deaths by 2030."},
  {e:"🧠",t:"Brain Development & ADHD",sev:"EMERGING",c:"#eab308",d:"ELF-EMF has been linked in studies to ADHD and cognitive dysfunction in children. Chronic sleep disruption from environmental noise independently impairs developing brains — affecting memory, attention, and emotional regulation."},
  {e:"😴",t:"Sleep & Growth",sev:"HIGH CONCERN",c:"#8b5cf6",d:"Children need more sleep than adults — it's when growth hormone is released and memories consolidate. Low-frequency noise prevents deep sleep even at levels adults barely notice."},
  {e:"👂",t:"Hearing Damage",sev:"DOCUMENTED CASES",c:"#3b82f6",d:"The Granbury TX case involved residents including children claiming permanent hearing damage and tinnitus. Children's hearing is still developing and more sensitive. Sustained exposure above 70 dB causes progressive damage."},
];

const QUIZ = [
  {q:"How far do you live from the facility or its substation?",k:"dist",o:["Less than 0.25 miles","0.25 – 0.5 miles","0.5 – 1 mile","More than 1 mile"]},
  {q:"Are there children under 12 in your household?",k:"kids",o:["Yes","No"]},
  {q:"Is anyone in your home pregnant, or trying to conceive?",k:"preg",o:["Yes","No","Not sure"]},
  {q:"Does anyone in your home have asthma, COPD, or heart disease?",k:"health",o:["Yes","No","Not sure"]},
  {q:"How long have you lived at this address?",k:"dur",o:["Less than 1 year","1 – 3 years","3 – 10 years","More than 10 years"]},
];

const fmt = n => n>=1e6?`${(n/1e6).toFixed(1)}M`:n>=1e3?`${(n/1e3).toFixed(0)}K`:`${n}`;

// ─── GLOBAL STYLES ────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700;800&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body { font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif; background: #f0f4f8; color: #1e293b; -webkit-font-smoothing: antialiased; }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: #f1f5f9; }
  ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
  
  @keyframes pulse-ring {
    0% { transform: scale(0.8); opacity: 0.8; }
    100% { transform: scale(2.4); opacity: 0; }
  }
  @keyframes float {
    0%, 100% { transform: translateY(0px); }
    50% { transform: translateY(-8px); }
  }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(24px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes countUp {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
  @keyframes shimmer {
    0% { background-position: -200% center; }
    100% { background-position: 200% center; }
  }
  @keyframes gradientShift {
    0%   { background-position: 0% 50%; }
    50%  { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
  .fade-up { animation: fadeUp 0.6s ease both; }
  .fade-up-2 { animation: fadeUp 0.6s ease 0.15s both; }
  .fade-up-3 { animation: fadeUp 0.6s ease 0.3s both; }
  .fade-up-4 { animation: fadeUp 0.6s ease 0.45s both; }
  .float { animation: float 4s ease-in-out infinite; }
  
  .tab-btn { transition: all 0.2s ease; }
  .tab-btn:hover { transform: translateY(-1px); }
  .search-input::placeholder { color: rgba(255,255,255,0.5); }
  .search-input:focus { outline: none; background: rgba(255,255,255,0.18) !important; }
  .symptom-card { transition: all 0.2s ease; }
  .symptom-card:hover { transform: translateY(-3px); box-shadow: 0 12px 32px rgba(0,0,0,0.12) !important; }
  .accordion-header { transition: background 0.15s; }
  .accordion-header:hover { background: #f8fafc !important; }
  .quiz-opt { transition: all 0.15s; }
  .quiz-opt:hover { transform: translateX(4px); }
  .drop-item { transition: background 0.1s; }
  .drop-item:hover { background: #f1f5f9 !important; }
  .clear-btn { transition: all 0.2s; }
  .clear-btn:hover { background: rgba(255,255,255,0.15) !important; }
  
  @media (max-width: 768px) {
    .hero-title { font-size: 36px !important; }
    .hero-sub { font-size: 14px !important; }
    .search-row { flex-direction: column !important; }
    .stats-strip { gap: 20px !important; padding: 16px !important; }
    .stat-num { font-size: 22px !important; }
    .facility-stats { grid-template-columns: 1fr 1fr !important; }
    .symptom-grid { grid-template-columns: 1fr !important; }
    .numbers-grid { grid-template-columns: 1fr !important; }
    .tabs-row { gap: 6px !important; }
    .tab-btn { font-size: 12px !important; padding: 8px 12px !important; }
    .facility-card { border-radius: 16px !important; }
    .main-content { padding: 20px 16px !important; }
    .facility-header { padding: 18px 16px !important; }
    .tab-content { padding: 0 16px 20px !important; }
    .hero-section { padding: 50px 20px 60px !important; min-height: auto !important; }
    .radar-rings { display: none !important; }
  }
  @media (max-width: 480px) {
    .hero-title { font-size: 28px !important; }
    .stat-num { font-size: 18px !important; }
  }
`;

// ─── SUB COMPONENTS ───────────────────────────────────────────────────────────
const SevBar = ({ level, color }) => (
  <div style={{ display:"flex", gap:4, margin:"8px 0" }}>
    {[1,2,3,4,5].map(i => (
      <div key={i} style={{ flex:1, height:4, borderRadius:2,
        background: i<=level ? color : "#e2e8f0", transition:"background 0.3s" }} />
    ))}
  </div>
);

const Chip = ({ label, color, small }) => (
  <span style={{
    display:"inline-flex", alignItems:"center", gap:4,
    fontSize: small ? 10 : 12, fontWeight:700,
    padding: small ? "2px 8px" : "4px 12px",
    borderRadius:20, letterSpacing:"0.04em",
    background: color+"18", color, border:`1px solid ${color}33`,
  }}>{label}</span>
);

const Card = ({ children, style={}, className="" }) => (
  <div className={className} style={{
    background:"#fff", borderRadius:16,
    border:"1px solid #e2e8f0",
    boxShadow:"0 2px 12px rgba(0,0,0,0.06)",
    overflow:"hidden", ...style,
  }}>{children}</div>
);

// ─── RADAR ANIMATION ──────────────────────────────────────────────────────────
const RadarRings = () => (
  <div className="radar-rings" style={{ position:"absolute", left:"50%", top:"50%", transform:"translate(-50%,-50%)", pointerEvents:"none", zIndex:0 }}>
    {[1,2,3,4].map(i => (
      <div key={i} style={{
        position:"absolute",
        width: i*180, height: i*180,
        borderRadius:"50%",
        border:"1px solid rgba(239,68,68,0.12)",
        top:"50%", left:"50%",
        transform:"translate(-50%,-50%)",
        animation:`pulse-ring ${2.5+i*0.5}s cubic-bezier(0.4,0,0.6,1) ${i*0.6}s infinite`,
      }} />
    ))}
  </div>
);

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
const TABS = [
  {id:"feel",    label:"What You'll Feel"},
  {id:"quiz",    label:"Your Risk Quiz"},
  {id:"health",  label:"Long-Term Health"},
  {id:"kids",    label:"Kids & Families"},
  {id:"numbers", label:"By the Numbers"},
  {id:"act",     label:"What To Do"},
  {id:"reports", label:"Community"},
];

export default function App() {
  const [facs, setFacs]           = useState([]);
  const [loading, setLoading]     = useState(true);
  const [country, setCountry]     = useState("");
  const [cInput, setCInput]       = useState("");
  const [showCD, setShowCD]       = useState(false);
  const [cityTxt, setCityTxt]     = useState("");
  const [showCityD, setShowCityD] = useState(false);
  const [sel, setSel]             = useState(null);
  const [tab, setTab]             = useState("feel");
  const [reps, setReps]           = useState([]);
  const [draft, setDraft]         = useState("");
  const [repName, setRepName]     = useState("");
  const [sending, setSending]     = useState(false);
  const [sent, setSent]           = useState(false);
  const [xLong, setXLong]         = useState(null);
  const [xKid, setXKid]           = useState(null);
  const [qStep, setQStep]         = useState(0);
  const [qAns, setQAns]           = useState({});
  const [qRes, setQRes]           = useState(null);
  const [imgErr, setImgErr]       = useState(false);
  const [counted, setCounted]     = useState(false);
  const [counts, setCounts]       = useState([0,0,0,0]);
  const cRef  = useRef(null);
  const ciRef = useRef(null);
  const topRef= useRef(null);

  useEffect(() => {
    apiFetch("Facilities").then(d => { setFacs(d); setLoading(false); });
  }, []);

  // Count-up animation for stats
  useEffect(() => {
    if (!loading && !counted) {
      setCounted(true);
      const targets = [1300, 20, 600000, facs.length];
      const duration = 1800;
      const steps = 60;
      let step = 0;
      const interval = setInterval(() => {
        step++;
        const progress = step/steps;
        const ease = 1-Math.pow(1-progress,3);
        setCounts(targets.map(t => Math.round(t*ease)));
        if (step >= steps) clearInterval(interval);
      }, duration/steps);
      return () => clearInterval(interval);
    }
  }, [loading, facs.length]);

  // Close dropdowns on outside click
  useEffect(() => {
    const h = e => {
      if (cRef.current  && !cRef.current.contains(e.target))  setShowCD(false);
      if (ciRef.current && !ciRef.current.contains(e.target)) setShowCityD(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const dc       = sel ? facs.find(f=>f.id===sel) : null;
  const rc       = dc ? (RISK_C[dc.Risk_Level]||"#64748b") : "#64748b";
  const sm       = dc ? (STATUS[dc.Facility_Status]||STATUS.OPERATING) : null;
  const symptoms = dc ? (SYMPTOMS[dc.Risk_Level]||SYMPTOMS["LOW-MODERATE"]) : [];

  useEffect(() => {
    if (!dc) return;
    setReps([]);
    apiFetch("Reports", { filterByFormula: `{Facility} = "${dc.Name}"` }).then(setReps);
  }, [sel]);

  const countries     = [...new Set(facs.map(f=>f.Country).filter(Boolean))].sort();
  const cMatches      = cInput ? countries.filter(c=>c.toLowerCase().includes(cInput.toLowerCase())) : countries;
  const citiesInC     = country ? [...new Map(facs.filter(f=>f.Country===country).map(f=>[f.City,f])).values()] : [];
  const cityMatches   = cityTxt ? citiesInC.filter(f=>f.City?.toLowerCase().includes(cityTxt.toLowerCase())) : citiesInC;
  const cityGroups    = cityMatches.reduce((a,f)=>{ if(!a[f.City])a[f.City]=[]; a[f.City].push(f); return a; },{});

  const pickCountry = c => { setCountry(c); setCInput(c); setShowCD(false); setCityTxt(""); setSel(null); };
  const clearAll    = () => { setCountry(""); setCInput(""); setCityTxt(""); setSel(null); setShowCD(false); setShowCityD(false); };
  const pickFac     = id => {
    setSel(id); setTab("feel");
    setQStep(0); setQRes(null); setQAns({});
    setXLong(null); setXKid(null);
    setSent(false); setImgErr(false);
    setTimeout(()=>topRef.current?.scrollIntoView({behavior:"smooth"}),100);
  };

  const calcQuiz = a => {
    let score=0; const flags=[];
    if(a.dist==="Less than 0.25 miles"){score+=3;flags.push("Very close proximity — highest EMF, noise, and air quality impact zone");}
    else if(a.dist==="0.25 – 0.5 miles"){score+=2;flags.push("Close — within significant noise and air quality impact zone");}
    else if(a.dist==="0.5 – 1 mile"){score+=1;flags.push("Moderate — within documented low-frequency noise range");}
    if(a.kids==="Yes"){score+=2;flags.push("Children present — higher vulnerability to all environmental impacts");}
    if(a.preg==="Yes"){score+=2;flags.push("Pregnancy — elevated concern for EMF and air pollution exposure");}
    if(a.health==="Yes"){score+=2;flags.push("Existing health conditions — pollution and noise compound these risks");}
    if(a.dur==="More than 10 years"){score+=1;flags.push("Long-term resident — chronic exposure accumulates over time");}
    const level = score>=6?"HIGH":score>=3?"MODERATE":"LOWER";
    const advice = score>=6
      ? "Your situation warrants immediate action. Request an independent EMF survey, file formal complaints with your local zoning board and state environmental agency, and speak with your doctor about proximity-related health concerns."
      : score>=3
      ? "Your situation warrants monitoring and action. Document any symptoms, keep windows closed on generator test days, and familiarize yourself with your local zoning board's noise complaint process."
      : "Your risk is lower, but not zero. Stay informed about any planned expansions and document any symptoms you notice.";
    return { level, score, flags, advice };
  };

  const sendReport = async () => {
    if (!draft.trim()||!dc) return;
    setSending(true);
    const ok = await postReport({
      Reporter: repName||"Anonymous", Facility: dc.Name,
      Report_Text: draft, City: dc.City, Country: dc.Country,
      Date_Submitted: new Date().toISOString().split("T")[0], Approved: false,
    });
    if(ok){ setSent(true); setDraft(""); setRepName("");
      apiFetch("Reports",{filterByFormula:`{Facility} = "${dc.Name}"`}).then(setReps); }
    setSending(false);
  };

  // Stats display values
  const STAT_TARGETS = [
    { raw:counts[0], display:"~"+counts[0].toLocaleString(), label:"Projected US deaths/year by 2030" },
    { raw:counts[1], display:"$"+counts[1]+"B+",             label:"Annual public health burden" },
    { raw:counts[2], display:counts[2]>=600000?"600K":fmt(counts[2]), label:"Projected asthma cases/year" },
    { raw:counts[3], display:loading?"…":facs.length,        label:"Facilities in our database" },
  ];

  return (
    <>
      <style>{GLOBAL_CSS}</style>
      <div style={{ minHeight:"100vh", background:"#f0f4f8" }}>

        {/* ══════════════════════════════════════════════════
            HERO SECTION
        ══════════════════════════════════════════════════ */}
        <section className="hero-section" style={{
          position:"relative", overflow:"hidden",
          minHeight:"100vh",
          background:"linear-gradient(160deg, #020818 0%, #0f172a 40%, #1e0a3c 70%, #0f172a 100%)",
          backgroundSize:"400% 400%",
          animation:"gradientShift 12s ease infinite",
          display:"flex", flexDirection:"column",
          alignItems:"center", justifyContent:"center",
          padding:"80px 24px 80px",
          textAlign:"center",
        }}>
          <RadarRings />

          {/* Logo / wordmark */}
          <div className="fade-up" style={{ marginBottom:32, position:"relative", zIndex:1 }}>
            <div style={{
              display:"inline-flex", alignItems:"center", gap:10,
              background:"rgba(255,255,255,0.06)",
              border:"1px solid rgba(255,255,255,0.12)",
              borderRadius:40, padding:"8px 20px",
              backdropFilter:"blur(12px)",
            }}>
              <div style={{ display:"flex", gap:5 }}>
                {["#ef4444","#f97316","#eab308"].map((c,i)=>(
                  <div key={i} style={{ width:8,height:8,borderRadius:"50%",background:c,boxShadow:`0 0 8px ${c}` }} />
                ))}
              </div>
              <span style={{ fontSize:13,fontWeight:700,color:"rgba(255,255,255,0.9)",letterSpacing:"0.12em" }}>
                HUMZONES.COM
              </span>
            </div>
          </div>

          {/* Main headline */}
          <h1 className="hero-title fade-up-2" style={{
            fontFamily:"'Impact','Arial Black',sans-serif",
            fontSize:"clamp(38px, 8vw, 88px)",
            lineHeight:1.0, letterSpacing:"0.02em",
            color:"#fff", marginBottom:20,
            position:"relative", zIndex:1,
            textShadow:"0 0 60px rgba(239,68,68,0.4)",
          }}>
            ARE YOU IN THE{" "}
            <span style={{
              background:"linear-gradient(90deg, #ef4444, #f97316, #ef4444)",
              backgroundSize:"200% auto",
              animation:"shimmer 3s linear infinite",
              WebkitBackgroundClip:"text",
              WebkitTextFillColor:"transparent",
            }}>HUM</span>ZONE?
          </h1>

          <p className="hero-sub fade-up-3" style={{
            fontSize:18, color:"rgba(255,255,255,0.6)",
            maxWidth:520, lineHeight:1.7,
            marginBottom:48, position:"relative", zIndex:1,
          }}>
            Data centers power the internet. You may live next to one.
            Search your country and city to find out what that means for your health.
          </p>

          {/* ── SEARCH BARS ── */}
          <div className="search-row fade-up-4" style={{
            display:"flex", gap:12, width:"100%", maxWidth:680,
            position:"relative", zIndex:10,
          }}>

            {/* Country */}
            <div ref={cRef} style={{ flex:1, position:"relative" }}>
              <div style={{ position:"relative" }}>
                <span style={{ position:"absolute",left:16,top:"50%",transform:"translateY(-50%)",fontSize:18,zIndex:2 }}>🌍</span>
                <input
                  className="search-input"
                  value={cInput}
                  onChange={e=>{setCInput(e.target.value);setShowCD(true);}}
                  onFocus={()=>setShowCD(true)}
                  placeholder="Select a country…"
                  style={{
                    width:"100%", paddingLeft:48, paddingRight:16,
                    padding:"18px 16px 18px 48px",
                    fontSize:15, fontWeight:500, fontFamily:"inherit",
                    borderRadius:14, border:"1px solid rgba(255,255,255,0.15)",
                    background:"rgba(255,255,255,0.1)",
                    color:"#fff", backdropFilter:"blur(16px)",
                    cursor:"pointer", boxSizing:"border-box",
                    boxShadow:"0 4px 24px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.1)",
                  }}
                />
              </div>
              {showCD && (
                <div style={{
                  position:"absolute", top:"calc(100% + 8px)", left:0, right:0,
                  background:"#fff", borderRadius:14,
                  boxShadow:"0 24px 64px rgba(0,0,0,0.25)",
                  zIndex:300, maxHeight:280, overflowY:"auto",
                  border:"1px solid #e2e8f0",
                }}>
                  {cMatches.length===0 && <div style={{padding:"14px 18px",color:"#94a3b8",fontSize:14,fontStyle:"italic"}}>No countries found</div>}
                  {cMatches.map(c=>(
                    <div key={c} className="drop-item"
                      style={{padding:"13px 18px",fontSize:14,color:"#1e293b",cursor:"pointer",borderBottom:"1px solid #f1f5f9",fontWeight:500}}
                      onClick={()=>pickCountry(c)}>
                      {c}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* City */}
            <div ref={ciRef} style={{ flex:1, position:"relative", opacity:country?1:0.5, pointerEvents:country?"all":"none", transition:"opacity 0.2s" }}>
              <div style={{ position:"relative" }}>
                <span style={{ position:"absolute",left:16,top:"50%",transform:"translateY(-50%)",fontSize:18,zIndex:2 }}>📍</span>
                <input
                  className="search-input"
                  value={cityTxt}
                  onChange={e=>{setCityTxt(e.target.value);setShowCityD(true);}}
                  onFocus={()=>setShowCityD(true)}
                  placeholder={country?`Cities in ${country}…`:"Select country first"}
                  style={{
                    width:"100%",
                    padding:"18px 16px 18px 48px",
                    fontSize:15, fontWeight:500, fontFamily:"inherit",
                    borderRadius:14, border:"1px solid rgba(255,255,255,0.15)",
                    background:"rgba(255,255,255,0.1)",
                    color:"#fff", backdropFilter:"blur(16px)",
                    cursor:"pointer", boxSizing:"border-box",
                    boxShadow:"0 4px 24px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.1)",
                  }}
                />
              </div>
              {showCityD && country && (
                <div style={{
                  position:"absolute", top:"calc(100% + 8px)", left:0, right:0,
                  background:"#fff", borderRadius:14,
                  boxShadow:"0 24px 64px rgba(0,0,0,0.25)",
                  zIndex:300, maxHeight:360, overflowY:"auto",
                  border:"1px solid #e2e8f0",
                }}>
                  {Object.keys(cityGroups).length===0 && <div style={{padding:"14px 18px",color:"#94a3b8",fontSize:14,fontStyle:"italic"}}>No cities found</div>}
                  {Object.entries(cityGroups).map(([city,facList])=>(
                    <div key={city}>
                      <div style={{padding:"8px 18px 4px",fontSize:11,color:"#94a3b8",letterSpacing:"0.08em",textTransform:"uppercase",background:"#f8fafc",borderTop:"1px solid #f1f5f9",fontWeight:600}}>
                        📍 {city}
                      </div>
                      {facList.map(f=>{
                        const s2=STATUS[f.Facility_Status]||STATUS.OPERATING;
                        const r2=RISK_C[f.Risk_Level]||"#64748b";
                        return (
                          <div key={f.id} className="drop-item"
                            style={{padding:"12px 18px 12px 26px",cursor:"pointer",borderBottom:"1px solid #f1f5f9"}}
                            onClick={()=>{setCityTxt(city);setShowCityD(false);pickFac(f.id);}}>
                            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
                              <div>
                                <div style={{fontSize:14,fontWeight:600,color:"#1e293b",marginBottom:2}}>{f.Name}</div>
                                <div style={{fontSize:12,color:"#64748b"}}>{f.Company} · {f.Power_MW>=1000?`${(f.Power_MW/1000).toFixed(1)} GW`:`${f.Power_MW||"?"}MW`}</div>
                              </div>
                              <div style={{display:"flex",flexDirection:"column",gap:3,alignItems:"flex-end",flexShrink:0}}>
                                <Chip label={`● ${s2.label}`} color={s2.color} small />
                                <Chip label={f.Risk_Level} color={r2} small />
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

          {/* Clear button */}
          {country && (
            <button className="clear-btn fade-up" onClick={clearAll} style={{
              marginTop:16,background:"rgba(255,255,255,0.08)",
              border:"1px solid rgba(255,255,255,0.15)",
              color:"rgba(255,255,255,0.6)",
              padding:"8px 20px",borderRadius:20,fontSize:13,
              cursor:"pointer",fontFamily:"inherit",
              backdropFilter:"blur(8px)",
              position:"relative",zIndex:1,
            }}>
              ✕ Clear search
            </button>
          )}

          {/* Scroll indicator */}
          {!dc && (
            <div className="float" style={{ position:"absolute",bottom:32,left:"50%",transform:"translateX(-50%)",color:"rgba(255,255,255,0.3)",fontSize:13,zIndex:1 }}>
              ↓ scroll to learn more
            </div>
          )}
        </section>

        {/* ══════════════════════════════════════════════════
            STATS STRIP
        ══════════════════════════════════════════════════ */}
        <div className="stats-strip" style={{
          background:"#fff", borderBottom:"1px solid #e2e8f0",
          padding:"20px 24px",
          display:"flex", justifyContent:"center",
          alignItems:"center", gap:48, flexWrap:"wrap",
        }}>
          {STAT_TARGETS.map((s,i)=>(
            <div key={i} style={{textAlign:"center"}}>
              <div className="stat-num" style={{
                fontSize:28,fontWeight:800,
                fontFamily:"'Impact',sans-serif",
                background:"linear-gradient(135deg,#ef4444,#f97316)",
                WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",
                letterSpacing:"-0.02em",display:"block",lineHeight:1.1,
              }}>
                {s.display}
              </div>
              <div style={{fontSize:11,color:"#94a3b8",letterSpacing:"0.08em",textTransform:"uppercase",fontWeight:600,marginTop:4}}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* ══════════════════════════════════════════════════
            MAIN CONTENT
        ══════════════════════════════════════════════════ */}
        <main className="main-content" ref={topRef} style={{ maxWidth:1000,margin:"0 auto",padding:"32px 24px 60px" }}>

          {/* No selection state */}
          {!dc && !loading && (
            <div style={{textAlign:"center",padding:"80px 24px"}}>
              <div className="float" style={{fontSize:72,marginBottom:20}}>🌍</div>
              <h2 style={{fontSize:24,fontWeight:800,color:"#1e293b",marginBottom:8}}>Search for a data center near you</h2>
              <p style={{fontSize:15,color:"#64748b",maxWidth:440,margin:"0 auto",lineHeight:1.7}}>
                Select your country above, then choose your city to find data centers in your area and understand their real health impact.
              </p>
              <div style={{display:"flex",justifyContent:"center",gap:16,marginTop:40,flexWrap:"wrap"}}>
                {Object.entries(STATUS).map(([k,v])=>(
                  <div key={k} style={{display:"flex",alignItems:"center",gap:6,fontSize:13,color:"#64748b",fontWeight:500}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:v.color,boxShadow:`0 0 6px ${v.color}`}} />
                    {v.label}: {facs.filter(f=>f.Facility_Status===k).length}
                  </div>
                ))}
              </div>
            </div>
          )}

          {loading && (
            <div style={{textAlign:"center",padding:80,color:"#94a3b8"}}>
              <div style={{fontSize:40,marginBottom:16}}>⏳</div>
              <div style={{fontSize:15,fontWeight:500}}>Loading global facility data…</div>
            </div>
          )}

          {/* ── FACILITY CARD ── */}
          {dc && (
            <Card className="facility-card" style={{borderRadius:24,overflow:"hidden",boxShadow:"0 8px 40px rgba(0,0,0,0.12)"}}>

              {/* Image */}
              <div style={{position:"relative",height:260,overflow:"hidden",flexShrink:0}}>
                {!imgErr ? (
                  <img
                    src={`https://source.unsplash.com/1200x400/?data+center,server,${encodeURIComponent(dc.Company||"technology")}`}
                    alt={dc.Name}
                    style={{width:"100%",height:"100%",objectFit:"cover"}}
                    onError={()=>setImgErr(true)}
                  />
                ) : (
                  <div style={{width:"100%",height:"100%",background:`linear-gradient(135deg, #0f172a, #1e293b)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:64}}>🏭</div>
                )}
                {/* Overlay gradient */}
                <div style={{position:"absolute",inset:0,background:"linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 60%)"}} />
                {/* Badges on image */}
                <div style={{position:"absolute",bottom:16,left:20,display:"flex",gap:8,flexWrap:"wrap"}}>
                  <Chip label={`● ${sm.label}`} color={sm.color} />
                  <Chip label={`${dc.Risk_Level} RISK`} color={rc} />
                </div>
                {/* Risk color bar */}
                <div style={{position:"absolute",top:0,left:0,right:0,height:4,background:rc}} />
              </div>

              {/* Header info */}
              <div className="facility-header" style={{padding:"24px 28px 20px"}}>
                <h2 style={{fontSize:22,fontWeight:800,color:"#0f172a",marginBottom:6,letterSpacing:"-0.02em",lineHeight:1.2}}>{dc.Name}</h2>
                <div style={{fontSize:13,color:"#64748b",marginBottom:4}}>{dc.Address}</div>
                {dc.Nearby_Info && <div style={{fontSize:13,color:"#64748b",fontStyle:"italic",marginBottom:16}}>Nearby: {dc.Nearby_Info}</div>}
                {dc.Opened && <div style={{fontSize:12,color:"#94a3b8",marginBottom:16}}>Status: {dc.Opened}</div>}

                {/* Quick stats grid */}
                <div className="facility-stats" style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
                  {[
                    {label:"Power Draw",value:dc.Power_MW>=1000?`${(dc.Power_MW/1000).toFixed(1)} GW`:`${dc.Power_MW||"?"} MW`,color:rc},
                    {label:"Noise Level",value:`${dc.Noise_DB||"?"} dB`,color:dc.Noise_DB>=70?"#ef4444":dc.Noise_DB>=60?"#f97316":"#3b82f6"},
                    {label:"EMF at Fence",value:`${dc.EMF_Fence_High||"?"} mG`,color:dc.EMF_Fence_High>=4?"#ef4444":"#10b981"},
                    {label:"Water/Day",value:dc.Water_Gal_Day>0?`${fmt(dc.Water_Gal_Day)} gal`:"Near zero",color:"#3b82f6"},
                  ].map(s=>(
                    <div key={s.label} style={{background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:12,padding:"14px 16px",textAlign:"center"}}>
                      <div style={{fontSize:20,fontWeight:800,color:s.color,marginBottom:4,fontFamily:"'Impact',sans-serif"}}>{s.value}</div>
                      <div style={{fontSize:10,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.06em",fontWeight:600}}>{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Tabs */}
              <div style={{borderTop:"1px solid #f1f5f9",background:"#fafafa"}}>
                <div className="tabs-row" style={{display:"flex",gap:8,padding:"16px 20px",overflowX:"auto",flexWrap:"wrap"}}>
                  {TABS.map(t=>(
                    <button key={t.id} className="tab-btn"
                      onClick={()=>setTab(t.id)}
                      style={{
                        padding:"10px 18px",borderRadius:20,fontSize:13,fontWeight:600,
                        border:`2px solid ${tab===t.id?rc:"#e2e8f0"}`,
                        background:tab===t.id?rc:"#fff",
                        color:tab===t.id?"#fff":"#64748b",
                        cursor:"pointer",whiteSpace:"nowrap",fontFamily:"inherit",
                        boxShadow:tab===t.id?`0 4px 12px ${rc}44`:"none",
                      }}>
                      {t.label}{t.id==="reports"&&reps.length>0?` (${reps.length})`:""}
                    </button>
                  ))}
                </div>
              </div>

              {/* Tab content */}
              <div className="tab-content" style={{padding:"24px 28px 32px"}}>

                {/* ── FEEL ── */}
                {tab==="feel" && (
                  <div>
                    <div style={{background:rc+"0d",border:`1px solid ${rc}22`,borderRadius:14,padding:"16px 20px",marginBottom:24}}>
                      <div style={{fontSize:11,color:rc,fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:8}}>Based on documented reports at comparable facilities</div>
                      <p style={{fontSize:14,color:"#374151",lineHeight:1.75,margin:0}}>Every symptom below has been reported by real people living near data centers of this scale — from lawsuits, news investigations, and community testimonies across the US and internationally.</p>
                    </div>
                    <div className="symptom-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                      {symptoms.map((s,i)=>(
                        <div key={i} className="symptom-card" style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,padding:"20px",boxShadow:"0 2px 8px rgba(0,0,0,0.05)"}}>
                          <div style={{fontSize:32,marginBottom:10}}>{s.e}</div>
                          <div style={{fontSize:15,fontWeight:700,color:"#0f172a",marginBottom:4}}>{s.t}</div>
                          <SevBar level={s.s} color={rc} />
                          <p style={{fontSize:13,color:"#64748b",lineHeight:1.75,margin:"10px 0 0"}}>{s.d}</p>
                        </div>
                      ))}
                    </div>
                    <p style={{fontSize:12,color:"#94a3b8",marginTop:16,fontStyle:"italic",lineHeight:1.6}}>Severity bars show frequency of reporting at comparable facilities. Individual experience depends on distance, building construction, terrain, and personal sensitivity.</p>
                  </div>
                )}

                {/* ── QUIZ ── */}
                {tab==="quiz" && (
                  <div>
                    <h3 style={{fontSize:20,fontWeight:800,color:"#0f172a",marginBottom:8}}>Your Personal Risk Assessment</h3>
                    <p style={{fontSize:14,color:"#64748b",marginBottom:24,lineHeight:1.7}}>Answer five questions to receive a personalized assessment based on your proximity and household situation.</p>
                    {qRes ? (
                      <div>
                        <div style={{background:(RISK_C[qRes.level]||"#64748b")+"0d",border:`1px solid ${(RISK_C[qRes.level]||"#64748b")}22`,borderRadius:16,padding:"24px",marginBottom:16}}>
                          <div style={{fontSize:11,color:"#64748b",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:10}}>Your Personal Risk Level</div>
                          <div style={{fontSize:48,fontWeight:800,color:RISK_C[qRes.level]||"#64748b",fontFamily:"'Impact',sans-serif",marginBottom:14,letterSpacing:"-0.01em"}}>{qRes.level}</div>
                          <p style={{fontSize:14,color:"#374151",lineHeight:1.8,marginBottom:20}}>{qRes.advice}</p>
                          <div style={{fontSize:11,color:"#94a3b8",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>Why this rating:</div>
                          {qRes.flags.map((f,i)=>(
                            <div key={i} style={{fontSize:13,color:"#374151",padding:"7px 0",borderBottom:i<qRes.flags.length-1?"1px solid #f1f5f9":"none",lineHeight:1.6}}>— {f}</div>
                          ))}
                        </div>
                        <button onClick={()=>{setQStep(0);setQRes(null);setQAns({});}}
                          style={{padding:"10px 22px",borderRadius:10,border:`1px solid ${rc}`,background:"transparent",color:rc,fontSize:13,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>
                          ↩ Retake Quiz
                        </button>
                      </div>
                    ):(
                      <div>
                        <div style={{fontSize:12,color:"#94a3b8",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:14}}>Question {qStep+1} of {QUIZ.length}</div>
                        <div style={{background:"#f8fafc",borderRadius:14,padding:"24px",marginBottom:16}}>
                          <p style={{fontSize:16,color:"#0f172a",fontWeight:600,marginBottom:20,lineHeight:1.5}}>{QUIZ[qStep].q}</p>
                          {QUIZ[qStep].o.map(opt=>(
                            <button key={opt} className="quiz-opt"
                              onClick={()=>{
                                const a={...qAns,[QUIZ[qStep].k]:opt};
                                setQAns(a);
                                if(qStep<QUIZ.length-1) setQStep(s=>s+1);
                                else setQRes(calcQuiz(a));
                              }}
                              style={{display:"block",width:"100%",padding:"14px 18px",borderRadius:10,border:"1px solid #e2e8f0",background:"#fff",color:"#374151",fontSize:14,cursor:"pointer",textAlign:"left",marginBottom:8,fontFamily:"inherit",fontWeight:500,boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>
                              {opt}
                            </button>
                          ))}
                        </div>
                        <div style={{height:6,background:"#e2e8f0",borderRadius:3}}>
                          <div style={{height:6,width:`${(qStep/QUIZ.length)*100}%`,background:`linear-gradient(90deg,${rc},#f97316)`,borderRadius:3,transition:"width 0.4s ease"}} />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ── LONG TERM HEALTH ── */}
                {tab==="health" && (
                  <div>
                    <div style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:14,padding:"16px 20px",marginBottom:20}}>
                      <div style={{fontSize:11,color:"#ef4444",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:8}}>⚠ Long-Term Health Risks</div>
                      <p style={{fontSize:14,color:"#7f1d1d",lineHeight:1.75,margin:0}}>A 2025 study estimated data center pollution causes a public health burden of over $20 billion annually by 2030. Click any risk to read the full explanation.</p>
                    </div>
                    {LONGTERM.map((r,i)=>(
                      <div key={i} style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,marginBottom:10,overflow:"hidden",boxShadow:"0 1px 6px rgba(0,0,0,0.04)"}}>
                        <div className="accordion-header" style={{padding:"18px 22px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}}
                          onClick={()=>setXLong(xLong===i?null:i)}>
                          <div style={{display:"flex",gap:14,alignItems:"center"}}>
                            <span style={{fontSize:26}}>{r.e}</span>
                            <div>
                              <div style={{fontSize:15,fontWeight:700,color:"#0f172a",marginBottom:3}}>{r.t}</div>
                              <div style={{fontSize:13,color:"#64748b",lineHeight:1.4}}>{r.sh}</div>
                            </div>
                          </div>
                          <div style={{fontSize:22,color:"#94a3b8",fontWeight:300,flexShrink:0,marginLeft:12}}>{xLong===i?"−":"+"}</div>
                        </div>
                        {xLong===i && (
                          <div style={{padding:"0 22px 22px",borderTop:"1px solid #f1f5f9"}}>
                            <p style={{fontSize:14,color:"#374151",lineHeight:1.85,margin:"16px 0"}}>{r.lo}</p>
                            <div style={{background:r.c+"0d",border:`1px solid ${r.c}22`,borderRadius:10,padding:"14px 18px"}}>
                              <div style={{fontSize:13,color:r.c,fontWeight:600,marginBottom:4}}>📊 {r.stat}</div>
                              <div style={{fontSize:11,color:"#94a3b8",fontStyle:"italic"}}>Source: {r.src}</div>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* ── KIDS ── */}
                {tab==="kids" && (
                  <div>
                    <div style={{background:"#fffbeb",border:"1px solid #fde68a",borderRadius:14,padding:"16px 20px",marginBottom:20}}>
                      <div style={{fontSize:11,color:"#d97706",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:8}}>👧 Why Children Are More Vulnerable</div>
                      <p style={{fontSize:14,color:"#78350f",lineHeight:1.75,margin:0}}>Children breathe more air per pound of body weight, sleep longer, and have developing systems that are more sensitive to environmental disruption than adults.</p>
                    </div>
                    {KIDS.map((k,i)=>(
                      <div key={i} style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,marginBottom:10,overflow:"hidden",boxShadow:"0 1px 6px rgba(0,0,0,0.04)"}}>
                        <div className="accordion-header" style={{padding:"18px 22px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}}
                          onClick={()=>setXKid(xKid===i?null:i)}>
                          <div style={{display:"flex",gap:14,alignItems:"center"}}>
                            <span style={{fontSize:26}}>{k.e}</span>
                            <div>
                              <div style={{fontSize:15,fontWeight:700,color:"#0f172a",marginBottom:4}}>{k.t}</div>
                              <Chip label={k.sev} color={k.c} small />
                            </div>
                          </div>
                          <div style={{fontSize:22,color:"#94a3b8",fontWeight:300,flexShrink:0,marginLeft:12}}>{xKid===i?"−":"+"}</div>
                        </div>
                        {xKid===i && (
                          <div style={{padding:"0 22px 22px",borderTop:"1px solid #f1f5f9"}}>
                            <p style={{fontSize:14,color:"#374151",lineHeight:1.85,margin:"16px 0 0"}}>{k.d}</p>
                          </div>
                        )}
                      </div>
                    ))}
                    <div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:14,padding:"18px 20px",marginTop:8}}>
                      <div style={{fontSize:11,color:"#15803d",fontWeight:700,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:12}}>What Parents Are Demanding</div>
                      {["Mandatory independent EMF and air quality monitoring before and after construction","Minimum setback requirements from schools, daycare centers, and playgrounds","Real-time public air quality data near each facility","Advance notice of generator test schedules so parents can keep children indoors","Community right-to-know reporting on all emission events"].map((p,i)=>(
                        <div key={i} style={{display:"flex",gap:10,padding:"7px 0",borderBottom:i<4?"1px solid #dcfce7":"none"}}>
                          <span style={{color:"#15803d",fontWeight:700,flexShrink:0}}>→</span>
                          <div style={{fontSize:13,color:"#166534",lineHeight:1.6}}>{p}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── NUMBERS ── */}
                {tab==="numbers" && (
                  <div className="numbers-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                    {[
                      {label:"Power Draw",value:dc.Power_MW>=1000?`${(dc.Power_MW/1000).toFixed(1)} GW`:`${dc.Power_MW||"?"}MW`,plain:dc.Power_MW?`Enough to power ${fmt(Math.round(dc.Power_MW*1000/1.25))} average homes — continuously, 24 hours a day, 365 days a year.`:"Power data pending verification.",color:rc},
                      {label:"CO₂ Per Year",value:dc.CO2_Tons_Year>0?`${fmt(dc.CO2_Tons_Year)} tons`:"Near zero",plain:dc.CO2_Tons_Year>0?`Same as ${fmt(Math.round(dc.CO2_Tons_Year/4.6))} cars driven for a full year.`:"Powered by renewable energy — very low carbon footprint.",color:dc.CO2_Tons_Year>200000?"#ef4444":"#10b981"},
                      {label:"Water Per Day",value:dc.Water_Gal_Day>0?`${fmt(dc.Water_Gal_Day)} gal`:"Near zero",plain:dc.Water_Gal_Day>0?`Same daily water use as ${fmt(Math.round(dc.Water_Gal_Day/80))} households. Permanently removed from the local water cycle.`:"Air-cooled design — minimal water consumption.",color:dc.Water_Gal_Day>500000?"#ef4444":"#10b981"},
                      {label:"Perimeter Noise",value:`${dc.Noise_DB||"?"} dB`,plain:dc.Noise_DB>=70?"Like a vacuum cleaner running nonstop — including 2am. Low-frequency components travel further than this number suggests.":"Moderate but continuous. Low-frequency components penetrate walls.",color:dc.Noise_DB>=70?"#ef4444":dc.Noise_DB>=60?"#f97316":"#3b82f6"},
                      {label:"EMF at Fence",value:`up to ${dc.EMF_Fence_High||"?"}mG`,plain:dc.EMF_Fence_High>=4?"Studies link childhood leukemia risk starting at 3–4 mG. The legal US limit is 2,000 mG — legal does not mean safe.":"Below the 3–4 mG epidemiological concern threshold at the fence line.",color:dc.EMF_Fence_High>=4?"#ef4444":"#10b981"},
                      {label:"EMF at 100m",value:`~${dc.EMF_100m||"?"} mG`,plain:dc.EMF_100m>=3?"Still above the level linked to childhood leukemia risk. Take seriously if you live within 100m of the substation.":dc.EMF_100m>=1?"In the zone where a 2026 cohort study found health associations.":"Below precautionary thresholds at this distance.",color:dc.EMF_100m>=3?"#ef4444":dc.EMF_100m>=1?"#f97316":"#10b981"},
                    ].map(s=>(
                      <div key={s.label} style={{background:"#fff",border:`2px solid ${s.color}22`,borderRadius:14,padding:"20px",boxShadow:"0 2px 12px rgba(0,0,0,0.05)"}}>
                        <div style={{fontSize:11,color:"#94a3b8",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:10}}>{s.label}</div>
                        <div style={{fontSize:28,fontWeight:800,color:s.color,marginBottom:10,fontFamily:"'Impact',sans-serif",letterSpacing:"-0.01em"}}>{s.value}</div>
                        <p style={{fontSize:13,color:"#64748b",lineHeight:1.65,margin:0}}>{s.plain}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* ── WHAT TO DO ── */}
                {tab==="act" && (
                  <div>
                    <h3 style={{fontSize:20,fontWeight:800,color:"#0f172a",marginBottom:8}}>You're Not Powerless</h3>
                    <p style={{fontSize:14,color:"#64748b",marginBottom:24,lineHeight:1.7}}>Every data center regulation that exists was won by residents who organized, documented, and demanded accountability. Here's where to start.</p>
                    {[
                      {e:"📋",t:"Document everything — starting today",c:"#ef4444",steps:["Write down symptoms: headaches, sleep issues, dizziness, ear ringing, anxiety. Include dates and times.","Note when you smell diesel exhaust — likely a generator test. Record date, time, wind direction, duration.","Photograph or video any visible smoke or unusual emissions.","Keep a log — even a phone notes app. Patterns matter more than any single data point."]},
                      {e:"📣",t:"File formal complaints",c:"#f97316",steps:["Contact your city or county zoning board — data center noise falls under industrial use permits.","File with your state or provincial environmental agency (search '[your state] Department of Environmental Quality').","File with your national environmental protection body for air quality concerns.","Contact your elected representative in writing — a paper trail matters."]},
                      {e:"📡",t:"Request independent monitoring",c:"#eab308",steps:["Request an independent EMF survey of your property from a certified environmental health firm.","Ask your local health department to monitor air quality near the facility.","If a school is nearby, contact the school board — they have legal standing to demand environmental assessments."]},
                      {e:"👥",t:"Organize with neighbors",c:"#8b5cf6",steps:["One complaint is easier to ignore than fifty. Start a neighborhood group or find existing local advocacy groups.","Coalitions in Prince William County VA and Loudoun County VA have successfully pushed back on data center ordinances.","Earthjustice (earthjustice.org) and the Environmental Defense Fund have resources for impacted communities."]},
                      {e:"🏠",t:"Protect your family right now",c:"#3b82f6",steps:["Keep windows closed on generator test days — often monthly. Request the facility's test schedule in writing.","Air purifiers with HEPA filtration reduce indoor PM2.5 from diesel exhaust.","Speak with your doctor about any symptoms — getting them on medical record matters if legal action is ever needed.","White noise machines can help mask low-frequency intrusion for better sleep."]},
                    ].map((s,i)=>(
                      <div key={i} style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,overflow:"hidden",marginBottom:12,boxShadow:"0 1px 6px rgba(0,0,0,0.04)"}}>
                        <div style={{padding:"16px 22px",borderBottom:"1px solid #f1f5f9",display:"flex",alignItems:"center",gap:10}}>
                          <span style={{fontSize:22}}>{s.e}</span>
                          <div style={{fontSize:15,fontWeight:700,color:"#0f172a"}}>{s.t}</div>
                        </div>
                        {s.steps.map((step,j)=>(
                          <div key={j} style={{display:"flex",gap:12,padding:"12px 22px",borderBottom:j<s.steps.length-1?"1px solid #f8fafc":"none",alignItems:"flex-start"}}>
                            <div style={{width:24,height:24,borderRadius:"50%",background:s.c+"18",color:s.c,fontSize:11,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}>{j+1}</div>
                            <div style={{fontSize:13,color:"#374151",lineHeight:1.7}}>{step}</div>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}

                {/* ── COMMUNITY REPORTS ── */}
                {tab==="reports" && (
                  <div>
                    <h3 style={{fontSize:20,fontWeight:800,color:"#0f172a",marginBottom:8}}>Community Reports</h3>
                    <p style={{fontSize:14,color:"#64748b",marginBottom:24,lineHeight:1.7}}>One person's symptom diary is anecdote. Three hundred people's diaries near the same facility, all spiking on generator test days, is a public health study. Your report matters.</p>

                    {reps.length===0 && <div style={{fontSize:14,color:"#94a3b8",fontStyle:"italic",marginBottom:24,padding:"16px 0"}}>No reports yet for this facility. Be the first to share your experience.</div>}

                    {reps.map((r,i)=>(
                      <div key={i} style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:14,padding:"18px 20px",marginBottom:10,boxShadow:"0 1px 6px rgba(0,0,0,0.04)"}}>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                          <span style={{fontSize:13,fontWeight:700,color:rc}}>{r.Reporter||"Anonymous"}</span>
                          <span style={{fontSize:12,color:"#94a3b8"}}>{r.Date_Submitted}</span>
                        </div>
                        <p style={{fontSize:14,color:"#374151",lineHeight:1.8,margin:0}}>{r.Report_Text}</p>
                      </div>
                    ))}

                    <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:16,padding:"24px",boxShadow:"0 2px 12px rgba(0,0,0,0.06)"}}>
                      <div style={{fontSize:13,fontWeight:700,color:"#0f172a",marginBottom:16,textTransform:"uppercase",letterSpacing:"0.06em"}}>Add Your Report</div>
                      {sent ? (
                        <div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:12,padding:"18px"}}>
                          <div style={{fontSize:15,fontWeight:700,color:"#15803d",marginBottom:4}}>✓ Report submitted — thank you</div>
                          <div style={{fontSize:13,color:"#166534",lineHeight:1.6}}>Your report will be reviewed and published shortly. Community data like yours builds the evidence base for regulatory action.</div>
                          <button onClick={()=>setSent(false)} style={{marginTop:12,fontSize:12,padding:"8px 16px",borderRadius:8,border:"1px solid #bbf7d0",background:"transparent",color:"#15803d",cursor:"pointer",fontFamily:"inherit"}}>Submit another</button>
                        </div>
                      ):(
                        <>
                          <input value={repName} onChange={e=>setRepName(e.target.value)} placeholder="Your name or Anonymous"
                            style={{width:"100%",padding:"12px 16px",borderRadius:10,border:"1px solid #e2e8f0",fontSize:14,marginBottom:10,boxSizing:"border-box",outline:"none",fontFamily:"inherit",color:"#1e293b"}} />
                          <textarea value={draft} onChange={e=>setDraft(e.target.value)} rows={5}
                            placeholder="What do you notice? Sounds, smells, symptoms, health changes since the facility opened. Any detail — however small — is useful."
                            style={{width:"100%",padding:"12px 16px",borderRadius:10,border:"1px solid #e2e8f0",fontSize:14,resize:"vertical",outline:"none",boxSizing:"border-box",fontFamily:"inherit",lineHeight:1.7,color:"#1e293b"}} />
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:14,gap:12,flexWrap:"wrap"}}>
                            <button onClick={sendReport} disabled={sending||!draft.trim()}
                              style={{padding:"13px 30px",borderRadius:10,border:"none",background:draft.trim()?rc:"#e2e8f0",color:draft.trim()?"#fff":"#94a3b8",fontSize:14,fontWeight:700,cursor:draft.trim()?"pointer":"default",fontFamily:"inherit",transition:"all 0.2s",boxShadow:draft.trim()?`0 4px 16px ${rc}44`:"none"}}>
                              {sending?"Submitting…":"Submit Report"}
                            </button>
                            <div style={{fontSize:11,color:"#94a3b8",maxWidth:280,lineHeight:1.5}}>Reports are reviewed before publishing. Anonymous reporting available. Data supports regulatory filings.</div>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}

              </div>
            </Card>
          )}
        </main>

        {/* ══════════════════════════════════════════════════
            FOOTER
        ══════════════════════════════════════════════════ */}
        <footer style={{background:"#0f172a",color:"#475569",textAlign:"center",padding:"32px 24px",fontSize:13,lineHeight:1.8}}>
          <div style={{
            fontFamily:"'Impact',sans-serif",fontSize:20,
            letterSpacing:"0.08em",marginBottom:8,
            background:"linear-gradient(90deg,#ef4444,#f97316)",
            WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",
          }}>HUMZONES</div>
          <div style={{color:"#475569"}}>Global Data Center Health Registry</div>
          <div style={{marginTop:6,color:"#334155",fontSize:12}}>
            Sources: Epoch AI (CC-BY) · EH Sciences · IARC / WHO · US News · arXiv 2025
          </div>
          <div style={{marginTop:6,color:"#334155",fontSize:12}}>
            © 2026 HumZones · humzones.com · Built for residents, not the industry
          </div>
        </footer>

      </div>
    </>
  );
}
