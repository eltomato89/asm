import { useEffect, useState } from 'react';

/** "mm:ss" with zero-padded minutes (minutes may exceed 59: "120:00"). */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Current time, re-rendered every `intervalMs` while enabled. */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

/** Seconds left until `until` (epoch ms), ticking once per second; 0 when elapsed or null. */
export function useCountdown(until: number | null): number {
  const now = useNow(1000, until !== null);
  if (until === null) return 0;
  return Math.max(0, Math.ceil((until - now) / 1000));
}
