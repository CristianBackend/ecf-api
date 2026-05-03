function toGmt4(d: Date): {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value || '0', 10);

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hours: get('hour'),
    minutes: get('minute'),
    seconds: get('second'),
  };
}

/** Format a date as DD/MM/YYYY in GMT-4 (America/Santo_Domingo). */
export function fmtDateGmt4(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const t = toGmt4(d);
  const dd = String(t.day).padStart(2, '0');
  const mm = String(t.month).padStart(2, '0');
  return `${dd}/${mm}/${t.year}`;
}

/** Format a date as DD-MM-YYYY HH:mm:ss in GMT-4 (America/Santo_Domingo). */
export function fmtDateTimeGmt4(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const t = toGmt4(d);
  const dd = String(t.day).padStart(2, '0');
  const mm = String(t.month).padStart(2, '0');
  const hh = String(t.hours).padStart(2, '0');
  const mi = String(t.minutes).padStart(2, '0');
  const ss = String(t.seconds).padStart(2, '0');
  return `${dd}-${mm}-${t.year} ${hh}:${mi}:${ss}`;
}
