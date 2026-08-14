# Deploy do DirectSpeed Runner

O Runner precisa de **HTTPS**, armazenamento persistente e suporte a Docker/Chromium.

## Variáveis obrigatórias

- `BASE44_APP_ID=6a7e4fafba892f2e86dfa7e7`
- `JWT_SECRET=<segredo longo e aleatório>`
- `DATA_DIR=/data`
- `HEADLESS=true`
- `ALLOWED_ORIGINS=https://direct-speed-cloud.base44.app`
- `PORT=8787`

## Opção A — host Docker gerenciado

1. Crie um serviço a partir deste diretório/repositório usando o `Dockerfile`.
2. Anexe um volume persistente montado em `/data`.
3. Configure as variáveis acima.
4. Exponha a porta `8787` por HTTPS.
5. Teste `GET /health`; deve retornar `{"ok":true,...}`.
6. No DirectSpeed Cloud, na aba **Sem PC**, informe a URL HTTPS do Runner no campo de configuração.

## Opção B — VPS Linux com Docker

```bash
cp .env.example .env
# edite .env
docker compose up -d --build
curl http://localhost:8787/health
```

Depois coloque Nginx/Caddy/Traefik na frente para HTTPS e use um domínio como `runner.directspeed.com.br`.

## Segurança antes de clientes reais

- nunca logar senha ou código 2FA;
- usar HTTPS obrigatório;
- JWT_SECRET exclusivo e forte;
- volume `/data` criptografado quando possível;
- limitar origens ao domínio do DirectSpeed;
- adicionar rate limiting e auditoria antes de abrir para público;
- para escala, isolar sessões Chromium e impor limite de contas por worker.
