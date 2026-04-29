import { createApp } from "./app";

async function main() {
  const app = await createApp({ logger: true });

  const port = Number(process.env.PORT ?? 8787);

  app.listen({ port, host: "0.0.0.0" }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

main();
