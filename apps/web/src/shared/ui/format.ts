export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = Math.round((now - new Date(iso).getTime()) / 1000);
  if (diff < 5) return 'たった今';
  if (diff < 60) return `${diff}秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
  return `${Math.floor(diff / 86400)}日前`;
}

export function untilTime(iso: string, now = Date.now()): string {
  const diff = Math.round((new Date(iso).getTime() - now) / 1000);
  if (diff <= 0) return '期限切れ';
  if (diff < 3600) return `あと${Math.ceil(diff / 60)}分`;
  if (diff < 86400) return `あと${Math.floor(diff / 3600)}時間`;
  return `あと${Math.floor(diff / 86400)}日`;
}

export function duration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}秒`;
  return `${Math.floor(m / 60)}時間${m % 60}分`;
}

export function usd(n: number | null | undefined, digits = 2): string {
  if (n == null) return '—';
  return `$${n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : digits)}`;
}

export function clockTime(d = new Date()): string {
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-5)}` : id;
}

export function fmtNum(n: number): string {
  return n.toLocaleString('ja-JP');
}
