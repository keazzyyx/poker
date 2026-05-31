/* =============================================================================
 * supabase.js — Database + Realtime layer
 * -----------------------------------------------------------------------------
 * Thin wrapper around the Supabase JS client (loaded from the CDN in the HTML).
 * Everything that touches the network lives here so the rest of the app can
 * stay focused on poker and UI. Exposed as `window.DB`.
 *
 * SETUP: paste your project URL + anon key below (Supabase Dashboard →
 * Project Settings → API). They are also overridable via localStorage so the
 * deployed site can be configured without editing this file.
 * ========================================================================== */
(function () {
  'use strict';

  // ---- Configuration -------------------------------------------------------
  const SUPABASE_URL =
    localStorage.getItem('sb_url') || 'https://ysdnbahtupolcpqovuhe.supabase.co';
  const SUPABASE_ANON_KEY =
    localStorage.getItem('sb_key') || 'sb_publishable_h0Hl8elo2XgI516HEy4LHw_yAxL0xDk';

  const configured =
    SUPABASE_URL.startsWith('http') && SUPABASE_ANON_KEY.length > 20;

  // `supabase` is the global created by the CDN script (@supabase/supabase-js).
  const client = configured
    ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

  // ---- Identity ------------------------------------------------------------
  // Generate an RFC-4122 v4 UUID on the client. Used for both client ids and
  // room primary keys so we never rely on a database-side default.
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    // Fallback for older browsers without crypto.randomUUID.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // A stable, anonymous client id so a player can rejoin/refresh and keep their
  // seat. Stored once in localStorage and reused across rooms.
  function clientId() {
    let id = localStorage.getItem('poker_client_id');
    if (!id) {
      id = uuid();
      localStorage.setItem('poker_client_id', id);
    }
    return id;
  }

  // Short, friendly, unambiguous room code (no 0/O/1/I).
  function generateRoomCode() {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return code;
  }

  // ---- Rooms ---------------------------------------------------------------
  async function createRoom({ code, hostId, smallBlind, bigBlind }) {
    // Generate the primary key client-side so the insert never depends on a
    // database default (some setups don't have gen_random_uuid() as a default).
    const { data, error } = await client
      .from('rooms')
      .insert({
        id: uuid(),
        code,
        host_id: hostId,
        small_blind: smallBlind,
        big_blind: bigBlind,
        status: 'lobby',
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async function getRoomByCode(code) {
    const { data, error } = await client
      .from('rooms')
      .select('*')
      .eq('code', code)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function updateRoom(roomId, patch) {
    const { error } = await client.from('rooms').update(patch).eq('id', roomId);
    if (error) throw error;
  }

  // ---- Players -------------------------------------------------------------
  async function getPlayers(roomId) {
    const { data, error } = await client
      .from('players')
      .select('*')
      .eq('room_id', roomId)
      .order('seat', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  // Insert or update a player row (upsert lets a refreshed client reclaim its seat).
  async function upsertPlayer(player) {
    const { data, error } = await client
      .from('players')
      .upsert(player, { onConflict: 'id,room_id' })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async function updatePlayer(playerId, roomId, patch) {
    const { error } = await client
      .from('players')
      .update(patch)
      .eq('id', playerId)
      .eq('room_id', roomId);
    if (error) throw error;
  }

  // Submit a move as the acting player. The host picks this up and applies it.
  async function setPendingAction(playerId, roomId, action) {
    return updatePlayer(playerId, roomId, { pending_action: action });
  }

  // ---- Realtime ------------------------------------------------------------
  // Subscribe to all row changes for one room. `onRooms` / `onPlayers` fire on
  // any insert/update/delete. Returns the channel so it can be removed later.
  function subscribe(roomId, { onRooms, onPlayers }) {
    const channel = client
      .channel('room:' + roomId)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rooms', filter: 'id=eq.' + roomId },
        (payload) => onRooms && onRooms(payload)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'players', filter: 'room_id=eq.' + roomId },
        (payload) => onPlayers && onPlayers(payload)
      )
      .subscribe();
    return channel;
  }

  function unsubscribe(channel) {
    if (channel) client.removeChannel(channel);
  }

  window.DB = {
    client,
    configured,
    uuid,
    clientId,
    generateRoomCode,
    createRoom,
    getRoomByCode,
    updateRoom,
    getPlayers,
    upsertPlayer,
    updatePlayer,
    setPendingAction,
    subscribe,
    unsubscribe,
  };
})();
