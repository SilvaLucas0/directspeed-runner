# DirectSpeed Runner MVP — sem PC

Executor cloud do DirectSpeed. O Base44 vira a interface mobile; este serviço mantém uma sessão Chromium persistente e executa a fila mesmo com o celular fechado.

## Fluxo
1. O app Base44 troca a sessão do usuário por um token próprio do Runner (`/api/auth/exchange`).
2. O usuário conecta o Instagram pelo celular. A senha é usada apenas durante o login e **não é gravada** pelo Runner.
3. Cookies e sessão do Chromium ficam no volume persistente `/data/browser/<userId>`.
4. Leads, mensagens, configurações e estado ficam no SQLite `/data/directspeed.sqlite`.
5. Start/Pause/Stop continuam funcionando mesmo depois de fechar o app.

## Subir com Docker
```bash
cp .env.example .env
# edite JWT_SECRET e ALLOWED_ORIGINS
docker build -t directspeed-runner .
docker run --env-file .env -p 8787:8787 -v directspeed-data:/data directspeed-runner
```

## Teste
```bash
curl http://localhost:8787/health
```

## Produção
- Use HTTPS obrigatório.
- Volume `/data` precisa ser persistente.
- Não registre senha/código 2FA em logs.
- Idealmente 1 container/pool isolado por grupo de contas conforme escalar.
- Checkpoints complexos do Instagram ainda exigem uma próxima etapa com browser remoto interativo.

## Limite do MVP
O login comum e 2FA por código estão implementados. Se o Instagram exigir captcha/checkpoint visual, o Runner retorna `checkpoint`; o próximo incremento deve oferecer uma sessão de navegador remoto para o usuário resolver pelo celular.
