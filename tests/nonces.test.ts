// MemoryNonceStore и verifyRequestAsync — договор К6 пп. 12–13 без базы.
import { describe } from "vitest";
import { MemoryNonceStore } from "../src/index.js";
import { nonceContract } from "./nonce-contract.js";

describe("MemoryNonceStore и verifyRequestAsync", () => {
  nonceContract((opts) => new MemoryNonceStore(opts));
});
