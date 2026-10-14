import { put } from '@vercel/blob';
import { timingSafeEqual } from 'node:crypto';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const KEY = 'alphalabs:leads';
const STATUSES = ['new', 'contacted', 'won', 'lost'];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function redis(cmd) {
  const r = await fetch(REDIS_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + REDIS_TOKEN }, body: JSON.stringify(cmd) });
  if (!r.ok) throw new Error('Redis HTTP ' + r.status);
  return (await r.json()).result;
}
const readLeads = async () => { const v = await redis(['GET', KEY]); return v ? JSON.parse(v) : []; };
const writeLeads = leads => redis(['SET', KEY, JSON.stringify(leads)]);

function isAdmin(request) {
  const pw = process.env.ADMIN_PASSWORD || '';
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given), b = Buffer.from(pw);
  return pw.length >= 6 && a.length === b.length && timingSafeEqual(a, b);
}
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/* Formadan gələn yeni müraciət (açıq) */
export async function POST(request) {
  try {
    const form = await request.formData();
    const name = clean(form.get('name'), 120);
    const phone = clean(form.get('phone'), 40);
    const business = clean(form.get('business'), 160);
    if (!name || !phone || !business) return json({ error: 'missing fields' }, 400);

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    let image = '';
    const file = form.get('image');
    if (file && typeof file === 'object' && file.size > 0 && process.env.BLOB_READ_WRITE_TOKEN) {
      try {
        const safe = clean(file.name, 80).replace(/[^\w.\-]+/g, '_') || 'logo';
        const blob = await put('logos/' + id + '-' + safe, file, { access: 'public', addRandomSuffix: true });
        image = blob.url;
      } catch (e) { console.error('blob upload failed', e); }
    }

    const leads = await readLeads();
    leads.push({
      id, date: new Date().toISOString(), name, phone, business,
      service: clean(form.get('service'), 80), language: clean(form.get('language'), 5),
      image, status: 'new', note: ''
    });
    await writeLeads(leads.slice(-5000));
    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ error: 'server error' }, 500);
  }
}

/* Admin: siyahını oxu */
export async function GET(request) {
  if (!isAdmin(request)) return json({ error: 'unauthorized' }, 401);
  try { return json(await readLeads()); }
  catch (e) { console.error(e); return json({ error: 'server error' }, 500); }
}

/* Admin: siyahını yenilə (status, qeyd, silmə) */
export async function PUT(request) {
  if (!isAdmin(request)) return json({ error: 'unauthorized' }, 401);
  try {
    const body = await request.json();
    if (!Array.isArray(body)) return json({ error: 'array expected' }, 400);
    const leads = body.slice(-5000).map(l => ({
      id: clean(l.id, 40), date: clean(l.date, 40), name: clean(l.name, 120), phone: clean(l.phone, 40),
      business: clean(l.business, 160), service: clean(l.service, 80), language: clean(l.language, 5),
      image: /^https:\/\//.test(l.image || '') ? clean(l.image, 500) : '',
      status: STATUSES.includes(l.status) ? l.status : 'new', note: clean(l.note, 1000)
    }));
    await writeLeads(leads);
    return json({ ok: true });
  } catch (e) { console.error(e); return json({ error: 'server error' }, 500); }
}
