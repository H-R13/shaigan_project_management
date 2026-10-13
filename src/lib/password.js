// Password hashing compatible with Django's default hasher:
//   pbkdf2_sha256$<iterations>$<salt>$<base64 hash>
// Users imported from the old Django database keep their passwords.

const crypto = require("crypto");
const { promisify } = require("util");
const pbkdf2 = promisify(crypto.pbkdf2);

const ALGORITHM = "pbkdf2_sha256";
const ITERATIONS = 600000;

async function hashPassword(raw, iterations = ITERATIONS) {
  const salt = crypto.randomBytes(16).toString("base64url").slice(0, 22);
  const hash = await pbkdf2(raw, salt, iterations, 32, "sha256");
  return `${ALGORITHM}$${iterations}$${salt}$${hash.toString("base64")}`;
}

async function verifyPassword(raw, encoded) {
  if (!raw || !encoded || typeof encoded !== "string") return false;
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== ALGORITHM) return false;

  const [, iterStr, salt, expected] = parts;
  const iterations = parseInt(iterStr, 10);
  if (!iterations) return false;

  const hash = await pbkdf2(raw, salt, iterations, 32, "sha256");
  const a = Buffer.from(hash.toString("base64"));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { hashPassword, verifyPassword };
