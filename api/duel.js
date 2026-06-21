// api/duel.js - Vercel serverless function for multiplayer duel state management
const { computeBoardLayout, isLegalMove } = require('./_maze');

const STATE_KEY_PREFIX = 'duel:room:';
const STATE_TTL_SEC = 60 * 60 * 24; // 24 hours

function kvCfg() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Upstash Redis env vars not set');
  return { url: url.replace(/\/+$/, ''), token };
}

async function redisCmd(cmd) {
  const { url, token } = kvCfg();
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`KV ${cmd[0]} failed: ${r.status}`);
  return r.json();
}

function emptyState(roomCode) {
  return {
    roomCode, seed: 0, goal: null,
    p1: null, p2: null,
    phase: 'lobby', winner: null,
    round: 1, score: { p1: 0, p2: 0 },
    updatedAt: new Date().toISOString(),
  };
}

async function readState(room) {
  try {
    const { result } = await redisCmd(['GET', STATE_KEY_PREFIX + room]);
    if (!result) return emptyState(room);
    try { return JSON.parse(result); } catch { return emptyState(room); }
  } catch (e) {
    console.error('Read state error:', e);
    return emptyState(room);
  }
}

async function writeState(room, state) {
  state.updatedAt = new Date().toISOString();
  await redisCmd(['SET', STATE_KEY_PREFIX + room, JSON.stringify(state), 'EX', STATE_TTL_SEC]);
  return state;
}

function sanitize(s, max = 16) {
  return String(s || '').slice(0, max).replace(/[<>"'&`]/g, '').trim();
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i);
  return Math.abs(h);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const room = sanitize(url.searchParams.get('room') || 'default', 40);

    if (req.method === 'GET') {
      const state = await readState(room);
      return res.status(200).json({ ok: true, state });
    }
    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = body.action;
    const playerId = sanitize(body.playerId, 64);
    if (!playerId) return res.status(400).json({ ok: false, error: 'playerId required' });

    let state = await readState(room);

    if (action === 'join') {
      const name = sanitize(body.name) || 'Player';
      const skin = parseInt(body.skin) || 1;

      if (state.p1?.id === playerId) {
        state.p1.name = name; state.p1.skin = skin;
      } else if (state.p2?.id === playerId) {
        state.p2.name = name; state.p2.skin = skin;
      } else if (!state.p1) {
        state.p1 = { id: playerId, name, skin, pos: null };
      } else if (!state.p2) {
        state.p2 = { id: playerId, name, skin, pos: null };
        // Both slots filled now → initialize board on server (single source of truth)
        state.seed = hashCode(room) ^ Math.floor(Date.now() / 1000);
        const layout = computeBoardLayout(state.seed);
        state.goal = layout.goal;
        state.p1.pos = layout.spawnA;
        state.p2.pos = layout.spawnB;
        state.phase = 'countdown';
      } else {
        return res.status(200).json({ ok: true, state, slot: 'observer' });
      }
      state = await writeState(room, state);
      const slot = state.p1?.id === playerId ? 'p1' : 'p2';
      return res.status(200).json({ ok: true, state, slot });
    }

    if (action === 'move') {
      const { dx, dy } = body;
      let slot;
      if (state.p1?.id === playerId) slot = 'p1';
      else if (state.p2?.id === playerId) slot = 'p2';
      else return res.status(403).json({ ok: false, error: 'not in room' });

      if (state.phase !== 'playing') return res.status(409).json({ ok: false, error: 'wrong phase' });

      const newPos = { x: state[slot].pos.x + dx, y: state[slot].pos.y + dy };
      if (!isLegalMove(state.seed, state[slot].pos, newPos)) {
        return res.status(400).json({ ok: false, error: 'illegal move' });
      }
      state[slot].pos = newPos;

      if (newPos.x === state.goal.x && newPos.y === state.goal.y) {
        state.winner = slot;
        state.score[slot]++;
        state.phase = 'over';
      }
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state, slot });
    }

    if (action === 'phase') {
      if (state.p1?.id !== playerId && state.p2?.id !== playerId) {
        return res.status(403).json({ ok: false, error: 'not in room' });
      }
      if (body.phase === 'playing' && state.phase === 'countdown') {
        state.phase = 'playing';
        state = await writeState(room, state);
      }
      return res.status(200).json({ ok: true, state });
    }

    if (action === 'next') {
      if (state.p1?.id !== playerId && state.p2?.id !== playerId) {
        return res.status(403).json({ ok: false, error: 'not in room' });
      }
      state.seed = Math.floor(Math.random() * 1000000000);
      const layout = computeBoardLayout(state.seed);
      state.goal = layout.goal;
      if (state.p1) state.p1.pos = layout.spawnA;
      if (state.p2) state.p2.pos = layout.spawnB;
      state.winner = null;
      state.phase = 'countdown';
      state.round++;
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state });
    }

    if (action === 'leave') {
      if (state.p1?.id === playerId) state.p1 = null;
      else if (state.p2?.id === playerId) state.p2 = null;
      if (!state.p1 && !state.p2) state = emptyState(room);
      state = await writeState(room, state);
      return res.status(200).json({ ok: true, state });
    }

    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (err) {
    console.error('duel error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
