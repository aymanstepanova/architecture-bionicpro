import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import Redis from 'ioredis';
import pg from 'pg';

const {
  PORT = '8000',
  FRONTEND_ORIGIN = 'http://localhost:3000',
  AUTH_BASE_URL = 'http://localhost:8000',
  KEYCLOAK_BASE_URL = 'http://localhost:8080',
  KEYCLOAK_INTERNAL_BASE_URL = 'http://keycloak:8080',
  KEYCLOAK_REALM = 'reports-realm',
  KEYCLOAK_CLIENT_ID = 'bionicpro-auth',
  KEYCLOAK_CLIENT_SECRET,
  REDIS_URL = 'redis://redis:6379',
  COOKIE_NAME = 'sid',
  COOKIE_SECURE = 'false',
  REFRESH_TOKEN_ENC_KEY_B64 = '',
  USERPROFILE_DB_URL
} = process.env;

if (!KEYCLOAK_CLIENT_SECRET) {
  throw new Error('KEYCLOAK_CLIENT_SECRET must be set (Keycloak confidential client secret)');
}
if (!USERPROFILE_DB_URL) {
  throw new Error('USERPROFILE_DB_URL must be set (PostgreSQL connection string for user profiles)');
}

const cookieSecure = COOKIE_SECURE === 'true';

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function sha256Base64Url(str) {
  const hash = crypto.createHash('sha256').update(str).digest();
  return base64UrlEncode(hash);
}

function randomBase64Url(bytes = 32) {
  return base64UrlEncode(crypto.randomBytes(bytes));
}

/** Claims из id_token (OIDC); подпись не проверяем — токен только что получен от Keycloak. */
function decodeOidcIdTokenPayload(idToken) {
  if (!idToken || typeof idToken !== 'string') return {};
  const parts = idToken.split('.');
  if (parts.length < 2) return {};
  try {
    let b64 = parts[1].replaceAll('-', '+').replaceAll('_', '/');
    const pad = b64.length % 4;
    if (pad) b64 += '='.repeat(4 - pad);
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

function getEncKey() {
  if (REFRESH_TOKEN_ENC_KEY_B64) return Buffer.from(REFRESH_TOKEN_ENC_KEY_B64, 'base64');
  // Dev fallback: deterministic per-process key (not for production)
  return crypto.createHash('sha256').update('dev-refresh-token-key').digest();
}

function encryptString(plaintext) {
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${base64UrlEncode(iv)}.${base64UrlEncode(tag)}.${base64UrlEncode(ciphertext)}`;
}

function decryptString(payload) {
  const [ivB64u, tagB64u, ctB64u] = payload.split('.');
  if (!ivB64u || !tagB64u || !ctB64u) throw new Error('Invalid encrypted payload');
  const iv = Buffer.from(ivB64u.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  const tag = Buffer.from(tagB64u.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  const ciphertext = Buffer.from(ctB64u.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  const key = getEncKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

const redis = new Redis(REDIS_URL);

const pool = new pg.Pool({
  connectionString: USERPROFILE_DB_URL
});

async function ensureSchema() {
  await pool.query(`
    create table if not exists user_profiles (
      id bigserial primary key,
      provider text not null,
      subject text not null,
      email text,
      name text,
      raw_profile jsonb not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(provider, subject)
    );
  `);
}

const app = express();
app.set('trust proxy', 1);
app.use(cookieParser());
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true
  })
);
app.use(express.json());

function keycloakEndpoints(baseUrl) {
  const root = `${baseUrl}/realms/${encodeURIComponent(KEYCLOAK_REALM)}/protocol/openid-connect`;
  return {
    auth: `${root}/auth`,
    token: `${root}/token`,
    userinfo: `${root}/userinfo`,
    logout: `${root}/logout`
  };
}

async function savePkceState(state, verifier) {
  const key = `pkce:${state}`;
  await redis.set(key, verifier, 'EX', 5 * 60);
}

async function consumePkceVerifier(state) {
  const key = `pkce:${state}`;
  const verifier = await redis.get(key);
  if (!verifier) return null;
  await redis.del(key);
  return verifier;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'lax',
    path: '/'
  };
}

async function setSession(sid, session) {
  const key = `sess:${sid}`;
  await redis.set(key, JSON.stringify(session), 'EX', session.sessionTtlSeconds);
}

async function getSession(sid) {
  const key = `sess:${sid}`;
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function deleteSession(sid) {
  await redis.del(`sess:${sid}`);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function refreshAccessTokenIfNeeded(session) {
  const skewSeconds = 10;
  if (session.accessTokenExpiresAt && session.accessTokenExpiresAt > nowSeconds() + skewSeconds) {
    return session;
  }

  const refreshToken = decryptString(session.refreshTokenEnc);
  const endpoints = keycloakEndpoints(KEYCLOAK_INTERNAL_BASE_URL);

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('client_id', KEYCLOAK_CLIENT_ID);
  body.set('client_secret', KEYCLOAK_CLIENT_SECRET);
  body.set('refresh_token', refreshToken);

  const resp = await fetch(endpoints.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Refresh failed: ${resp.status} ${text}`);
  }

  const json = await resp.json();
  const accessToken = json.access_token;
  const newRefreshToken = json.refresh_token || refreshToken;
  const expiresIn = Number(json.expires_in || 0);

  return {
    ...session,
    accessToken,
    accessTokenExpiresAt: nowSeconds() + expiresIn,
    refreshTokenEnc: encryptString(newRefreshToken)
  };
}

async function rotateSessionId(oldSid, session, res) {
  const newSid = randomBase64Url(32);
  await setSession(newSid, session);
  await deleteSession(oldSid);
  res.cookie(COOKIE_NAME, newSid, cookieOptions());
  return newSid;
}

async function requireSession(req, res, next) {
  const sid = req.cookies[COOKIE_NAME];
  if (!sid) return res.status(401).json({ error: 'Not authenticated' });

  let session = await getSession(sid);
  if (!session) return res.status(401).json({ error: 'Session expired' });

  try {
    session = await refreshAccessTokenIfNeeded(session);
  } catch (e) {
    await deleteSession(sid);
    return res.status(401).json({ error: 'Session invalid' });
  }

  // Persist updated tokens, then rotate sid to mitigate fixation
  await setSession(sid, session);
  const newSid = await rotateSessionId(sid, session, res);

  req.session = session;
  req.sessionId = newSid;
  return next();
}

app.get('/health', async (_req, res) => {
  try {
    await redis.ping();
    await pool.query('select 1 as ok');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

app.get('/auth/start', async (req, res) => {
  const state = randomBase64Url(24);
  const codeVerifier = randomBase64Url(48);
  const codeChallenge = sha256Base64Url(codeVerifier);

  await savePkceState(state, codeVerifier);

  const endpoints = keycloakEndpoints(KEYCLOAK_BASE_URL);
  const redirectUri = `${AUTH_BASE_URL}/auth/callback`;
  const params = new URLSearchParams({
    client_id: KEYCLOAK_CLIENT_ID,
    response_type: 'code',
    scope: 'openid profile email',
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });

  // Optional app return URL
  const returnTo = req.query.returnTo ? String(req.query.returnTo) : '';
  if (returnTo) {
    params.set('nonce', returnTo);
  }

  return res.redirect(`${endpoints.auth}?${params.toString()}`);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code ? String(req.query.code) : '';
  const state = req.query.state ? String(req.query.state) : '';
  if (!code || !state) return res.status(400).send('Missing code/state');

  const codeVerifier = await consumePkceVerifier(state);
  if (!codeVerifier) return res.status(400).send('PKCE state expired');

  const endpoints = keycloakEndpoints(KEYCLOAK_INTERNAL_BASE_URL);
  const redirectUri = `${AUTH_BASE_URL}/auth/callback`;

  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('client_id', KEYCLOAK_CLIENT_ID);
  body.set('client_secret', KEYCLOAK_CLIENT_SECRET);
  body.set('code', code);
  body.set('redirect_uri', redirectUri);
  body.set('code_verifier', codeVerifier);

  const tokenResp = await fetch(endpoints.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!tokenResp.ok) {
    const text = await tokenResp.text();
    return res.status(500).send(`Token exchange failed: ${tokenResp.status} ${text}`);
  }

  const tokenJson = await tokenResp.json();
  const accessToken = tokenJson.access_token;
  const refreshToken = tokenJson.refresh_token;
  const expiresIn = Number(tokenJson.expires_in || 0);
  const idClaims = decodeOidcIdTokenPayload(tokenJson.id_token);

  // Userinfo иногда пустой/без sub; id_token после code exchange всегда содержит sub (openid)
  let userinfo = {};
  try {
    const ui = await fetch(endpoints.userinfo, {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    if (ui.ok) userinfo = await ui.json();
  } catch {
    userinfo = {};
  }

  const merged = { ...idClaims, ...userinfo };
  const provider = merged.identity_provider || merged.idp || 'keycloak';
  const subject = merged.sub || 'unknown';
  const email = merged.email ?? null;
  const name = merged.name || merged.preferred_username || null;

  try {
    await pool.query(
      `
      insert into user_profiles (provider, subject, email, name, raw_profile)
      values ($1, $2, $3, $4, $5::jsonb)
      on conflict (provider, subject) do update
        set email = excluded.email,
            name = excluded.name,
            raw_profile = excluded.raw_profile,
            updated_at = now();
      `,
      [String(provider), String(subject), email, name, JSON.stringify(merged)]
    );
  } catch {
    // ignore profile persistence errors for auth flow
  }

  const sid = randomBase64Url(32);
  const sessionTtlSeconds = 60 * 60; // 1h session, must be > access token TTL
  await setSession(sid, {
    sessionTtlSeconds,
    createdAt: nowSeconds(),
    accessToken,
    accessTokenExpiresAt: nowSeconds() + expiresIn,
    refreshTokenEnc: encryptString(refreshToken),
    user: {
      provider,
      subject,
      email,
      name,
      profile: merged
    }
  });

  res.cookie(COOKIE_NAME, sid, cookieOptions());

  // Return to app if provided
  const returnTo = req.query.returnTo ? String(req.query.returnTo) : '';
  if (returnTo) return res.redirect(returnTo);
  return res.redirect(FRONTEND_ORIGIN);
});

app.post('/auth/logout', requireSession, async (req, res) => {
  const sid = req.cookies[COOKIE_NAME];
  if (sid) await deleteSession(sid);
  res.clearCookie(COOKIE_NAME, cookieOptions());
  res.json({ ok: true });
});

app.get('/me', requireSession, async (req, res) => {
  res.json({
    authenticated: true,
    user: {
      provider: req.session.user.provider,
      subject: req.session.user.subject,
      email: req.session.user.email,
      name: req.session.user.name
    },
    sessionRotated: true
  });
});

// Minimal secured endpoint (placeholder for Reports API integration)
app.get('/reports', requireSession, async (req, res) => {
  res.json({
    user: req.session.user.subject,
    generatedAt: new Date().toISOString(),
    note: 'This is a placeholder report endpoint for assignment 1 auth verification.'
  });
});

await ensureSchema();
app.listen(Number(PORT), () => {
  // eslint-disable-next-line no-console
  console.log(`bionicpro-auth listening on :${PORT}`);
});

