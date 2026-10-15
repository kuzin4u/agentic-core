// AsyncMemoryNonceStore и verifyRequestAsync — договор К6 пп. 12–13 без базы.
import { describe } from "vitest";
import { AsyncMemoryNonceStore } from "../src/index.js";
import { nonceContract } from "./nonce-contract.js";

describe("AsyncMemoryNonceStore и verifyRequestAsync", () => {
  nonceContract((opts) => new AsyncMemoryNonceStore(opts));
});
