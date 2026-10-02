const integer = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function formatInt(n: number): string {
  return integer.format(n);
}

/** Seconds with one decimal ("32,4 s"); em dash when there is no value yet. */
export function formatSeconds(s: number): string {
  return Number.isFinite(s) ? `${oneDecimal.format(s)} s` : '—';
}

export function formatRate(n: number): string {
  return Number.isFinite(n) ? oneDecimal.format(n) : '—';
}

/** Simulation clock as T+ hh:mm:ss. */
export function formatClock(seconds: number): string {
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (v: number) => String(v).padStart(2, '0');
  return `T+ ${pad(h)}:${pad(m)}:${pad(s)}`;
}
