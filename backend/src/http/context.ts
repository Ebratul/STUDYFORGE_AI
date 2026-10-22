import type { SessionUser } from "../auth/types.js";

export type AppEnv = {
  Variables: {
    requestId: string;
    user: SessionUser;
    sessionId: string;
    clientIp: string | null;
  };
};
