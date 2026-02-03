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

async function logWebhookEvent(eventRow) {
  try {
    // Optional: only works if the table exists in Supabase.
    await supabaseInsert('payment_webhook_events', eventRow);
  } catch (e) {
    // Never break webhook processing because of logging.
    console.warn('Falha ao registrar payment_webhook_events (ignorado):', String(e?.message || e));
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

app.post('/api/infinitepay/webhook', async (req, res) => {
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

    const eventNameRaw = evt.event || evt.type || evt.name || null;
    const eventName = normalizeEventName(eventNameRaw);
    const statusRaw =
      evt?.data?.status ||
      evt?.data?.payment_status ||
      evt?.data?.paymentStatus ||
      evt?.data?.transaction_status ||
      evt?.status ||
      null;
    const status = normalizeStatus(statusRaw);

    const approved =
      status === 'approved' ||
      status === 'paid' ||
      status === 'succeeded' ||
      status === 'success' ||
      status === 'completed' ||
      status === 'confirmed' ||
      eventName === 'payment.approved' ||
      eventName === 'payment.paid' ||
      eventName === 'payment.succeeded' ||
      eventName === 'transaction.approved' ||
      eventName === 'transaction.paid';

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
      evt?.data?.metadata?.reference ||
      evt?.data?.metadata?.ref ||
      evt?.data?.metadata?.external_reference ||
      evt?.reference ||
      null;

    let providerPaymentId =
      evt?.data?.payment_id ||
      evt?.data?.paymentId ||
      evt?.data?.id ||
      evt?.data?.transaction_id ||
      evt?.data?.transactionId ||
      evt?.payment_id ||
      evt?.id ||
      null;
    if (!providerPaymentId) providerPaymentId = stableFallbackPaymentId(evt);

    const amountCents = normalizeAmountCents(evt?.data?.amount ?? evt?.data?.total_amount ?? evt?.amount);
    const inferredDays = daysFromAmount(amountCents);

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

    const parsed = parseReference(reference);

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
      if (payerEmail) {
        const resolved = await supabaseRpc('service_get_user_id_by_email', { p_email: payerEmail });
        // PostgREST pode retornar "uuid" como string ou [{...}] dependendo da função;
        if (typeof resolved === 'string') userId = resolved;
        else if (Array.isArray(resolved) && resolved[0]?.user_id) userId = resolved[0].user_id;
        else if (resolved?.user_id) userId = resolved.user_id;
      }
    }

    let outcome = 'received';
    let outcomeReason = null;

    if (!approved) {
      outcome = 'ignored';
      outcomeReason = 'not_approved';
      await logWebhookEvent({
        provider: 'infinitepay',
        event_name: eventName,
        status,
        approved,
        provider_payment_id: providerPaymentId,
        reference,
        amount_cents: amountCents,
        payer_email: payerEmail,
        user_id: userId,
        days,
        outcome,
        outcome_reason: outcomeReason,
      });
      return res.status(200).json({ received: true });
    }

    if (!userId || !days || days <= 0) {
      outcome = 'skipped';
      outcomeReason = 'missing_user_or_days';
      console.error('Webhook aprovado mas sem identificação suficiente', {
        eventName,
        status,
        reference,
        amountCents,
        providerPaymentId,
      });
      await logWebhookEvent({
        provider: 'infinitepay',
        event_name: eventName,
        status,
        approved,
        provider_payment_id: providerPaymentId,
        reference,
        amount_cents: amountCents,
        payer_email: payerEmail,
        user_id: userId,
        days,
        outcome,
        outcome_reason: outcomeReason,
      });
      return res.status(200).json({ received: true, skipped: true });
    }

    if (!providerPaymentId) {
      outcome = 'skipped';
      outcomeReason = 'missing_provider_payment_id';
      console.error('Webhook aprovado mas sem providerPaymentId', {
        eventName,
        status,
        reference,
        amountCents,
      });
      await logWebhookEvent({
        provider: 'infinitepay',
        event_name: eventName,
        status,
        approved,
        provider_payment_id: providerPaymentId,
        reference,
        amount_cents: amountCents,
        payer_email: payerEmail,
        user_id: userId,
        days,
        outcome,
        outcome_reason: outcomeReason,
      });
      return res.status(200).json({ received: true, skipped: true });
    }

    await applyCredits({ userId, days, amountCents: amountCents ?? 0, providerPaymentId, rawEvent: evt });
    outcome = 'applied';
    await logWebhookEvent({
      provider: 'infinitepay',
      event_name: eventName,
      status,
      approved,
      provider_payment_id: providerPaymentId,
      reference,
      amount_cents: amountCents,
      payer_email: payerEmail,
      user_id: userId,
      days,
      outcome,
      outcome_reason: null,
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erro no webhook:', err);
    try {
      await logWebhookEvent({
        provider: 'infinitepay',
        event_name: null,
        status: null,
        approved: null,
        provider_payment_id: null,
        reference: null,
        amount_cents: null,
        payer_email: null,
        user_id: null,
        days: null,
        outcome: 'error',
        outcome_reason: String(err?.message || err).slice(0, 200),
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
