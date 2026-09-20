export function parseSchedule(value: string, now = new Date()): Date {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error('Schedule must be ISO-8601 with an explicit UTC offset or Z');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error('Invalid schedule timestamp');
  if (parsed.valueOf() <= now.valueOf()) throw new Error('Schedule must be in the future');
  return parsed;
}

export function formatInTimezone(value: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'long',
  }).format(new Date(value));
}
