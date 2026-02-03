import express from 'express';

const app = express();
app.use(express.json());

app.post('/api/infinitepay/webhook', (req, res) => {
  console.log('Webhook recebido:', req.body);
  res.status(200).json({ received: true });
});

app.get('/', (req, res) => {
  res.send('InfinitePay Webhook Backend rodando!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
