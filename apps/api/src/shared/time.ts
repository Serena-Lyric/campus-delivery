function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function offsetAt(date: Date, timeZone: string): number {
  const value = zonedParts(date, timeZone);
  const representedAsUtc = Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
  );
  return representedAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function campusDay(now: Date, timeZone: string): Date {
  const value = zonedParts(now, timeZone);
  return new Date(Date.UTC(value.year, value.month - 1, value.day));
}

export function campusMinuteOfDay(now: Date, timeZone: string): number {
  const value = zonedParts(now, timeZone);
  return value.hour * 60 + value.minute;
}

export function nextCampusDayStart(now: Date, timeZone: string): Date {
  const value = zonedParts(now, timeZone);
  const localMidnightAsUtc = Date.UTC(value.year, value.month - 1, value.day + 1);
  const firstGuess = new Date(localMidnightAsUtc - offsetAt(new Date(localMidnightAsUtc), timeZone));
  return new Date(localMidnightAsUtc - offsetAt(firstGuess, timeZone));
}

// Repeated DST minutes use the first occurrence; missing minutes use the first valid minute afterwards.
function localBoundary(day: Date, timeZone: string, time: string): Date {
  const [hour, minute] = time.split(':').map(Number);
  const target = day.getTime() + (hour! * 60 + minute!) * 60_000;
  const offsets = new Set([-24, 0, 24].map((hours) => offsetAt(new Date(target + hours * 3_600_000), timeZone)));
  const exact = [...offsets].map((offset) => new Date(target - offset)).filter((candidate) => {
    const p = zonedParts(candidate, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === target;
  }).sort((a, b) => a.getTime() - b.getTime());
  if (exact[0]) return exact[0];
  // Only needed for a DST gap or a skipped local calendar date.
  for (let utc = target - 18 * 3_600_000; utc <= target + 42 * 3_600_000; utc += 60_000) {
    const p = zonedParts(new Date(utc), timeZone);
    if (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) >= target) return new Date(utc);
  }
  throw new Error('Unable to resolve local business-day boundary');
}

export function businessDayInterval(now: Date, timeZone: string, time: string) {
  let day = campusDay(now, timeZone);
  let startsAt = localBoundary(day, timeZone, time);
  if (startsAt > now) {
    day = new Date(day.getTime() - 86_400_000);
    startsAt = localBoundary(day, timeZone, time);
  }
  let nextDay = new Date(day.getTime() + 86_400_000);
  let nextStartsAt = localBoundary(nextDay, timeZone, time);
  while (nextStartsAt <= startsAt) {
    nextDay = new Date(nextDay.getTime() + 86_400_000);
    nextStartsAt = localBoundary(nextDay, timeZone, time);
  }
  return { day: campusDay(startsAt, timeZone).toISOString().slice(0, 10), startsAt, nextStartsAt };
}
