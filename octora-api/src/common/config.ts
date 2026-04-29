export interface AppConfig {
  port: number;
  databaseUrl: string;
  frontendUrl: string;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 8787),
    databaseUrl: process.env.DATABASE_URL ?? "",
    frontendUrl: process.env.FRONTEND_URL ?? "*",
  };
}
