/** Deterministic unit vectors for controlled ranking tests. */
export function unitVector(dims: number, entries: Record<number, number>): Float32Array {
  const v = new Float32Array(dims);
  for (const [k, val] of Object.entries(entries)) v[Number(k)] = val;
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  for (let i = 0; i < dims; i++) v[i] = v[i]! / n;
  return v;
}
