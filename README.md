# ♠ Hold'em — Multiplayer Texas Hold'em

A real-time, multiplayer Texas Hold'em poker web app. Pure **vanilla HTML / CSS / JS**
on the frontend, **Supabase** for the database + realtime sync, and deployable as a
**static site on Vercel** (no Node server required).

Host a table, share a link, and play a full game in the browser — deal → pre-flop →
flop → turn → river → showdown — with automatic winner detection and hand naming
("Full House", "Flush", …), blinds, side pots and all-ins.

---

## ✨ Features

- **Shareable rooms** — the host creates a table and gets a link like `/game.html?room=ABC123`.
- **Lobby + buy-in** — players open the link, pick a name + buy-in, and take a seat (2–8 players).
- **Full betting** — fold / check / call / raise (with slider), small & big blinds.
- **Complete hand flow** — pre-flop, flop, turn, river, showdown.
- **Real-time** — every action is pushed to all players via Supabase Realtime.
- **Automatic winner** — best 5-of-7 hand evaluation, correct **side pots** for all-ins,
  ties split evenly, hand announced by name.
- **Dark green felt table** with CSS playing cards, dealer button, turn highlight and
  pot/chip displays.

---

## 🗂 Project structure

```
.
├── index.html        # Home: create a game or join by code
├── game.html         # The poker table + lobby + join modal
├── css/style.css     # Dark casino theme, felt table, cards
├── js/
│   ├── engine.js     # Pure poker rules: deck, hand eval, betting state machine
│   ├── supabase.js   # Supabase client + all DB / Realtime calls
│   └── game.js        # Orchestration: host game loop, realtime sync, UI rendering
├── schema.sql        # Supabase tables, policies & realtime setup
└── vercel.json       # Static deploy config
```

### How the architecture works

- The entire game state (deck, community cards, pot, whose turn, hole cards, etc.) is
  stored as a single **JSONB blob** in the `rooms.state` column.
- **Only the host/dealer client runs the game logic** (`engine.js`). It reads moves,
  applies the rules and writes the new state back to the database.
- Other players never compute anything: when it's their turn they write a
  `pending_action` (`{ action, amount }`) to their own `players` row. The host picks it
  up via Realtime, validates it, and advances the game.
- Everyone subscribes to row changes on `rooms` + `players` and re-renders on any update.

---

## 🚀 Setup

### 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) → **New project**.
2. Open **SQL Editor → New query**, paste the contents of [`schema.sql`](./schema.sql),
   and **Run**. This creates the `rooms` and `players` tables, opens up access for the
   anon key, and enables Realtime.
3. Go to **Project Settings → API** and copy your **Project URL** and **anon public key**.

### 2. Add your keys

Open [`js/supabase.js`](./js/supabase.js) and replace the placeholders near the top:

```js
const SUPABASE_URL      = localStorage.getItem('sb_url') || 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = localStorage.getItem('sb_key') || 'YOUR_SUPABASE_ANON_KEY';
```

> Tip: you can also set them at runtime without editing the file by running
> `localStorage.setItem('sb_url', '...')` and `localStorage.setItem('sb_key', '...')`
> in the browser console.

### 3. Run locally

It's a static site, so any static file server works:

```bash
# Python
python3 -m http.server 5173
# or Node
npx serve .
```

Then open <http://localhost:5173>. Open the shared link in multiple tabs / devices to
test multiplayer.

### 4. Deploy to Vercel

```bash
npm i -g vercel   # if you don't have it
vercel            # from the project root, accept defaults
```

There's no build step — Vercel just serves the static files. The included
[`vercel.json`](./vercel.json) is enough.

---

## 🎮 How to play

1. **Host:** on the home page, choose **Create Game**, enter your name, buy-in and
   blinds, then **Create Table**.
2. **Share** the lobby link (Copy button) with friends.
3. **Players** open the link, enter a name + buy-in, and take a seat.
4. The **host** clicks **Start Game** (needs 2+ players).
5. Play hands: act on your turn with **Fold / Check / Call / Raise**. The pot, blinds and
   community cards update live. The winner of each hand is announced with the hand name,
   and a new hand starts automatically. Last player with chips wins the game.

---

## ⚠️ Notes & limitations (it's a portfolio project)

- **No authentication / no real privacy.** Because all game logic runs on the client and
  the full state (including the deck and everyone's hole cards) lives in a row that any
  client can read, this is *not* cheat-proof. The UI only shows you your own cards, but a
  determined player could read the database. For a production game you'd move the dealer
  logic to a trusted server (e.g. a Supabase Edge Function) and use Row Level Security to
  hide private data.
- **The host must stay connected** — they run the dealer loop. If the host closes the tab,
  the current hand pauses until they return.
- The permissive RLS policies in `schema.sql` let the public anon key read/write freely,
  which is fine for a friendly game but should be tightened for anything serious.

---

## 🧠 The poker engine

`js/engine.js` is completely standalone (no DOM, no network) and can be unit-tested with
Node by shimming `window`:

```bash
node -e "global.window={}; require('./js/engine.js'); console.log(window.PokerEngine.HAND_NAMES)"
```

It handles deck shuffling, dealing, blinds (including heads-up rules), the full betting
state machine, best-5-of-7 hand ranking, and side-pot construction for all-ins.
