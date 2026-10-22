# StudyForge frontend

Next.js 16 (App Router) UI. It has **no database access and no secrets**: every `/api/*` request is proxied to the backend (`src/app/api/[...path]/route.ts`), server components call the backend with the visitor's cookie (`src/lib/server/backend.ts`), and the backend is the only authority for authentication and authorization.

```bash
pnpm install
cp .env.example .env.local     # BACKEND_URL (server-side only), default http://127.0.0.1:4000
pnpm dev                       # http://localhost:3000   (backend and rag_agent must be running)
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:e2e                  # starts rag_agent + backend + this app against a throw-away database; see ../backend/README.md
```

Project overview, architecture and security model: [`../backend/README.md`](../backend/README.md) and [`../backend/docs/`](../backend/docs/).
