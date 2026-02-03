import express from 'express';
import dotenv from 'dotenv';
import { createHash } from 'node:crypto';

dotenv.config();

const app = express();
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BUILD_INFO = {
  commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
  url: process.env.VERCEL_URL || null,
  env: process.env.VERCEL_ENV || null,
};

function getSupabaseProjectRef(url) {
  try {
    if (!url) return null;
    const u = new URL(url);
    const host = u.hostname || '';
    const parts = host.split('.');
    const ref = parts?.[0] || null;
    return ref || null;
  } catch {
    return null;
  }
}

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function normalizeAmountCents(raw) {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(n)) return null;
  // Heurística: se vier como 7.99 -> BRL, converte para centavos.
  if (n > 0 && n < 1000 && Math.round(n) !== n) return Math.round(n * 100);
  // Se vier como 799 (centavos) mantém.
  return Math.round(n);
}

function nowIso() {
  return new Date().toISOString();
}

function parseReference(reference) {
  if (!reference || typeof reference !== 'string') return null;
  // user_<uuid>_days_<N>
  let m = reference.match(/^user_([0-9a-fA-F-]{36})_days_(\d{1,4})$/);
  if (m) return { user_id: m[1], days: Number(m[2]) };
  // user_<uuid>_<N>
  m = reference.match(/^user_([0-9a-fA-F-]{36})_(\d{1,4})$/);
  if (m) return { user_id: m[1], days: Number(m[2]) };
  // legado: user_<uuid>_premium
  m = reference.match(/^user_([0-9a-fA-F-]{36})_(premium|standard)$/);
  if (m) return { user_id: m[1], days: m[2] === 'premium' ? 30 : 0 };
  return null;
}

function normalizeStatus(raw) {
  if (!raw) return null;
  return String(raw).trim().toLowerCase();
}

function normalizeEventName(raw) {
  if (!raw) return null;
  return String(raw).trim().toLowerCase();
}

function toBoolOrNull(v) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  return null;
}

function findFirstKeyMatch(root, keySet, { maxDepth = 5, maxArray = 50, maxKeys = 200 } = {}) {
  // Returns { path, value } where value is primitive (string/number/boolean), else null.
  // Defensive limits to avoid expensive traversal on weird payloads.
  const seen = new Set();
  const queue = [{ value: root, path: '$', depth: 0 }];
  let visitedKeys = 0;

  while (queue.length) {
    const { value, path, depth } = queue.shift();
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (depth >= maxDepth) continue;

    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(value.length, maxArray); i++) {
        queue.push({ value: value[i], path: `${path}[${i}]`, depth: depth + 1 });
      }
      continue;
    }

    const keys = Object.keys(value);
    for (const k of keys) {
      visitedKeys++;
      if (visitedKeys > maxKeys) return null;

      const v = value[k];
      if (keySet.has(String(k).toLowerCase())) {
        if (v === null || v === undefined) {
          // keep searching
        } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          return { path: `${path}.${k}`, value: v };
        }
      }

      if (v && typeof v === 'object') {
        queue.push({ value: v, path: `${path}.${k}`, depth: depth + 1 });
      }
    }
  }

  return null;
}

function findFirstStringMatch(root, regex, { maxDepth = 5, maxArray = 50, maxKeys = 400 } = {}) {
  const seen = new Set();
  const queue = [{ value: root, depth: 0 }];
  let visitedKeys = 0;

  while (queue.length) {
    const { value, depth } = queue.shift();
    if (value === null || value === undefined) continue;

    if (typeof value === 'string') {
      if (regex.test(value)) return value;
      continue;
    }

    if (typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (depth >= maxDepth) continue;

    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(value.length, maxArray); i++) {
        queue.push({ value: value[i], depth: depth + 1 });
      }
      continue;
    }

    for (const k of Object.keys(value)) {
      visitedKeys++;
      if (visitedKeys > maxKeys) return null;
      queue.push({ value: value[k], depth: depth + 1 });
    }
  }

  return null;
}

function computeApproval({ eventName, status, evt }) {
  const explicitApproved =
    toBoolOrNull(evt?.data?.approved) ??
    toBoolOrNull(evt?.data?.is_approved) ??
    toBoolOrNull(evt?.data?.isApproved) ??
    toBoolOrNull(evt?.approved) ??
    toBoolOrNull(evt?.is_approved) ??
    toBoolOrNull(evt?.isApproved);

  if (explicitApproved !== null) return explicitApproved;

  const explicitPaid =
    toBoolOrNull(evt?.data?.paid) ??
    toBoolOrNull(evt?.data?.is_paid) ??
    toBoolOrNull(evt?.data?.isPaid) ??
    toBoolOrNull(evt?.paid) ??
    toBoolOrNull(evt?.is_paid) ??
    toBoolOrNull(evt?.isPaid);

  if (explicitPaid !== null) return explicitPaid;

  // Timestamp-based signals (common in some providers).
  const hasPaidAt = Boolean(
    evt?.data?.paid_at ||
      evt?.data?.paidAt ||
      evt?.data?.approved_at ||
      evt?.data?.approvedAt ||
      evt?.data?.confirmed_at ||
      evt?.data?.confirmedAt ||
      evt?.data?.captured_at ||
      evt?.data?.capturedAt
  );
  if (hasPaidAt) return true;

  // Amount-based signals: if paid_amount equals or exceeds amount, treat as paid.
  const amountCents = normalizeAmountCents(
    evt?.data?.amount ?? evt?.data?.total_amount ?? evt?.amount ?? evt?.total_amount ?? null
  );
  const paidAmountCents = normalizeAmountCents(
    evt?.data?.paid_amount ?? evt?.data?.paidAmount ?? evt?.paid_amount ?? evt?.paidAmount ?? null
  );
  if (Number.isFinite(amountCents) && amountCents > 0 && Number.isFinite(paidAmountCents)) {
    if (paidAmountCents >= amountCents) return true;
    if (paidAmountCents === 0) return false;
  }

  // Normalize status/eventName based inference.
  const okStatuses = new Set([
    'approved',
    'paid',
    'succeeded',
    'success',
    'completed',
    'confirmed',
    'captured',
    'settled',
    'authorized',
    'authorised',
    // PT-BR common variants
    'aprovado',
    'pago',
    'confirmado',
    'concluido',
    'concluído',
  ]);
  const notOkStatuses = new Set([
    'rejected',
    'refused',
    'failed',
    'canceled',
    'cancelled',
    'chargeback',
    'refunded',
    'expired',
    'voided',
    // PT-BR common variants
    'recusado',
    'rejeitado',
    'falhou',
    'cancelado',
    'cancelada',
    'estornado',
    'estornada',
    'expirado',
    'expirada',
  ]);

  if (status && okStatuses.has(status)) return true;
  if (status && notOkStatuses.has(status)) return false;

  const okEvents = new Set([
    'payment.approved',
    'payment.paid',
    'payment.succeeded',
    'transaction.approved',
    'transaction.paid',
  ]);
  const notOkEvents = new Set([
    'payment.rejected',
    'payment.failed',
    'payment.canceled',
    'payment.cancelled',
    'payment.refunded',
    'transaction.rejected',
    'transaction.failed',
    'transaction.canceled',
    'transaction.cancelled',
    'transaction.refunded',
  ]);
  if (eventName && okEvents.has(eventName)) return true;
  if (eventName && notOkEvents.has(eventName)) return false;

  // Unknown: do NOT treat as not-approved.
  return null;
}

function looksLikeUuid(v) {
  return typeof v === 'string' && /^[0-9a-fA-F-]{36}$/.test(v.trim());
}

function safeNumber(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

function stableFallbackPaymentId(evt) {
  try {
    const raw = JSON.stringify(evt ?? {});
    return createHash('sha256').update(raw).digest('hex').slice(0, 32);
  } catch {
    return null;
  }
}

function daysFromAmount(amountCents) {
  if (!Number.isFinite(amountCents)) return null;
  // Alinhar com os preços do frontend.
  const map = new Map([
    [799, 30],
    [3500, 180],
    [5999, 365],
  ]);
  return map.get(amountCents) ?? null;
}

async function supabaseRpc(fnName, payload) {
  requireEnv('SUPABASE_URL', SUPABASE_URL);
  requireEnv('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY);

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload ?? {}),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Supabase RPC ${fnName} failed (${resp.status}): ${text}`);
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function supabaseInsert(tableName, payload) {
  requireEnv('SUPABASE_URL', SUPABASE_URL);
  requireEnv('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY);

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${tableName}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(payload ?? {}),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Supabase insert ${tableName} failed (${resp.status}): ${text}`);
  }
  return null;
}

async function supabaseSelect(tableName, queryString) {
  requireEnv('SUPABASE_URL', SUPABASE_URL);
  requireEnv('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY);

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${tableName}?${queryString}`, {
    method: 'GET',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Supabase select ${tableName} failed (${resp.status}): ${text}`);
  }
  try {
    return text ? JSON.parse(text) : [];
  } catch {
    return [];
  }
}

async function supabasePatch(tableName, queryString, payload) {
  requireEnv('SUPABASE_URL', SUPABASE_URL);
  requireEnv('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY);

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${tableName}?${queryString}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload ?? {}),
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Supabase patch ${tableName} failed (${resp.status}): ${text}`);
  }
  try {
    return text ? JSON.parse(text) : [];
  } catch {
    return [];
  }
}

async function logWebhookEvent(eventRow) {
  try {
    // Optional: only works if the table exists in Supabase.
    await supabaseInsert('payment_webhook_events', eventRow);
  } catch (e) {
    // If table exists but a column is missing (schema drift), retry with a minimal payload.
    const msg = String(e?.message || e);
    const looksLikeUnknownColumn = msg.includes('Could not find the') || msg.includes('column') || msg.includes('PGRST');
    if (looksLikeUnknownColumn) {
      try {
        const {
          provider,
          received_at,
          event_name,
          status,
          approved,
          provider_payment_id,
          reference,
          amount_cents,
          payer_email,
          user_id,
          days,
          outcome,
          outcome_reason,
        } = eventRow || {};

        await supabaseInsert('payment_webhook_events', {
          provider,
          received_at,
          event_name,
          status,
          approved,
          provider_payment_id,
          reference,
          amount_cents,
          payer_email,
          user_id,
          days,
          outcome,
          outcome_reason,
        });
        return;
      } catch {
        // fallthrough
      }
    }

    // Never break webhook processing because of logging.
    console.warn('Falha ao registrar payment_webhook_events (ignorado):', msg);
  }
}

function sanitizeWebhookEvent(evt) {
  try {
    const data = evt?.data ?? null;
    const foundStatus = findFirstKeyMatch(evt, new Set(['status', 'state', 'situation', 'payment_status', 'transaction_status']));
    return {
      hasData: Boolean(data),
      event:
        evt?.event ??
        evt?.type ??
        evt?.name ??
        evt?.event_name ??
        evt?.eventName ??
        evt?.topic ??
        evt?.action ??
        evt?.event_type ??
        evt?.eventType ??
        null,
      topLevelKeys: Object.keys(evt || {}).slice(0, 50),
      dataKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 80) : null,
      found: {
        statusPath: foundStatus?.path ?? null,
        statusValue: foundStatus?.value ?? null,
      },
      data: {
        status:
          data?.status ||
          data?.payment_status ||
          data?.paymentStatus ||
          data?.transaction_status ||
          data?.state ||
          data?.situation ||
          data?.status_detail ||
          data?.statusDetail ||
          data?.payment?.status ||
          data?.transaction?.status ||
          data?.charge?.status ||
          data?.order?.status ||
          null,
        approved:
          data?.approved ??
          data?.is_approved ??
          data?.isApproved ??
          evt?.approved ??
          evt?.is_approved ??
          evt?.isApproved ??
          null,
        paid:
          data?.paid ??
          data?.is_paid ??
          data?.isPaid ??
          evt?.paid ??
          evt?.is_paid ??
          evt?.isPaid ??
          null,
        amount: data?.amount ?? data?.total_amount ?? null,
        topAmount: evt?.amount ?? evt?.total_amount ?? null,
        topPaidAmount: evt?.paid_amount ?? evt?.paidAmount ?? null,
        reference:
          data?.reference ||
          data?.external_reference ||
          data?.externalReference ||
          data?.metadata?.reference ||
          data?.metadata?.ref ||
          data?.metadata?.external_reference ||
          null,
        uid: data?.uid || data?.user_id || data?.userId || data?.metadata?.uid || data?.metadata?.user_id || data?.metadata?.userId || null,
        days: data?.days || data?.metadata?.days || data?.metadata?.plan_days || null,
        paymentId: data?.payment_id || data?.paymentId || data?.id || data?.transaction_id || data?.transactionId || null,
        topPaymentId: evt?.payment_id || evt?.paymentId || evt?.id || evt?.transaction_id || evt?.transactionId || evt?.transaction_nsu || evt?.order_nsu || evt?.invoice_slug || null,
        payerEmail:
          data?.customer?.email ||
          data?.payer?.email ||
          data?.buyer?.email ||
          data?.customer_email ||
          data?.customerEmail ||
          data?.buyer_email ||
          data?.buyerEmail ||
          data?.email ||
          null,
      },
    };
  } catch {
    return null;
  }
}

async function applyCredits({ userId, days, amountCents, providerPaymentId, rawEvent }) {
  await supabaseRpc('service_apply_payment_credits', {
    p_user_id: userId,
    p_days: days,
    p_amount_cents: amountCents ?? 0,
    p_description: 'infinitepay_webhook',
    p_provider: 'infinitepay',
    p_provider_payment_id: providerPaymentId ?? null,
    p_raw_event: rawEvent ?? null,
  });
}

async function tryMatchIntent({ amountCents, providerPaymentId }) {
  // Tries to match a pending intent created by the frontend when the webhook doesn't include user info.
  // Only auto-matches if there is exactly 1 candidate within the window.
  if (!Number.isFinite(amountCents)) return { intent: null, reason: 'invalid_amount' };

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const qs = new URLSearchParams({
    select: 'id,user_id,days,created_at',
    provider: 'eq.infinitepay',
    status: 'eq.pending',
    amount_cents: `eq.${amountCents}`,
    created_at: `gte.${since}`,
    order: 'created_at.desc',
    limit: '2',
  });

  const rows = await supabaseSelect('payment_intents', qs.toString());
  if (!Array.isArray(rows) || rows.length === 0) return { intent: null, reason: 'no_candidate' };
  if (rows.length !== 1) return { intent: null, reason: 'multiple_candidates' };

  const intent = rows[0];
  if (!intent?.id || !intent?.user_id) return { intent: null, reason: 'invalid_intent_row' };

  // Claim it (best-effort) to avoid double matching.
  const claimQs = new URLSearchParams({
    id: `eq.${intent.id}`,
    status: 'eq.pending',
    select: 'id',
  });
  const claimed = await supabasePatch('payment_intents', claimQs.toString(), {
    status: 'matched',
    provider_payment_id: providerPaymentId ?? null,
    matched_at: nowIso(),
  });
  if (!Array.isArray(claimed) || claimed.length !== 1) return { intent: null, reason: 'claim_failed' };

  return { intent, reason: 'matched' };
}

app.post('/api/infinitepay/webhook', async (req, res) => {
  // Keep context for error logging.
  let ctxEventName = null;
  let ctxStatus = null;
  let ctxApproved = null;
  let ctxReference = null;
  let ctxProviderPaymentId = null;
  let ctxAmountCents = null;
  let ctxPayerEmail = null;
  let ctxUserId = null;
  let ctxDays = null;
  let ctxIntentId = null;
  let ctxOutcome = null;
  let ctxOutcomeReason = null;
  let ctxIntentMatchReason = null;
  const ctxTraceId = `t_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;

  try {
    const evt = req.body ?? {};

    const hasSupabaseUrl = Boolean(SUPABASE_URL);
    const hasServiceRoleKey = Boolean(SUPABASE_SERVICE_ROLE_KEY);
    if (!hasSupabaseUrl || !hasServiceRoleKey) {
      console.error('Webhook recebido mas env do Supabase ausente', {
        hasSupabaseUrl,
        hasServiceRoleKey,
      });
      return res.status(500).json({ error: 'missing_supabase_env' });
    }

    const eventNameRaw =
      evt?.event ||
      evt?.type ||
      evt?.name ||
      evt?.event_name ||
      evt?.eventName ||
      evt?.topic ||
      evt?.action ||
      evt?.event_type ||
      evt?.eventType ||
      null;
    const eventName = normalizeEventName(eventNameRaw);
    const statusRaw =
      evt?.data?.status ||
      evt?.data?.payment_status ||
      evt?.data?.paymentStatus ||
      evt?.data?.transaction_status ||
      evt?.data?.state ||
      evt?.data?.situation ||
      evt?.data?.status_detail ||
      evt?.data?.statusDetail ||
      evt?.data?.payment?.status ||
      evt?.data?.transaction?.status ||
      evt?.data?.charge?.status ||
      evt?.data?.order?.status ||
      evt?.status ||
      null;
    const statusFallback =
      statusRaw ??
      findFirstKeyMatch(evt, new Set(['status', 'state', 'situation', 'payment_status', 'transaction_status']))?.value ??
      null;
    const status = normalizeStatus(statusFallback);

    ctxEventName = eventName;
    ctxStatus = status;

    const approved = computeApproval({ eventName, status, evt });

    ctxApproved = approved;

    // Always log a compact summary so we can confirm delivery in Vercel logs.
    try {
      console.log('InfinitePay webhook summary', {
        eventName,
        status,
        approved,
        hasReference: Boolean(
          evt?.data?.reference ||
            evt?.data?.external_reference ||
            evt?.data?.externalReference ||
            evt?.data?.metadata?.reference ||
            evt?.data?.metadata?.ref ||
            evt?.data?.metadata?.external_reference ||
            evt?.reference
        ),
        hasId: Boolean(evt?.data?.id || evt?.data?.payment_id || evt?.data?.transaction_id || evt?.id),
      });
    } catch {
      // ignore
    }

    const reference =
      evt?.data?.reference ||
      evt?.data?.external_reference ||
      evt?.data?.externalReference ||
      evt?.data?.order_reference ||
      evt?.data?.orderReference ||
      evt?.data?.description ||
      evt?.data?.title ||
      evt?.data?.message ||
      evt?.data?.metadata?.reference ||
      evt?.data?.metadata?.ref ||
      evt?.data?.metadata?.external_reference ||
      evt?.reference ||
      null;

    // Some providers move our reference/metadata around; try to find any reference-like string.
    const referenceRegex = /user_[0-9a-fA-F-]{36}_(?:days_\d{1,4}|\d{1,4}|premium|standard)/;
    const referenceScanned = reference ?? findFirstStringMatch(evt, referenceRegex);

    ctxReference = referenceScanned;

    let providerPaymentId =
      evt?.data?.payment_id ||
      evt?.data?.paymentId ||
      evt?.data?.id ||
      evt?.data?.transaction_id ||
      evt?.data?.transactionId ||
      evt?.data?.transaction_nsu ||
      evt?.data?.order_nsu ||
      evt?.data?.invoice_slug ||
      evt?.payment_id ||
      evt?.id ||
      evt?.transaction_id ||
      evt?.transactionId ||
      evt?.transaction_nsu ||
      evt?.order_nsu ||
      evt?.invoice_slug ||
      null;
    if (!providerPaymentId) providerPaymentId = stableFallbackPaymentId(evt);

    ctxProviderPaymentId = providerPaymentId;

    const amountRaw =
      evt?.data?.amount ??
      evt?.data?.total_amount ??
      evt?.amount ??
      evt?.total_amount ??
      // Some payloads only include paid_amount
      evt?.paid_amount ??
      evt?.paidAmount ??
      null;

    const amountFallback =
      amountRaw ??
      findFirstKeyMatch(evt, new Set(['amount', 'total_amount', 'paid_amount', 'paidamount']))?.value ??
      null;

    const amountCents = normalizeAmountCents(amountFallback);
    const inferredDays = daysFromAmount(amountCents);

    ctxAmountCents = amountCents;

    const payerEmail =
      evt?.data?.customer?.email ||
      evt?.data?.payer?.email ||
      evt?.data?.buyer?.email ||
      evt?.data?.customer_email ||
      evt?.data?.customerEmail ||
      evt?.data?.buyer_email ||
      evt?.data?.buyerEmail ||
      evt?.data?.email ||
      evt?.email ||
      null;

    const payerEmailScanned =
      payerEmail ??
      findFirstKeyMatch(
        evt,
        new Set([
          'email',
          'customer_email',
          'customeremail',
          'buyer_email',
          'buyeremail',
          'payer_email',
          'payeremail',
        ])
      )?.value ??
      null;

    ctxPayerEmail = payerEmailScanned;

    const parsed = parseReference(referenceScanned);

    let userId = parsed?.user_id ?? null;
    let days = parsed?.days ?? null;

    // Alternative metadata-based identification (when reference is not preserved)
    if (!userId) {
      const maybeUserId =
        evt?.data?.uid ||
        evt?.data?.user_id ||
        evt?.data?.userId ||
        evt?.data?.metadata?.uid ||
        evt?.data?.metadata?.user_id ||
        evt?.data?.metadata?.userId ||
        null;
      if (looksLikeUuid(maybeUserId)) userId = String(maybeUserId).trim();
    }

    if (!days) {
      const maybeDays =
        evt?.data?.days ||
        evt?.data?.metadata?.days ||
        evt?.data?.metadata?.plan_days ||
        null;
      const n = safeNumber(maybeDays);
      if (Number.isFinite(n) && n > 0) days = Math.round(n);
    }

    if (!days && inferredDays) days = inferredDays;

    // Fallback: tenta resolver por email (se o webhook trouxer email do pagador)
    if (!userId) {
      if (payerEmailScanned) {
        const resolved = await supabaseRpc('service_get_user_id_by_email', { p_email: payerEmailScanned });
        // PostgREST pode retornar "uuid" como string ou [{...}] dependendo da função;
        if (typeof resolved === 'string') userId = resolved;
        else if (Array.isArray(resolved) && resolved[0]?.user_id) userId = resolved[0].user_id;
        else if (resolved?.user_id) userId = resolved.user_id;
      }
    }

    // Definitive fallback: match a pending intent by amount (created by the frontend right before opening checkout)
    if (!userId) {
      try {
        const match = await tryMatchIntent({ amountCents, providerPaymentId });
        ctxIntentMatchReason = match?.reason ?? null;
        const intent = match?.intent ?? null;
        if (intent?.user_id) {
          userId = intent.user_id;
          ctxIntentId = intent.id;
          if (!days && Number(intent?.days) > 0) days = Number(intent.days);
        }
      } catch (e) {
        // ignore, we will handle as missing user below
        console.warn('Falha ao tentar casar payment_intent (ignorado):', String(e?.message || e));
      }
    }

    ctxUserId = userId;
    ctxDays = days;

    let outcome = 'received';
    let outcomeReason = null;

    if (approved === false) {
      outcome = 'ignored';
      outcomeReason = 'not_approved';
      ctxOutcome = outcome;
      ctxOutcomeReason = outcomeReason;
      await logWebhookEvent({
        provider: 'infinitepay',
        event_name: eventName,
        status,
        approved,
        provider_payment_id: providerPaymentId,
          reference: referenceScanned,
        amount_cents: amountCents,
          payer_email: payerEmailScanned,
        user_id: userId,
        days,
        outcome,
        outcome_reason: outcomeReason,
        trace_id: ctxTraceId,
        raw_event: sanitizeWebhookEvent(evt),
      });
      return res.status(200).json({ received: true });
    }

    if (approved === null) {
      outcome = 'skipped';
      outcomeReason = 'unknown_approval_state';
      ctxOutcome = outcome;
      ctxOutcomeReason = outcomeReason;
      await logWebhookEvent({
        provider: 'infinitepay',
        event_name: eventName,
        status,
        approved,
        provider_payment_id: providerPaymentId,
        reference: referenceScanned,
        amount_cents: amountCents,
        payer_email: payerEmailScanned,
        user_id: userId,
        days,
        outcome,
        outcome_reason: outcomeReason,
        trace_id: ctxTraceId,
        raw_event: sanitizeWebhookEvent(evt),
      });
      return res.status(200).json({ received: true, skipped: true });
    }

    if (!userId || !days || days <= 0) {
      outcome = 'skipped';
      outcomeReason = ctxIntentMatchReason
        ? `missing_user_or_days_${ctxIntentMatchReason}`
        : 'missing_user_or_days';
      ctxOutcome = outcome;
      ctxOutcomeReason = outcomeReason;
      console.error('Webhook aprovado mas sem identificação suficiente', {
        eventName,
        status,
        reference,
        amountCents,
        providerPaymentId,
        intentMatchReason: ctxIntentMatchReason,
        traceId: ctxTraceId,
      });
      await logWebhookEvent({
        provider: 'infinitepay',
        event_name: eventName,
        status,
        approved,
        provider_payment_id: providerPaymentId,
        reference: referenceScanned,
        amount_cents: amountCents,
        payer_email: payerEmailScanned,
        user_id: userId,
        days,
        outcome,
        outcome_reason: outcomeReason,
        trace_id: ctxTraceId,
        raw_event: sanitizeWebhookEvent(evt),
      });
      return res.status(200).json({ received: true, skipped: true });
    }

    if (!providerPaymentId) {
      outcome = 'skipped';
      outcomeReason = 'missing_provider_payment_id';
      ctxOutcome = outcome;
      ctxOutcomeReason = outcomeReason;
      console.error('Webhook aprovado mas sem providerPaymentId', {
        eventName,
        status,
        reference,
        amountCents,
        traceId: ctxTraceId,
      });
      await logWebhookEvent({
        provider: 'infinitepay',
        event_name: eventName,
        status,
        approved,
        provider_payment_id: providerPaymentId,
        reference: referenceScanned,
        amount_cents: amountCents,
        payer_email: payerEmailScanned,
        user_id: userId,
        days,
        outcome,
        outcome_reason: outcomeReason,
        trace_id: ctxTraceId,
        raw_event: sanitizeWebhookEvent(evt),
      });
      return res.status(200).json({ received: true, skipped: true });
    }

    try {
      await applyCredits({ userId, days, amountCents: amountCents ?? 0, providerPaymentId, rawEvent: evt });
    } catch (e) {
      outcome = 'error';
      outcomeReason = String(e?.message || e || 'apply_failed').slice(0, 200);
      ctxOutcome = outcome;
      ctxOutcomeReason = outcomeReason;

      // If we had matched an intent, mark it as error for easier manual recovery.
      if (ctxIntentId) {
        try {
          const qs = new URLSearchParams({ id: `eq.${ctxIntentId}`, select: 'id' });
          await supabasePatch('payment_intents', qs.toString(), {
            status: 'error',
            provider_payment_id: providerPaymentId ?? null,
            matched_at: nowIso(),
            note: `apply_failed: ${outcomeReason}`.slice(0, 240),
          });
        } catch {
          // ignore
        }
      }

      await logWebhookEvent({
        provider: 'infinitepay',
        event_name: eventName,
        status,
        approved,
        provider_payment_id: providerPaymentId,
        reference: referenceScanned,
        amount_cents: amountCents,
        payer_email: payerEmailScanned,
        user_id: userId,
        days,
        outcome,
        outcome_reason: outcomeReason,
        trace_id: ctxTraceId,
        raw_event: sanitizeWebhookEvent(evt),
      });
      throw e;
    }

    // Mark matched intent as applied (best-effort).
    if (ctxIntentId) {
      try {
        const qs = new URLSearchParams({ id: `eq.${ctxIntentId}`, select: 'id' });
        await supabasePatch('payment_intents', qs.toString(), {
          status: 'applied',
          provider_payment_id: providerPaymentId ?? null,
          matched_at: nowIso(),
        });
      } catch (e) {
        console.warn('Falha ao marcar payment_intent como applied (ignorado):', String(e?.message || e));
      }
    }

    outcome = 'applied';
    ctxOutcome = outcome;
    await logWebhookEvent({
      provider: 'infinitepay',
      event_name: eventName,
      status,
      approved,
      provider_payment_id: providerPaymentId,
      reference: referenceScanned,
      amount_cents: amountCents,
      payer_email: payerEmailScanned,
      user_id: userId,
      days,
      outcome,
      outcome_reason: null,
      trace_id: ctxTraceId,
      raw_event: null,
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erro no webhook:', err);
    try {
      await logWebhookEvent({
        provider: 'infinitepay',
        event_name: ctxEventName,
        status: ctxStatus,
        approved: ctxApproved,
        provider_payment_id: ctxProviderPaymentId,
        reference: ctxReference,
        amount_cents: ctxAmountCents,
        payer_email: ctxPayerEmail,
        user_id: ctxUserId,
        days: ctxDays,
        outcome: 'error',
        outcome_reason: String(err?.message || err).slice(0, 200),
        trace_id: ctxTraceId,
        raw_event: sanitizeWebhookEvent(req?.body ?? {}),
      });
    } catch {
      // ignore
    }
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Some providers perform a GET/HEAD handshake to validate the endpoint before sending POSTs.
app.get('/api/infinitepay/webhook', async (req, res) => {
  try {
    await logWebhookEvent({
      provider: 'infinitepay',
      event_name: 'handshake',
      status: null,
      approved: null,
      provider_payment_id: null,
      reference: null,
      amount_cents: null,
      payer_email: null,
      user_id: null,
      days: null,
      outcome: 'handshake',
      outcome_reason: null,
    });
  } catch {
    // ignore
  }
  return res.status(200).json({ ok: true });
});

app.head('/api/infinitepay/webhook', (req, res) => {
  return res.status(200).end();
});

app.get('/api/infinitepay/health', async (req, res) => {
  try {
    const hasSupabaseUrl = Boolean(SUPABASE_URL);
    const hasServiceRoleKey = Boolean(SUPABASE_SERVICE_ROLE_KEY);

    const supabaseProjectRef = getSupabaseProjectRef(SUPABASE_URL);
    let supabaseHost = null;
    try {
      supabaseHost = SUPABASE_URL ? new URL(SUPABASE_URL).hostname : null;
    } catch {
      supabaseHost = null;
    }

    let supabaseRpcOk = false;
    let supabaseRpcError = null;

    if (hasSupabaseUrl && hasServiceRoleKey) {
      try {
        // Safe RPC that should return null and still validate connectivity + permissions.
        await supabaseRpc('service_get_user_id_by_email', { p_email: '__healthcheck__@example.invalid' });
        supabaseRpcOk = true;
      } catch (e) {
        supabaseRpcOk = false;
        supabaseRpcError = String(e?.message || 'rpc_failed').slice(0, 200);
      }
    }

    // Optional: verify that we can write into the webhook log table.
    const wantLogWrite =
      String(req.query?.log || '').trim() === '1' ||
      String(req.query?.writeLog || '').trim() === '1';

    let logWriteOk = null;
    let logWriteError = null;
    if (wantLogWrite) {
      try {
        await logWebhookEvent({
          provider: 'infinitepay',
          event_name: 'healthcheck',
          status: null,
          approved: null,
          provider_payment_id: null,
          reference: null,
          amount_cents: null,
          payer_email: null,
          user_id: null,
          days: null,
          outcome: 'healthcheck',
          outcome_reason: null,
        });
        logWriteOk = true;
      } catch (e) {
        logWriteOk = false;
        logWriteError = String(e?.message || e || 'log_write_failed').slice(0, 200);
      }
    }

    return res.status(200).json({
      ok: true,
      build: BUILD_INFO,
      env: {
        hasSupabaseUrl,
        hasServiceRoleKey,
      },
      supabase: {
        projectRef: supabaseProjectRef,
        host: supabaseHost,
        rpcOk: supabaseRpcOk,
        rpcError: supabaseRpcError,
        logWriteOk,
        logWriteError,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

app.get('/', (req, res) => {
  res.send('InfinitePay Webhook Backend rodando!');
});

// Vercel Serverless Function entrypoint
export default (req, res) => app(req, res);
