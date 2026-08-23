const pad = value => String(value).padStart(2, '0');

function dayStr(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDay(value, fallback = new Date()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(fallback.getFullYear(), fallback.getMonth(), fallback.getDate());
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
    return new Date(fallback.getFullYear(), fallback.getMonth(), fallback.getDate());
  }
  return parsed;
}

function parseExactDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day
    ? parsed
    : null;
}

function addDays(date, amount) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}

function rangeBounds(range, anchor, reference = new Date(), startValue, endValue) {
  const selected = parseDay(anchor, reference);
  if (range === 'custom') {
    const start = parseExactDay(startValue) || selected;
    const end = parseExactDay(endValue) || selected;
    return start <= end ? { start, end } : { start: end, end: start };
  }
  if (range === 'daily') return { start: selected, end: selected };
  if (range === 'weekly') {
    if (!anchor) return { start: addDays(selected, -6), end: selected };
    const mondayOffset = (selected.getDay() + 6) % 7;
    const start = addDays(selected, -mondayOffset);
    return { start, end: addDays(start, 6) };
  }
  if (range === 'monthly') {
    return {
      start: new Date(selected.getFullYear(), selected.getMonth(), 1),
      end: new Date(selected.getFullYear(), selected.getMonth() + 1, 0),
    };
  }
  return null;
}

function eachDay(start, end) {
  const days = [];
  for (let date = new Date(start); date <= end; date = addDays(date, 1)) days.push(date);
  return days;
}

module.exports = { addDays, dayStr, eachDay, parseDay, parseExactDay, rangeBounds };
