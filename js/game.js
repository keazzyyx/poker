/* =============================================================================
 * game.js — Orchestration, networking glue and UI for the poker table
 * -----------------------------------------------------------------------------
 * Responsibilities:
 *   1. Join flow (read ?room=CODE, register the player).
 *   2. Subscribe to Supabase Realtime and keep a local copy of room + players.
 *   3. HOST ONLY: run the game loop — start hands, read players' pending moves,
 *      apply the rules via PokerEngine, write the new state back, rotate dealer,
 *      pay out, and advance to the next hand.
 *   4. Render the lobby and the table for everyone.
 *
 * Non-host clients never run game logic. When it is their turn they simply write
 * a `pending_action`; the host reads it and updates the authoritative state.
 * ========================================================================== */
(function () {
  'use strict';

  const Engine = window.PokerEngine;

  // ---- Local session state ------------------------------------------------
  const me = DB.clientId();
  const roomCode = new URLSearchParams(location.search).get('room');

  let room = null;        // current rooms row
  let players = [];        // current players rows
  let myPlayer = null;     // my row (null until I join)
  let isHost = false;
  let channel = null;

  // Host loop guards.
  let processing = false;  // prevents overlapping async ticks
  let scheduledForHand = null; // handNumber we've already queued a "next hand" for

  // Action-bar state. `pendingMove` is an optimistic lock so the controls stay
  // hidden between clicking and the host applying the move (prevents the bar
  // flickering back and double-submits). `shownSig` is the turn the controls are
  // currently configured for, so re-renders don't reset a slider mid-drag.
  let pendingMove = null;  // { sig, seen } for the move I just submitted
  let shownSig = null;

  // ---- Tiny DOM helpers ----------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const show = (id) => $(id).classList.remove('hidden');
  const hide = (id) => $(id).classList.add('hidden');

  // ---- Boot ----------------------------------------------------------------
  async function init() {
    if (!DB.configured) {
      showFatal(
        'Supabase is not configured. Open js/supabase.js and add your project ' +
        'URL and anon key (see README.md).'
      );
      return;
    }
    if (!roomCode) {
      showFatal('No room code in the URL. Start from the home page.');
      return;
    }

    try {
      room = await DB.getRoomByCode(roomCode);
    } catch (e) {
      showFatal('Could not reach Supabase: ' + e.message);
      return;
    }
    if (!room) {
      showFatal('Room "' + roomCode + '" was not found.');
      return;
    }

    players = await DB.getPlayers(room.id);
    myPlayer = players.find((p) => p.id === me) || null;
    isHost = room.host_id === me;

    // Subscribe before rendering so we never miss an update.
    channel = DB.subscribe(room.id, { onRooms: onChange, onPlayers: onChange });

    // Safety-net poll in case a realtime event is ever dropped.
    setInterval(() => reload().catch(() => {}), 4000);

    if (!myPlayer) {
      openJoinModal();
    } else {
      render();
      if (isHost) hostTick();
    }
    wireControls();
  }

  // Re-fetch everything from the DB, then re-render and (if host) run the loop.
  async function reload() {
    const [r, ps] = await Promise.all([
      DB.getRoomByCode(roomCode),
      DB.getPlayers(room.id),
    ]);
    if (r) room = r;
    players = ps;
    myPlayer = players.find((p) => p.id === me) || myPlayer;
    render();
    if (isHost) hostTick();
  }

  // Any realtime event simply triggers a reload (cheap at this scale).
  function onChange() {
    reload().catch((e) => console.error(e));
  }

  // =========================================================================
  // JOIN FLOW
  // =========================================================================
  function openJoinModal() {
    show('join-view');
    hide('lobby-view');
    hide('table-view');
    $('join-room-code').textContent = roomCode;
  }

  async function submitJoin() {
    const username = $('join-username').value.trim() || 'Player';
    const buyIn = Math.max(1, parseInt($('join-buyin').value, 10) || 1000);

    // Pick the lowest free seat (max 8 players).
    const used = new Set(players.map((p) => p.seat));
    let seat = 0;
    while (used.has(seat)) seat++;
    if (seat > 7) {
      $('join-error').textContent = 'This table is full (8 players max).';
      return;
    }

    myPlayer = await DB.upsertPlayer({
      id: me,
      room_id: room.id,
      username,
      chips: buyIn,
      buy_in: buyIn,
      seat,
      is_host: false,
      connected: true,
      pending_action: null,
    });

    hide('join-view');
    await reload();
  }

  // =========================================================================
  // HOST GAME LOOP
  // =========================================================================
  function nameMap(rows) {
    const m = {};
    for (const p of rows) m[p.id] = p.username;
    return m;
  }

  // Host clicks "Start Game" in the lobby.
  async function startGame() {
    const seated = players
      .filter((p) => p.chips > 0)
      .sort((a, b) => a.seat - b.seat);
    if (seated.length < 2) return;

    const seats = seated.map((p) => ({ id: p.id, seat: p.seat, chips: p.chips }));
    const state = Engine.startHand(
      seats,
      seats[0].seat,
      room.small_blind,
      room.big_blind,
      1
    );
    state.playerNames = nameMap(players);

    // Clear any leftover pending actions, then flip the room to "playing".
    await Promise.all(
      players.map((p) => DB.updatePlayer(p.id, room.id, { pending_action: null }))
    );
    await DB.updateRoom(room.id, { status: 'playing', state });
  }

  // Runs after every change while the host is connected.
  async function hostTick() {
    if (!isHost || processing) return;
    if (!room || room.status !== 'playing' || !room.state) return;
    processing = true;
    try {
      const state = room.state;

      // Hand is over — settle chips, then queue the next hand.
      if (state.phase === 'showdown') {
        if (!state.settled) {
          for (const id in state.players) {
            await DB.updatePlayer(id, room.id, { chips: state.players[id].stack });
          }
          state.settled = true;
          await DB.updateRoom(room.id, { state });
        }
        scheduleNextHand(state.handNumber);
        return;
      }

      // Find the player whose turn it is and who has submitted a move.
      // NOTE: we deliberately do NOT bulk-clear other players' pending_actions.
      // The host's snapshot can lag a tick behind a player's submission, and
      // clearing on a stale `currentSeat` would drop a valid in-flight move.
      // A move is only ever consumed (and cleared) for the player on turn.
      const acting = players.find(
        (p) =>
          p.pending_action &&
          state.players[p.id] &&
          state.players[p.id].seat === state.currentSeat &&
          state.players[p.id].status === 'active'
      );

      if (acting) {
        const mv = acting.pending_action;
        const currentSig = turnSignature(state);

        // Ignore (and clear) a move tagged for a different decision point — it's
        // a stale submission, e.g. a duplicate or one made against old state.
        if (mv.sig && mv.sig !== currentSig) {
          await DB.updatePlayer(acting.id, room.id, { pending_action: null });
          return;
        }

        state.playerNames = nameMap(players);
        Engine.applyAction(state, acting.id, mv.action, mv.amount);
        // Clear the consumed move first, then publish the new state, so clients
        // never momentarily see "my move applied" with the move still pending.
        await DB.updatePlayer(acting.id, room.id, { pending_action: null });
        await DB.updateRoom(room.id, { state });
      }
    } catch (e) {
      console.error('hostTick error', e);
    } finally {
      processing = false;
    }
  }

  function scheduleNextHand(handNumber) {
    if (scheduledForHand === handNumber) return;
    scheduledForHand = handNumber;
    setTimeout(() => {
      scheduledForHand = null;
      nextHand().catch((e) => console.error(e));
    }, 6500);
  }

  async function nextHand() {
    if (!isHost) return;
    const fresh = await DB.getPlayers(room.id);
    const alive = fresh.filter((p) => p.chips > 0).sort((a, b) => a.seat - b.seat);

    // One player left with chips → that's the champion.
    if (alive.length <= 1) {
      const champ = alive[0];
      const finalState = Object.assign({}, room.state, {
        finished: true,
        message: champ ? `${champ.username} wins the game! 🏆` : 'Game over',
      });
      await DB.updateRoom(room.id, { status: 'finished', state: finalState });
      return;
    }

    // Rotate the dealer button to the next live seat.
    const seatList = alive.map((p) => p.seat);
    const prevDealer = room.state ? room.state.dealerSeat : seatList[0];
    const newDealer = nextSeatInList(seatList, prevDealer);

    const seats = alive.map((p) => ({ id: p.id, seat: p.seat, chips: p.chips }));
    const handNumber = (room.state ? room.state.handNumber : 0) + 1;
    const state = Engine.startHand(seats, newDealer, room.small_blind, room.big_blind, handNumber);
    state.playerNames = nameMap(fresh);

    await Promise.all(
      fresh.map((p) => DB.updatePlayer(p.id, room.id, { pending_action: null }))
    );
    await DB.updateRoom(room.id, { state });
  }

  function nextSeatInList(sortedSeats, fromSeat) {
    const idx = sortedSeats.indexOf(fromSeat);
    if (idx === -1) {
      // Previous dealer is gone — first seat after them (wrapping).
      return sortedSeats.find((s) => s > fromSeat) ?? sortedSeats[0];
    }
    return sortedSeats[(idx + 1) % sortedSeats.length];
  }

  // =========================================================================
  // PLAYER ACTIONS (everyone, including host)
  // =========================================================================
  // A signature that uniquely identifies the current decision point. If anything
  // about whose-turn-it-is changes, so does this string. Used both to tag a
  // submitted move and to know when a fresh turn starts.
  function turnSignature(state) {
    if (!state) return '';
    return [state.handNumber, state.phase, state.currentSeat, state.currentBet].join(':');
  }

  async function sendAction(action, amount) {
    if (!myPlayer || !room.state) return;
    // Ignore extra clicks once a move for this turn is already in flight.
    if (pendingMove) return;

    const sig = turnSignature(room.state);
    pendingMove = { sig, seen: false };
    hide('action-bar'); // lock the controls immediately

    try {
      await DB.setPendingAction(me, room.id, { action, amount: amount || 0, sig });
    } catch (e) {
      // Let the player try again if the write failed.
      pendingMove = null;
      console.error('sendAction failed', e);
      render();
      return;
    }
    if (isHost) hostTick();
  }

  // =========================================================================
  // RENDERING
  // =========================================================================
  function render() {
    if (!room) return;
    $('table-code').textContent = roomCode;

    if (room.status === 'lobby') {
      show('lobby-view');
      hide('table-view');
      renderLobby();
    } else {
      hide('lobby-view');
      show('table-view');
      renderTable();
    }
  }

  function renderLobby() {
    const list = $('lobby-players');
    list.innerHTML = players
      .sort((a, b) => a.seat - b.seat)
      .map(
        (p) => `
        <li class="lobby-player">
          <span class="seat-num">Seat ${p.seat + 1}</span>
          <span class="name">${escapeHtml(p.username)}${p.is_host ? ' 👑' : ''}${p.id === me ? ' (you)' : ''}</span>
          <span class="chips">${p.chips} chips</span>
        </li>`
      )
      .join('');

    $('lobby-code').textContent = roomCode;
    $('lobby-blinds').textContent = `Blinds: ${room.small_blind} / ${room.big_blind}`;
    $('share-link').value = location.origin + location.pathname + '?room=' + roomCode;

    const startBtn = $('start-game-btn');
    if (isHost) {
      show('start-game-btn');
      startBtn.disabled = players.length < 2;
      startBtn.textContent =
        players.length < 2 ? 'Waiting for players…' : `Start Game (${players.length})`;
    } else {
      hide('start-game-btn');
      $('lobby-wait').textContent = 'Waiting for the host to start the game…';
    }
  }

  function renderTable() {
    const state = room.state;
    if (!state) return;

    // Pot + community cards + status message.
    $('pot-amount').textContent = state.pot || 0;
    $('community').innerHTML = renderCommunity(state.community);
    $('table-message').textContent = state.lastActionText || state.message || '';

    // Winner / finished banner.
    const banner = $('winner-banner');
    if (room.status === 'finished') {
      banner.textContent = state.message;
      show('winner-banner');
    } else if (state.phase === 'showdown' && state.winners) {
      banner.textContent = state.message;
      show('winner-banner');
    } else {
      hide('winner-banner');
    }

    renderSeats(state);
    renderActionBar(state);
  }

  function renderCommunity(cards) {
    const slots = [];
    for (let i = 0; i < 5; i++) {
      slots.push(cards[i] ? cardHTML(cards[i]) : '<div class="card placeholder"></div>');
    }
    return slots.join('');
  }

  function renderSeats(state) {
    // Order players by seat, then rotate so that *I* always sit at the bottom.
    let ordered = Engine.playersBySeat(state).map((sp) => {
      const row = players.find((p) => p.id === sp.id) || {};
      return { ...sp, username: row.username || '—' };
    });
    const myIdx = ordered.findIndex((p) => p.id === me);
    if (myIdx > 0) ordered = ordered.slice(myIdx).concat(ordered.slice(0, myIdx));

    const n = ordered.length;
    const seatsEl = $('seats');
    seatsEl.innerHTML = ordered
      .map((p, i) => {
        // Place seats around an ellipse; i=0 (me) at the bottom centre.
        const angle = (90 + (i * 360) / n) * (Math.PI / 180);
        const x = 50 + 44 * Math.cos(angle);
        const y = 50 + 42 * Math.sin(angle);

        const isTurn = p.seat === state.currentSeat && p.status === 'active';
        const isDealer = p.seat === state.dealerSeat;
        const showdown = state.phase === 'showdown';
        const isWinner = state.winners && state.winners.some((w) => w.id === p.id);

        // Show real cards for me always, and for everyone at showdown (if not folded).
        const reveal = p.id === me || (showdown && p.status !== 'folded');
        const cards = (p.holeCards || [])
          .map((c) => (reveal ? cardHTML(c, false, 'mini') : cardHTML(null, true, 'mini')))
          .join('');

        const cls = [
          'seat',
          isTurn ? 'seat-turn' : '',
          p.status === 'folded' ? 'seat-folded' : '',
          isWinner ? 'seat-winner' : '',
          p.id === me ? 'seat-me' : '',
        ].join(' ');

        const statusTag =
          p.status === 'allin' ? '<span class="tag allin">ALL IN</span>' :
          p.status === 'folded' ? '<span class="tag fold">FOLDED</span>' : '';

        return `
          <div class="${cls}" style="left:${x}%;top:${y}%">
            ${isDealer ? '<span class="dealer-btn">D</span>' : ''}
            <div class="seat-cards">${cards}</div>
            <div class="seat-info">
              <div class="seat-name">${escapeHtml(p.username)}${p.id === me ? ' (you)' : ''}</div>
              <div class="seat-stack">${p.stack} ${statusTag}</div>
            </div>
            ${p.bet > 0 ? `<div class="seat-bet">${p.bet}</div>` : ''}
          </div>`;
      })
      .join('');
  }

  function renderActionBar(state) {
    const legal = Engine.legalActions(state, me);

    // Not my turn (or game not running): hide controls and release any lock.
    if (!legal || room.status !== 'playing') {
      pendingMove = null;
      shownSig = null;
      hide('action-bar');
      return;
    }

    const sig = turnSignature(state);

    // Reconcile the optimistic lock with what the server actually shows.
    if (pendingMove) {
      if (pendingMove.sig !== sig) {
        // The decision point moved on → my move was applied. Release the lock.
        pendingMove = null;
      } else {
        // Still the same turn. Track the move appearing then being consumed by
        // the host, so a rejected/cleared move re-enables the controls.
        if (myPlayer && myPlayer.pending_action) pendingMove.seen = true;
        if (pendingMove.seen && myPlayer && !myPlayer.pending_action) pendingMove = null;
      }
    }

    // While a move is pending (locally or on the server), keep controls hidden.
    if (pendingMove || (myPlayer && myPlayer.pending_action)) {
      hide('action-bar');
      return;
    }

    show('action-bar');

    // Check vs Call label.
    const callBtn = $('btn-call');
    if (legal.canCheck) {
      callBtn.textContent = 'Check';
      callBtn.dataset.action = 'check';
    } else {
      callBtn.textContent = `Call ${legal.callAmount}`;
      callBtn.dataset.action = 'call';
    }

    // Raise slider. Always available when the player has chips beyond a call —
    // even a short stack can shove all-in (slider min == max in that case).
    if (legal.canRaise) {
      show('raise-wrap');
      const slider = $('raise-slider');
      const lo = legal.minRaiseTo;
      const hi = legal.maxRaiseTo;
      slider.min = lo;
      slider.max = hi;
      slider.step = Math.max(1, Math.min(room.big_blind, hi - lo || 1));
      slider.disabled = hi <= lo;

      // Only reset the slider when this is a brand-new turn; otherwise preserve
      // whatever the player is currently dragging so re-renders don't reset it.
      if (shownSig !== sig) {
        slider.value = lo;
      } else {
        let v = parseInt(slider.value, 10);
        if (isNaN(v) || v < lo) v = lo;
        if (v > hi) v = hi;
        slider.value = v;
      }
      $('raise-amount').textContent = slider.value;

      const allInOnly = hi <= lo;
      $('btn-raise').textContent = allInOnly ? 'All in' : (state.currentBet > 0 ? 'Raise' : 'Bet');
    } else {
      hide('raise-wrap');
    }

    shownSig = sig;
  }

  // ---- Card markup ---------------------------------------------------------
  const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
  function rankLabel(r) {
    return { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[r] || String(r);
  }
  function cardHTML(card, faceDown, size) {
    const sz = size ? ' ' + size : '';
    if (faceDown || !card) return `<div class="card back${sz}"></div>`;
    const red = card.s === 'h' || card.s === 'd';
    return `
      <div class="card${sz}${red ? ' red' : ''}">
        <span class="rank">${rankLabel(card.r)}</span>
        <span class="suit">${SUIT_SYMBOL[card.s]}</span>
      </div>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function showFatal(msg) {
    const el = $('fatal');
    el.textContent = msg;
    show('fatal');
    hide('join-view');
    hide('lobby-view');
    hide('table-view');
  }

  // ---- Control wiring ------------------------------------------------------
  function wireControls() {
    $('join-submit').addEventListener('click', () => submitJoin().catch((e) => {
      $('join-error').textContent = e.message;
    }));
    $('start-game-btn').addEventListener('click', () => startGame().catch(console.error));

    $('btn-fold').addEventListener('click', () => sendAction('fold'));
    $('btn-call').addEventListener('click', (e) =>
      sendAction(e.target.dataset.action || 'call'));
    $('btn-raise').addEventListener('click', () =>
      sendAction('raise', parseInt($('raise-slider').value, 10)));

    $('raise-slider').addEventListener('input', (e) => {
      $('raise-amount').textContent = e.target.value;
    });

    $('copy-link').addEventListener('click', () => {
      const input = $('share-link');
      input.select();
      navigator.clipboard?.writeText(input.value);
      $('copy-link').textContent = 'Copied!';
      setTimeout(() => ($('copy-link').textContent = 'Copy'), 1500);
    });
  }

  document.addEventListener('DOMContentLoaded', () => init().catch(console.error));
})();
