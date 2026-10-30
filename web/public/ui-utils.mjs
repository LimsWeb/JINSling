export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
export function seoulToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const part = type => parts.find(p => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function addDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0,10);
}
export function dateLabel(date, full = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const value = new Date(`${date}T12:00:00+09:00`);
  return new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul',month:'long',day:'numeric',weekday:'long',...(full ? {year:'numeric'} : {})}).format(value);
}
export function extractInvite(location, history) {
  return consumeAuthFragment(location, history).inviteToken;
}
export function consumeAuthFragment(location, history) {
  const params = new URLSearchParams(location.hash.slice(1));
  const inviteToken = params.get('invite');
  const resetToken = params.get('reset');
  // Consume both secrets in one synchronous step, before any page requests.
  if (inviteToken !== null || resetToken !== null) history.replaceState(null, '', `${location.pathname}${location.search}`);
  return {inviteToken, resetToken};
}
export function listenForAuthFragments(browser, onChange) {
  browser.addEventListener('hashchange', () => {
    const tokens = consumeAuthFragment(browser.location, browser.history);
    if (tokens.inviteToken !== null || tokens.resetToken !== null) onChange(tokens);
  });
}
export function normalizeUsername(value) {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[a-z0-9_]{4,32}$/.test(username)) throw new Error('아이디는 영문, 숫자, 밑줄(_)로 4–32자를 입력해 주세요.');
  return username;
}
export function validateNewPassword(password, confirmation) {
  const length = typeof password === 'string' ? Array.from(password).length : 0;
  if (length < 15 || length > 128) throw new Error('비밀번호는 15–128자로 입력해 주세요.');
  if (password !== confirmation) throw new Error('비밀번호와 비밀번호 확인이 일치하지 않아요.');
  return password;
}
export function canCustomerChange(booking, cutoffMinutes = 0, now = new Date()) {
  return booking.status === 'confirmed' && new Date(`${booking.date}T${booking.start_time}:00+09:00`).getTime() - Number(cutoffMinutes) * 60000 > now.getTime();
}
export function parseTimestamp(value) {
  // SQLite datetime('now') is UTC but does not include an offset.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ','T')}Z` : value;
  return new Date(normalized);
}
export function createRequestId(source = globalThis.crypto) {
  if (typeof source.randomUUID === 'function') return source.randomUUID();
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
