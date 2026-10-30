export function timestamp(value) {
  if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Use an ISO timestamp with an explicit timezone.');
  }
  return new Date(value).toISOString();
}

export function eventType(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(value)) throw new Error('Invalid event type.');
  return value;
}

export function normalizeTrigger(trigger, now = Date.now()) {
  if (!trigger || typeof trigger !== 'object') throw new Error('Configure a trigger.');
  switch (trigger.type) {
    case 'event': return { type: 'event', eventType: eventType(trigger.eventType) };
    case 'once': {
      const at = timestamp(trigger.at);
      if (Date.parse(at) <= now) throw new Error('One-off schedule must be in the future.');
      return { type: 'once', at };
    }
    case 'interval': {
      if (!Number.isInteger(trigger.everySeconds) || trigger.everySeconds < 60 || trigger.everySeconds > 31536000) {
        throw new Error('Interval must be 60–31536000 seconds.');
      }
      return { type: 'interval', everySeconds: trigger.everySeconds,
        startAt: trigger.startAt ? timestamp(trigger.startAt) : new Date(now + trigger.everySeconds * 1000).toISOString() };
    }
    case 'daily': {
      if (typeof trigger.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.time) ||
        typeof trigger.timeZone !== 'string') throw new Error('Daily schedules require HH:mm and an IANA timezone.');
      new Intl.DateTimeFormat('en', { timeZone: trigger.timeZone }).format(now);
      return { type: 'daily', time: trigger.time, timeZone: trigger.timeZone };
    }
    default: throw new Error('Unknown automation trigger.');
  }
}

function localParts(formatter, instant) {
  return Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
}

export function nextOccurrence(trigger, after, previousDate) {
  if (trigger.type === 'event') return null;
  if (trigger.type === 'once') return Date.parse(trigger.at) > after ? trigger.at : null;
  if (trigger.type === 'interval') {
    const start = Date.parse(trigger.startAt), period = trigger.everySeconds * 1000;
    const next = start > after ? start : start + (Math.floor((after - start) / period) + 1) * period;
    return new Date(next).toISOString();
  }
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: trigger.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (let minute = Math.floor(after / 60000) * 60000 + 60000, count = 0; count < 4320; minute += 60000, count++) {
    const p = localParts(formatter, minute);
    if (p.hour + ':' + p.minute === trigger.time &&
      [p.year, p.month, p.day].join('-') !== previousDate) return new Date(minute).toISOString();
  }
  throw new Error('No daily occurrence found within three days.');
}

export function occurrenceDate(trigger, instant) {
  if (trigger.type !== 'daily') return undefined;
  const p = localParts(new Intl.DateTimeFormat('en-CA', { timeZone: trigger.timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit' }), instant);
  return [p.year, p.month, p.day].join('-');
}
