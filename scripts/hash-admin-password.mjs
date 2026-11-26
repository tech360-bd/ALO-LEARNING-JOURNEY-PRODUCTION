import { randomBytes, scryptSync } from "node:crypto";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
if (password.length < 14) {
  console.error(
    "Password must be at least 14 characters.\n" +
      "Usage (password is read from stdin, never from argv, to keep it out of process listings):\n" +
      "  printf '%s' 'your-long-password' | node scripts/hash-admin-password.mjs"
  );
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(password, salt, 64);
const encoded = `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;

// `$` is interpolation syntax in every .env loader this app supports, so a bare
// hash is silently rewritten to an invalid 80-character value before the
// process reads it. Print the escaped form that survives `.env`, plus the value
// itself for systems that take the variable directly (PM2, docker -e, CI).
console.log(`# Paste this line into .env (the \\$ escapes are required there):`);
console.log(`ADMIN_PASSWORD_HASH=${encoded.replace(/\$/g, "\\$")}`);
console.log("# Direct value for PM2 / docker -e / CI secrets (no .env file):");
console.log(encoded);
