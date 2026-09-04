import path from "node:path";
import { validatePsuReleaseCacheDirectory } from "../infrastructure/psu/release-cache.ts";

const root = path.resolve(process.argv.find((value) => value.startsWith("--cache-dir="))?.slice(12)
  ?? "work/psu-field-release-cache/lionlog.psu-nutrition.v2");
const result = await validatePsuReleaseCacheDirectory(root);
process.stdout.write(result.restored
  ? `Validated ${result.entryCount} persisted nutrition cache entries.\n`
  : "No persisted nutrition cache was restored.\n");
