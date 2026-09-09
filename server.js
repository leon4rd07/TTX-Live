/* ------------------------------------------------------------------ *
 * TTX server
 *
 * One exercise, many join codes. Each business unit gets its own code,
 * so entering JEXN puts you in Risk Management without picking from a
 * dropdown you could get wrong.
 *
 * Timing and scoring are computed here, not on the client. The clock
 * starts when the facilitator opens the inject, so a slow phone doesn't
 * change anyone's score.
 * ------------------------------------------------------------------ */

import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const SNAPSHOT = process.env.SNAPSHOT_PATH || join(__dirname, "rooms.json");
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.use(express.static(join(__dirname, "dist")));
app.get("/healthz", (_, res) => res.send("ok"));

/* ------------------------------ state ------------------------------ */

const rooms = new Map();      // roomId -> room
const codeIndex = new Map();  // JOIN CODE -> { roomId, peran }
const sockets = new Map();    // ws -> { roomId, pid, isHost }

const DEFAULTS = {
  mode: "auto",       // auto = multiple choice, scored. manual = facilitator scores
  timeLimit: 60,      // seconds to answer, 0 for none
  points: 1000,
  speedBonus: true,
  showNames: true,
  showUnits: true,
  leaderboard: true,
};

/* Answer time for an inject: its own override, else the global default. */
const limitFor = (room, injId) => {
  const v = room.times?.[injId];
  return v === "" || v == null ? room.settings.timeLimit : Number(v);
};

function restore() {
  if (!existsSync(SNAPSHOT)) return;
  try {
    const saved = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
    const now = Date.now();
    for (const r of saved) {
      if (now - r.touched > ROOM_TTL_MS) continue;
      rooms.set(r.id, r);
      for (const [code, peran] of Object.entries(r.codes || {})) {
        codeIndex.set(code, { roomId: r.id, peran });
      }
    }
    console.log(`restored ${rooms.size} room(s)`);
  } catch (e) {
    console.warn("restore failed:", e.message);
  }
}

let snapPending = false;
const markSnapshot = () => { snapPending = true; };
function snapshot() {
  try { writeFileSync(SNAPSHOT, JSON.stringify([...rooms.values()])); }
  catch (e) { console.warn("snapshot failed:", e.message); }
}

function dropRoom(room) {
  for (const code of Object.keys(room.codes || {})) codeIndex.delete(code);
  rooms.delete(room.id);
}

function sweep() {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (now - room.touched > ROOM_TTL_MS) dropRoom(room);
  }
}

function newCode() {
  let c;
  do { c = Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * 32)]).join(""); }
  while (codeIndex.has(c));
  return c;
}

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

function toRoom(roomId, msg, hostOnly = false) {
  const raw = JSON.stringify(msg);
  for (const [ws, s] of sockets) {
    if (s.roomId !== roomId) continue;
    if (hostOnly && !s.isHost) continue;
    if (ws.readyState === 1) ws.send(raw);
  }
}

/* Coalesce roster pushes: a burst of answers becomes one update. */
const dirty = new Set();
setInterval(() => {
  for (const id of dirty) {
    const room = rooms.get(id);
    if (room) toRoom(id, { t: "roster", people: Object.values(room.people) }, true);
  }
  dirty.clear();
}, 1200);
const markDirty = (id) => dirty.add(id);

/* Participants get only their own unit's questions — no peeking. */
function deckFor(room, peran) {
  return {
    roles: room.deck.roles,
    injects: room.deck.injects.map((i) => ({
      id: i.id, siklus: i.siklus, condition: i.condition, window: i.window,
      limit: limitFor(room, i.id),
      questions: i.questions
        .filter((q) => q.peran === peran)
        .map((q) => ({
          qid: q.qid, peran: q.peran, text: q.text, type: q.type,
          // never send which option is correct
          choices: (q.choices || []).map((c) => ({ text: c.text })),
        })),
    })),
  };
}

/* Quizizz-style: correct answers earn full points, faster ones earn more. */
function scoreAnswer(room, q, choiceIdx, elapsedMs, limit) {
  const s = room.settings;
  if (s.mode !== "auto" || q.type !== "choice") return { correct: null, points: 0 };
  const correctIdx = (q.choices || []).findIndex((c) => c.correct);
  if (correctIdx < 0) return { correct: null, points: 0 };
  const correct = choiceIdx === correctIdx;
  if (!correct) return { correct: false, points: 0 };
  if (!s.speedBonus || !limit) return { correct: true, points: s.points };
  const frac = Math.max(0, 1 - elapsedMs / (limit * 1000));
  return { correct: true, points: Math.round(s.points * (0.5 + 0.5 * frac)) };
}

/* --------------------------- connections --------------------------- */

wss.on("connection", (ws) => {
  sockets.set(ws, {});
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    const byId = m.roomId ? rooms.get(m.roomId) : null;
    if (byId) byId.touched = Date.now();

    switch (m.t) {
      /* ---- facilitator opens an exercise ---- */
      case "host": {
        const id = newCode() + newCode();
        const settings = { ...DEFAULTS, ...(m.settings || {}) };
        const codes = {};
        for (const [peran, wanted] of Object.entries(m.codes || {})) {
          let c = String(wanted || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
          if (!c || codeIndex.has(c) || codes[c]) c = newCode();
          codes[c] = peran;
        }
        for (const peran of m.deck.roles) {
          if (!Object.values(codes).includes(peran)) codes[newCode()] = peran;
        }
        const room = { id, deck: m.deck, settings, codes, people: {},
          times: m.times || {},
          state: { activeIdx: 0, phase: "lobby", openedAt: null, limit: null }, touched: Date.now() };
        rooms.set(id, room);
        for (const [c, p] of Object.entries(codes)) codeIndex.set(c, { roomId: id, peran: p });
        sockets.set(ws, { roomId: id, isHost: true });
        send(ws, { t: "hosted", roomId: id, codes, settings, times: room.times, state: room.state });
        markSnapshot();
        break;
      }

      /* ---- facilitator returns after a refresh ---- */
      case "rehost": {
        if (!byId) return send(ws, { t: "gone" });
        sockets.set(ws, { roomId: byId.id, isHost: true });
        send(ws, { t: "hosted", roomId: byId.id, codes: byId.codes,
          settings: byId.settings, times: byId.times || {}, state: byId.state });
        send(ws, { t: "roster", people: Object.values(byId.people) });
        break;
      }

      case "settings": {
        if (!byId || !sockets.get(ws)?.isHost) return;
        if (m.settings) byId.settings = { ...byId.settings, ...m.settings };
        if (m.times) byId.times = { ...byId.times, ...m.times };
        toRoom(byId.id, { t: "settings", settings: byId.settings, times: byId.times });
        markSnapshot();
        break;
      }

      /* ---- a code tells us both the room and the unit ---- */
      case "peek": {
        const hit = codeIndex.get(String(m.code || "").toUpperCase());
        if (!hit || !rooms.get(hit.roomId)) return send(ws, { t: "nosuch" });
        send(ws, { t: "codeok", peran: hit.peran });
        break;
      }

      case "join": {
        const code = String(m.code || "").toUpperCase();
        const hit = codeIndex.get(code);
        const room = hit && rooms.get(hit.roomId);
        if (!room) return send(ws, { t: "nosuch" });
        room.touched = Date.now();
        const pid = m.pid && room.people[m.pid]
          ? m.pid
          : `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        room.people[pid] = {
          pid, code, peran: hit.peran,
          name: (m.name || "").trim() || hit.peran,
          answers: room.people[pid]?.answers || {},
          total: room.people[pid]?.total || 0,
        };
        sockets.set(ws, { roomId: room.id, pid });
        send(ws, { t: "joined", pid, roomId: room.id, peran: hit.peran,
          deck: deckFor(room, hit.peran), state: room.state,
          settings: room.settings, me: room.people[pid] });
        markDirty(room.id);
        markSnapshot();
        break;
      }

      case "rejoin": {
        const room = byId;
        if (!room || !room.people[m.pid]) return send(ws, { t: "gone" });
        const me = room.people[m.pid];
        sockets.set(ws, { roomId: room.id, pid: m.pid });
        send(ws, { t: "joined", pid: m.pid, roomId: room.id, peran: me.peran,
          deck: deckFor(room, me.peran), state: room.state,
          settings: room.settings, me });
        break;
      }

      /* ---- phase changes; the answer clock starts here ---- */
      case "state": {
        if (!byId || !sockets.get(ws)?.isHost) return;
        const openedAt = m.phase === "open" ? Date.now() : byId.state.openedAt;
        const inj0 = byId.deck.injects[m.activeIdx];
        byId.state = { activeIdx: m.activeIdx, phase: m.phase, openedAt,
          limit: inj0 ? limitFor(byId, inj0.id) : byId.settings.timeLimit };
        toRoom(byId.id, { t: "state", ...byId.state });
        markDirty(byId.id);
        markSnapshot();
        break;
      }

      case "answer": {
        const room = byId;
        if (!room) return;
        const p = room.people[m.pid];
        if (!p) return;
        if (room.state.phase !== "open") return send(ws, { t: "locked" });

        const inj = room.deck.injects[room.state.activeIdx];
        const elapsed = room.state.openedAt ? Date.now() - room.state.openedAt : 0;
        const limit = limitFor(room, inj?.id);
        if (limit && elapsed > limit * 1000 + 2000) return send(ws, { t: "timeup" });

        for (const [qid, val] of Object.entries(m.answers || {})) {
          const q = inj?.questions.find((x) => x.qid === qid);
          if (!q || q.peran !== p.peran) continue;
          if (p.answers[qid]?.locked) continue; // one shot per question in auto mode

          if (q.type === "choice" && room.settings.mode === "auto") {
            const idx = Number(val);
            const { correct, points } = scoreAnswer(room, q, idx, elapsed, limit);
            p.answers[qid] = { choice: idx, text: q.choices[idx]?.text || "",
              ms: elapsed, correct, points, locked: true };
          } else {
            const text = String(val).trim();
            if (!text) continue;
            p.answers[qid] = { text, ms: elapsed, correct: null, points: 0, locked: false };
          }
        }
        for (const qid of Object.keys(m.answers || {})) {
          if (!p.answers[qid]) continue;
          const earlier = Object.values(room.people)
            .filter((o) => o.pid !== p.pid && o.answers[qid] && o.answers[qid].ms < p.answers[qid].ms).length;
          p.answers[qid].rank = earlier + 1;
        }
        p.total = Object.values(p.answers).reduce((a, b) => a + (b.points || 0), 0);
        send(ws, { t: "ack", me: p });
        markDirty(room.id);
        markSnapshot();
        break;
      }

      case "end": {
        if (!byId || !sockets.get(ws)?.isHost) return;
        toRoom(byId.id, { t: "ended" });
        dropRoom(byId);
        snapshot();
        break;
      }
    }
  });

  ws.on("close", () => sockets.delete(ws));
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); sockets.delete(ws); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

setInterval(() => { if (snapPending) { snapshot(); snapPending = false; } }, 8000);
setInterval(() => { sweep(); snapshot(); }, 60000);

app.get("*", (_, res) => res.sendFile(join(__dirname, "dist", "index.html")));

restore();
server.listen(PORT, () => console.log(`TTX server on :${PORT}`));
