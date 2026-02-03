import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

    const eventName = evt.event || evt.type || evt.name || null;
    const status = evt?.data?.status || evt?.data?.payment_status || evt?.status || null;
    const approved =
      status === 'approved' ||
      status === 'paid' ||
      eventName === 'payment.approved' ||
      eventName === 'payment.paid';

    if (!approved) {
      return res.status(200).json({ received: true });
    }

    const reference = evt?.data?.reference || evt?.data?.external_reference || evt?.reference || null;
    const parsed = parseReference(reference);

    const providerPaymentId =
      evt?.data?.payment_id ||
      evt?.data?.id ||
      evt?.payment_id ||
      evt?.id ||
      null;

    const amountCents = normalizeAmountCents(evt?.data?.amount ?? evt?.data?.total_amount ?? evt?.amount);
    const inferredDays = daysFromAmount(amountCents);

    let userId = parsed?.user_id ?? null;
    let days = parsed?.days ?? null;

    if (!days && inferredDays) days = inferredDays;

    // Fallback: tenta resolver por email (se o webhook trouxer email do pagador)
    if (!userId) {
      const payerEmail =
        evt?.data?.customer?.email ||
        evt?.data?.payer?.email ||
        evt?.data?.email ||
        evt?.email ||
        null;

      if (payerEmail) {
        const resolved = await supabaseRpc('service_get_user_id_by_email', { p_email: payerEmail });
        // PostgREST pode retornar "uuid" como string ou [{...}] dependendo da função;
        if (typeof resolved === 'string') userId = resolved;
        else if (Array.isArray(resolved) && resolved[0]?.user_id) userId = resolved[0].user_id;
        else if (resolved?.user_id) userId = resolved.user_id;
      }
    }

    if (!userId || !days || days <= 0) {
      console.error('Webhook aprovado mas sem identificação suficiente', {
        eventName,
        status,
        reference,
        amountCents,
        providerPaymentId,
      });
      return res.status(200).json({ received: true, skipped: true });
    }

    await applyCredits({ userId, days, amountCents: amountCents ?? 0, providerPaymentId, rawEvent: evt });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erro no webhook:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.get('/', (req, res) => {
  res.send('InfinitePay Webhook Backend rodando!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
