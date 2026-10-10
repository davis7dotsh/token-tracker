// Web Crypto works in both Bun and Cloudflare Workers. The passcode never
// leaves the server; cookies carry only an expiry, nonce, and HMAC signature.
export const sessionCookie = 'token-tracker-session';
export const sessionMaxAge = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const signingKey = (passcode: string) =>
  crypto.subtle.importKey('raw', encoder.encode(passcode), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);

export const matchesPasscode = async (candidate: string, passcode: string) => {
  const [left, right] = await Promise.all(
    [candidate, passcode].map(
      async (value) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))),
    ),
  );
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
};

export const createSession = async (passcode: string, now = Date.now()) => {
  const expires = Math.floor(now / 1000) + sessionMaxAge;
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const payload = `v1.${expires}.${nonce}`;
  const signature = await crypto.subtle.sign(
    'HMAC',
    await signingKey(passcode),
    encoder.encode(`dashboard:${payload}`),
  );
  return `${payload}.${hex(new Uint8Array(signature))}`;
};

export const validSession = async (cookie: string | undefined, passcode: string, now = Date.now()) => {
  if (!cookie || cookie.length > 150) return false;
  const parts = /^v1\.(\d{10})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(cookie);
  if (!parts || Number(parts[1]) <= Math.floor(now / 1000)) return false;
  const signature = Uint8Array.from(parts[3].match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
  return crypto.subtle.verify(
    'HMAC',
    await signingKey(passcode),
    signature,
    encoder.encode(`dashboard:v1.${parts[1]}.${parts[2]}`),
  );
};

export const loginDestination = (value: string | null) => {
  if (
    !value?.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.split('').some((character) => character.charCodeAt(0) <= 32)
  )
    return '/';
  const destination = new URL(value, 'https://dashboard.invalid');
  return destination.origin === 'https://dashboard.invalid' && !['/login', '/logout'].includes(destination.pathname)
    ? destination.pathname + destination.search + destination.hash
    : '/';
};
