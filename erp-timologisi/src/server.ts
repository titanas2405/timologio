import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildApp } from "./app.js";
import { createDb } from "./db/client.js";

const db = createDb();
const webDir = resolve(import.meta.dirname, "../dist/web");
const app = buildApp(db, { webDir: existsSync(webDir) ? webDir : undefined });
const port = Number(process.env.PORT ?? 3000);

app.listen({ port, host: "0.0.0.0" }).then(() => {
  console.log(`Ο server τρέχει στο http://localhost:${port}`);
  if (!existsSync(webDir)) console.log("Το frontend δεν έχει γίνει build (npm run build). Για ανάπτυξη: npm run dev");
});
