// Арифметика кривой Ed25519 для проверки открытых ключей (расхождение 12).
// Внутренний модуль: index.ts его не реэкспортирует, exports пакета его не открывает.

// Кривая Ed25519 (RFC 8032 §5.1): p = 2^255 − 19, d = −121665/121666, a = −1.
const P = 2n ** 255n - 19n;
const mod = (n: bigint): bigint => ((n % P) + P) % P;
function pow(b: bigint, e: bigint): bigint {
  let r = 1n;
  for (b = mod(b); e > 0n; e >>= 1n, b = (b * b) % P) if (e & 1n) r = (r * b) % P;
  return r;
}
const D = mod(-121665n * pow(121666n, P - 2n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);
export type Point = readonly [bigint, bigint];
export type Projective = readonly [bigint, bigint, bigint];

/** Удвоение в проективных координатах (dbl-2008-bbjlp, a = −1) — без обращения по модулю.
 *  Для точек кривой знаменатели не обнуляются: d — невычет. */
function double([x, y, z]: Projective): Projective {
  const b = mod((x + y) * (x + y)), c = mod(x * x), d = mod(y * y);
  const f = mod(d - c), j = mod(f - 2n * z * z);
  return [mod((b - c - d) * j), mod(f * (-c - d)), mod(f * j)];
}

/** Разбор 32 байт по RFC 8032 §5.1.3 со строгой каноничностью: y < p, точка на кривой, x = 0 без знакового бита. Иначе null. */
export function decodePoint(bytes: Buffer): Point | null {
  if (bytes.length !== 32) return null;
  const sign = bytes[31]! >> 7;
  const le = Buffer.from(bytes);
  le[31] = le[31]! & 0x7f;
  const y = BigInt(`0x${le.reverse().toString("hex")}`);
  if (y >= P) return null;
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  let x = mod(u * pow(v, 3n) * pow(u * pow(v, 7n), (P - 5n) / 8n));
  const vxx = mod(v * x * x);
  if (vxx !== u) {
    if (vxx !== mod(-u)) return null;
    x = mod(x * SQRT_M1);
  }
  if (x === 0n && sign === 1) return null;
  if (Number(x & 1n) !== sign) x = mod(-x);
  return [x, y];
}

/** [8]A — три удвоения. */
export function timesEight([x, y]: Point): Projective {
  let q: Projective = [x, y, 1n];
  for (let i = 0; i < 3; i++) q = double(q);
  return q;
}

/** Нейтраль O = (0 : 1 : 1) в проективной записи: X = 0, Y = Z. */
export const isIdentity = ([x, y, z]: Projective): boolean => x === 0n && y === z;

/** Слабый открытый ключ: неканоническая запись, точка не на кривой или малого порядка ([8]A = O).
 *  С ключом малого порядка подпись «R = нейтраль, S = 0» верна для любого сообщения (A2 п. 5.1, расхождение 12). */
export function isWeakEd25519(x: Buffer): boolean {
  const a = decodePoint(x);
  return !a || isIdentity(timesEight(a));
}

