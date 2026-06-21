// api/_maze.js — shared maze logic (same algorithm on client side in duels.html)

const GRID_W = 32;     // 640px / 20px per tile
const GRID_H = 24;     // 480px / 20px per tile

function createSeededRandom(seed) {
  let s = seed;
  return function() {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function carve(grid, x, y, rng) {
  const dirs = [[0, -2], [2, 0], [0, 2], [-2, 0]];
  for (let i = dirs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
  }
  grid[y][x] = 1;
  for (const [dx, dy] of dirs) {
    const nx = x + dx, ny = y + dy;
    const mx = x + dx/2, my = y + dy/2;
    if (nx > 0 && nx < grid[0].length - 1 && ny > 0 && ny < grid.length - 1 && grid[ny][nx] === 0) {
      grid[my][mx] = 1;
      carve(grid, nx, ny, rng);
    }
  }
}

function generateMaze(seed) {
  const rng = createSeededRandom(seed);
  const grid = Array.from({ length: GRID_H }, () => Array(GRID_W).fill(0));
  carve(grid, 1, 1, rng);
  return grid;
}

function pickGoal(grid, seed) {
  const rng = createSeededRandom(seed * 2 + 1);
  while (true) {
    const gx = Math.floor(rng() * (GRID_W - 2)) + 1;
    const gy = Math.floor(rng() * (GRID_H - 2)) + 1;
    if (grid[gy][gx] === 1 && (gx > GRID_W/2 || gy > GRID_H/2)) return { x: gx, y: gy };
  }
}

// BFS distances from a cell
function bfsDist(grid, from) {
  const dist = Array.from({ length: GRID_H }, () => Array(GRID_W).fill(-1));
  dist[from.y][from.x] = 0;
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    for (const [dx, dy] of [[0,-1],[1,0],[0,1],[-1,0]]) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
      if (grid[ny][nx] !== 1) continue;
      if (dist[ny][nx] !== -1) continue;
      dist[ny][nx] = dist[cur.y][cur.x] + 1;
      queue.push({ x: nx, y: ny });
    }
  }
  return dist;
}

function computeEquidistantSpawns(grid, goal) {
  const dist = bfsDist(grid, goal);
  let maxD = 0;
  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++)
      if (dist[y][x] > maxD) maxD = dist[y][x];

  const dTarget = Math.floor(maxD * 0.7);
  const candidates = [];
  for (let y = 0; y < GRID_H; y++)
    for (let x = 0; x < GRID_W; x++)
      if (dist[y][x] >= 0 && Math.abs(dist[y][x] - dTarget) <= 2)
        candidates.push({ x, y, d: dist[y][x] });

  if (candidates.length < 2) {
    // fallback — most distant cells
    const sorted = [];
    for (let y = 0; y < GRID_H; y++)
      for (let x = 0; x < GRID_W; x++)
        if (dist[y][x] > 0) sorted.push({ x, y, d: dist[y][x] });
    sorted.sort((a, b) => b.d - a.d);
    return { spawnA: sorted[0], spawnB: sorted[1] || sorted[0] };
  }

  // Group by exact distance; pick group with most candidates
  const byDist = {};
  for (const c of candidates) (byDist[c.d] = byDist[c.d] || []).push(c);
  const groups = Object.values(byDist).sort((a, b) => b.length - a.length);
  const group = groups[0];

  // Pick two cells far from each other
  let best = null;
  for (let i = 0; i < group.length; i++) {
    const distFromI = bfsDist(grid, group[i]);
    for (let j = i + 1; j < group.length; j++) {
      const sep = distFromI[group[j].y][group[j].x];
      if (sep === -1) continue;
      if (!best || sep > best.sep) best = { a: group[i], b: group[j], sep };
    }
  }

  if (!best) return { spawnA: group[0], spawnB: group[1] || group[0] };
  return { spawnA: { x: best.a.x, y: best.a.y }, spawnB: { x: best.b.x, y: best.b.y } };
}

function computeBoardLayout(seed) {
  const grid = generateMaze(seed);
  const goal = pickGoal(grid, seed);
  const spawns = computeEquidistantSpawns(grid, goal);
  return { goal, spawnA: spawns.spawnA, spawnB: spawns.spawnB, grid };
}

function isLegalMove(seed, fromPos, toPos) {
  if (!fromPos || !toPos) return false;
  if (Math.abs(toPos.x - fromPos.x) + Math.abs(toPos.y - fromPos.y) !== 1) return false;
  const grid = generateMaze(seed);
  if (toPos.x < 0 || toPos.x >= GRID_W || toPos.y < 0 || toPos.y >= GRID_H) return false;
  return grid[toPos.y][toPos.x] === 1;
}

module.exports = { generateMaze, pickGoal, computeBoardLayout, isLegalMove, GRID_W, GRID_H };
