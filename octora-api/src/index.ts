import { createApp } from "./app";
import { loadConfig } from "#common/config";

async function main() {
  const app = await createApp({ logger: true });
  const { port } = loadConfig();

  app.listen({ port, host: "0.0.0.0" }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

main();
