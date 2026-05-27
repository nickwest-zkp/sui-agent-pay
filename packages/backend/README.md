# Sui Agent Pay Backend

Standalone HTTP backend for the demo UI. It owns SDK initialization, local JSON storage, Telegram delivery, approval callbacks, x402 verification, and agent runtime actions.

## Local Run

```bash
pnpm install
pnpm build:backend
pnpm start:backend
```

Default URL: `http://localhost:8787`.

Point the frontend to it with:

```bash
NEXT_PUBLIC_BACKEND_URL=http://localhost:8787
BACKEND_URL=http://localhost:8787
```

## Production Notes

Set `APP_BASE_URL` on the backend to the public backend HTTPS origin so Telegram approve/reject buttons point directly to the backend callback:

```bash
APP_BASE_URL=https://your-backend.example.com
```

If `AGENT_PAY_API_KEY` is set on the backend, set the same value as `NEXT_PUBLIC_AGENT_PAY_API_KEY` on the frontend.
