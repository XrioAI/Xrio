import { CacheDir } from "../cache-dir.ts";
import { startDeadline } from "../deadline.ts";
import { hostFactsFor } from "../sources/browser/host-facts.ts";

const [cache, binary] = process.argv.slice(2);

if (cache === undefined || binary === undefined) {
  throw new Error("A cache directory and comparison binary are required.");
}

using deadline = startDeadline(5000);

const snapshot = await hostFactsFor(new CacheDir(cache)).snapshotFor(binary, deadline);

process.stdout.write(JSON.stringify(snapshot));
