// Locale-sensitive formatting (numbers, currency, %).
export function fmtInt(n: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(Math.round(n || 0));
}

export function fmtUsd(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(n || 0);
}

export function fmtPct(n: number): string {
  return `${Math.round((n || 0) * 100)}%`;
}

export function fmtCompact(n: number): string {
  const v = n || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}k`;
  return String(Math.round(v));
}

// Relative reset ("in 7 min" / "in 5 days"), locale-sensitive. undefined when past/absent.
export function fmtReset(iso: string | undefined, locale: string): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  const ms = t - Date.now();
  if (ms <= 0) return undefined;
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'short' });
    const min = Math.round(ms / 60000);
    if (min < 60) return rtf.format(min, 'minute');
    const hr = Math.round(min / 60);
    if (hr < 24) return rtf.format(hr, 'hour');
    return rtf.format(Math.round(hr / 24), 'day');
  } catch {
    return undefined;
  }
}

export function fmtTime(iso: string | undefined, locale: string): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}

// ---- Helpers for the timeline hints (epoch ms, bytes, duration, cost) ----

/** Hora local HH:MM:SS a partir de epoch ms. */
export function fmtClock(epochMs: number | undefined, locale?: string): string {
  if (epochMs == null || !Number.isFinite(epochMs)) return '—';
  try {
    return new Date(epochMs).toLocaleTimeString(locale || undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '—';
  }
}

/** Readable size: 980 -> "980 B", 2048 -> "2.0 KB". */
export function fmtBytes(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Duration: <1000ms -> "840 ms"; otherwise "1.4 s". */
export function fmtMs(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Short dollar cost, without depending on the locale. */
export function fmtUsdShort(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

/** Length in UTF-8 bytes (more faithful than .length for payloads). */
export function byteLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++; // par surrogate = 1 code point de 4 bytes
    } else n += 3;
  }
  return n;
}

/** Number of words (non-space sequences). */
export function countWords(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Number of lines (0 when empty). */
export function countLines(s: string): number {
  return s ? s.split('\n').length : 0;
}

/** Session duration: "5s" · "3m 12s" · "1h 23m". */
export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
