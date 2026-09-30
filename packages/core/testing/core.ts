// Manual smoke test. Run from the repo root:
//   node --conditions=source packages/core/testing/core.ts
import { httpApiPlugin } from "../../plugins/http-api/src/index.ts";
import { localStoragePlugin } from "../../plugins/local-storage/src/index.ts";
import { Xrio } from "../src/index.ts";

const api = httpApiPlugin({ port: 3000 });

const xrio = Xrio.create()
  .use(localStoragePlugin({ directory: "./scrapes" }))
  .use(api);

await xrio.start();

const page = await xrio.scrape({ format: "json", url: "https://eth0.me" });

console.log(page.status, page.content.length);

console.log("docs at", api.docsUrl);
// keep the server up; press Ctrl+C to stop
