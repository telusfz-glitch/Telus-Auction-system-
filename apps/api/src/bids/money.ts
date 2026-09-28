/** All money maths in integer cents (BigInt) — never floating point. */
export const toCents = (s: string): bigint => {
  const m = /^(\d+)(?:\.(\d{1,2}))?\d*$/.exec(s);
  if (!m) throw new Error('bad decimal');
  return BigInt(m[1]! + (m[2] ?? '').padEnd(2, '0'));
};
export const fromCents = (c: bigint): string => {
  const s = c.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
};
