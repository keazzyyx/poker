/* =============================================================================
 * engine.js — Pure Texas Hold'em rules engine
 * -----------------------------------------------------------------------------
 * This file has ZERO knowledge of Supabase, the DOM, or networking. It only
 * knows poker: how to build a deck, deal a hand, run the betting rounds, rank
 * 5-card hands and split the pot at showdown.
 *
 * The whole game lives in a single plain-object `state` that can be serialised
 * straight to JSON and stored in the database. The host client mutates this
 * state by calling the functions below, then saves it; everyone else just reads
 * it. Keeping the engine pure makes it easy to reason about and test.
 *
 * Everything is attached to `window.PokerEngine`.
 * ========================================================================== */
(function () {
  'use strict';

  // ---- Cards ---------------------------------------------------------------
  // A card is { r, s } where r is the rank 2..14 (14 = Ace) and s is the suit
  // character: 's' spades, 'h' hearts, 'd' diamonds, 'c' clubs.
  const SUITS = ['s', 'h', 'd', 'c'];
  const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

  const HAND_NAMES = [
    'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
    'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
  ];

  function makeDeck() {
    const deck = [];
    for (const s of SUITS) for (const r of RANKS) deck.push({ r, s });
    return deck;
  }

  // Fisher–Yates shuffle (in place) — the only source of randomness in the game.
  function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  // ---- Hand evaluation -----------------------------------------------------

  // Score a single 5-card hand. Returns { cat, score } where `score` is an array
  // that can be compared lexicographically (bigger = stronger). `cat` is the
  // category index into HAND_NAMES.
  function evaluate5(cards) {
    const ranks = cards.map((c) => c.r).sort((a, b) => b - a);
    const suits = cards.map((c) => c.s);
    const isFlush = suits.every((s) => s === suits[0]);

    const uniq = [...new Set(ranks)];
    let straightHigh = 0;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
      // Wheel: A-2-3-4-5, where the Ace plays low so the straight is 5-high.
      else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5;
    }

    // Group ranks by how many times they appear, then sort by count desc, then
    // rank desc. This drives pairs / trips / quads / full houses + their kickers.
    const counts = {};
    for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
    const groups = Object.entries(counts)
      .map(([r, c]) => [c, Number(r)])
      .sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    const countShape = groups.map((g) => g[0]); // e.g. [3,2] for a full house
    const kickers = groups.map((g) => g[1]);    // ranks ordered by group strength

    let cat;
    if (straightHigh && isFlush) cat = 8;
    else if (countShape[0] === 4) cat = 7;
    else if (countShape[0] === 3 && countShape[1] === 2) cat = 6;
    else if (isFlush) cat = 5;
    else if (straightHigh) cat = 4;
    else if (countShape[0] === 3) cat = 3;
    else if (countShape[0] === 2 && countShape[1] === 2) cat = 2;
    else if (countShape[0] === 2) cat = 1;
    else cat = 0;

    // For straights/straight-flushes the only tiebreaker is the high card.
    const score = (cat === 8 || cat === 4) ? [cat, straightHigh] : [cat, ...kickers];
    return { cat, score };
  }

  // Lexicographic compare of two score arrays. >0 means a is stronger.
  function cmpScore(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  }

  // All k-combinations of an array (used to pick the best 5 of 7 cards).
  function combinations(arr, k) {
    const result = [];
    (function pick(start, combo) {
      if (combo.length === k) { result.push(combo.slice()); return; }
      for (let i = start; i < arr.length; i++) {
        combo.push(arr[i]);
        pick(i + 1, combo);
        combo.pop();
      }
    })(0, []);
    return result;
  }

  // Best 5-card hand out of up to 7 cards. Returns { cat, score, name }.
  function evaluate(cards) {
    let best = null;
    for (const combo of combinations(cards, 5)) {
      const e = evaluate5(combo);
      if (!best || cmpScore(e.score, best.score) > 0) best = e;
    }
    best.name = best.name = handName(best);
    return best;
  }

  function handName(e) {
    if (e.cat === 8 && e.score[1] === 14) return 'Royal Flush';
    return HAND_NAMES[e.cat];
  }

  // ---- Seat / player helpers ----------------------------------------------
  // state.players is an object keyed by player id. Each entry:
  //   { seat, stack, holeCards, bet, contributed, status, hasActed }
  // status: 'active' (can act) | 'allin' | 'folded' | 'out' (no chips).

  function playersBySeat(state) {
    return Object.entries(state.players)
      .map(([id, p]) => ({ id, ...p }))
      .sort((a, b) => a.seat - b.seat);
  }

  // Players still contesting the pot (not folded, not sitting out).
  function inHand(state) {
    return playersBySeat(state).filter((p) => p.status === 'active' || p.status === 'allin');
  }

  // Find the next seat (clockwise) after `fromSeat` whose player can still act.
  function nextSeatToAct(state, fromSeat) {
    const seats = playersBySeat(state);
    if (seats.length === 0) return null;
    const startIdx = seats.findIndex((p) => p.seat === fromSeat);
    for (let i = 1; i <= seats.length; i++) {
      const p = seats[(startIdx + i) % seats.length];
      if (p.status === 'active') return p.seat;
    }
    return null;
  }

  // First seat clockwise after `fromSeat` that is still in the hand (any status).
  function nextInHandSeat(state, fromSeat) {
    const seats = playersBySeat(state);
    const startIdx = seats.findIndex((p) => p.seat === fromSeat);
    for (let i = 1; i <= seats.length; i++) {
      const p = seats[(startIdx + i) % seats.length];
      if (p.status === 'active' || p.status === 'allin') return p.seat;
    }
    return null;
  }

  function seatToId(state, seat) {
    for (const id in state.players) if (state.players[id].seat === seat) return id;
    return null;
  }

  // ---- Starting a hand -----------------------------------------------------
  // `seats` is an array of { id, seat, chips } for everyone with chips > 0.
  function startHand(seats, dealerSeat, smallBlind, bigBlind, handNumber) {
    const state = {
      handNumber,
      phase: 'preflop',
      deck: shuffle(makeDeck()),
      community: [],
      pot: 0,
      dealerSeat,
      smallBlind,
      bigBlind,
      currentBet: 0,
      minRaise: bigBlind,
      currentSeat: null,
      players: {},
      winners: null,
      message: '',
      lastActionText: '',
    };

    // Seat every player and deal two hole cards each.
    for (const s of seats) {
      state.players[s.id] = {
        seat: s.seat,
        stack: s.chips,
        holeCards: [state.deck.pop(), state.deck.pop()],
        bet: 0,
        contributed: 0,
        status: 'active',
        hasActed: false,
      };
    }

    const ordered = playersBySeat(state);
    const headsUp = ordered.length === 2;

    // Determine small-blind and big-blind seats.
    let sbSeat, bbSeat;
    if (headsUp) {
      // Heads-up: the dealer posts the small blind and acts first pre-flop.
      sbSeat = dealerSeat;
      bbSeat = nextInHandSeat(state, dealerSeat);
    } else {
      sbSeat = nextInHandSeat(state, dealerSeat);
      bbSeat = nextInHandSeat(state, sbSeat);
    }

    postBlind(state, sbSeat, smallBlind);
    postBlind(state, bbSeat, bigBlind);
    state.currentBet = bigBlind;
    state.minRaise = bigBlind;

    // Blind posters still get to act later, so they have not "acted" yet.
    state.players[seatToId(state, sbSeat)].hasActed = false;
    state.players[seatToId(state, bbSeat)].hasActed = false;

    // Action starts to the left of the big blind (heads-up: that's the dealer).
    state.currentSeat = nextSeatToAct(state, bbSeat);
    state.message = `Hand #${handNumber} — blinds ${smallBlind}/${bigBlind}`;
    return state;
  }

  function postBlind(state, seat, amount) {
    const id = seatToId(state, seat);
    const p = state.players[id];
    const pay = Math.min(amount, p.stack);
    p.stack -= pay;
    p.bet += pay;
    p.contributed += pay;
    state.pot += pay;
    if (p.stack === 0) p.status = 'allin';
  }

  // ---- Legal actions (drives the UI) --------------------------------------
  function legalActions(state, playerId) {
    const p = state.players[playerId];
    if (!p || p.status !== 'active' || p.seat !== state.currentSeat) return null;
    const toCall = state.currentBet - p.bet;
    const maxRaiseTo = p.bet + p.stack;           // shoving all-in
    const minRaiseTo = Math.min(state.currentBet + state.minRaise, maxRaiseTo);
    return {
      toCall,
      canCheck: toCall === 0,
      callAmount: Math.min(toCall, p.stack),
      canRaise: p.stack > toCall,                  // has chips beyond a call
      minRaiseTo,
      maxRaiseTo,
    };
  }

  // ---- Applying an action --------------------------------------------------
  // action: 'fold' | 'check' | 'call' | 'raise'. For 'raise', `amount` is the
  // total amount the player wants their bet to become this round (raise-to).
  function applyAction(state, playerId, action, amount) {
    const p = state.players[playerId];
    if (!p || p.status !== 'active' || p.seat !== state.currentSeat) return state;

    const toCall = state.currentBet - p.bet;
    const name = state.playerNames ? state.playerNames[playerId] : 'Player';

    if (action === 'fold') {
      p.status = 'folded';
      state.lastActionText = `${name} folds`;
    } else if (action === 'check') {
      if (toCall > 0) return state; // illegal — ignore
      state.lastActionText = `${name} checks`;
    } else if (action === 'call') {
      const pay = Math.min(toCall, p.stack);
      commit(state, p, pay);
      state.lastActionText = pay > 0 ? `${name} calls ${pay}` : `${name} checks`;
    } else if (action === 'raise') {
      let raiseTo = Math.max(amount, state.currentBet + state.minRaise);
      const maxRaiseTo = p.bet + p.stack;
      if (raiseTo > maxRaiseTo) raiseTo = maxRaiseTo; // can't bet more than you have
      const pay = raiseTo - p.bet;
      commit(state, p, pay);
      const raiseSize = raiseTo - state.currentBet;
      if (raiseSize >= state.minRaise) state.minRaise = raiseSize;
      state.currentBet = Math.max(state.currentBet, raiseTo);
      state.lastActionText = `${name} raises to ${raiseTo}`;
      // A genuine raise reopens the betting: everyone else must act again.
      for (const id in state.players) {
        if (id !== playerId && state.players[id].status === 'active') {
          state.players[id].hasActed = false;
        }
      }
    }

    p.hasActed = true;
    advance(state);
    return state;
  }

  // Move chips from a player's stack into the pot.
  function commit(state, p, amount) {
    const pay = Math.min(amount, p.stack);
    p.stack -= pay;
    p.bet += pay;
    p.contributed += pay;
    state.pot += pay;
    if (p.stack === 0) p.status = 'allin';
  }

  // Decide what happens after an action: keep betting, deal the next street, or
  // go to showdown / award the pot.
  function advance(state) {
    const contenders = inHand(state);

    // Everyone folded but one — that player wins immediately.
    if (contenders.length === 1) {
      awardUncontested(state, contenders[0].id);
      return;
    }

    if (bettingRoundComplete(state)) {
      nextStreet(state);
    } else {
      state.currentSeat = nextSeatToAct(state, state.currentSeat);
    }
  }

  function bettingRoundComplete(state) {
    const contenders = inHand(state);
    const canAct = contenders.filter((p) => p.status === 'active');
    if (canAct.length === 0) return true; // everybody is all-in
    // Complete when every player who can still act has acted and matched the bet.
    return canAct.every((p) => p.hasActed && p.bet === state.currentBet);
  }

  // Advance to the next betting street (flop/turn/river) or showdown.
  function nextStreet(state) {
    // Sweep the current round's bets (they are already in the pot) and reset.
    for (const id in state.players) {
      const p = state.players[id];
      p.bet = 0;
      if (p.status === 'active') p.hasActed = false;
    }
    state.currentBet = 0;
    state.minRaise = state.bigBlind;

    if (state.phase === 'preflop') {
      state.phase = 'flop';
      dealCommunity(state, 3);
    } else if (state.phase === 'flop') {
      state.phase = 'turn';
      dealCommunity(state, 1);
    } else if (state.phase === 'turn') {
      state.phase = 'river';
      dealCommunity(state, 1);
    } else if (state.phase === 'river') {
      showdown(state);
      return;
    }

    // If at most one player can still act (others all-in), there is no more
    // betting — deal straight through to the river and then show down.
    const canAct = inHand(state).filter((p) => p.status === 'active');
    if (canAct.length <= 1) {
      nextStreet(state);
      return;
    }

    state.currentSeat = nextSeatToAct(state, state.dealerSeat);
  }

  function dealCommunity(state, n) {
    for (let i = 0; i < n; i++) state.community.push(state.deck.pop());
  }

  // ---- Ending a hand -------------------------------------------------------
  function awardUncontested(state, winnerId) {
    const p = state.players[winnerId];
    p.stack += state.pot;
    const name = state.playerNames ? state.playerNames[winnerId] : 'Player';
    state.winners = [{ id: winnerId, amount: state.pot, handName: '(uncontested)', uncontested: true }];
    state.message = `${name} wins ${state.pot} (everyone folded)`;
    state.phase = 'showdown';
    state.pot = 0;
    state.currentSeat = null;
  }

  // Compute side pots from each player's total contribution, then award every
  // pot to the best eligible (non-folded) hand, splitting ties.
  function showdown(state) {
    state.phase = 'showdown';
    state.currentSeat = null;

    const contenders = inHand(state); // players who can win (didn't fold)

    // Pre-evaluate everyone's best 7-card hand once.
    const evals = {};
    for (const c of contenders) {
      evals[c.id] = evaluate([...c.holeCards, ...state.community]);
    }

    // Build side pots from the distinct contribution levels.
    const contributors = playersBySeat(state).filter((p) => p.contributed > 0);
    const levels = [...new Set(contributors.map((p) => p.contributed))].sort((a, b) => a - b);

    const winners = [];
    let prev = 0;
    for (const level of levels) {
      const layerPerPlayer = level - prev;
      const inLayer = contributors.filter((p) => p.contributed >= level);
      const potAmount = layerPerPlayer * inLayer.length;
      prev = level;
      if (potAmount === 0) continue;

      // Eligible winners contributed to this layer AND are still in the hand.
      const eligible = contenders.filter((p) => p.contributed >= level);
      if (eligible.length === 0) continue;

      // Best hand(s) among the eligible players.
      let best = null;
      for (const p of eligible) {
        if (!best || cmpScore(evals[p.id].score, best) > 0) best = evals[p.id].score;
      }
      const potWinners = eligible.filter((p) => cmpScore(evals[p.id].score, best) === 0);

      const share = Math.floor(potAmount / potWinners.length);
      let remainder = potAmount - share * potWinners.length;
      for (const w of potWinners) {
        let amt = share;
        if (remainder > 0) { amt += 1; remainder -= 1; } // odd chip to first winner
        state.players[w.id].stack += amt;
        winners.push({ id: w.id, amount: amt, handName: evals[w.id].name });
      }
    }

    // Merge duplicate winners (a player winning multiple side pots) for display.
    const merged = {};
    for (const w of winners) {
      if (!merged[w.id]) merged[w.id] = { id: w.id, amount: 0, handName: w.handName };
      merged[w.id].amount += w.amount;
    }
    state.winners = Object.values(merged);

    const names = state.playerNames || {};
    state.message = state.winners
      .map((w) => `${names[w.id] || 'Player'} wins ${w.amount} with ${w.handName}`)
      .join(' · ');
    state.pot = 0;
  }

  // Expose the public API.
  window.PokerEngine = {
    makeDeck,
    shuffle,
    evaluate,
    evaluate5,
    cmpScore,
    startHand,
    legalActions,
    applyAction,
    playersBySeat,
    inHand,
    nextInHandSeat,
    seatToId,
    HAND_NAMES,
  };
})();
