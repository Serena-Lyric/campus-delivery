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

export function nextCampusDayStart(now: Date, timeZone: string): Date {
  const value = zonedParts(now, timeZone);
  const localMidnightAsUtc = Date.UTC(value.year, value.month - 1, value.day + 1);
  const firstGuess = new Date(localMidnightAsUtc - offsetAt(new Date(localMidnightAsUtc), timeZone));
  return new Date(localMidnightAsUtc - offsetAt(firstGuess, timeZone));
}
