// TSV nuit par service — port direct de Python 6_codeRot_v7.py:49-59
// Créneau "nuit" = 18h-06h locale. J = nuit du jour de départ ; J+1 = nuit
// du lendemain (déborde après minuit). Formules brutes du référentiel AF.

const r2 = (n: number) => Math.round(n * 100) / 100;

export function tsvNuitJ(dep_loc: number, block: number): number {
  const x = dep_loc;
  const y = block;
  const part1 = (x - 1) < 6
    ? Math.max(0, Math.min(y + 1.5, 6 - (x - 1)))
    : 0;
  const part2 = (x + y + 0.5) > 18
    ? Math.max(0, Math.min(6, y + 1.5, (x + y + 0.5) - 18, 24 + 1 - x))
    : 0;
  return r2(part1 + part2);
}

export function tsvNuitJ1(dep_loc: number, block: number): number {
  const x = dep_loc;
  const y = block;
  if ((x + y + 0.5) > 24) {
    return r2(Math.min(6, y, (x + y + 0.5) - 24));
  }
  return 0;
}
