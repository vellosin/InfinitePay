
import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Função para atualizar perfil e registrar pagamento
async function processPayment({ user_id, plan, amount_cents, days_added, description }) {
  // Atualiza o plano e premium_until
  let premium_until = null;
  if (plan === 'premium') {
    // 30 dias por padrão, pode customizar conforme o plano
    premium_until = new Date(Date.now() + days_added * 24 * 60 * 60 * 1000).toISOString();
  }
  // Atualiza user_profiles
  await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${user_id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({
      plan,
      premium_until: premium_until
    })
  });
  // Insere no log de pagamentos
  await fetch(`${SUPABASE_URL}/rest/v1/user_payments`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify({
      user_id,
      amount_cents,
      days_added,
      description
    })
  });
}

app.post('/api/infinitepay/webhook', async (req, res) => {
  try {
    const event = req.body;
    // Exemplo de payload esperado:
    // {
    //   event: 'payment.approved',
    //   data: {
    //     reference: 'user_1234_premium',
    //     status: 'approved',
    //     amount: 9900,
    //     payment_id: 'abc123'
    //   }
    // }
    if (event.event === 'payment.approved' && event.data?.status === 'approved') {
      const reference = event.data.reference || '';
      // Espera-se reference no formato: user_<user_id>_<plano>
      const refMatch = reference.match(/^user_([\w-]+)_(\w+)$/);
      if (!refMatch) {
        console.error('Reference inválido:', reference);
        return res.status(400).json({ error: 'Reference inválido' });
      }
      const user_id = refMatch[1];
      const plan = refMatch[2];
      // Defina os dias adicionados conforme o plano
      let days_added = 30;
      if (plan === 'premium') days_added = 30;
      // Adapte para outros planos se necessário
      const amount_cents = event.data.amount || 0;
      const description = `Pagamento InfinitePay (${plan})`; 
      await processPayment({ user_id, plan, amount_cents, days_added, description });
      return res.status(200).json({ success: true });
    }
    res.status(200).json({ received: true });
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
