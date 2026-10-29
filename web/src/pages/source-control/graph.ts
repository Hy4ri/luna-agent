/** One row of the commit graph: where the commit sits and which lines cross the row. */
export type GraphRow = {
  column: number;
  /** Lines from the top edge: [from column, to column]. to = the commit column for lines that end at the commit. */
  top: [number, number][];
  /** Lines from the commit dot to the bottom edge, one per parent. */
  bottom: [number, number][];
  /** Lines that pass the row without touching the commit. */
  through: [number, number][];
  width: number;
};

/**
 * Assigns graph lanes to commits in topological order (newest first).
 * Each lane waits for one commit oid; a commit takes the first lane waiting for it.
 */
export function layoutGraph(commits: { oid: string; parents: string[] }[]): GraphRow[] {
  const lanes: (string | null)[] = [], rows: GraphRow[] = [];
  for (const commit of commits) {
    let column = lanes.indexOf(commit.oid);
    if (column < 0) { column = lanes.indexOf(null); if (column < 0) column = lanes.push(null) - 1; }
    const before = [...lanes];
    // Other lanes that waited for this commit end here (branches that forked from it).
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === commit.oid) lanes[i] = null;
    const [first, ...others] = commit.parents;
    // A parent that another lane already waits for joins that lane, so one oid never holds two lanes.
    lanes[column] = first && !lanes.includes(first) ? first : null;
    for (const parent of others) if (!lanes.includes(parent)) { const free = lanes.indexOf(null); if (free < 0) lanes.push(parent); else lanes[free] = parent; }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const top: [number, number][] = [], through: [number, number][] = [], bottom: [number, number][] = [];
    before.forEach((oid, i) => {
      if (oid === null) return;
      if (oid === commit.oid) top.push([i, column]);
      else through.push([i, i]);
    });
    for (const parent of commit.parents) bottom.push([column, lanes.indexOf(parent)]);
    rows.push({ column, top, bottom, through, width: Math.max(before.length, lanes.length, column + 1) });
  }
  return rows;
}

const COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#f87171", "#22d3ee", "#a3e635"];
export const laneColor = (lane: number) => COLORS[lane % COLORS.length]!;
