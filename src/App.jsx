import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";

/* ------------------------------------------------------------------ *
 * TTX Live
 *
 * Each business unit joins with its own code, so the code decides the
 * unit. Multiple choice is scored on correctness and speed; essay
 * questions fall through to facilitator scoring.
 * ------------------------------------------------------------------ */

/* Bumping this version invalidates every stored session. A leftover
   session from an older build was the cause of the white screens. */
const V = "v3";
const BUILD = "b15";  // shown in the corner so you can confirm what is deployed
const K_HOST = `ttx:${V}:host`;
const K_ME = `ttx:${V}:me`;
const K_KEY = `ttx:${V}:key`;

/* The facilitator lives at /host. Participants never see a link to it. */
const isHostRoute = () =>
  /^\/host\/?$/i.test(location.pathname) || /^#\/?host$/i.test(location.hash);

const ROLE_COLORS = ["#2E5EAA", "#B5442E", "#5A7A2E", "#7A4B8F", "#B07A16", "#2A7A72", "#8F3A5C", "#43506B"];
const SCORE_LABELS = ["Not addressed", "Partial", "Adequate", "Strong"];
const DECISION_OPTS = [
  { k: "reached", label: "Decided", color: "#2A7A72" },
  { k: "deferred", label: "Deferred", color: "#B07A16" },
  { k: "none", label: "No decision", color: "#B5442E" },
  { k: "na", label: "N/A", color: "#6B7671" },
];
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const rand = (n = 4) => Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * 32)]).join("");
const fmt = (s) => `${String(Math.floor((s || 0) / 60)).padStart(2, "0")}:${String(Math.floor(s || 0) % 60).padStart(2, "0")}`;

/* Wipe every key from any previous build, not just the current one. */
function nukeAll() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("ttx:"))
      .forEach((k) => localStorage.removeItem(k));
  } catch (e) { /* private mode */ }
}
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } };

/* ---------------------------- transport ---------------------------- */

/* True once the answering window has closed. Recomputed on a tick so the
   UI locks itself rather than relying on the server to refuse a tap. */
function useExpired(openedAt, limit, active) {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!active || !limit || !openedAt) { setOver(false); return; }
    const check = () => setOver(Date.now() - openedAt >= limit * 1000);
    check();
    const iv = setInterval(check, 250);
    return () => clearInterval(iv);
  }, [openedAt, limit, active]);
  return over;
}

function useSocket(onMessage) {
  const ws = useRef(null);
  const handler = useRef(onMessage);
  const queue = useRef([]);
  const [status, setStatus] = useState("connecting");
  /* Bumped on every successful open. A reconnect gives the server a brand new
     socket with no room attached, so whoever owns the session has to re-register
     or they silently stop receiving phase changes. */
  const [gen, setGen] = useState(0);
  handler.current = onMessage;

  useEffect(() => {
    let closed = false, retry = 0, timer;
    const open = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const sock = new WebSocket(`${proto}//${location.host}/ws`);
      ws.current = sock;
      sock.onopen = () => {
        retry = 0; setStatus("live");
        queue.current.splice(0).forEach((m) => sock.send(JSON.stringify(m)));
        setGen((g) => g + 1);
      };
      sock.onmessage = (e) => {
        try { handler.current?.(JSON.parse(e.data)); } catch (err) { /* junk */ }
      };
      sock.onclose = () => {
        if (closed) return;
        setStatus("reconnecting");
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(open, 400 * 2 ** retry);
      };
      sock.onerror = () => sock.close();
    };
    open();
    return () => { closed = true; clearTimeout(timer); ws.current?.close(); };
  }, []);

  const send = useCallback((msg) => {
    if (ws.current?.readyState === 1) ws.current.send(JSON.stringify(msg));
    else queue.current.push(msg);
  }, []);

  return { send, status, gen };
}

/* ---------------------------- parsing ---------------------------- */

const HEADER_ALIASES = {
  inject: "inject", injectno: "inject", injectnumber: "inject", injectnum: "inject",
  no: "inject", nomor: "inject", nomorinject: "inject",
  condition: "condition", kondisi: "condition", skenario: "condition",
  scenario: "condition", situation: "condition", situasi: "condition",
  peran: "peran", role: "peran", roles: "peran", unit: "peran",
  businessunit: "peran", bu: "peran", audience: "peran", target: "peran",
  siklus: "siklus", cycle: "siklus", phase: "siklus", fase: "siklus",
  round: "siklus", babak: "siklus", tahap: "siklus",
  question: "question", pertanyaan: "question", q: "question", prompt: "question",
  answer: "answer", jawaban: "answer", expectedanswer: "answer",
  jawabanyangdiharapkan: "answer", kuncijawaban: "answer", key: "answer",
  window: "window", windowmin: "window", waktu: "window",
  decisionwindow: "window", bataswaktu: "window", windowminutes: "window",
};
const normKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
/* Split only on unambiguous list separators. "&", "/", "dan" and "and" all
   appear inside real unit names — "Hukum & Kepatuhan" is one unit, not two. */
const splitPeran = (v) => [...new Set(
  String(v || "").split(/[,;|]|\r?\n/).map((s) => s.trim()).filter(Boolean)
)];

function detectAnswerType(raw) {
  const t = String(raw || "").trim();
  if (!t) return "open";
  const lines = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const bare = lines.map((l) => l.replace(/^\s*\*+\s*/, ""));
  if (bare.filter((s) => /^(?:[A-Ea-e][.)]|[1-6][.)])\s+\S/.test(s)).length >= 2) return "choice";
  const parts = t.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2 && parts.every((p) => p.split(/\s+/).length <= 5)) return "keywords";
  return "open";
}
const parseChoices = (raw) => String(raw || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  .map((s) => ({
    /* strip the correct-marker first, then the A./1) prefix — the other
       order leaves the letter in the text and the UI renders it twice */
    text: s
      .replace(/^\s*\*+\s*/, "").replace(/\s*\*+\s*$/, "")
      .replace(/\(correct\)|\[x\]/gi, "")
      .replace(/^\s*(?:[A-Ea-e][.)]|[1-6][.)])\s*/, "")
      .trim(),
    correct: /^\s*\*|\*\s*$|\(correct\)|\[x\]/i.test(s),
  }));
const parseKeywords = (raw) => String(raw || "").split(/[;,]|\r?\n/).map((s) => s.trim()).filter(Boolean);

function buildModel(rows) {
  if (!rows.length) return { injects: [], roles: [], warnings: ["The sheet has no rows."] };
  const hmap = {};
  Object.keys(rows[0]).forEach((k) => {
    const hit = HEADER_ALIASES[normKey(k)];
    if (hit && !hmap[hit]) hmap[hit] = k;
  });
  const warnings = [];
  ["inject", "peran", "question"].forEach((f) => {
    if (!hmap[f]) warnings.push(`No column matched "${f}". Check the header row spelling.`);
  });
  const get = (row, f) => (hmap[f] ? String(row[hmap[f]] ?? "").trim() : "");

  let lastInject = "", lastCondition = "", lastSiklus = "", lastWindow = "";
  const flat = [];
  rows.forEach((row, i) => {
    const rawInject = get(row, "inject");
    const inject = rawInject || lastInject;
    if (rawInject) { lastInject = rawInject; lastCondition = ""; lastWindow = ""; }
    if (get(row, "condition")) lastCondition = get(row, "condition");
    if (get(row, "siklus")) lastSiklus = get(row, "siklus");
    if (get(row, "window")) lastWindow = get(row, "window");
    const question = get(row, "question");
    const peranRaw = get(row, "peran");
    if (!question && !peranRaw && !inject) return;
    flat.push({
      srcRow: i + 2, inject: inject || "(unnumbered)",
      condition: get(row, "condition") || lastCondition,
      siklus: get(row, "siklus") || lastSiklus || "(no siklus)",
      window: get(row, "window") || lastWindow,
      question, answer: get(row, "answer"), roles: splitPeran(peranRaw),
    });
  });

  const roles = [];
  flat.forEach((r) => r.roles.forEach((x) => { if (!roles.includes(x)) roles.push(x); }));

  const byInject = new Map();
  let noKey = 0;
  flat.forEach((r) => {
    if (!byInject.has(r.inject)) {
      byInject.set(r.inject, { id: r.inject, siklus: r.siklus, window: r.window, conditions: [], questions: [] });
    }
    const inj = byInject.get(r.inject);
    if (r.condition && !inj.conditions.includes(r.condition)) inj.conditions.push(r.condition);
    if (!inj.window && r.window) inj.window = r.window;
    if (!r.question) return;
    const type = detectAnswerType(r.answer);
    const choices = type === "choice" ? parseChoices(r.answer) : [];
    if (type === "choice" && !choices.some((c) => c.correct)) noKey += 1;
    (r.roles.length ? r.roles : ["(untargeted)"]).forEach((peran, k) => {
      inj.questions.push({
        qid: `${r.inject}::${peran}::${r.srcRow}::${k}`,
        peran, text: r.question, answerRaw: r.answer, type, choices,
        keywords: type === "keywords" ? parseKeywords(r.answer) : [],
      });
    });
  });

  const num = (s) => { const m = String(s).match(/\d+/); return m ? parseInt(m[0], 10) : 9999; };
  const injects = [...byInject.values()].map((inj) => {
    const rs = [];
    inj.questions.forEach((q) => { if (!rs.includes(q.peran)) rs.push(q.peran); });
    return { ...inj, roles: rs, condition: inj.conditions[0] || "", splitNarrative: inj.conditions.length > 1 };
  }).sort((a, b) => num(a.siklus) - num(b.siklus) || num(a.id) - num(b.id));

  const mc = injects.flatMap((i) => i.questions).filter((q) => q.type === "choice").length;
  if (noKey > 0) {
    warnings.push(`${noKey} multiple-choice question${noKey > 1 ? "s have" : " has"} no correct option marked. Put * at the start of the right answer, or those questions score zero.`);
  }
  injects.forEach((i) => {
    if (i.splitNarrative) warnings.push(`Inject ${i.id} has more than one Condition. Only the first is shown.`);
    if (!i.condition) warnings.push(`Inject ${i.id} has no Condition text.`);
  });
  return { injects, roles, warnings, mcCount: mc };
}

const SAMPLE = [
  { "Inject No.": "1", Siklus: "Siklus 1 - Detection", Window: "10", Condition: "At 02:14 the SOC monitoring tool raises a burst of failed authentications against the core banking admin portal, originating from an internal subnet assigned to a third-party maintenance vendor. The on-call analyst has not yet escalated.", Peran: "SOC, IT Operations", Question: "What is your first action in the next 15 minutes?", Answer: "A. Wait for a second alert before acting\n*B. Verify the alert, disable the vendor account, notify the IR lead\nC. Call the vendor and ask what they are doing\nD. Open a ticket and hand over at shift change" },
  { "Inject No.": "", Siklus: "", Condition: "", Peran: "Vendor Management", Question: "Do you have current after-hours contact details and a contractual notification window for this vendor?", Answer: "A. No, we would have to wait for business hours\n*B. Yes, both are in the contract register and reachable now\nC. We have a contact but no defined window" },
  { "Inject No.": "2", Siklus: "Siklus 1 - Detection", Window: "8", Condition: "Thirty minutes later the vendor account is confirmed compromised. Logs show successful access to a database holding customer identity documents. The volume of records touched is not yet known.", Peran: "Risk Management", Question: "Has this crossed your threshold for declaring a major incident?", Answer: "A. Not yet, wait for the record count\n*B. Yes, declare immediately on confirmed unauthorised access to customer data\nC. Escalate to the CISO for a decision" },
  { "Inject No.": "", Siklus: "", Condition: "", Peran: "Legal & Compliance", Question: "What regulatory notification clock has now started?", Answer: "*A. The clock started at confirmation of unauthorised access to personal data\nB. It starts once the record count is final\nC. It starts when the board is briefed" },
  { "Inject No.": "3", Siklus: "Siklus 2 - Response", Window: "12", Condition: "A journalist emails corporate communications at 08:40 asking to confirm a data breach affecting customer identity documents. They cite a post on a criminal forum and want a response within two hours.", Peran: "Corporate Communications, Legal & Compliance", Question: "What goes in the first response?", Answer: "A. A full account of what happened so far\n*B. A holding statement, legally reviewed, from one named spokesperson\nC. No response until the investigation closes" },
  { "Inject No.": "", Siklus: "", Condition: "", Peran: "Executive", Question: "Do you notify the board now or wait for confirmed scope?", Answer: "*A. Now, covering what is known, what is not, and decisions taken\nB. Wait until scope is confirmed\nC. Delegate to the CISO at the next scheduled meeting" },
];

/* ------------------------- crash containment ------------------------- */

class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="crash">
        <h1>Something broke</h1>
        <p className="muted">
          Try clearing first. If it returns immediately, it's a fault in the app
          rather than your device — send this message to whoever runs the exercise.
        </p>
        <pre>{String(this.state.err?.message || this.state.err)}</pre>
        <button className="primary" onClick={() => { nukeAll(); location.reload(); }}>
          Clear and start fresh
        </button>
      </div>
    );
  }
}

/* ================================================================== */

export default function App() {
  const [host, setHost] = useState(isHostRoute());
  useEffect(() => {
    const onPop = () => setHost(isHostRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const leaveHost = () => { history.pushState({}, "", "/"); setHost(false); };

  return (
    <div className="ttx">
      <style>{CSS}</style>
      <Boundary>
        {host ? <Host onExit={leaveHost} /> : <Participant />}
      </Boundary>
    </div>
  );
}

/* ============================== HOST ============================== */

function Host({ onExit }) {
  const [screen, setScreen] = useState("setup"); // setup | config | run | report
  const [roomId, setRoomId] = useState("");
  const [codes, setCodes] = useState({});
  const [draftCodes, setDraftCodes] = useState({});
  const [settings, setSettings] = useState({
    mode: "auto", timeLimit: 60, points: 1000,
    speedBonus: true, showNames: true, showUnits: true, leaderboard: true,
  });
  const [times, setTimes] = useState({});
  const [model, setModel] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [fileName, setFileName] = useState("");
  const [parseError, setParseError] = useState("");
  const [phase, setPhase] = useState("lobby");
  const [activeIdx, setActiveIdx] = useState(0);
  const [openedAt, setOpenedAt] = useState(null);
  const [people, setPeople] = useState([]);
  const [scores, setScores] = useState({});
  const [notes, setNotes] = useState({});
  const [meta, setMeta] = useState({});
  const [revealKey, setRevealKey] = useState({});
  const [roomOpen, setRoomOpen] = useState(false);
  const [confirmNext, setConfirmNext] = useState(false);
  const [booted, setBooted] = useState(false);
  const [keyRequired, setKeyRequired] = useState(false);
  const [keyIn, setKeyIn] = useState(() => lsGet(K_KEY) || "");
  const [denied, setDenied] = useState(false);
  const fileRef = useRef(null);

  const onMsg = useCallback((m) => {
    if (m.t === "hosted") {
      setRoomId(m.roomId); setCodes(m.codes); setSettings(m.settings); setTimes(m.times || {});
      setActiveIdx(m.state.activeIdx); setPhase(m.state.phase);
      setOpenedAt(m.state.openedAt); setScreen("run");
    } else if (m.t === "roster") setPeople(m.people || []);
    else if (m.t === "settings") { setSettings(m.settings); if (m.times) setTimes(m.times); }
    else if (m.t === "hello") setKeyRequired(!!m.keyRequired);
    else if (m.t === "denied") { setDenied(true); lsDel(K_KEY); }
    else if (m.t === "gone") { lsDel(K_HOST); setModel(null); setRoomId(""); setScreen("setup"); }
  }, []);
  const { send, status, gen } = useSocket(onMsg);

  /* re-attach after any reconnect */
  useEffect(() => {
    if (gen > 1 && roomId) send({ t: "rehost", roomId });
  }, [gen, roomId, send]);

  useEffect(() => {
    const s = lsGet(K_HOST);
    if (s?.roomId && s?.model) {
      setRoomId(s.roomId); setModel(s.model); setFileName(s.fileName || "");
      setScores(s.scores || {}); setNotes(s.notes || {}); setMeta(s.meta || {});
      setCodes(s.codes || {}); setSettings(s.settings || settings); setTimes(s.times || {});
      setScreen("run");
      send({ t: "rehost", roomId: s.roomId });
    }
    setBooted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send]);

  useEffect(() => {
    if (!booted || !model || !roomId) return;
    const t = setTimeout(() => {
      lsSet(K_HOST, { roomId, model, fileName, scores, notes, meta, codes, settings, times });
    }, 500);
    return () => clearTimeout(t);
  }, [booted, model, roomId, fileName, scores, notes, meta, codes, settings, times]);

  useEffect(() => {
    if (roomId && screen === "run") send({ t: "state", roomId, activeIdx, phase });
  }, [roomId, screen, activeIdx, phase, send]);

  const roleColor = useCallback((p) => {
    if (!model) return "#43506B";
    const i = model.roles.indexOf(p);
    return ROLE_COLORS[(i < 0 ? model.roles.length : i) % ROLE_COLORS.length];
  }, [model]);

  function loadRows(rows, name) {
    const built = buildModel(rows);
    if (!built.injects.length) { setParseError("No injects found. Check that the header row is the first row."); return; }
    setModel({ injects: built.injects, roles: built.roles });
    setWarnings(built.warnings); setFileName(name); setParseError("");
    setDraftCodes(Object.fromEntries(built.roles.map((r) => [r, rand(4)])));
    setTimes(Object.fromEntries(built.injects.map((i) => [i.id, i.window ? String(Math.round(Number(i.window) * 60)) : ""])));
    setScores({}); setNotes({}); setMeta({}); setActiveIdx(0); setPhase("lobby");
    setScreen("config");
  }

  async function handleFile(file) {
    if (!file) return;
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      loadRows(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" }), file.name);
    } catch (e) {
      setParseError("That file could not be read. Save it as .xlsx or .csv and try again.");
    }
  }

  const start = () => {
    setDenied(false);
    if (keyIn) lsSet(K_KEY, keyIn);
    send({ t: "host", deck: model, settings, codes: draftCodes, times, key: keyIn });
  };

  const setInjectTime = (id, v) => {
    const next = { ...times, [id]: v };
    setTimes(next);
    if (roomId) send({ t: "settings", roomId, times: { [id]: v } });
  };
  const limitOf = (id) => {
    const v = times[id];
    return v === "" || v == null ? settings.timeLimit : Number(v);
  };

  const patchSettings = (patch) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    if (roomId) send({ t: "settings", roomId, settings: patch });
  };

  function endSession() {
    if (roomId) send({ t: "end", roomId });
    lsDel(K_HOST);
    setModel(null); setRoomId(""); setPeople([]); setScreen("setup"); onExit();
  }

  const setScore = (qid, patch) =>
    setScores((s) => ({ ...s, [qid]: { score: null, decision: null, ...(s[qid] || {}), ...patch } }));
  const setIMeta = (id, patch) =>
    setMeta((m) => ({ ...m, [id]: { target: "", decidedAt: null, ...(m[id] || {}), ...patch } }));

  const inject = model?.injects[activeIdx];
  const unitOf = (peran) => {
    if (settings.showUnits) return peran;
    const i = model?.roles.indexOf(peran) ?? -1;
    return `Unit ${i < 0 ? "?" : String.fromCharCode(65 + i)}`;
  };
  const label = (p) => (settings.showNames ? p.name : unitOf(p.peran));

  /* ---- setup ---- */
  if (screen === "setup") {
    return (
      <>
        <Bar left="Facilitator setup" onExit={onExit} exitLabel="Back" conn={status} />
        <main className="load">
          <div className="loadinner">
            <h1>Load your inject sheet</h1>
            <p className="lede">
              One row per question, with <b>Inject No.</b>, <b>Condition</b>, <b>Peran</b>,{" "}
              <b>Siklus</b>, <b>Question</b> and <b>Answer</b>. Optional <b>Window</b> in minutes.
            </p>
            <p className="lede">
              For multiple choice, put each option on its own line in the Answer cell
              (<code>A. …</code> / <code>B. …</code>) and mark the correct one with a
              leading <code>*</code>.
            </p>
            <div className="drop" onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" hidden
                onChange={(e) => handleFile(e.target.files[0])} />
              <button className="primary" onClick={() => fileRef.current?.click()}>Choose a file</button>
              <span className="or">or drop it here</span>
            </div>
            {parseError && <div className="err">{parseError}</div>}
            <button className="link" onClick={() => loadRows(SAMPLE, "sample-exercise")}>
              Load a sample exercise instead
            </button>
          </div>
        </main>
      </>
    );
  }

  /* ---- config ---- */
  if (screen === "config") {
    return (
      <>
        <Bar left="Before you start" onExit={() => setScreen("setup")} exitLabel="Back" conn={status} />
        <main className="load">
          <div className="loadinner wide">
            <h1>Before you start</h1>

            {warnings.length > 0 && (
              <details className="warn open" open>
                <summary>{warnings.length} thing{warnings.length > 1 ? "s" : ""} to check</summary>
                <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </details>
            )}

            <h3>Scoring</h3>
            <div className="setgrid">
              <Toggle label="Mode"
                value={settings.mode}
                opts={[["auto", "Auto (multiple choice)"], ["manual", "Manual (you score)"]]}
                onChange={(v) => patchSettings({ mode: v })} />
              <p className="hint span2">
                Auto scores multiple-choice answers by correctness and speed. Manual keeps
                answers unscored so you grade them after the discussion. Questions with no
                options always fall through to manual.
              </p>

              {settings.mode === "auto" && (
                <>
                  <label className="fld">
                    <span>Points per question</span>
                    <input type="number" min="0" step="100" value={settings.points}
                      onChange={(e) => patchSettings({ points: Number(e.target.value) })} />
                  </label>
                  <label className="fld">
                    <span>Time limit (seconds, 0 for none)</span>
                    <input type="number" min="0" step="5" value={settings.timeLimit}
                      onChange={(e) => patchSettings({ timeLimit: Number(e.target.value) })} />
                  </label>
                  <Check label="Speed bonus" checked={settings.speedBonus}
                    onChange={(v) => patchSettings({ speedBonus: v })}
                    hint="A correct answer earns half the points, plus up to half again for answering early." />
                  <Check label="Reveal automatically when time runs out" checked={settings.autoReveal}
                    onChange={(v) => patchSettings({ autoReveal: v })}
                    hint="Closes answering and moves the room to discussion the moment the clock hits zero." />
                  <Check label="Show leaderboard" checked={settings.leaderboard}
                    onChange={(v) => patchSettings({ leaderboard: v })}
                    hint="Ranking units against each other can make people defensive rather than candid. Off is the safer default for a first exercise." />
                </>
              )}

              <Check label="Show device names" checked={settings.showNames}
                onChange={(v) => patchSettings({ showNames: v })}
                hint="Off hides who was operating the device." />
              <Check label="Show unit names" checked={settings.showUnits}
                onChange={(v) => patchSettings({ showUnits: v })}
                hint="Off replaces every Peran with a neutral label on your screen. Useful when you're projecting and don't want the room to see which unit gave which answer." />
            </div>

            {settings.mode === "auto" && (
              <>
                <h3>Time per inject</h3>
                <p className="hint">
                  Blank uses the {settings.timeLimit}s default. Seeded from the Window column
                  if your sheet has one. Editable during the exercise too.
                </p>
                <ul className="codelist">
                  {model.injects.map((i) => (
                    <li key={i.id}>
                      <span className="cname">
                        <b className="mono">{i.id}</b> {i.siklus}
                      </span>
                      <input className="cinput narrow" type="number" min="0" step="5"
                        placeholder={String(settings.timeLimit)}
                        value={times[i.id] ?? ""}
                        onChange={(e) => setTimes((t) => ({ ...t, [i.id]: e.target.value }))} />
                      <span className="unit">sec</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <h3>Join codes</h3>
            <p className="hint">
              One code per unit. Entering the code puts that device in that unit, so nobody
              picks the wrong one. Edit any code, or generate a new one.
            </p>
            <ul className="codelist">
              {model.roles.map((r) => (
                <li key={r}>
                  <span className="dot" style={{ background: roleColor(r) }} />
                  <span className="cname">{r}</span>
                  <input className="cinput" maxLength={8} value={draftCodes[r] || ""}
                    onChange={(e) => setDraftCodes((d) => ({ ...d, [r]: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") }))} />
                  <button className="ghost" onClick={() => setDraftCodes((d) => ({ ...d, [r]: rand(4) }))}>
                    Random
                  </button>
                </li>
              ))}
            </ul>

            {keyRequired && (
              <>
                <h3>Facilitator passcode</h3>
                <label className="fld">
                  <span>Set by whoever deployed this</span>
                  <input type="password" value={keyIn} autoComplete="off"
                    onChange={(e) => { setKeyIn(e.target.value); setDenied(false); }} />
                </label>
              </>
            )}
            {denied && <div className="err">That passcode was not accepted.</div>}
            <button className="primary big" onClick={start}
              disabled={keyRequired && !keyIn}>Open the room</button>
          </div>
        </main>
      </>
    );
  }

  /* ---- report ---- */
  if (screen === "report") {
    return <Report {...{ model, scores, notes, meta, people, settings, roleColor, fileName, label, unitOf }}
      onBack={() => setScreen("run")} onEnd={endSession} />;
  }

  /* ---- run ---- */
  if (!model || !inject) {
    return (
      <>
        <Bar left="Facilitator setup" onExit={onExit} exitLabel="Back" conn={status} />
        <div className="crash">
          <h1>This session is no longer on the server</h1>
          <p className="muted">It may have expired, or the service restarted without a volume.</p>
          <button className="primary" onClick={() => { nukeAll(); location.reload(); }}>Start fresh</button>
        </div>
      </>
    );
  }

  const answeredBy = (q) => people.filter((p) => p.peran === q.peran && p.answers?.[q.qid]);
  const expected = inject.roles.reduce((a, r) => a + people.filter((p) => p.peran === r).length, 0);
  const allIn = inject.questions.every((q) =>
    people.filter((p) => p.peran === q.peran).every((p) => p.answers?.[q.qid]));

  return (
    <>
      <Bar dark conn={status} onExit={onExit}
        left={<>
          <span className="crumb">{inject.siklus}</span>
          <b className="injno">Inject {inject.id}</b>
          <PhaseSteps phase={phase} onPick={(k) => {
            if (k === "open" && phase !== "open") setOpenedAt(Date.now());
            setPhase(k);
          }} />
        </>}
        right={<>
          <span className="vis">
            <button className={`ghost pill ${settings.showUnits ? "" : "off"}`}
              title={settings.showUnits ? "Hide unit names" : "Show unit names"}
              onClick={() => patchSettings({ showUnits: !settings.showUnits })}>Units</button>
            <button className={`ghost pill ${settings.showNames ? "" : "off"}`}
              title={settings.showNames ? "Hide device names" : "Show device names"}
              onClick={() => patchSettings({ showNames: !settings.showNames })}>Names</button>
          </span>
          <button className="ghost" onClick={() => setRoomOpen(true)}>
            Codes · {people.length}
          </button>
          <button className="ghost" onClick={() => setScreen("report")}>Report</button>
        </>} />

      {roomOpen && (
        <RoomPanel {...{ codes, people, model, roleColor, label, unitOf, settings }}
          onSetting={patchSettings}
          onClose={() => setRoomOpen(false)}
          onLobby={() => { setPhase("lobby"); setRoomOpen(false); }} />
      )}

      <main className="run">
        <aside className="rail">
          <ol className="tl">
            {model.injects.map((inj, i) => {
              const head = i === 0 || model.injects[i - 1].siklus !== inj.siklus;
              const state = i < activeIdx ? "done" : i === activeIdx ? "now" : "next";
              const words = (inj.condition || "").split(/\s+/).slice(0, 5).join(" ");
              return (
                <React.Fragment key={inj.id}>
                  {head && <li className="tlhead">{inj.siklus}</li>}
                  <li className={`tlrow ${state}`}>
                    <button onClick={() => { setActiveIdx(i); setPhase("briefing"); }}>
                      <span className="tldot" aria-hidden="true" />
                      <span className="tlno">{inj.id}</span>
                      <span className="tltext">{words}{words ? "…" : "—"}</span>
                      <span className="tlunits">
                        {inj.roles.slice(0, 5).map((r) => (
                          <i key={r} style={{ background: roleColor(r) }} title={r} />
                        ))}
                      </span>
                    </button>
                  </li>
                </React.Fragment>
              );
            })}
          </ol>
          <div className="tlfoot">
            <span className="mono">{activeIdx + 1}/{model.injects.length}</span>
            <span className="tlprog"><i style={{ width: `${((activeIdx + 1) / model.injects.length) * 100}%` }} /></span>
          </div>
        </aside>

        <section className="stage">
          {phase === "lobby" ? (
            <Lobby {...{ codes, people, model, roleColor, unitOf }} showNames={settings.showNames}
              onBegin={() => setPhase("briefing")} injectId={inject.id} />
          ) : (
            <>
              {inject.condition
                ? <blockquote className="scenario">{inject.condition}</blockquote>
                : <div className="empty">No scenario text for this inject. Brief the room from your notes.</div>}

              <div className="callon">
                <span>Asking</span>
                {inject.roles.map((r) => <span key={r} className="chip" style={{ "--c": roleColor(r) }}>{unitOf(r)}</span>)}
              </div>

              <div className="actbar">
                {phase === "briefing" && (<>
                  <span className="amsg">Scenario is on every device. Read it aloud.</span>
                  {settings.mode === "auto" && (
                    <span className="inlinetime">
                      <input type="number" min="0" step="5" placeholder={String(settings.timeLimit)}
                        value={times[inject.id] ?? ""}
                        onChange={(e) => setInjectTime(inject.id, e.target.value)} />
                      <span className="unit">sec</span>
                    </span>
                  )}
                  <button className="primary" onClick={() => { setOpenedAt(Date.now()); setPhase("open"); }}>
                    Open for answers
                  </button>
                </>)}

                {phase === "open" && (<>
                  {settings.mode === "auto" && limitOf(inject.id) > 0
                    ? <Countdown openedAt={openedAt} limit={limitOf(inject.id)} />
                    : <span className="amsg">Answers are open.</span>}
                  <span className="amsg right">{allIn ? "All units in" : "Waiting on answers"}</span>
                  <button className="primary" onClick={() => setPhase("revealed")}>Reveal answers</button>
                </>)}

                {phase === "revealed" && (<>
                  <span className="amsg">Discuss the answers, then score anything unscored.</span>
                  <button className="ghost" onClick={() => { setOpenedAt(Date.now()); setPhase("open"); }}>
                    Reopen
                  </button>
                </>)}
              </div>

              {phase === "open" && (
                <div className="tracker">
                  {inject.roles.map((r) => {
                    const members = people.filter((p) => p.peran === r);
                    const qs = inject.questions.filter((q) => q.peran === r);
                    const done = members.filter((p) => qs.every((q) => p.answers?.[q.qid]));
                    const pct = members.length ? Math.round((done.length / members.length) * 100) : 0;
                    // finished when their slowest answer for this inject landed
                    const finishedMs = done.length
                      ? Math.max(...done.flatMap((p) => qs.map((q) => p.answers[q.qid]?.ms || 0)))
                      : null;
                    return (
                      <div key={r} className="trow">
                        <span className="dot" style={{ background: roleColor(r) }} />
                        <span className="tname">{unitOf(r)}</span>
                        <span className="tbar"><i style={{ width: `${pct}%`, background: roleColor(r) }} /></span>
                        <span className="tcount">{done.length}/{members.length}</span>
                        {finishedMs != null
                          ? <span className="tdone">{(finishedMs / 1000).toFixed(1)}s</span>
                          : members.length === 0
                            ? <span className="tmiss">not joined</span>
                            : <span className="tmiss">answering</span>}
                      </div>
                    );
                  })}
                </div>
              )}

              {phase === "revealed" && inject.roles.map((peran) => (
                <div key={peran} className="rolegroup">
                  <div className="rolerule" style={{ "--c": roleColor(peran) }}>{unitOf(peran)}</div>
                  {inject.questions.filter((q) => q.peran === peran).map((q) => (
                    <QuestionResult key={q.qid} {...{ q, settings, roleColor, label }}
                      answers={answeredBy(q)}
                      sc={scores[q.qid] || {}}
                      onScore={(patch) => setScore(q.qid, patch)}
                      showExpected={revealKey[q.qid]}
                      toggleExpected={() => setRevealKey((v) => ({ ...v, [q.qid]: !v[q.qid] }))} />
                  ))}
                </div>
              ))}

              {phase === "revealed" && (
                <>
                  <DecisionBar {...{ inject, meta, setIMeta }} />
                  <div className="notes">
                    <label htmlFor={`n-${inject.id}`}>Facilitator notes</label>
                    <textarea id={`n-${inject.id}`} rows={3} value={notes[inject.id] || ""}
                      placeholder="Gaps, arguments, who hesitated, anything that becomes a finding"
                      onChange={(e) => setNotes((n) => ({ ...n, [inject.id]: e.target.value }))} />
                  </div>
                </>
              )}

              <div className="nav">
                <button className="ghost" disabled={activeIdx === 0}
                  onClick={() => { setActiveIdx((i) => i - 1); setPhase("briefing"); setConfirmNext(false); }}>Previous</button>
                {activeIdx < model.injects.length - 1 ? (
                  confirmNext ? (
                    <span className="confirm">
                      <span className="cmsg">Move everyone to inject {model.injects[activeIdx + 1].id}?</span>
                      <button className="ghost" onClick={() => setConfirmNext(false)}>Cancel</button>
                      <button className="primary" onClick={() => {
                        setActiveIdx((i) => i + 1); setPhase("briefing"); setConfirmNext(false);
                      }}>Yes, move on</button>
                    </span>
                  ) : (
                    <button className="primary" onClick={() => setConfirmNext(true)}>Next inject</button>
                  )
                ) : (
                  <button className="primary" onClick={() => setScreen("report")}>Finish</button>
                )}
              </div>
            </>
          )}
        </section>
      </main>
    </>
  );
}

/* --------------------------- host pieces --------------------------- */

function Countdown({ openedAt, limit, big }) {
  const [left, setLeft] = useState(limit);
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, limit - (Date.now() - (openedAt || Date.now())) / 1000));
    tick();
    const iv = setInterval(tick, 200);
    return () => clearInterval(iv);
  }, [openedAt, limit]);
  const frac = limit ? left / limit : 0;
  const cls = left <= 10 ? "urgent" : left <= limit * 0.34 ? "warn" : "";
  return (
    <div className={`cd ${cls} ${big ? "big" : ""}`}>
      <span className="cdnum">{fmt(Math.ceil(left))}</span>
      <span className="cdbar"><i style={{ width: `${frac * 100}%` }} /></span>
    </div>
  );
}

function Lobby({ codes, people, model, roleColor, unitOf, showNames, onBegin, injectId }) {
  const joined = people.length;
  return (
    <div className="lobby">
      <div className="lobbyhead">
        <div>
          <h2>Waiting room</h2>
          <p className="muted">Each unit joins with its own code, on one device.</p>
        </div>
        <div className="joincount">
          <b>{joined}</b><span>{joined === 1 ? "device in" : "devices in"}</span>
        </div>
      </div>

      <ul className="codegrid">
        {model.roles.map((r) => {
          const code = Object.keys(codes).find((c) => codes[c] === r);
          const members = people.filter((p) => p.peran === r);
          return (
            <li key={r} className={members.length ? "in" : ""} style={{ "--c": roleColor(r) }}>
              <span className="cgunit">{unitOf(r)}</span>
              <b className="cgcode">{code}</b>
              <span className="cgwho">
                {members.length === 0
                  ? "not joined yet"
                  : showNames
                    ? members.map((m) => m.name).join(", ")
                    : `${members.length} device${members.length > 1 ? "s" : ""} joined`}
              </span>
            </li>
          );
        })}
      </ul>

      <button className="primary big" onClick={onBegin}>
        {injectId ? `Continue to inject ${injectId}` : "Begin the exercise"}
      </button>
      {joined === 0 && (
        <p className="hint">
          You can start with nobody in. Anyone joining later picks up wherever you are.
        </p>
      )}
    </div>
  );
}

function RoomPanel({ codes, people, model, roleColor, label, unitOf, settings, onSetting, onClose, onLobby }) {
  useEffect(() => {
    const esc = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  return (
    <div className="scrim" onClick={onClose}>
      <aside className="panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Codes and devices">
        <div className="phead">
          <h2>Codes &amp; devices</h2>
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
        <p className="hint">
          Late arrivals can join at any point. They pick up from the current inject.
        </p>
        <ul className="codelist big">
          {model.roles.map((r) => {
            const code = Object.keys(codes).find((c) => codes[c] === r);
            const members = people.filter((p) => p.peran === r);
            return (
              <li key={r}>
                <span className="dot" style={{ background: roleColor(r) }} />
                <span className="cname">{unitOf(r)}</span>
                <b className="bigcode">{code}</b>
                <span className={members.length ? "tin" : "tmiss"}>
                  {members.length === 0
                    ? "waiting"
                    : settings.showNames
                      ? members.map((m) => m.name).join(", ")
                      : `${members.length} joined`}
                </span>
              </li>
            );
          })}
        </ul>
        <h3>On-screen display</h3>
        <label className="chk">
          <input type="checkbox" checked={settings.showUnits}
            onChange={(e) => onSetting({ showUnits: e.target.checked })} />
          <span><b>Unit names</b><em>Off shows Unit A, Unit B instead of the real Peran.</em></span>
        </label>
        <label className="chk">
          <input type="checkbox" checked={settings.showNames}
            onChange={(e) => onSetting({ showNames: e.target.checked })} />
          <span><b>Device names</b><em>Off hides who is operating each device.</em></span>
        </label>

        <button className="ghost wide" onClick={onLobby}>Back to the waiting room</button>
        <p className="hint">
          Sends every device back to standby. Your scores and notes are kept.
        </p>
      </aside>
    </div>
  );
}

function QuestionResult({ q, answers, settings, sc, onScore, showExpected, toggleExpected, label }) {
  const isAuto = settings.mode === "auto" && q.type === "choice";
  const correctIdx = q.choices?.findIndex((c) => c.correct);

  const dist = useMemo(() => {
    if (!q.choices?.length) return [];
    return q.choices.map((c, i) => ({
      ...c, i, n: answers.filter((p) => p.answers[q.qid]?.choice === i).length,
    }));
  }, [q, answers]);
  const total = answers.length || 1;

  return (
    <div className="qcard">
      <p className="qtext">{q.text}</p>

      {isAuto ? (
        <>
          <ul className="dist">
            {dist.map((c) => (
              <li key={c.i} className={c.correct ? "right" : ""}>
                <span className="dlabel">{c.text}</span>
                {c.correct && <span className="keytag">correct</span>}
                <span className="dbar"><i style={{ width: `${(c.n / total) * 100}%` }} /></span>
                <span className="dn">{c.n}</span>
              </li>
            ))}
          </ul>
          {correctIdx < 0 && (
            <p className="hint warnhint">No correct option marked in your sheet, so nobody scored.</p>
          )}
          <ul className="who-list">
            {answers.map((p) => {
              const a = p.answers[q.qid];
              return (
                <li key={p.pid} className={a.correct ? "ok" : a.correct === false ? "no" : ""}>
                  {a.rank && <span className="rk">{a.rank}</span>}
                  <span>{label(p)}</span>
                  <span className="ms">{(a.ms / 1000).toFixed(1)}s</span>
                  <span className="pts">{a.points ? `+${a.points}` : "0"}</span>
                </li>
              );
            })}
            {answers.length === 0 && <li className="none">No answer from this unit.</li>}
          </ul>
        </>
      ) : (
        <>
          {answers.length === 0
            ? <p className="noanswer">No answer from this unit.</p>
            : <ul className="answers">
                {answers.map((p) => (
                  <li key={p.pid}>
                    <span className="who">{label(p)} · {(p.answers[q.qid].ms / 1000).toFixed(0)}s</span>
                    <p>{p.answers[q.qid].text}</p>
                  </li>
                ))}
              </ul>}
          <div className="qfoot">
            <div className="dims">
              <div className="dim">
                <span className="dimlab">Quality</span>
                <div className="scorer" role="group" aria-label="Quality">
                  {SCORE_LABELS.map((l, s) => (
                    <button key={s} className={sc.score === s ? "on" : ""} title={l} aria-label={l}
                      onClick={() => onScore({ score: sc.score === s ? null : s })}>{s}</button>
                  ))}
                </div>
                <span className="scorelab">{sc.score != null ? SCORE_LABELS[sc.score] : "—"}</span>
              </div>
              <div className="dim">
                <span className="dimlab">Decision</span>
                <div className="dseg" role="group" aria-label="Decision">
                  {DECISION_OPTS.map((o) => (
                    <button key={o.k} style={{ "--c": o.color }} className={sc.decision === o.k ? "on" : ""}
                      onClick={() => onScore({ decision: sc.decision === o.k ? null : o.k })}>{o.label}</button>
                  ))}
                </div>
              </div>
            </div>
            {q.answerRaw && (
              <button className="reveal" onClick={toggleExpected}>
                {showExpected ? "Hide expected" : "Show expected"}
              </button>
            )}
          </div>
          {showExpected && q.answerRaw && <p className="model">{q.answerRaw}</p>}
        </>
      )}
    </div>
  );
}

function DecisionBar({ inject, meta, setIMeta }) {
  const m = meta[inject.id] || {};
  const preset = m.target || inject.window || "";
  const target = preset ? Number(preset) * 60 : null;
  const decided = m.decidedAt;
  const over = target != null && decided != null ? decided - target : null;
  const [t0] = useState(Date.now());
  return (
    <div className={`decbar ${decided != null ? (over > 0 ? "late" : "ontime") : ""}`}>
      <label htmlFor={`w-${inject.id}`}>Decision window</label>
      <input id={`w-${inject.id}`} type="number" min="0" placeholder="—" value={preset}
        onChange={(e) => setIMeta(inject.id, { target: e.target.value })} />
      <span className="unit">min</span>
      {decided != null ? (
        <>
          <span className="verdict">
            Decided at {fmt(decided)}
            {over != null && (over > 0 ? ` · ${fmt(over)} over` : ` · ${fmt(Math.abs(over))} inside`)}
          </span>
          <button className="undo" onClick={() => setIMeta(inject.id, { decidedAt: null })}>Undo</button>
        </>
      ) : (
        <button className="undo"
          onClick={() => setIMeta(inject.id, { decidedAt: Math.round((Date.now() - t0) / 1000) })}>
          Mark decision reached
        </button>
      )}
    </div>
  );
}

const Toggle = ({ label, value, opts, onChange }) => (
  <div className="fld span2">
    <span>{label}</span>
    <div className="seg2">
      {opts.map(([v, l]) => (
        <button key={v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  </div>
);

const Check = ({ label, checked, onChange, hint }) => (
  <label className="chk span2">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span><b>{label}</b>{hint && <em>{hint}</em>}</span>
  </label>
);

/* =========================== PARTICIPANT =========================== */

function Participant() {
  const [me, setMe] = useState(null);
  const [codeIn, setCodeIn] = useState("");
  const [nameIn, setNameIn] = useState("");
  const [foundPeran, setFoundPeran] = useState("");
  const [deck, setDeck] = useState(null);
  const [state, setState] = useState(null);
  const [settings, setSettings] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [msg, setMsg] = useState("");
  const [key, setKey] = useState({});
  const [booted, setBooted] = useState(false);

  const onMsg = useCallback((m) => {
    if (m.t === "joined") {
      const rec = { pid: m.pid, roomId: m.roomId, peran: m.peran, name: m.me.name, answers: m.me.answers || {}, total: m.me.total || 0 };
      setMe(rec); lsSet(K_ME, rec);
      setDeck(m.deck); setState(m.state); setSettings(m.settings); setMsg("");
    } else if (m.t === "codeok") { setFoundPeran(m.peran); setMsg(""); }
    else if (m.t === "state") setState({ activeIdx: m.activeIdx, phase: m.phase, openedAt: m.openedAt });
    else if (m.t === "settings") setSettings(m.settings);
    else if (m.t === "ack") {
      setMe((p) => { const n = { ...p, answers: m.me.answers, total: m.me.total }; lsSet(K_ME, n); return n; });
      setMsg("Sent."); setTimeout(() => setMsg(""), 1800);
    }
    else if (m.t === "locked") setMsg("Answers are closed.");
    else if (m.t === "timeup") setMsg("Time is up for this question.");
    else if (m.t === "nosuch") { setFoundPeran(""); setMsg("No exercise found with that code."); }
    else if (m.t === "key") setKey(m.key || {});
    else if (m.t === "left") { lsDel(K_ME); setMe(null); setDeck(null); setState(null); }
    else if (m.t === "gone" || m.t === "ended") { lsDel(K_ME); setMe(null); setDeck(null); setState(null); }
  }, []);
  const { send, status, gen } = useSocket(onMsg);

  useEffect(() => {
    if (gen > 1 && me?.roomId && me?.pid) send({ t: "rejoin", roomId: me.roomId, pid: me.pid });
  }, [gen, me?.roomId, me?.pid, send]);

  useEffect(() => {
    const saved = lsGet(K_ME);
    if (saved?.roomId && saved?.pid) {
      setMe(saved);
      send({ t: "rejoin", roomId: saved.roomId, pid: saved.pid });
    }
    setBooted(true);
  }, [send]);

  const leave = () => {
    if (me?.roomId && me?.pid) send({ t: "leave", roomId: me.roomId, pid: me.pid });
    nukeAll(); setMe(null); setDeck(null); setState(null);
    setCodeIn(""); setNameIn(""); setFoundPeran(""); setKey({});
  };

  /* Derived above every early return. useExpired sat below them, so it only
     ran once a device had joined — the hook count changed between renders,
     which is React error #310. */
  const phase = state?.phase || "lobby";
  const inject = deck?.injects?.[state?.activeIdx ?? 0];
  const mine = inject?.questions || [];
  const limit = state?.limit ?? inject?.limit ?? settings?.timeLimit ?? 0;
  const timeUp = useExpired(
    state?.openedAt,
    settings?.mode === "auto" ? limit : 0,
    phase === "open" && !!me && !!deck
  );

  if (!booted) return <div className="boot">Loading</div>;

  /* ---- join: this is the front door for everyone but the facilitator ---- */
  if (!me || !deck) {
    const ready = codeIn.length >= 4;
    return (
      <main className="door">
        <div className="doorinner">
          <span className="mark" aria-hidden="true" />
          <h1>Tabletop exercise</h1>
          <p className="lede">Enter the code for your business unit.</p>

          <input className="codein" value={codeIn} maxLength={8} placeholder="————"
            autoComplete="off" autoCapitalize="characters" spellCheck="false"
            aria-label="Your unit's code"
            onChange={(e) => {
              const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
              setCodeIn(v); setFoundPeran("");
              if (v.length >= 4) send({ t: "peek", code: v });
            }}
            onKeyDown={(e) => e.key === "Enter" && ready && send({ t: "join", code: codeIn, name: nameIn })} />

          <div className={`resolve ${foundPeran ? "hit" : msg ? "miss" : ""}`}>
            {foundPeran
              ? <>Joining as <b>{foundPeran}</b></>
              : msg || (ready ? "Checking…" : "Four characters, from the facilitator")}
          </div>

          <label className="fld">
            <span>Who's on this device <em>optional</em></span>
            <input value={nameIn} onChange={(e) => setNameIn(e.target.value)}
              placeholder="Name or desk" autoComplete="off" />
          </label>

          <button className="primary big" disabled={!foundPeran}
            onClick={() => send({ t: "join", code: codeIn, name: nameIn })}>
            Join
          </button>

          {(lsGet(K_ME) || lsGet(K_HOST)) && (
            <div className="doorfoot">
              <button className="link quiet" onClick={() => { nukeAll(); location.reload(); }}>
                Clear saved session
              </button>
            </div>
          )}
        </div>
      </main>
    );
  }


  return (
    <>
      <Bar dark onExit={leave} exitLabel="Leave" conn={status}
        left={<b className="unitname">{me.peran}</b>}
        right={settings?.mode === "auto" && settings?.leaderboard
          ? <span className="ptsbadge">{(me.total || 0).toLocaleString()}</span> : null} />
      <main className="pmain">
        <div className="pinner">
          {phase === "lobby" && (
            <div className="standby">
              <span className="pulse" />
              <h2>You're in</h2>
              <p className="muted">Waiting for the facilitator to begin.</p>
            </div>
          )}

          {phase !== "lobby" && inject && (
            <>
              <div className="eyebrow">{inject.siklus} · Inject {inject.id}</div>
              {inject.condition && <blockquote className="condition">{inject.condition}</blockquote>}

              {phase === "briefing" && (
                <div className="standby small">
                  <span className="pulse" />
                  <p className="muted">Read the scenario. Questions open shortly.</p>
                </div>
              )}

              {phase === "open" && (mine.length === 0 ? (
                <div className="standby small">
                  <p className="muted">This inject doesn't involve your unit. Listen in.</p>
                </div>
              ) : (
                <>
                  {limit > 0 && settings?.mode === "auto" && (
                    <Countdown openedAt={state.openedAt} limit={limit} big />
                  )}
                  {timeUp && <div className="timeup">Time is up. Answers are closed.</div>}
                  {mine.map((q) => {
                    const sent = me.answers?.[q.qid];
                    const isMC = q.type === "choice" && q.choices?.length && settings.mode === "auto";
                    return (
                      <div className="pq" key={q.qid}>
                        <p className="pqtext">{q.text}</p>
                        {isMC ? (
                          <div className="opts">
                            {q.choices.map((c, i) => (
                              <button key={i}
                                className={`opt ${sent && sent.choice === i ? "picked" : ""} ${timeUp ? "dim" : ""}`}
                                disabled={timeUp}
                                onClick={() => send({ t: "answer", roomId: me.roomId, pid: me.pid, answers: { [q.qid]: i } })}>
                                <span className="oletter">{String.fromCharCode(65 + i)}</span>
                                <span className="otext">{c.text}</span>
                              </button>
                            ))}
                            {sent && (
                              <p className="sent">
                                {timeUp ? "Locked in." : "Answer sent. Tap another option to change it."}
                              </p>
                            )}
                          </div>
                        ) : (
                          <>
                            <textarea rows={5} placeholder="Type your unit's answer" disabled={timeUp}
                              value={drafts[q.qid] ?? sent?.text ?? ""}
                              onChange={(e) => setDrafts((d) => ({ ...d, [q.qid]: e.target.value }))} />
                            <button className="primary big" disabled={timeUp}
                              onClick={() => send({ t: "answer", roomId: me.roomId, pid: me.pid, answers: { [q.qid]: drafts[q.qid] ?? "" } })}>
                              {sent ? "Update answer" : "Send answer"}
                            </button>
                            {sent && <p className="sent">Sent. You can revise until answers close.</p>}
                          </>
                        )}
                      </div>
                    );
                  })}
                  {msg && <p className="sentnote">{msg}</p>}
                </>
              ))}

              {phase === "revealed" && (
                <>
                  {settings?.mode === "auto" && mine.some((q) => me.answers?.[q.qid]) ? (
                    <div className="myresult">
                      {mine.map((q) => {
                        const a = me.answers?.[q.qid];
                        if (!a) return (
                          <div className="rescard miss" key={q.qid}>
                            <p className="qtext">{q.text}</p>
                            {key[q.qid] && <p className="rkey">Correct answer: <b>{key[q.qid].text}</b></p>}
                            <p className="rline">No answer sent</p>
                          </div>
                        );
                        return (
                          <div className={`rescard ${a.correct ? "ok" : a.correct === false ? "no" : ""}`} key={q.qid}>
                            <p className="qtext">{q.text}</p>
                            <p className="rpick">You chose: {a.text}</p>
                            {key[q.qid] && !a.correct && (
                              <p className="rkey">Correct answer: <b>{key[q.qid].text}</b></p>
                            )}
                            <p className="rline">
                              {a.correct == null ? "Not auto-scored" : a.correct ? "Correct" : "Incorrect"}
                              {" · "}{(a.ms / 1000).toFixed(1)}s
                              {a.rank ? ` · ${a.rank}${a.rank === 1 ? "st" : a.rank === 2 ? "nd" : a.rank === 3 ? "rd" : "th"} to answer` : ""}
                              {" · "}<b>{a.points || 0} pts</b>
                            </p>
                          </div>
                        );
                      })}
                      {settings?.leaderboard && <p className="bigpts">{me.total || 0} pts total</p>}
                      <p className="muted small">The facilitator is leading the discussion.</p>
                    </div>
                  ) : (
                    <div className="standby small">
                      <h2>Answers are in</h2>
                      <p className="muted">The facilitator is leading the discussion.</p>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </main>
    </>
  );
}

/* ============================= REPORT ============================= */

function Report({ model, scores, notes, meta, people, settings, roleColor, fileName, label, unitOf, onBack, onEnd }) {
  const all = useMemo(() => model.injects.flatMap((i) =>
    i.questions.map((q) => ({ ...q, injectId: i.id, siklus: i.siklus }))), [model]);

  const board = useMemo(() =>
    [...people].sort((a, b) => (b.total || 0) - (a.total || 0)), [people]);

  const byRole = useMemo(() => {
    const o = {};
    all.forEach((q) => {
      if (!o[q.peran]) o[q.peran] = { total: 0, scored: 0, sum: 0, correct: 0, mc: 0, pts: 0 };
      const b = o[q.peran];
      b.total += 1;
      const sc = scores[q.qid] || {};
      if (sc.score != null) { b.scored += 1; b.sum += sc.score; }
      const answers = people.filter((p) => p.peran === q.peran && p.answers?.[q.qid]);
      answers.forEach((p) => {
        const a = p.answers[q.qid];
        if (a.correct != null) { b.mc += 1; if (a.correct) b.correct += 1; }
        b.pts += a.points || 0;
      });
    });
    return o;
  }, [all, scores, people]);

  function exportCSV() {
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["Siklus", "Inject", "Peran", "Question", "Expected", "Device", "Answer",
      "Correct", "Seconds", "Points", "Quality", "Decision", "Window", "Notes"];
    const lines = [head.map(esc).join(",")];
    model.injects.forEach((inj) => {
      const m = meta[inj.id] || {};
      inj.questions.forEach((q) => {
        const sc = scores[q.qid] || {};
        const rs = people.filter((p) => p.peran === q.peran && p.answers?.[q.qid]);
        (rs.length ? rs : [null]).forEach((p) => {
          const a = p?.answers[q.qid];
          lines.push([inj.siklus, inj.id, q.peran, q.text, q.answerRaw,
            p ? label(p) : "", a?.text || "",
            a?.correct == null ? "" : a.correct ? "Yes" : "No",
            a ? (a.ms / 1000).toFixed(1) : "", a?.points ?? "",
            sc.score != null ? SCORE_LABELS[sc.score] : "",
            sc.decision ? DECISION_OPTS.find((d) => d.k === sc.decision)?.label : "",
            m.target || inj.window || "", notes[inj.id] || ""].map(esc).join(","));
        });
      });
    });
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ttx-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const totalPts = people.reduce((a, p) => a + (p.total || 0), 0);
  const mcAll = Object.values(byRole).reduce((a, b) => a + b.mc, 0);
  const mcRight = Object.values(byRole).reduce((a, b) => a + b.correct, 0);

  return (
    <>
      <Bar left={<>Results · {fileName}</>} onExit={onBack} exitLabel="Back" />
      <main className="report">
        <div className="repinner">
          <h1>Exercise results</h1>
          <div className="kpis">
            <div><b>{people.length}</b><span>units</span></div>
            <div><b>{all.length}</b><span>questions</span></div>
            <div><b>{mcAll ? `${Math.round((mcRight / mcAll) * 100)}%` : "—"}</b><span>correct</span></div>
            <div><b>{totalPts.toLocaleString()}</b><span>points</span></div>
          </div>

          {settings.mode === "auto" && settings.leaderboard && board.length > 0 && (
            <>
              <h3>Leaderboard</h3>
              <ol className="board">
                {board.map((p, i) => (
                  <li key={p.pid}>
                    <span className="rank">{i + 1}</span>
                    <span className="dot" style={{ background: roleColor(p.peran) }} />
                    <span className="bname">{label(p)}</span>
                    <b>{(p.total || 0).toLocaleString()}</b>
                  </li>
                ))}
              </ol>
            </>
          )}

          <h3>By Peran</h3>
          <table className="tbl">
            <thead><tr><th>Peran</th><th>Correct</th><th>Points</th>
              {settings.mode === "manual" && <th>Quality</th>}</tr></thead>
            <tbody>
              {Object.entries(byRole).map(([role, d]) => (
                <tr key={role}>
                  <td><span className="dot" style={{ background: roleColor(role) }} />{role}</td>
                  <td>{d.mc ? `${d.correct}/${d.mc}` : "—"}</td>
                  <td>{d.pts ? d.pts.toLocaleString() : "—"}</td>
                  {settings.mode === "manual" &&
                    <td>{d.scored ? (d.sum / d.scored).toFixed(1) : "—"}</td>}
                </tr>
              ))}
            </tbody>
          </table>

          <div className="repactions">
            <button className="primary" onClick={exportCSV}>Download CSV</button>
            <button className="ghost" onClick={onBack}>Back to the run</button>
            <button className="danger" onClick={onEnd}>End session</button>
          </div>
          <p className="muted small">Ending clears the room for everyone. Download the CSV first.</p>
        </div>
      </main>
    </>
  );
}

function Bar({ left, right, onExit, exitLabel = "Exit", conn, dark }) {
  return (
    <header className={`bar ${dark ? "dark" : ""}`}>
      <span className="mark" aria-hidden="true" />
      <div className="brand">{left}</div>
      <div className="barright">
        {conn && conn !== "live" && <span className="offline">Reconnecting</span>}
        {right}
        {dark && <span className="build">{BUILD}</span>}
        <button className="ghost" onClick={onExit}>{exitLabel}</button>
      </div>
    </header>
  );
}

/* The four phases are a real sequence, so they get a real stepper. */
const PHASES = [
  { k: "lobby", label: "Waiting" },
  { k: "briefing", label: "Brief" },
  { k: "open", label: "Answer" },
  { k: "revealed", label: "Discuss" },
];

function PhaseSteps({ phase, onPick }) {
  const at = PHASES.findIndex((p) => p.k === phase);
  return (
    <ol className="steps">
      {PHASES.map((p, i) => (
        <li key={p.k} className={i === at ? "now" : i < at ? "past" : ""}>
          <button onClick={() => onPick(p.k)}>{p.label}</button>
        </li>
      ))}
    </ol>
  );
}

/* ============================== CSS ============================== */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:wght@400;500&display=swap');

.ttx{
  --paper:#EDEFEA; --panel:#FFFFFF; --sink:#12232A;
  --ink:#14191D; --ink2:#414C54; --muted:#6E7973;
  --rule:#D5DAD4; --rule2:#E6E9E4; --accent:#0E5457; --accent2:#0A4245;
  --good:#1D6647; --warn:#8A6410; --alert:#A33A1F;
  --sans:'IBM Plex Sans',system-ui,-apple-system,sans-serif;
  --serif:'IBM Plex Serif',Georgia,serif;
  --mono:'IBM Plex Mono',ui-monospace,monospace;
  font-family:var(--sans);color:var(--ink);background:var(--paper);
  min-height:100vh;font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;
}
.ttx *{box-sizing:border-box}
.ttx button{font:inherit;cursor:pointer;border:none;background:none;color:inherit;text-align:inherit}
.ttx :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
.ttx textarea,.ttx input[type=text],.ttx input[type=number],.ttx input:not([type]),.ttx select{
  font:inherit;color:inherit;width:100%;background:var(--panel);
  border:1px solid var(--rule);border-radius:5px;padding:10px 12px}
.ttx textarea{resize:vertical;line-height:1.55}
.ttx textarea:focus,.ttx input:focus,.ttx select:focus{border-color:var(--accent);outline:none}
.ttx h1{font-size:28px;font-weight:600;letter-spacing:-.015em;margin:0 0 10px;line-height:1.2}
.ttx h2{font-size:20px;font-weight:600;margin:0 0 4px;letter-spacing:-.01em}
.ttx h3{font-size:13px;font-weight:600;color:var(--ink2);margin:32px 0 10px}
.ttx code{font-family:var(--mono);font-size:12.5px;background:var(--rule2);padding:1px 5px;border-radius:3px}
.mono{font-family:var(--mono)}
.muted{color:var(--muted)}
.small{font-size:13px}
.boot{padding:70px;text-align:center;color:var(--muted)}
.hint{font-size:12.5px;color:var(--muted);margin:8px 0 0;line-height:1.5;max-width:62ch}

/* ---------- buttons ---------- */
.ttx .primary{padding:9px 18px;background:var(--accent);color:#fff;border-radius:5px;
  font-size:14px;font-weight:500;width:auto;transition:background .12s}
.ttx .primary:hover:not(:disabled){background:var(--accent2)}
.ttx .primary:disabled{opacity:.35;cursor:default}
.ttx .primary.big{width:100%;padding:14px;margin-top:20px;font-size:15px}
.ttx .ghost{padding:6px 13px;border:1px solid var(--rule);border-radius:5px;
  font-size:13px;color:var(--ink2);width:auto;background:transparent}
.ttx .ghost:hover:not(:disabled){border-color:var(--muted)}
.ttx .ghost:disabled{opacity:.35;cursor:default}
.ttx .ghost.wide{width:100%;padding:11px;margin-top:20px;text-align:center}
.vis{display:flex;gap:3px}
.keytag{font-size:10px;font-weight:600;color:var(--good);border:1px solid #A9C7B4;
  border-radius:9px;padding:1px 7px;background:#EFF6F1}
.confirm{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.cmsg{font-size:13px;color:var(--ink2)}
.rkey{margin:0 0 7px;font-size:13.5px;color:var(--good)}
.rkey b{font-weight:600}
.ttx .ghost.pill{padding:5px 11px;font-size:12px}
.ttx .bar.dark .ghost.pill{background:#1E3D44;border-color:#2F5A60;color:#CFDCDA}
.ttx .bar.dark .ghost.pill.off{background:transparent;border-style:dashed;border-color:#33474F;color:#728683}
.panel .chk{margin-bottom:14px}
.panel h3{margin-top:26px}
.ttx .danger{padding:8px 16px;border:1px solid #D9B1A5;color:var(--alert);border-radius:5px;font-size:13px}
.ttx .danger:hover{background:#FBF0EC}
.ttx .link{color:var(--accent);text-decoration:underline;text-underline-offset:3px;font-size:14px}

/* ---------- header ---------- */
.bar{display:flex;align-items:center;gap:14px;padding:0 16px;height:56px;background:var(--panel);
  border-bottom:1px solid var(--rule);position:sticky;top:0;z-index:10}
.bar .mark{width:4px;height:22px;background:var(--accent);border-radius:2px;flex:none}
.brand{display:flex;align-items:center;gap:14px;font-size:14px;min-width:0}
.barright{margin-left:auto;display:flex;align-items:center;gap:9px;font-size:12px;color:var(--muted)}
.build{font-family:var(--mono);font-size:10.5px;opacity:.45}
.build.big{display:block;margin:-12px 0 20px;opacity:.5}
.offline{color:var(--alert);font-weight:500}
.bar.dark{background:var(--sink);border-bottom-color:#0B171C;color:#DDE4E2}
.bar.dark .mark{background:#3F8F84}
.bar.dark .ghost{border-color:#2C4048;color:#B7C4C2}
.bar.dark .ghost:hover{border-color:#4E6670;background:#1A2F37}
.bar.dark .barright{color:#8FA09E}
.crumb{color:#8FA09E;font-size:12.5px;white-space:nowrap}
.injno{font-weight:600;white-space:nowrap}
.unitname{font-size:15px;font-weight:600}
.ptsbadge{font-family:var(--mono);font-size:14px;font-weight:600;color:#7FD4C0}

/* ---------- phase stepper ---------- */
.steps{display:flex;list-style:none;margin:0;padding:0;gap:2px}
.steps li button{padding:5px 12px;font-size:12.5px;color:#7A8C8A;border-radius:4px;white-space:nowrap}
.steps li button:hover{color:#DDE4E2;background:#1A2F37}
.steps li.past button{color:#A9BAB7}
.steps li.now button{background:#1E3D44;color:#fff;font-weight:500;box-shadow:inset 0 0 0 1px #2F5A60}
.steps li+li{position:relative;padding-left:9px}
.steps li+li::before{content:"";position:absolute;left:2px;top:50%;width:4px;height:1px;background:#2C4048}

/* ---------- door (join is the front page) ---------- */
.door{display:flex;justify-content:center;padding:64px 22px 90px}
.doorinner{max-width:380px;width:100%}
.doorinner .mark{display:block;width:4px;height:26px;background:var(--accent);border-radius:2px;margin-bottom:24px}
.doorinner h1{margin-bottom:6px}
.doorinner .lede{margin-bottom:22px}
.doorinner .codein{margin-bottom:10px;border-width:1.5px}
.resolve{min-height:22px;font-size:13.5px;color:var(--muted);text-align:center;margin-bottom:22px}
.resolve.hit{color:var(--good)}
.resolve.hit b{font-weight:600}
.resolve.miss{color:var(--alert)}
.doorinner .fld>span{display:flex;align-items:baseline;gap:7px}
.doorinner .fld em{font-style:normal;font-size:11.5px;color:var(--muted);font-weight:400}
.doorfoot{margin-top:30px;padding-top:20px;border-top:1px solid var(--rule);
  display:flex;flex-direction:column;gap:10px;align-items:flex-start}
.ttx .link.quiet{color:var(--muted);font-size:12.5px}

/* ---------- landing ---------- */
.landing{display:flex;justify-content:center;padding:76px 24px}
.landinner{max-width:460px;width:100%}
.landinner .mark{display:block;width:4px;height:26px;background:var(--accent);border-radius:2px;margin-bottom:22px}
.lede{color:var(--ink2);margin:0 0 26px;max-width:56ch}
.lede b{font-weight:600;font-family:var(--mono);font-size:13px}
.picks{display:grid;gap:9px}
.ttx .pick{text-align:left;background:var(--panel);border:1px solid var(--rule);border-radius:7px;
  padding:17px 19px;transition:border-color .12s}
.ttx .pick:hover{border-color:var(--accent)}
.ttx .pick b{display:block;font-size:15.5px;font-weight:600;margin-bottom:2px}
.ttx .pick span{font-size:13.5px;color:var(--muted)}
.ttx .landinner .link{margin-top:24px;display:inline-block}

/* ---------- forms ---------- */
.load{display:flex;justify-content:center;padding:46px 24px 90px}
.loadinner{max-width:560px;width:100%}
.loadinner.narrow{max-width:380px}
.loadinner.wide{max-width:660px}
.drop{border:1.5px dashed var(--rule);border-radius:7px;padding:36px;text-align:center;
  background:var(--panel);display:flex;flex-direction:column;align-items:center;gap:12px}
.or{color:var(--muted);font-size:13px}
.err{margin-top:14px;padding:11px 14px;background:#FBF0EC;border-left:3px solid var(--alert);
  border-radius:0 5px 5px 0;font-size:13.5px;color:#7C2B16}
.found{margin:-6px 0 16px;padding:10px 13px;background:#EFF6F1;border-left:3px solid var(--good);
  border-radius:0 5px 5px 0;font-size:14px;color:var(--good)}
.ttx .load .link{margin-top:18px;display:inline-block}
.fld{display:block;margin-bottom:16px}
.fld>span{display:block;font-size:13px;font-weight:500;color:var(--ink2);margin-bottom:6px}
.codein{font-family:var(--mono);font-size:30px;font-weight:500;letter-spacing:.26em;
  text-align:center;text-transform:uppercase;padding:14px 12px}
.warn{font-size:12.5px;background:#FBF6E9;border:1px solid #E5D6AE;border-radius:5px;padding:10px 13px;margin-bottom:22px}
.warn summary{cursor:pointer;font-weight:500;color:#755C14}
.warn ul{margin:9px 0 0;padding-left:16px;color:#6A5415;line-height:1.5}
.warn li{margin-bottom:5px}
.warnhint{color:var(--warn)}
.setgrid{display:grid;grid-template-columns:1fr 1fr;gap:15px}
.span2{grid-column:1/-1}
.seg2{display:flex;gap:3px}
.seg2 button{flex:1;padding:9px 12px;border:1px solid var(--rule);border-radius:5px;
  font-size:13.5px;color:var(--muted);background:var(--panel);text-align:center}
.seg2 button.on{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:500}
.chk{display:flex;gap:10px;align-items:flex-start;cursor:pointer}
.chk input{width:16px;height:16px;margin-top:3px;flex:none;accent-color:var(--accent)}
.chk b{display:block;font-size:14px;font-weight:500}
.chk em{display:block;font-style:normal;font-size:12.5px;color:var(--muted);margin-top:2px;line-height:1.45}
.codelist{list-style:none;margin:10px 0 0;padding:0;background:var(--panel);
  border:1px solid var(--rule);border-radius:6px;overflow:hidden}
.codelist li{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--rule2)}
.codelist li:last-child{border-bottom:none}
.cname{flex:1;font-size:14px;font-weight:500}
.cinput{width:112px;font-family:var(--mono);text-align:center;letter-spacing:.1em;text-transform:uppercase;padding:6px}
.cinput.narrow{width:76px;letter-spacing:0}
.unit{color:var(--muted);font-size:12.5px}

/* ---------- run shell ---------- */
.run{display:grid;grid-template-columns:224px minmax(0,1fr);align-items:start}
.rail{position:sticky;top:56px;height:calc(100vh - 56px);display:flex;flex-direction:column;
  border-right:1px solid var(--rule);background:#E8EBE6}
.tl{list-style:none;margin:0;padding:12px 0;overflow-y:auto;flex:1}
.tlhead{font-size:10.5px;font-weight:600;color:var(--muted);padding:16px 16px 7px;letter-spacing:.03em}
.tl li:first-child.tlhead{padding-top:2px}
.tlrow button{width:100%;display:grid;grid-template-columns:16px 22px 1fr auto;align-items:center;
  gap:7px;padding:7px 14px;position:relative}
.tlrow button:hover{background:#DFE3DC}
.tldot{width:9px;height:9px;border-radius:50%;border:1.5px solid var(--rule);background:var(--paper);
  margin-left:3px;z-index:1}
.tlrow::before{content:"";position:absolute;left:23px;width:1px;height:100%;background:var(--rule)}
.tlrow:first-of-type::before{top:50%;height:50%}
.tlrow.done .tldot{background:var(--muted);border-color:var(--muted)}
.tlrow.now .tldot{background:var(--accent);border-color:var(--accent);
  box-shadow:0 0 0 3px rgba(14,84,87,.16)}
.tlrow.now button{background:var(--panel);font-weight:500}
.tlrow{position:relative}
.tlno{font-family:var(--mono);font-size:12px;color:var(--muted)}
.tlrow.now .tlno{color:var(--ink)}
.tltext{font-size:12.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tlrow.now .tltext{color:var(--ink2)}
.tlunits{display:flex;gap:2px}
.tlunits i{width:5px;height:5px;border-radius:50%;display:block}
.tlfoot{border-top:1px solid var(--rule);padding:11px 16px;display:flex;align-items:center;gap:10px;
  font-size:11.5px;color:var(--muted);background:#E4E8E2}
.tlprog{flex:1;height:3px;background:var(--rule);border-radius:2px;overflow:hidden}
.tlprog i{display:block;height:100%;background:var(--accent);transition:width .3s}

/* ---------- stage ---------- */
.stage{padding:30px 36px 90px;max-width:820px}
.scenario{font-family:var(--serif);font-size:19px;line-height:1.68;margin:0 0 22px;
  padding:24px 28px;background:var(--panel);border-left:3px solid var(--accent);
  border-radius:0 7px 7px 0;max-width:64ch;box-shadow:0 1px 2px rgba(20,25,29,.04)}
.empty{color:var(--muted);font-style:italic;margin-bottom:22px}
.callon{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:18px;
  font-size:12.5px;color:var(--muted)}
.chip{color:#fff;background:var(--c);padding:4px 12px;border-radius:12px;font-size:12.5px;font-weight:500}
.actbar{display:flex;align-items:center;gap:14px;padding:13px 16px;background:var(--panel);
  border:1px solid var(--rule);border-radius:7px;margin-bottom:26px;flex-wrap:wrap}
.amsg{font-size:13.5px;color:var(--muted)}
.amsg.right{margin-left:auto}
.actbar .primary,.actbar .ghost{margin-left:auto}
.actbar .amsg.right+.primary{margin-left:0}
.inlinetime{display:flex;align-items:center;gap:6px}
.inlinetime input{width:70px;font-family:var(--mono);text-align:center;padding:5px 6px;background:var(--paper)}

/* ---------- countdown ---------- */
.cd{display:flex;align-items:center;gap:11px;min-width:150px}
.cdnum{font-family:var(--mono);font-size:19px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--ink2)}
.cdbar{flex:1;height:5px;background:var(--rule2);border-radius:3px;overflow:hidden;min-width:60px}
.cdbar i{display:block;height:100%;background:var(--accent);transition:width .2s linear}
.cd.warn .cdnum{color:var(--warn)} .cd.warn .cdbar i{background:var(--warn)}
.cd.urgent .cdnum{color:var(--alert)} .cd.urgent .cdbar i{background:var(--alert)}
.cd.big{display:block;margin:0 0 22px}
.cd.big .cdnum{display:block;font-size:46px;text-align:center;letter-spacing:-.02em;line-height:1.1}
.cd.big .cdbar{width:100%;height:7px;margin-top:10px}

/* ---------- lobby ---------- */
.lobby{max-width:720px}
.lobbyhead{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:22px}
.joincount{text-align:right;flex:none}
.joincount b{display:block;font-family:var(--mono);font-size:32px;font-weight:500;line-height:1;color:var(--accent)}
.joincount span{font-size:11.5px;color:var(--muted)}
.codegrid{list-style:none;margin:0;padding:0;display:grid;
  grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:9px}
.codegrid li{background:var(--panel);border:1px solid var(--rule);border-top:3px solid var(--c);
  border-radius:0 0 7px 7px;padding:14px 16px}
.codegrid li.in{background:#F4F8F4;border-color:#B6CFBD;border-top-color:var(--c)}
.cgunit{display:block;font-size:12.5px;font-weight:500;color:var(--ink2);margin-bottom:6px}
.cgcode{display:block;font-family:var(--mono);font-size:28px;font-weight:600;
  letter-spacing:.14em;color:var(--c);line-height:1.1}
.cgwho{display:block;font-size:11.5px;color:var(--muted);margin-top:7px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.codegrid li.in .cgwho{color:var(--good)}

/* ---------- tracker ---------- */
.tracker{background:var(--panel);border:1px solid var(--rule);border-radius:7px;overflow:hidden;margin-bottom:22px}
.trow{display:flex;align-items:center;gap:11px;padding:11px 15px;border-bottom:1px solid var(--rule2);font-size:13.5px}
.trow:last-child{border-bottom:none}
.tname{font-weight:500;min-width:140px}
.tbar{flex:1;height:5px;background:var(--rule2);border-radius:3px;overflow:hidden;max-width:260px}
.tbar i{display:block;height:100%;transition:width .3s}
.tcount{font-family:var(--mono);font-size:12.5px;color:var(--muted)}
.tmiss{color:var(--muted);font-size:12.5px}
.tin{color:var(--good);font-size:12.5px}
.tdone{font-family:var(--mono);font-size:12px;color:var(--good);min-width:46px;text-align:right}
.timeup{margin:-8px 0 20px;padding:11px 14px;background:#FBF0EC;border-left:3px solid var(--alert);
  border-radius:0 5px 5px 0;font-size:13.5px;color:#7C2B16;text-align:center;font-weight:500}

/* ---------- question cards ---------- */
.rolegroup{margin-bottom:28px}
.rolerule{font-size:12.5px;font-weight:600;color:var(--c);padding-bottom:7px;
  border-bottom:2px solid var(--c);margin-bottom:13px}
.qcard{background:var(--panel);border:1px solid var(--rule2);border-radius:7px;padding:16px 18px;margin-bottom:10px}
.qtext{margin:0 0 13px;font-size:15.5px;line-height:1.5;font-weight:500}
.dist{list-style:none;margin:0 0 13px;padding:0;display:grid;gap:7px}
.dist li{display:flex;align-items:center;gap:11px;font-size:13.5px}
.dist .dlabel{flex:1;color:var(--ink2)}
.dist li.right .dlabel{color:var(--good);font-weight:500}
.dbar{width:130px;height:9px;background:var(--rule2);border-radius:5px;overflow:hidden}
.dbar i{display:block;height:100%;background:var(--muted)}
.dist li.right .dbar i{background:var(--good)}
.dn{font-family:var(--mono);font-size:12px;color:var(--muted);min-width:18px;text-align:right}
.who-list{list-style:none;margin:0;padding:11px 0 0;border-top:1px dashed var(--rule);display:grid;gap:6px}
.who-list li{display:flex;align-items:center;gap:10px;font-size:13px}
.who-list li span:nth-child(2){flex:1}
.who-list li.ok span:nth-child(2){color:var(--good)}
.who-list li.no span:nth-child(2){color:var(--alert)}
.rk{font-family:var(--mono);font-size:10.5px;color:var(--muted);width:16px;flex:none}
.who-list .ms{font-family:var(--mono);font-size:12px;color:var(--muted)}
.who-list .pts{font-family:var(--mono);font-size:12.5px;font-weight:600;min-width:54px;text-align:right}
.who-list .none{color:var(--muted);font-style:italic}
.answers{list-style:none;margin:0 0 13px;padding:0;display:grid;gap:8px}
.answers li{background:var(--paper);border-radius:5px;padding:10px 13px}
.answers .who{font-size:11px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px}
.answers p{margin:0;font-family:var(--serif);font-size:14.5px;line-height:1.58}
.noanswer{margin:0 0 12px;color:var(--alert);font-size:13.5px;font-style:italic}
.qfoot{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap}
.dims{display:flex;gap:22px;flex-wrap:wrap}
.dim{display:flex;align-items:center;gap:7px}
.dimlab{font-size:11px;color:var(--muted);font-weight:500}
.scorer{display:flex;gap:3px}
.scorer button{width:28px;height:28px;border:1px solid var(--rule);border-radius:5px;
  font-family:var(--mono);font-size:13px;color:var(--muted)}
.scorer button:hover{border-color:var(--ink2)}
.scorer button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.scorelab{font-size:12.5px;color:var(--muted);min-width:76px}
.dseg{display:flex;gap:3px}
.dseg button{padding:6px 11px;border:1px solid var(--rule);border-radius:5px;
  font-size:12.5px;color:var(--muted);white-space:nowrap}
.dseg button:hover{border-color:var(--ink2)}
.dseg button.on{background:var(--c);border-color:var(--c);color:#fff;font-weight:500}
.ttx .reveal{font-size:13px;color:var(--accent);text-decoration:underline;text-underline-offset:3px}
.model{margin:13px 0 0;padding-top:13px;border-top:1px dashed var(--rule);white-space:pre-line;
  font-family:var(--serif);font-size:14.5px;line-height:1.6;color:var(--ink2)}
.decbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:24px 0;padding:12px 15px;
  background:var(--panel);border:1px solid var(--rule);border-radius:7px;font-size:13px}
.decbar label{color:var(--ink2);font-weight:500}
.decbar input{width:58px;font-family:var(--mono);text-align:center;padding:5px 6px;background:var(--paper)}
.verdict{margin-left:auto;font-family:var(--mono);font-size:12.5px}
.ttx .undo{margin-left:auto;font-size:12.5px;color:var(--accent);text-decoration:underline;text-underline-offset:3px}
.ttx .decbar .verdict+.undo{margin-left:0}
.decbar.ontime{border-color:#A9C7B4;background:#F1F8F3}
.decbar.ontime .verdict{color:var(--good)}
.decbar.late{border-color:#DEB4A6;background:#FBF0EC}
.decbar.late .verdict{color:var(--alert)}
.notes{margin-top:28px}
.notes label{display:block;font-size:13px;font-weight:500;color:var(--ink2);margin-bottom:7px}
.nav{display:flex;justify-content:space-between;margin-top:28px;padding-top:22px;border-top:1px solid var(--rule)}

/* ---------- room panel ---------- */
.scrim{position:fixed;inset:0;background:rgba(18,35,42,.38);z-index:30;display:flex;justify-content:flex-end}
.panel{background:var(--paper);width:min(460px,100%);height:100%;overflow-y:auto;padding:24px 26px 44px;
  border-left:1px solid var(--rule);box-shadow:-10px 0 32px rgba(0,0,0,.12)}
.phead{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.phead h2{margin:0}

/* ---------- participant ---------- */
.pmain{display:flex;justify-content:center;padding:22px 16px 80px}
.pinner{max-width:560px;width:100%}
.standby{text-align:center;padding:64px 20px}
.standby.small{padding:30px 20px}
.pulse{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--accent);
  margin-bottom:16px;animation:beat 2s ease-in-out infinite}
@keyframes beat{0%,100%{opacity:.22}50%{opacity:1}}
.pq{margin-bottom:22px}
.pqtext{margin:0 0 14px;font-size:18px;line-height:1.42;font-weight:500;letter-spacing:-.005em}
.opts{display:grid;gap:9px}
.ttx .opt{display:flex;align-items:center;gap:13px;text-align:left;padding:16px 16px;
  background:var(--panel);border:1.5px solid var(--rule);border-radius:8px;font-size:15.5px;line-height:1.4}
.ttx .opt:hover:not(:disabled){border-color:var(--accent)}
.ttx .opt.dim{opacity:.4}
.ttx .opt.picked{border-color:var(--accent);background:#E7F1F0;font-weight:500;opacity:1}
.otext{flex:1}
.oletter{font-family:var(--mono);font-size:12.5px;font-weight:600;width:26px;height:26px;flex:none;
  display:grid;place-items:center;border-radius:5px;background:var(--paper);border:1px solid var(--rule);color:var(--muted)}
.ttx .opt.picked .oletter{background:var(--accent);border-color:var(--accent);color:#fff}
.sent{margin:11px 0 0;font-size:12.5px;color:var(--accent);text-align:center}
.sentnote{text-align:center;font-size:13px;color:var(--accent);margin-top:12px}
.bigpts{font-family:var(--mono);font-size:34px;font-weight:600;color:var(--accent);margin:16px 0 0;text-align:center}
.myresult{display:grid;gap:10px}
.rescard{background:var(--panel);border:1px solid var(--rule2);border-left:3px solid var(--muted);
  border-radius:0 7px 7px 0;padding:15px 17px}
.rescard.ok{border-left-color:var(--good)}
.rescard.no{border-left-color:var(--alert)}
.rescard.miss{opacity:.65}
.rpick{margin:0 0 7px;font-size:14px;color:var(--ink2)}
.rline{margin:0;font-size:12.5px;color:var(--muted)}
.rescard.ok .rline b{color:var(--good)}
.rescard.no .rline b{color:var(--alert)}

/* ---------- report ---------- */
.report{display:flex;justify-content:center;padding:34px 24px 96px}
.repinner{max-width:790px;width:100%}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:1px;background:var(--rule);
  border:1px solid var(--rule);border-radius:7px;overflow:hidden;margin:20px 0 8px}
.kpis div{background:var(--panel);padding:15px 16px}
.kpis b{display:block;font-family:var(--mono);font-size:25px;font-weight:600;
  font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.kpis span{font-size:11.5px;color:var(--muted);display:block;margin-top:4px}
.board{list-style:none;margin:0;padding:0;background:var(--panel);border:1px solid var(--rule);
  border-radius:7px;overflow:hidden}
.board li{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--rule2);font-size:14px}
.board li:last-child{border-bottom:none}
.board li:first-child{background:#F4F8F4}
.rank{font-family:var(--mono);font-size:13px;color:var(--muted);width:20px}
.bname{flex:1}
.board b{font-family:var(--mono);font-variant-numeric:tabular-nums}
.tbl{width:100%;border-collapse:collapse;font-size:14px;background:var(--panel);
  border:1px solid var(--rule);border-radius:7px;overflow:hidden}
.tbl th{text-align:left;font-size:11.5px;font-weight:600;color:var(--muted);padding:10px 15px;border-bottom:1px solid var(--rule)}
.tbl td{padding:11px 15px;border-bottom:1px solid var(--rule2)}
.tbl tr:last-child td{border-bottom:none}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:9px;flex:none}
.repactions{display:flex;gap:12px;margin-top:32px;flex-wrap:wrap}
.crash{max-width:490px;margin:88px auto;padding:0 24px;text-align:center}
.crash pre{text-align:left;background:var(--panel);border:1px solid var(--rule);border-radius:6px;
  padding:13px;font-size:12px;overflow:auto;margin:18px 0;color:var(--alert)}

@media (max-width:860px){
  .run{grid-template-columns:1fr}
  .rail{position:static;height:auto;border-right:none;border-bottom:1px solid var(--rule)}
  .tl{display:flex;overflow-x:auto;padding:10px}
  .tlhead{display:none}
  .tlrow::before{display:none}
  .tlrow button{grid-template-columns:auto auto;padding:8px 12px;border:1px solid var(--rule);
    border-radius:6px;background:var(--panel)}
  .tltext,.tlunits{display:none}
  .stage{padding:22px 16px 80px}
  .scenario{font-size:17px;padding:18px 20px}
  .setgrid{grid-template-columns:1fr}
  .steps{display:none}
  .actbar{flex-wrap:wrap}
  .actbar .primary{width:100%;margin-left:0}
  .lobbyhead{flex-direction:column;gap:10px}
  .joincount{text-align:left}
}
@media (prefers-reduced-motion:reduce){.ttx *{animation:none!important;transition:none!important}}
`;
