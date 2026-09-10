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
const BUILD = "b7";  // shown in the corner so you can confirm what is deployed
const K_HOST = `ttx:${V}:host`;
const K_ME = `ttx:${V}:me`;

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

function useSocket(onMessage) {
  const ws = useRef(null);
  const handler = useRef(onMessage);
  const queue = useRef([]);
  const [status, setStatus] = useState("connecting");
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

  return { send, status };
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
          Usually a session left over from an earlier version. Clearing it fixes it.
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
  const [mode, setMode] = useState(null);
  return (
    <div className="ttx">
      <style>{CSS}</style>
      <Boundary>
        {mode === null && <Landing onPick={setMode} />}
        {mode === "host" && <Host onExit={() => setMode(null)} />}
        {mode === "join" && <Participant onExit={() => setMode(null)} />}
      </Boundary>
    </div>
  );
}

function Landing({ onPick }) {
  const stale = lsGet(K_HOST) || lsGet(K_ME);
  return (
    <main className="landing">
      <div className="landinner">
        <span className="mark" aria-hidden="true" />
        <h1>Tabletop exercise</h1>
        <p className="lede">
          Every business unit joins with its own code. They answer on one device
          per unit, scored on whether they got it right and how fast.
        </p>
        <p className="build big">build {BUILD}</p>
        <div className="picks">
          <button className="pick" onClick={() => onPick("host")}>
            <b>Run an exercise</b><span>Load your inject sheet and facilitate</span>
          </button>
          <button className="pick" onClick={() => onPick("join")}>
            <b>Join an exercise</b><span>You have a code from the facilitator</span>
          </button>
        </div>
        {stale && (
          <button className="link small" onClick={() => { nukeAll(); location.reload(); }}>
            Clear the session saved on this device
          </button>
        )}
      </div>
    </main>
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
  const [booted, setBooted] = useState(false);
  const fileRef = useRef(null);

  const onMsg = useCallback((m) => {
    if (m.t === "hosted") {
      setRoomId(m.roomId); setCodes(m.codes); setSettings(m.settings); setTimes(m.times || {});
      setActiveIdx(m.state.activeIdx); setPhase(m.state.phase);
      setOpenedAt(m.state.openedAt); setScreen("run");
    } else if (m.t === "roster") setPeople(m.people || []);
    else if (m.t === "settings") { setSettings(m.settings); if (m.times) setTimes(m.times); }
    else if (m.t === "gone") { lsDel(K_HOST); setModel(null); setRoomId(""); setScreen("setup"); }
  }, []);
  const { send, status } = useSocket(onMsg);

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

  const start = () => send({ t: "host", deck: model, settings, codes: draftCodes, times });

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
        <Bar left="Facilitator" onExit={onExit} conn={status} />
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
        <Bar left="Setup" onExit={() => setScreen("setup")} exitLabel="Back" conn={status} />
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

            <button className="primary big" onClick={start}>Open the room</button>
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
        <Bar left="Facilitator" onExit={onExit} conn={status} />
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
      <Bar left={<>{inject.siklus} · <b>Inject {inject.id}</b> · <span className="phasetag">{
        phase === "lobby" ? "Waiting room" : phase === "briefing" ? "Briefing"
          : phase === "open" ? "Answering" : "Discussing"}</span></>}
        onExit={onExit} conn={status}
        right={<>
          <button className="ghost" onClick={() => setRoomOpen(true)}>
            Codes &amp; devices · {people.length}
          </button>
          <button className="ghost" onClick={() => setScreen("report")}>Report</button>
        </>} />

      {roomOpen && (
        <RoomPanel {...{ codes, people, model, roleColor, label, unitOf }}
          onClose={() => setRoomOpen(false)}
          onLobby={() => { setPhase("lobby"); setRoomOpen(false); }} />
      )}

      <main className="run">
        <aside className="rail">
          <ol className="cues">
            {model.injects.map((inj, i) => {
              const head = i === 0 || model.injects[i - 1].siklus !== inj.siklus;
              return (
                <React.Fragment key={inj.id}>
                  {head && <li className="sikhead">{inj.siklus}</li>}
                  <li>
                    <button className={`cue ${i === activeIdx ? "current" : ""}`}
                      onClick={() => { setActiveIdx(i); setPhase("briefing"); }}>
                      <span className="cueno">{inj.id}</span>
                      <span className="cuedots">
                        {inj.roles.slice(0, 4).map((r) => <i key={r} style={{ background: roleColor(r) }} title={r} />)}
                      </span>
                    </button>
                  </li>
                </React.Fragment>
              );
            })}
          </ol>
        </aside>

        <section className="stage">
          {phase === "lobby" ? (
            <Lobby {...{ codes, people, model, roleColor, settings, label, unitOf }}
              onBegin={() => setPhase("briefing")} injectId={inject.id} />
          ) : (
            <>
              <div className="stagehead">
                <div>
                  <div className="eyebrow">{inject.siklus}</div>
                  <h2>Inject {inject.id}</h2>
                </div>
                {phase === "open" && settings.mode === "auto" && limitOf(inject.id) > 0 && (
                  <Countdown openedAt={openedAt} limit={limitOf(inject.id)} />
                )}
              </div>

              {inject.condition
                ? <blockquote className="condition">{inject.condition}</blockquote>
                : <div className="empty">No Condition text. Brief the room from your own notes.</div>}

              <div className="callon">
                <span>Call on</span>
                {inject.roles.map((r) => <span key={r} className="chip" style={{ "--c": roleColor(r) }}>{unitOf(r)}</span>)}
              </div>

              <div className="phasebar">
                <button className="ghost" onClick={() => setPhase("lobby")} title="Show the join codes">
                  Waiting room
                </button>
                {phase === "briefing" && (
                  <>
                    <span className="pmsg">Scenario is on every device. Read it aloud.</span>
                    {settings.mode === "auto" && (
                      <span className="inlinetime">
                        <input type="number" min="0" step="5" placeholder={String(settings.timeLimit)}
                          value={times[inject.id] ?? ""}
                          onChange={(e) => setInjectTime(inject.id, e.target.value)} />
                        <span className="unit">sec to answer</span>
                      </span>
                    )}
                    <button className="primary" onClick={() => { setOpenedAt(Date.now()); setPhase("open"); }}>
                      Open for answers
                    </button>
                  </>
                )}
                {phase === "open" && (
                  <>
                    <span className="pmsg">{allIn ? "Everyone has answered." : "Waiting on answers."}</span>
                    <button className="primary" onClick={() => setPhase("revealed")}>Reveal answers</button>
                  </>
                )}
                {phase === "revealed" && (
                  <>
                    <span className="pmsg">Answers are revealed. Discuss, then score.</span>
                    <button className="ghost" onClick={() => { setOpenedAt(Date.now()); setPhase("open"); }}>
                      Reopen
                    </button>
                  </>
                )}
              </div>

              {phase === "open" && (
                <div className="tracker">
                  {inject.roles.map((r) => {
                    const members = people.filter((p) => p.peran === r);
                    const qs = inject.questions.filter((q) => q.peran === r);
                    const done = members.filter((p) => qs.every((q) => p.answers?.[q.qid]));
                    const pct = members.length ? Math.round((done.length / members.length) * 100) : 0;
                    return (
                      <div key={r} className="trow">
                        <span className="dot" style={{ background: roleColor(r) }} />
                        <span className="tname">{unitOf(r)}</span>
                        <span className="tbar"><i style={{ width: `${pct}%`, background: roleColor(r) }} /></span>
                        <span className="tcount">{done.length}/{members.length}</span>
                        {members.length === 0 && <span className="tmiss">not joined</span>}
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
                  onClick={() => { setActiveIdx((i) => i - 1); setPhase("briefing"); }}>Previous</button>
                {activeIdx < model.injects.length - 1
                  ? <button className="primary" onClick={() => { setActiveIdx((i) => i + 1); setPhase("briefing"); }}>Next inject</button>
                  : <button className="primary" onClick={() => setScreen("report")}>Finish</button>}
              </div>
            </>
          )}
        </section>
      </main>
    </>
  );
}

/* --------------------------- host pieces --------------------------- */

function Countdown({ openedAt, limit }) {
  const [left, setLeft] = useState(limit);
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, limit - Math.floor((Date.now() - (openedAt || Date.now())) / 1000)));
    tick();
    const iv = setInterval(tick, 250);
    return () => clearInterval(iv);
  }, [openedAt, limit]);
  return <div className={`clock ${left <= 10 ? "urgent" : ""}`}>{fmt(left)}</div>;
}

function Lobby({ codes, people, model, roleColor, settings, label, unitOf, onBegin, injectId }) {
  const byRole = (r) => people.filter((p) => p.peran === r);
  return (
    <div className="lobby">
      <h2>Waiting room</h2>
      <p className="lede">
        Give each unit its own code. The code decides which questions they get.
      </p>
      <ul className="codelist big">
        {model.roles.map((r) => {
          const code = Object.keys(codes).find((c) => codes[c] === r);
          const members = byRole(r);
          return (
            <li key={r}>
              <span className="dot" style={{ background: roleColor(r) }} />
              <span className="cname">{r}</span>
              <b className="bigcode">{code}</b>
              <span className={members.length ? "tin" : "tmiss"}>
                {members.length
                  ? members.map(label).join(", ")
                  : "waiting"}
              </span>
            </li>
          );
        })}
      </ul>
      <button className="primary big" onClick={onBegin}>
        {injectId ? `Continue to inject ${injectId}` : "Begin the exercise"}
      </button>
      {people.length === 0 && (
        <p className="hint">
          No devices yet. You can still continue — anyone joining later picks up
          from wherever you are.
        </p>
      )}
    </div>
  );
}

function RoomPanel({ codes, people, model, roleColor, label, unitOf, onClose, onLobby }) {
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
                  {members.length ? members.map(label).join(", ") : "waiting"}
                </span>
              </li>
            );
          })}
        </ul>
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

function Participant({ onExit }) {
  const [me, setMe] = useState(null);
  const [codeIn, setCodeIn] = useState("");
  const [nameIn, setNameIn] = useState("");
  const [foundPeran, setFoundPeran] = useState("");
  const [deck, setDeck] = useState(null);
  const [state, setState] = useState(null);
  const [settings, setSettings] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [msg, setMsg] = useState("");
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
    else if (m.t === "gone" || m.t === "ended") { lsDel(K_ME); setMe(null); setDeck(null); setState(null); }
  }, []);
  const { send, status } = useSocket(onMsg);

  useEffect(() => {
    const saved = lsGet(K_ME);
    if (saved?.roomId && saved?.pid) {
      setMe(saved);
      send({ t: "rejoin", roomId: saved.roomId, pid: saved.pid });
    }
    setBooted(true);
  }, [send]);

  const leave = () => { nukeAll(); setMe(null); setDeck(null); setState(null); onExit(); };

  if (!booted) return <div className="boot">Loading</div>;

  /* ---- join ---- */
  if (!me || !deck) {
    return (
      <>
        <Bar left="Join" onExit={onExit} conn={status} />
        <main className="load">
          <div className="loadinner narrow">
            <h1>Join</h1>
            <label className="fld">
              <span>Your unit's code</span>
              <input className="codein" value={codeIn} maxLength={8} placeholder="ABCD"
                onChange={(e) => { setCodeIn(e.target.value.toUpperCase()); setFoundPeran(""); }}
                onBlur={() => codeIn.length >= 4 && send({ t: "peek", code: codeIn })} />
            </label>
            {foundPeran && <div className="found">You'll join as <b>{foundPeran}</b></div>}
            <label className="fld">
              <span>Name on this device (optional)</span>
              <input value={nameIn} onChange={(e) => setNameIn(e.target.value)}
                placeholder="Who is operating it" />
            </label>
            {msg && <div className="err">{msg}</div>}
            <button className="primary big" disabled={codeIn.length < 4}
              onClick={() => send({ t: "join", code: codeIn, name: nameIn })}>
              Join
            </button>
            {me && (
              <button className="link small" onClick={leave}>
                Clear the session saved on this device
              </button>
            )}
          </div>
        </main>
      </>
    );
  }

  const phase = state?.phase || "lobby";
  const inject = deck.injects?.[state?.activeIdx ?? 0];
  const mine = inject?.questions || [];
  const limit = state?.limit ?? inject?.limit ?? settings?.timeLimit ?? 0;

  return (
    <>
      <Bar left={<><b>{me.peran}</b>{settings?.mode === "auto" && settings?.leaderboard && <> · {me.total || 0} pts</>}</>}
        onExit={leave} exitLabel="Leave" conn={status} />
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
                  <p className="muted">This inject does not involve your unit. Listen in.</p>
                </div>
              ) : (
                <>
                  {limit > 0 && settings?.mode === "auto" && <Countdown openedAt={state.openedAt} limit={limit} />}
                  {mine.map((q) => {
                    const sent = me.answers?.[q.qid];
                    const isMC = q.type === "choice" && q.choices?.length && settings.mode === "auto";
                    return (
                      <div className="qcard" key={q.qid}>
                        <p className="qtext">{q.text}</p>
                        {isMC ? (
                          <div className="opts">
                            {q.choices.map((c, i) => (
                              <button key={i}
                                className={`opt ${sent?.choice === i ? "picked" : ""}`}
                                disabled={!!sent}
                                onClick={() => send({ t: "answer", roomId: me.roomId, pid: me.pid, answers: { [q.qid]: i } })}>
                                <span className="oletter">{String.fromCharCode(65 + i)}</span>
                                {c.text}
                              </button>
                            ))}
                            {sent && <p className="sent">Locked in.</p>}
                          </div>
                        ) : (
                          <>
                            <textarea rows={4} placeholder="Your answer"
                              value={drafts[q.qid] ?? sent?.text ?? ""}
                              onChange={(e) => setDrafts((d) => ({ ...d, [q.qid]: e.target.value }))} />
                            <button className="primary"
                              onClick={() => send({ t: "answer", roomId: me.roomId, pid: me.pid, answers: { [q.qid]: drafts[q.qid] ?? "" } })}>
                              Send
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
                            <p className="rline">No answer sent</p>
                          </div>
                        );
                        return (
                          <div className={`rescard ${a.correct ? "ok" : a.correct === false ? "no" : ""}`} key={q.qid}>
                            <p className="qtext">{q.text}</p>
                            <p className="rpick">You chose: {a.text}</p>
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
            <thead><tr><th>Peran</th><th>Correct</th><th>Points</th><th>Quality</th></tr></thead>
            <tbody>
              {Object.entries(byRole).map(([role, d]) => (
                <tr key={role}>
                  <td><span className="dot" style={{ background: roleColor(role) }} />{role}</td>
                  <td>{d.mc ? `${d.correct}/${d.mc}` : "—"}</td>
                  <td>{d.pts ? d.pts.toLocaleString() : "—"}</td>
                  <td>{d.scored ? (d.sum / d.scored).toFixed(1) : "—"}</td>
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

function Bar({ left, right, onExit, exitLabel = "Exit", conn }) {
  return (
    <header className="bar">
      <div className="brand"><span className="mark" aria-hidden="true" />{left}</div>
      <div className="barright">
        <span className="build" title="Build tag">{BUILD}</span>
        {conn && conn !== "live" && <span className="offline">Reconnecting</span>}
        {right}
        <button className="ghost" onClick={onExit}>{exitLabel}</button>
      </div>
    </header>
  );
}

/* ============================== CSS ============================== */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:wght@400;500&display=swap');

.ttx{--paper:#EEF0EC;--panel:#FFFFFF;--ink:#161C20;--ink2:#3C4750;--muted:#6B7671;
  --rule:#D3D8D2;--rule2:#E4E8E3;--accent:#0F5A5E;--good:#1F6B4A;--bad:#9B3A22;
  --sans:'IBM Plex Sans',system-ui,-apple-system,sans-serif;
  --serif:'IBM Plex Serif',Georgia,serif;--mono:'IBM Plex Mono',ui-monospace,monospace;
  font-family:var(--sans);color:var(--ink);background:var(--paper);min-height:100vh;
  font-size:15px;line-height:1.5}
.ttx *{box-sizing:border-box}
.ttx button{font:inherit;cursor:pointer;border:none;background:none;color:inherit;text-align:inherit}
.ttx :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}
.ttx textarea,.ttx input[type=text],.ttx input[type=number],.ttx input:not([type]){font:inherit;color:inherit;
  width:100%;background:var(--panel);border:1px solid var(--rule);border-radius:4px;padding:9px 11px}
.ttx textarea{resize:vertical}
.ttx textarea:focus,.ttx input:focus{border-color:var(--accent);outline:none}
.ttx h1{font-size:26px;font-weight:600;letter-spacing:-.01em;margin:0 0 10px}
.ttx h2{font-size:21px;font-weight:600;margin:2px 0 6px;letter-spacing:-.01em}
.ttx h3{font-size:13px;font-weight:600;color:var(--ink2);margin:30px 0 10px}
.ttx code{font-family:var(--mono);font-size:12.5px;background:var(--rule2);padding:1px 5px;border-radius:3px}
.boot{padding:60px;text-align:center;color:var(--muted)}
.small{font-size:13px}
.muted{color:var(--muted)}

.crash{max-width:480px;margin:80px auto;padding:0 24px;text-align:center}
.crash pre{text-align:left;background:var(--panel);border:1px solid var(--rule);border-radius:5px;
  padding:12px;font-size:12px;overflow:auto;margin:16px 0;color:var(--bad)}

.bar{display:flex;align-items:center;gap:16px;padding:0 18px;height:52px;background:var(--panel);
  border-bottom:1px solid var(--rule);position:sticky;top:0;z-index:5}
.brand{display:flex;align-items:center;gap:9px;font-size:14px}
.mark{width:9px;height:16px;background:var(--accent);border-radius:1px;flex:none}
.barright{margin-left:auto;display:flex;align-items:center;gap:10px;font-size:12px;color:var(--muted)}
.offline{color:var(--bad);font-weight:500}
.code{font-family:var(--mono);color:var(--ink)}
.ttx .ghost{padding:5px 12px;border:1px solid var(--rule);border-radius:4px;font-size:13px;color:var(--ink2);width:auto}
.ttx .ghost:hover:not(:disabled){border-color:var(--muted)}
.ttx .ghost:disabled{opacity:.4;cursor:default}
.ttx .primary{padding:8px 18px;background:var(--accent);color:#fff;border-radius:4px;font-size:14px;font-weight:500;width:auto}
.ttx .primary:hover:not(:disabled){background:#0C4A4D}
.ttx .primary:disabled{opacity:.4;cursor:default}
.ttx .primary.big{width:100%;padding:13px;margin-top:20px;font-size:15px}
.ttx .danger{padding:8px 16px;border:1px solid #D8AFA3;color:var(--bad);border-radius:4px;font-size:13px}
.ttx .link{color:var(--accent);text-decoration:underline;text-underline-offset:3px;font-size:14px}

.landing{display:flex;justify-content:center;padding:70px 24px}
.landinner{max-width:470px;width:100%}
.landinner .mark{display:block;margin-bottom:20px;height:22px}
.lede{color:var(--ink2);margin:0 0 22px;max-width:58ch}
.lede b{font-weight:600;font-family:var(--mono);font-size:13px}
.picks{display:grid;gap:10px}
.ttx .pick{text-align:left;background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:16px 18px}
.ttx .pick:hover{border-color:var(--accent)}
.pick b{display:block;font-size:15.5px;font-weight:600;margin-bottom:3px}
.pick span{font-size:13.5px;color:var(--muted)}
.ttx .landinner .link{margin-top:22px;display:inline-block}

.load{display:flex;justify-content:center;padding:48px 24px 80px}
.loadinner{max-width:560px;width:100%}
.loadinner.narrow{max-width:370px}
.loadinner.wide{max-width:640px}
.drop{border:1.5px dashed var(--rule);border-radius:6px;padding:34px;text-align:center;background:var(--panel);
  display:flex;flex-direction:column;align-items:center;gap:12px}
.or{color:var(--muted);font-size:13px}
.err{margin-top:14px;padding:10px 13px;background:#FBEDEA;border-left:3px solid var(--bad);
  border-radius:0 4px 4px 0;font-size:13.5px;color:#7A2C1D}
.found{margin:-6px 0 16px;padding:9px 12px;background:#F1F8F3;border-left:3px solid var(--good);
  border-radius:0 4px 4px 0;font-size:14px;color:var(--good)}
.ttx .load .link{margin-top:18px;display:inline-block}
.fld{display:block;margin-bottom:16px}
.fld>span{display:block;font-size:13px;font-weight:500;color:var(--ink2);margin-bottom:5px}
.codein{font-family:var(--mono);font-size:24px;letter-spacing:.24em;text-align:center;text-transform:uppercase}
.warn{font-size:12.5px;background:#FCF6E8;border:1px solid #E8D9AE;border-radius:4px;padding:9px 12px;margin-bottom:20px}
.warn summary{cursor:pointer;font-weight:500;color:#7A5C12}
.warn ul{margin:8px 0 0;padding-left:16px;color:#6B5514;line-height:1.5}
.warn li{margin-bottom:5px}
.warnhint{color:#8A6A14}

.setgrid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.span2{grid-column:1/-1}
.seg2{display:flex;gap:3px}
.seg2 button{flex:1;padding:8px 12px;border:1px solid var(--rule);border-radius:4px;font-size:13.5px;color:var(--muted);background:var(--panel)}
.seg2 button.on{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:500}
.chk{display:flex;gap:10px;align-items:flex-start;cursor:pointer}
.chk input{width:16px;height:16px;margin-top:2px;flex:none;accent-color:var(--accent)}
.chk b{display:block;font-size:14px;font-weight:500}
.chk em{display:block;font-style:normal;font-size:12.5px;color:var(--muted);margin-top:2px;line-height:1.45}
.hint{font-size:12.5px;color:var(--muted);margin:6px 0 0;line-height:1.5}

.codelist{list-style:none;margin:10px 0 0;padding:0;background:var(--panel);
  border:1px solid var(--rule);border-radius:5px;overflow:hidden}
.codelist li{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--rule2)}
.codelist li:last-child{border-bottom:none}
.cname{flex:1;font-size:14px;font-weight:500}
.cinput{width:110px;font-family:var(--mono);text-align:center;letter-spacing:.1em;text-transform:uppercase;padding:5px}
.codelist.big .bigcode{font-family:var(--mono);font-size:22px;font-weight:500;letter-spacing:.14em;color:var(--accent)}
.codelist.big li{padding:13px 16px}
.codelist.big .tin,.codelist.big .tmiss{min-width:130px;text-align:right;font-size:12.5px}

.run{display:grid;grid-template-columns:172px minmax(0,1fr);align-items:start}
.rail{position:sticky;top:52px;max-height:calc(100vh - 52px);overflow-y:auto;
  border-right:1px solid var(--rule);padding:14px 0 40px}
.cues{list-style:none;margin:0;padding:0}
.sikhead{font-size:11px;font-weight:600;color:var(--muted);padding:16px 14px 6px;
  border-top:1px solid var(--rule2);margin-top:8px}
.cues li:first-child.sikhead{border-top:none;margin-top:0;padding-top:4px}
.ttx .cue{width:100%;display:flex;align-items:center;gap:8px;padding:7px 14px;text-align:left;border-left:2px solid transparent}
.ttx .cue:hover{background:var(--rule2)}
.ttx .ttx .cue.current{background:var(--panel);border-left-color:var(--accent);font-weight:500}
.cueno{font-family:var(--mono);font-size:13px;min-width:24px}
.cuedots{display:flex;gap:3px}
.cuedots i{width:6px;height:6px;border-radius:50%;display:block}

.stage{padding:26px 32px 80px;max-width:800px}
.lobby{max-width:600px}
.stagehead{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px}
.eyebrow{font-size:12px;color:var(--muted)}
.clock{font-family:var(--mono);font-size:26px;color:var(--ink2);font-variant-numeric:tabular-nums;text-align:center}
.clock.urgent{color:var(--bad)}
.condition{font-family:var(--serif);font-size:18px;line-height:1.62;margin:0 0 18px;padding:18px 22px;
  background:var(--panel);border-left:3px solid var(--accent);border-radius:0 5px 5px 0;max-width:66ch}
.empty{color:var(--muted);font-style:italic;margin-bottom:18px}
.callon{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:16px;font-size:13px;color:var(--muted)}
.chip{color:#fff;background:var(--c);padding:3px 11px;border-radius:11px;font-size:12.5px;font-weight:500}
.phasebar{display:flex;align-items:center;gap:14px;padding:12px 16px;background:var(--panel);
  border:1px solid var(--rule);border-radius:5px;margin-bottom:22px}
.pmsg{font-size:13.5px;color:var(--muted);flex:1}

.tracker{background:var(--panel);border:1px solid var(--rule);border-radius:5px;overflow:hidden;margin-bottom:20px}
.trow{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--rule2);font-size:13.5px}
.trow:last-child{border-bottom:none}
.tname{font-weight:500;min-width:130px}
.tbar{flex:1;height:5px;background:var(--rule2);border-radius:3px;overflow:hidden;max-width:240px}
.tbar i{display:block;height:100%;transition:width .3s}
.tcount{font-family:var(--mono);font-size:12.5px;color:var(--muted)}
.tmiss{color:var(--muted);font-size:12.5px}
.tin{color:var(--good);font-size:12.5px}

.rolegroup{margin-bottom:24px}
.rolerule{font-size:13px;font-weight:600;color:var(--c);padding-bottom:6px;border-bottom:2px solid var(--c);margin-bottom:12px}
.qcard{background:var(--panel);border:1px solid var(--rule2);border-radius:5px;padding:15px 17px;margin-bottom:10px}
.qtext{margin:0 0 12px;font-size:15.5px;line-height:1.5;font-weight:500}

.dist{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:6px}
.dist li{display:flex;align-items:center;gap:10px;font-size:13.5px}
.dist .dlabel{flex:1;color:var(--ink2)}
.dist li.right .dlabel{color:var(--good);font-weight:500}
.dbar{width:120px;height:8px;background:var(--rule2);border-radius:4px;overflow:hidden}
.dbar i{display:block;height:100%;background:var(--muted)}
.dist li.right .dbar i{background:var(--good)}
.dn{font-family:var(--mono);font-size:12px;color:var(--muted);min-width:18px;text-align:right}
.who-list{list-style:none;margin:0;padding:10px 0 0;border-top:1px dashed var(--rule);display:grid;gap:5px}
.who-list li{display:flex;align-items:center;gap:10px;font-size:13px}
.who-list li span:first-child{flex:1}
.who-list li.ok span:first-child{color:var(--good)}
.who-list li.no span:first-child{color:var(--bad)}
.who-list .ms{font-family:var(--mono);font-size:12px;color:var(--muted)}
.who-list .pts{font-family:var(--mono);font-size:12.5px;font-weight:500;min-width:52px;text-align:right}
.who-list .none{color:var(--muted);font-style:italic}

.answers{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:8px}
.answers li{background:var(--paper);border-radius:4px;padding:9px 12px}
.answers .who{font-size:11.5px;font-weight:600;color:var(--muted);display:block;margin-bottom:3px}
.answers p{margin:0;font-family:var(--serif);font-size:14.5px;line-height:1.55}
.noanswer{margin:0 0 11px;color:var(--bad);font-size:13.5px;font-style:italic}
.qfoot{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap}
.dims{display:flex;gap:20px;flex-wrap:wrap}
.dim{display:flex;align-items:center;gap:7px}
.dimlab{font-size:11.5px;color:var(--muted);font-weight:500}
.scorer{display:flex;gap:3px}
.scorer button{width:27px;height:27px;border:1px solid var(--rule);border-radius:4px;font-family:var(--mono);font-size:13px;color:var(--muted)}
.scorer button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.scorelab{font-size:12.5px;color:var(--muted);min-width:76px}
.dseg{display:flex;gap:3px}
.dseg button{padding:5px 10px;border:1px solid var(--rule);border-radius:4px;font-size:12.5px;color:var(--muted);white-space:nowrap}
.dseg button.on{background:var(--c);border-color:var(--c);color:#fff;font-weight:500}
.ttx .reveal{font-size:13px;color:var(--accent);text-decoration:underline;text-underline-offset:3px}
.model{margin:12px 0 0;padding-top:12px;border-top:1px dashed var(--rule);white-space:pre-line;
  font-family:var(--serif);font-size:14.5px;line-height:1.6;color:var(--ink2)}

.decbar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:22px 0;padding:11px 14px;
  background:var(--panel);border:1px solid var(--rule);border-radius:5px;font-size:13px}
.decbar label{color:var(--ink2);font-weight:500}
.decbar input{width:56px;font-family:var(--mono);text-align:center;padding:4px 6px;background:var(--paper)}
.decbar .unit{color:var(--muted)}
.verdict{margin-left:auto;font-family:var(--mono);font-size:12.5px}
.ttx .undo{margin-left:auto;font-size:12.5px;color:var(--accent);text-decoration:underline;text-underline-offset:3px}
.ttx .decbar .verdict+.undo{margin-left:0}
.decbar.ontime{border-color:#9CC0AE;background:#F1F8F3}
.decbar.ontime .verdict{color:var(--good)}
.decbar.late{border-color:#E0A99B;background:#FCF2EF}
.decbar.late .verdict{color:var(--bad)}
.notes label{display:block;font-size:13px;font-weight:500;color:var(--ink2);margin-bottom:6px}
.nav{display:flex;justify-content:space-between;margin-top:26px;padding-top:20px;border-top:1px solid var(--rule)}

.pmain{display:flex;justify-content:center;padding:20px 16px 70px}
.pinner{max-width:540px;width:100%}
.standby{text-align:center;padding:56px 20px}
.standby.small{padding:26px 20px}
.pulse{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--accent);
  margin-bottom:14px;animation:beat 1.8s ease-in-out infinite}
@keyframes beat{0%,100%{opacity:.25}50%{opacity:1}}
.bigpts{font-family:var(--mono);font-size:32px;font-weight:500;color:var(--accent);margin:14px 0 0}
.opts{display:grid;gap:8px}
.ttx .opt{display:flex;align-items:center;gap:11px;text-align:left;padding:14px 15px;background:var(--paper);
  border:1.5px solid var(--rule);border-radius:6px;font-size:15px;line-height:1.4}
.ttx .opt:hover:not(:disabled){border-color:var(--accent)}
.ttx .opt:disabled{opacity:.5;cursor:default}
.ttx .opt.picked{border-color:var(--accent);background:#E8F1F0;opacity:1;font-weight:500}
.oletter{font-family:var(--mono);font-size:12px;font-weight:500;width:22px;height:22px;flex:none;
  display:grid;place-items:center;border-radius:4px;background:var(--panel);border:1px solid var(--rule)}
.ttx .ttx .opt.picked .oletter{background:var(--accent);border-color:var(--accent);color:#fff}
.sent{margin:9px 0 0;font-size:12.5px;color:var(--accent)}
.sentnote{text-align:center;font-size:13px;color:var(--accent);margin-top:10px}

.report{display:flex;justify-content:center;padding:32px 24px 90px}
.repinner{max-width:760px;width:100%}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:1px;background:var(--rule);
  border:1px solid var(--rule);border-radius:5px;overflow:hidden;margin:18px 0 8px}
.kpis div{background:var(--panel);padding:14px 15px}
.kpis b{display:block;font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.kpis span{font-size:11.5px;color:var(--muted);display:block;margin-top:3px}
.board{list-style:none;margin:0;padding:0;background:var(--panel);border:1px solid var(--rule);border-radius:5px;overflow:hidden}
.board li{display:flex;align-items:center;gap:11px;padding:11px 15px;border-bottom:1px solid var(--rule2);font-size:14px}
.board li:last-child{border-bottom:none}
.board li:first-child{background:#F6F9F5}
.rank{font-family:var(--mono);font-size:13px;color:var(--muted);width:20px}
.bname{flex:1}
.board b{font-family:var(--mono);font-variant-numeric:tabular-nums}
.tbl{width:100%;border-collapse:collapse;font-size:14px;background:var(--panel);
  border:1px solid var(--rule);border-radius:5px;overflow:hidden}
.tbl th{text-align:left;font-size:12px;font-weight:600;color:var(--muted);padding:9px 14px;border-bottom:1px solid var(--rule)}
.tbl td{padding:10px 14px;border-bottom:1px solid var(--rule2)}
.tbl tr:last-child td{border-bottom:none}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:8px;flex:none}
.repactions{display:flex;gap:12px;margin-top:30px;flex-wrap:wrap}
.mono{font-family:var(--mono);font-size:13px}
.cinput.narrow{width:74px}
.inlinetime{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted)}
.inlinetime input{width:66px;font-family:var(--mono);text-align:center;padding:4px 6px;background:var(--paper)}
.rk{font-family:var(--mono);font-size:11px;color:var(--muted);width:16px;flex:none}
.myresult{display:grid;gap:10px}
.rescard{background:var(--panel);border:1px solid var(--rule2);border-left:3px solid var(--muted);
  border-radius:0 5px 5px 0;padding:14px 16px}
.rescard.ok{border-left-color:var(--good)}
.rescard.no{border-left-color:var(--bad)}
.rescard.miss{border-left-color:var(--muted);opacity:.7}
.rpick{margin:0 0 6px;font-size:14px;color:var(--ink2)}
.rline{margin:0;font-size:13px;color:var(--muted)}
.rescard.ok .rline b{color:var(--good)}
.rescard.no .rline b{color:var(--bad)}
.build{font-family:var(--mono);font-size:11px;color:var(--muted);opacity:.7}
.build.big{margin:-14px 0 18px}
.phasetag{padding:2px 9px;border-radius:10px;background:var(--rule2);color:var(--ink2);font-size:11.5px;font-weight:500}
.scrim{position:fixed;inset:0;background:rgba(22,28,32,.34);z-index:20;display:flex;justify-content:flex-end}
.panel{background:var(--paper);width:min(440px,100%);height:100%;overflow-y:auto;padding:22px 24px 40px;
  border-left:1px solid var(--rule);box-shadow:-8px 0 28px rgba(0,0,0,.10)}
.phead{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.phead h2{margin:0}
.ttx .ghost.wide{width:100%;padding:10px;margin-top:20px;text-align:center}
@media (prefers-reduced-motion:no-preference){
  .panel{animation:slide .18s ease-out}
  @keyframes slide{from{transform:translateX(16px);opacity:.6}to{transform:none;opacity:1}}
}

@media (max-width:820px){
  .run{grid-template-columns:1fr}
  .rail{position:static;max-height:none;border-right:none;border-bottom:1px solid var(--rule)}
  .cues{display:flex;flex-wrap:wrap;gap:4px;padding:0 12px 12px}
  .sikhead{width:100%;padding:10px 2px 4px;border-top:none}
  .cue{width:auto;border:1px solid var(--rule);border-radius:4px;border-left-width:2px}
  .stage{padding:20px 16px 70px}
  .condition{font-size:16.5px;padding:15px 17px}
  .setgrid{grid-template-columns:1fr}
  .codelist.big li{flex-wrap:wrap}
  .phasebar{flex-wrap:wrap}
  .ttx .phasebar .primary{width:100%}
}
@media (prefers-reduced-motion:reduce){.ttx *{animation:none!important;transition:none!important}}
`;
