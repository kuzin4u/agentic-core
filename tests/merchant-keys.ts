// Помощник тестов /merchant: ключ агента Ed25519 и его JWK каталога (РП22 п. 1).
import { generateKeyPairSync } from "node:crypto";
import { okpThumbprint } from "../src/merchant/index.js";

export function agentKey(agent_code = "nspk:agent:a:v1", nbf = 1_700_000_000, exp = 1_900_000_000) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x as string;
  const jwk = { kty: "OKP", crv: "Ed25519", x, alg: "EdDSA", use: "sig", kid: okpThumbprint(x), agent_code, nbf, exp };
  return { jwk, privateKey, publicKey };
}
