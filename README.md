# TTX Live

A facilitator-led tabletop exercise tool. Each unit answers privately on their
own device; the facilitator then reveals every answer at once so the room works
through them together.

One Node process serves the app and handles the live connections. No database.

---

## Run it locally

```bash
npm install
npm run build
npm start
```

Open http://localhost:3000

For UI work, `npm run dev` gives hot reload on port 5173 with the socket
proxied to 3000. Keep `npm start` running in a second terminal.

---

## Deploy it

Any host that runs a long-lived Node process works. **Netlify and Vercel will
not** — their functions are serverless and cannot hold a WebSocket open.

Render, Railway, and Fly.io all work. Render, as an example:

1. Push this folder to a GitHub repo
2. Render → New → Web Service → connect the repo
3. Build command: `npm install && npm run build`
4. Start command: `npm start`
5. Deploy

You get `your-app.onrender.com`. Add a custom domain in the dashboard if you
want the URL to look like it belongs to you.

**Before a real exercise:** Render's free tier sleeps after inactivity and takes
about a minute to wake. Either use a paid instance or load the page ten minutes
before people arrive.

---

## Running an exercise

**Facilitator** — open the URL, choose *Run an exercise*, load your inject
sheet. You get a four-character room code. Share it. When people have joined,
press *Begin*.

Each inject moves through four phases, and every device follows:

| Phase | What happens |
|---|---|
| Briefing | Scenario appears on all devices. Read it aloud. No questions yet. |
| Open | Questions unlock, only for the units they're addressed to. You see who's still outstanding, by name. |
| Reveal | Every answer appears at once, on your screen and theirs. This is the discussion. |
| Score | Set quality and decision per question, stamp the decision time. |

Scores and notes never leave your machine. They're kept in your browser's local
storage and go into the CSV at the end.

**Participants** — open the same URL, *Join an exercise*, enter the code, name,
and unit. They can edit and resend until you reveal, after which answers lock.

---

## The inject sheet

One row per question. First row must be the headers.

| Column | Required | Notes |
|---|---|---|
| Inject No. | yes | Groups rows into one inject |
| Condition | | Scenario text, read aloud |
| Peran | yes | The unit(s) asked. Several in one cell, or one per row — both work |
| Siklus | | Groups injects into phases |
| Question | yes | |
| Answer | | Model answer, `A.`/`B.` options, or comma-separated keywords |
| Window | | Decision window in minutes |

Indonesian header names are recognised too (Kondisi, Pertanyaan, Jawaban,
Tahap, Waktu).

Blank cells in Inject No., Condition, Siklus and Window carry down from the row
above, so merged-looking sheets import correctly.

Answer type is guessed per row: two or more lines starting `A.` or `1)` are
treated as choices; two or more short comma-separated fragments as keywords;
anything else as a model answer. For choices, mark the correct one with `*` or
`[x]` — otherwise they're shown for reference and you score manually.

---

## Operational notes

- **Rooms are in memory**, snapshotted to `rooms.json` every 30s and restored on
  restart. They expire 12 hours after last activity.
- **A refresh is safe** on both sides. The facilitator resumes from local
  storage; participants rejoin with their existing answers intact.
- **A dropped connection** shows "Reconnecting" in the header and retries with
  backoff. It doesn't fail silently.
- **Set `SNAPSHOT_PATH`** to a mounted volume if your host has ephemeral disk
  and you want snapshots to survive a redeploy.

## Before you use real content

There's no authentication. Anyone with the URL and a four-character code can
join and read the scenario and every answer.

That's fine for an internal exercise on a URL you haven't published. It is not
fine if the injects name real systems and the answers document where controls
fail — which is exactly what a useful TTX produces.

If it needs to be locked down, the two smallest additions are a shared password
on the join screen, or hosting it inside the corporate network instead of on a
public PaaS. Worth deciding before the first real run, not after.
