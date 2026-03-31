import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import Redis from 'ioredis';
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const {
  PORT = '8001',
  FRONTEND_ORIGIN = 'http://localhost:3000',
  REDIS_URL = 'redis://redis:6379',
  COOKIE_NAME = 'sid',
  CLICKHOUSE_HTTP = 'http://clickhouse:8123',
  S3_ENDPOINT = 'http://minio:9000',
  S3_BUCKET = 'reports',
  S3_REGION = 'us-east-1',
  S3_ACCESS_KEY,
  S3_SECRET_KEY,
  CDN_BASE_URL = 'http://localhost:8088',
  CDN_PREFIX = '/reports-cache'
} = process.env;

if (!S3_ACCESS_KEY) {
  throw new Error('S3_ACCESS_KEY must be set');
}
if (!S3_SECRET_KEY) {
  throw new Error('S3_SECRET_KEY must be set');
}

const redis = new Redis(REDIS_URL);
const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY
  }
});

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

function isoToChDateTime(iso) {
  // expects 'YYYY-MM-DD' or ISO; returns 'YYYY-MM-DD 00:00:00'
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return `${iso} 00:00:00`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function chStringLiteral(value) {
  const s = String(value);
  // Escape for ClickHouse single-quoted string literal
  return `'${s.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
}

async function getSessionFromRedis(sid) {
  const raw = await redis.get(`sess:${sid}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function chQueryJsonEachRow(sql) {
  const resp = await fetch(`${CLICKHOUSE_HTTP}/?query=${encodeURIComponent(sql)}&default_format=JSONEachRow`, {
    method: 'POST'
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ClickHouse error: ${resp.status} ${text}`);
  }
  const text = await resp.text();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

async function getAvailableTo() {
  const rows = await chQueryJsonEachRow(`
    SELECT watermark_to
    FROM reports.etl_watermarks
    WHERE source = 'reports_available_to'
    ORDER BY updated_at DESC
    LIMIT 1
    FORMAT JSONEachRow
  `);
  return rows.length ? rows[0].watermark_to : null;
}

function normalizeDateOnly(dateStr) {
  if (!dateStr) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function addDaysUtc(yyyyMmDd, deltaDays) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + deltaDays);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function watermarkToVersion(watermarkTo) {
  if (!watermarkTo) return 'none';
  return String(watermarkTo).replace(/[^\d]/g, '').slice(0, 14) || 'none';
}

function encodePathPreservingSlashes(path) {
  return String(path)
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function toCsv(rows) {
  const columns = [
    'user_id',
    'prosthesis_id',
    'event_date',
    'movements',
    'errors',
    'low_battery_events',
    'avg_latency_ms',
    'country',
    'prosthesis_type',
    'processed_at',
    'watermark_to'
  ];
  const header = columns.join(',');
  const body = rows
    .map((r) => columns.map((c) => csvEscape(r?.[c])).join(','))
    .join('\n');
  return `${header}\n${body}\n`;
}

async function s3ObjectExists(objectKey) {
  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: S3_BUCKET,
        Key: objectKey
      })
    );
    return true;
  } catch (e) {
    const name = e?.name || e?.Code || e?.code;
    const httpStatus = e?.$metadata?.httpStatusCode;
    if (name === 'NotFound' || name === 'NoSuchKey' || httpStatus === 404) return false;
    throw e;
  }
}

function requireAuth(req, res, next) {
  const sid = req.cookies[COOKIE_NAME];
  if (!sid) return res.status(401).json({ error: 'Not authenticated' });
  req.sid = sid;
  return next();
}

/** В витрине user_id = email из CRM (см. reports_etl); в сессии Keycloak — email + sub (UUID). */
function martUserKey(session) {
  const u = session?.user;
  if (!u) return '';
  const email = u.email && String(u.email).trim();
  if (email) return email;
  return String(u.subject || '');
}

app.get('/health', async (_req, res) => {
  try {
    await redis.ping();
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

app.get('/reports', requireAuth, async (req, res) => {
  const session = await getSessionFromRedis(req.sid);
  if (!session?.user?.subject) return res.status(401).json({ error: 'Session invalid' });
  const userId = martUserKey(session);

  try {
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;

    const availableTo = await getAvailableTo();
    if (to && availableTo) {
      const toDt = isoToChDateTime(to);
      if (toDt && toDt > String(availableTo)) {
        return res.status(409).json({
          error: 'Report data not ready for requested period',
          available_to: availableTo
        });
      }
    }

    // Default period: last 7 days ending at available_to (if present)
    let where = `user_id = ${chStringLiteral(userId)}`;
    if (from) where += ` AND event_date >= toDate(${chStringLiteral(from)})`;
    if (to) where += ` AND event_date <= toDate(${chStringLiteral(to)})`;

    const rows = await chQueryJsonEachRow(`
      SELECT
        user_id,
        prosthesis_id,
        event_date,
        movements,
        errors,
        low_battery_events,
        avg_latency_ms,
        country,
        prosthesis_type,
        processed_at,
        watermark_to
      FROM reports.reporting_mart_daily
      WHERE ${where}
      ORDER BY event_date DESC
      LIMIT 365
      FORMAT JSONEachRow
    `);

    return res.json({
      user_id: userId,
      available_to: availableTo,
      from,
      to,
      rows
    });
  } catch (e) {
    return res.status(500).json({ error: 'Reports read failed', message: String(e?.message || e) });
  }
});

// Чтение из витрины CDC (не из CRM Postgres) — задание 4
app.get('/crm-export', requireAuth, async (req, res) => {
  const session = await getSessionFromRedis(req.sid);
  if (!session?.user?.subject) return res.status(401).json({ error: 'Session invalid' });
  const email = session.user?.email && String(session.user.email).trim();
  const subject = String(session.user.subject);
  const cdcFilter = email
    ? `email = ${chStringLiteral(email)}`
    : `user_id = ${chStringLiteral(subject)}`;

  try {
    const rows = await chQueryJsonEachRow(`
      SELECT
        user_id,
        email,
        country,
        prosthesis_id,
        prosthesis_type,
        updated_at
      FROM reports.crm_cdc_mart
      FINAL
      WHERE ${cdcFilter}
      ORDER BY updated_at DESC
      LIMIT 100
      FORMAT JSONEachRow
    `);
    res.json({ user_id: email || subject, source: 'cdc_mart', rows });
  } catch (e) {
    res.status(500).json({ error: 'CDC mart read failed', message: String(e?.message || e) });
  }
});

app.get('/reports/url', requireAuth, async (req, res) => {
  const session = await getSessionFromRedis(req.sid);
  if (!session?.user?.subject) return res.status(401).json({ error: 'Session invalid' });
  const userId = martUserKey(session);

  try {
    const availableTo = await getAvailableTo();

    const requestedFrom = req.query.from ? String(req.query.from) : null;
    const requestedTo = req.query.to ? String(req.query.to) : null;

    // keep assignment-2 behavior: if requested 'to' beyond watermark -> 409
    if (requestedTo && availableTo) {
      const toDt = isoToChDateTime(requestedTo);
      if (toDt && toDt > String(availableTo)) {
        return res.status(409).json({
          error: 'Report data not ready for requested period',
          available_to: availableTo
        });
      }
    }

    // Deterministic defaults for cache key
    const watermarkDateOnly = availableTo ? normalizeDateOnly(String(availableTo)) : null;
    const toDate =
      normalizeDateOnly(requestedTo) || watermarkDateOnly || normalizeDateOnly(new Date().toISOString());
    const fromDate = normalizeDateOnly(requestedFrom) || addDaysUtc(toDate, -6);

    const wmVersion = watermarkToVersion(availableTo);
    const objectKey = `reports/v1/user/${userId}/from=${fromDate}/to=${toDate}/wm=${wmVersion}/report.csv`;

    const url = `${CDN_BASE_URL}${CDN_PREFIX}/${encodePathPreservingSlashes(objectKey)}`;

    const exists = await s3ObjectExists(objectKey);
    if (exists) {
      return res.json({
        url,
        cache: 'hit',
        available_to: availableTo
      });
    }

    let where = `user_id = ${chStringLiteral(userId)}`;
    if (fromDate) where += ` AND event_date >= toDate(${chStringLiteral(fromDate)})`;
    if (toDate) where += ` AND event_date <= toDate(${chStringLiteral(toDate)})`;

    const rows = await chQueryJsonEachRow(`
      SELECT
        user_id,
        prosthesis_id,
        event_date,
        movements,
        errors,
        low_battery_events,
        avg_latency_ms,
        country,
        prosthesis_type,
        processed_at,
        watermark_to
      FROM reports.reporting_mart_daily
      WHERE ${where}
      ORDER BY event_date DESC
      LIMIT 365
      FORMAT JSONEachRow
    `);

    const csv = toCsv(rows);

    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: objectKey,
        Body: Buffer.from(csv, 'utf8'),
        ContentType: 'text/csv; charset=utf-8',
        ContentDisposition: 'attachment; filename=\"report.csv\"',
        CacheControl: 'public, max-age=31536000'
      })
    );

    return res.json({
      url,
      cache: 'miss',
      available_to: availableTo
    });
  } catch (e) {
    const status = Number(e?.$metadata?.httpStatusCode) || 500;
    return res.status(status).json({ error: 'Report cache/write failed', message: String(e?.message || e) });
  }
});

app.listen(Number(PORT), () => {
  // eslint-disable-next-line no-console
  console.log(`reports-api listening on :${PORT}`);
});

