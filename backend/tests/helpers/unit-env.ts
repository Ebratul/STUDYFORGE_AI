Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  APP_URL: "http://localhost:3100",
  BETTER_AUTH_SECRET: "x".repeat(40),
  CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  RAG_AGENT_TOKEN: "unit-rag-agent-token-0123456789abcdef",
});
