# DV.net Telegram bot

A Telegram bot that accepts crypto payments through [DV.net](https://docs.dv.net/en/):

- `/topup` hands the user a personal deposit address (one per currency, QR code included) — DV.net keeps one wallet per Telegram user, so the same address comes back every time.
- `/pay <amount>` creates a hosted DV.net checkout page for a fixed USD amount.
- DV.net's signed webhooks (`PaymentNotConfirmed`, `PaymentReceived`, `PaymentAMLBlocked`, `WithdrawalFromProcessingReceived`) are verified and relayed to the depositor on Telegram, to the admins on Telegram, and by email.
- Admin commands: `/stop` (pause), `/start` (resume), `/balance`, `/status`.

Everything is configured in `.env` — see [`.env.example`](.env.example) for every setting. All bot code is in [`index.ts`](index.ts).

## DV.net side

1. In the DV.net panel open your project → **advanced settings** and copy the **API key** (`DVNET_API_KEY`) and the **Secret** (`DVNET_WEBHOOK_SECRET`).
   - `DVNET_HOST` is `https://cloud.dv.net` on the DV.net cloud (the key identifies your store). Only a self-hosted dv-merchant uses its own domain. Unrouted `*.dv.net` names such as `api.<store>.dv.net` hit a Traefik catch-all with a self-signed certificate and `404 page not found` — the bot logs that as `DEPTH_ZERO_SELF_SIGNED_CERT` / "Failed to reach the payment provider".
2. Enable the currencies you want to accept on the store. The bot only offers what is enabled (and only what `DEPOSIT_CURRENCIES` lists).
3. In the project's **webhook settings** add `https://<your-domain><WEBHOOK_PATH>` (default path `/dvnet/webhook`). The receiver answers `{"success":true}` only for requests whose `X-Sign` header matches `sha256(body + secret)`.

## Local run

```bash
cp .env.example .env    # fill in BOT_TOKEN, DVNET_HOST, DVNET_API_KEY, ...
npm install
npm run dev             # tsx watch index.ts
```

## Deploy on a Hostinger VPS with PM2

```bash
# 1. Node 20+ and PM2 (once per server)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2

# 2. Get the code onto the box (git clone / scp), then
cd ~/dvnet-bot
cp .env.example .env && nano .env   # fill in the real values
npm ci
npm run build                        # compiles index.ts -> dist/index.js

# 3. Start under PM2 and survive reboots
pm2 start ecosystem.config.js
pm2 save
pm2 startup                          # run the command it prints once
```

Day-to-day:

```bash
pm2 logs dvnet-bot        # live logs (also in ./logs/)
pm2 restart dvnet-bot     # after `git pull && npm ci && npm run build`
pm2 stop dvnet-bot        # actually stops the process (/stop in Telegram only pauses it)
```

### Expose the webhook over HTTPS

DV.net must reach the receiver over HTTPS. Put nginx in front of the port from `.env` (`WEBHOOK_PORT`, default 8080) and let certbot handle the certificate:

```nginx
server {
    server_name bot.example.com;

    location /dvnet/webhook {          # = WEBHOOK_PATH
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
    location /health {
        proxy_pass http://127.0.0.1:8080;
    }
}
```

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d bot.example.com
```

Then set `https://bot.example.com/dvnet/webhook` as the webhook URL in DV.net. `GET https://bot.example.com/health` answers `{"ok":true,...}` for uptime monitors.

## How the pieces fit

| Env | Effect |
| --- | --- |
| `DEPOSIT_CURRENCIES=USDT.Tron` | One currency: `/topup` answers with the address straight away, no menu. |
| `DEPOSIT_CURRENCIES=USDT.Tron,BTC.Bitcoin` or `all` | `/topup` shows a button per currency; `/topup BTC.Bitcoin` skips the menu; `/methods` lists them. |
| `ADDRESS_MODE=reuse` | `store_external_id` is `tg-<userId>`, so DV.net returns the user's permanent wallet every time. |
| `ADDRESS_MODE=unique` | A new wallet (`tg-<userId>-<ts>-<n>`) on every `/topup`; older addresses keep working. |
| `/pay 25` | A fresh wallet `tg-<userId>-pay-<hex>` with `amount: 25`, so the checkout page shows that amount. |
| `DVNET_WEBHOOK_SECRET` blank | Webhook receiver stays off; addresses still work, nobody is notified. |

Every `store_external_id` starts with `tg-<userId>`, which is how an incoming webhook is traced back to the Telegram user to notify.
