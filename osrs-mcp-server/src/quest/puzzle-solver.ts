// ─── Puzzle Solver ───────────────────────────────────────────────────────────
// Solvers for common OSRS quest puzzles.

// ── Tower of Life (symbol matching) ──────────────────────────────────────────
// Not relevant for F2P, placeholder

// ── Sliding Puzzle (15-puzzle style) ─────────────────────────────────────────
// Used in: Lunar Diplomacy, Desert Treasure variants

export type SlidingBoard = number[][]; // 0 = empty tile

type BoardKey = string;
const boardKey = (b: SlidingBoard): BoardKey => b.flat().join(",");

function findZero(board: SlidingBoard): [number, number] {
  for (let r = 0; r < board.length; r++)
    for (let c = 0; c < board[r].length; c++)
      if (board[r][c] === 0) return [r, c];
  return [0, 0];
}

function cloneBoard(board: SlidingBoard): SlidingBoard {
  return board.map((row) => [...row]);
}

function isGoal(board: SlidingBoard, goal: SlidingBoard): boolean {
  return boardKey(board) === boardKey(goal);
}

/**
 * Solve a sliding puzzle using BFS.
 * Returns array of moves: "up"|"down"|"left"|"right" (direction the empty tile moves).
 * Returns null if unsolvable or exceeds maxSteps.
 */
export function solveSlidingPuzzle(
  start: SlidingBoard,
  goal: SlidingBoard,
  maxSteps = 200
): string[] | null {
  const DIRS: [string, number, number][] = [
    ["up",    -1,  0],
    ["down",   1,  0],
    ["left",   0, -1],
    ["right",  0,  1],
  ];

  const startKey = boardKey(start);
  const goalKey  = boardKey(goal);
  if (startKey === goalKey) return [];

  const queue: { board: SlidingBoard; moves: string[] }[] = [{ board: start, moves: [] }];
  const visited = new Set<BoardKey>([startKey]);

  while (queue.length > 0) {
    const { board, moves } = queue.shift()!;
    if (moves.length >= maxSteps) continue;

    const [zr, zc] = findZero(board);
    for (const [dir, dr, dc] of DIRS) {
      const nr = zr + dr;
      const nc = zc + dc;
      if (nr < 0 || nr >= board.length || nc < 0 || nc >= board[0].length) continue;

      const next = cloneBoard(board);
      next[zr][zc] = next[nr][nc];
      next[nr][nc] = 0;

      const key = boardKey(next);
      if (visited.has(key)) continue;
      visited.add(key);

      const newMoves = [...moves, dir];
      if (key === goalKey) return newMoves;
      queue.push({ board: next, moves: newMoves });
    }
  }
  return null;
}

// ── Light Box Puzzle ──────────────────────────────────────────────────────────
// Used in: Mourning's End Part II
// 8x8 grid of lights, each lever toggles a cross pattern

export type LightBoard = boolean[][];  // true = lit

export function solveLightBox(initial: LightBoard): number[][] | null {
  // Returns list of [row, col] lever positions to pull
  // Uses Gaussian elimination over GF(2)
  const N = initial.length * initial[0].length;
  const rows = initial.length;
  const cols = initial[0].length;

  // Build toggle matrix: which lights does each switch toggle?
  const matrix: number[][] = [];
  for (let sr = 0; sr < rows; sr++) {
    for (let sc = 0; sc < cols; sc++) {
      const row = new Array(N + 1).fill(0);
      for (const [dr, dc] of [[0,0],[-1,0],[1,0],[0,-1],[0,1]]) {
        const nr = sr + dr, nc = sc + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
          row[nr * cols + nc] = 1;
        }
      }
      row[N] = initial[sr][sc] ? 1 : 0; // target: turn all on -> XOR with current
      matrix.push(row);
    }
  }

  // Gaussian elimination over GF(2)
  const pivotRow: number[] = new Array(N).fill(-1);
  let col = 0;
  for (let row = 0; row < N && col < N; ) {
    let pivotFound = -1;
    for (let r = row; r < N; r++) {
      if (matrix[r][col] === 1) { pivotFound = r; break; }
    }
    if (pivotFound === -1) { col++; continue; }
    [matrix[row], matrix[pivotFound]] = [matrix[pivotFound], matrix[row]];
    pivotRow[col] = row;
    for (let r = 0; r < N; r++) {
      if (r !== row && matrix[r][col] === 1) {
        for (let c = col; c <= N; c++) {
          matrix[r][c] ^= matrix[row][c];
        }
      }
    }
    row++; col++;
  }

  // Extract solution
  const solution = new Array(N).fill(0);
  for (let c = 0; c < N; c++) {
    const pr = pivotRow[c];
    if (pr !== -1) solution[c] = matrix[pr][N];
  }

  const levers: number[][] = [];
  for (let i = 0; i < N; i++) {
    if (solution[i] === 1) {
      levers.push([Math.floor(i / cols), i % cols]);
    }
  }
  return levers;
}

// ── Hanoi (Clock Tower puzzle) ────────────────────────────────────────────────
// Used in: Priest in Peril area, Clock Tower quest

export type HanoiMove = { from: number; to: number };

export function solveHanoi(n: number, from = 0, to = 2, via = 1): HanoiMove[] {
  if (n === 0) return [];
  return [
    ...solveHanoi(n - 1, from, via, to),
    { from, to },
    ...solveHanoi(n - 1, via, to, from),
  ];
}

// ── Maze solver (BFS) ─────────────────────────────────────────────────────────
// Generic maze used in: Melzar's Maze (Dragon Slayer), etc.

export type MazeCell = "." | "#" | "S" | "E";  // open, wall, start, end
export type MazePath = [number, number][];       // sequence of [row, col]

export function solveMaze(grid: MazeCell[][]): MazePath | null {
  let start: [number, number] | null = null;
  let end:   [number, number] | null = null;

  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      if (grid[r][c] === "S") start = [r, c];
      if (grid[r][c] === "E") end   = [r, c];
    }
  }
  if (!start || !end) return null;

  const queue: { pos: [number, number]; path: MazePath }[] = [{ pos: start, path: [start] }];
  const visited = new Set<string>([`${start[0]},${start[1]}`]);

  while (queue.length > 0) {
    const { pos: [r, c], path } = queue.shift()!;
    if (r === end[0] && c === end[1]) return path;

    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nr = r + dr, nc = c + dc;
      const key = `${nr},${nc}`;
      if (nr < 0 || nr >= grid.length || nc < 0 || nc >= grid[0].length) continue;
      if (grid[nr][nc] === "#") continue;
      if (visited.has(key)) continue;
      visited.add(key);
      queue.push({ pos: [nr, nc], path: [...path, [nr, nc]] });
    }
  }
  return null;
}
