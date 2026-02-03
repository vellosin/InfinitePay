# InfinitePay Webhook Backend

Backend minimalista em Node.js (Express) para receber webhooks da InfinitePay e pronto para deploy no Vercel.

## Endpoints
- `POST /api/infinitepay/webhook`: Recebe notificações da InfinitePay (apenas loga o payload por enquanto).

## Variáveis de ambiente (Vercel)
- `SUPABASE_URL`: URL do projeto Supabase (ex: `https://xxxx.supabase.co`)
- `SUPABASE_SERVICE_ROLE_KEY`: Service Role Key (somente backend)

Opcional (fallback de identificação):
- O webhook tenta identificar o usuário por `reference` (recomendado) e, se não existir, tenta por email do pagador via RPC.

## Deploy
1. Suba este repositório no GitHub
2. Conecte ao Vercel
3. Use a URL gerada para configurar o webhook na InfinitePay

## Checklist no Supabase
- Aplicar as funções SQL `service_apply_payment_credits` e `service_get_user_id_by_email` no banco (veja o `schema.sql` do app).
