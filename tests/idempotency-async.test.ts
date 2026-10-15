// AsyncMemoryIdempotencyStore — договор К6 п. 11 без базы.
import { describe } from "vitest";
import { AsyncMemoryIdempotencyStore } from "../src/index.js";
import { idempotencyContract } from "./idempotency-contract.js";

describe("AsyncMemoryIdempotencyStore", () => {
  idempotencyContract((opts) => new AsyncMemoryIdempotencyStore(opts));
});
