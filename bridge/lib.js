// Pure helpers shared by server.js and bridge.js. Kept free of side effects
// so they can be unit-tested in isolation (no Docker, no network, no fs).
const crypto = require('crypto');

// Timing-safe secret comparison to prevent timing side-channel attacks.
function safeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Domain allowlist for registering bridges with additional routers.
const ALLOWED_ROUTER_DOMAINS = ['.xaiworkspace.com', '.xshopper.com', 'localhost'];

function isAllowedRouterUrl(routerUrl) {
  try {
    const { hostname } = new URL(routerUrl);
    return ALLOWED_ROUTER_DOMAINS.some(d =>
      d.startsWith('.') ? hostname.endsWith(d) || hostname === d.slice(1) : hostname === d
    );
  } catch {
    return false;
  }
}

// HTML-escape untrusted values before embedding them in the router management
// page. Mirrors the usual five-char replacement set.
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Commands the router is permitted to invoke via the bridge exec channel. Any
// command not matching one of these prefixes (or equal to a bare keyword) is
// rejected before reaching the shell.
const EXEC_ALLOWLIST = [
  'docker ', 'docker-compose ', 'docker compose ', 'pm2 ',
  'curl ', 'cat /data/', 'ls ', 'echo ',
  'whoami', 'hostname', 'uname ', 'df ', 'free ', 'ps ',
];

function isCommandAllowed(command) {
  if (typeof command !== 'string') return false;
  const trimmed = command.trimStart();
  return EXEC_ALLOWLIST.some(prefix => trimmed.startsWith(prefix) || trimmed === prefix.trim());
}

// Shell metacharacters and newlines that could enable command chaining,
// substitution, redirection, or background execution. Rejected regardless of
// allowlist match.
const EXEC_FORBIDDEN_CHAR_RE = /[;`|$()><&\n\r]/;

function hasDisallowedExecChars(command) {
  return EXEC_FORBIDDEN_CHAR_RE.test(String(command));
}

// Provision env validation: keys must be valid shell identifiers, values must
// not contain ASCII control characters that could break out of the Docker env
// record.
const ENV_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const ENV_VAL_FORBIDDEN_RE = /[\x00-\x08\x0e-\x1f\x7f]/;

module.exports = {
  safeCompare,
  ALLOWED_ROUTER_DOMAINS,
  isAllowedRouterUrl,
  esc,
  EXEC_ALLOWLIST,
  isCommandAllowed,
  EXEC_FORBIDDEN_CHAR_RE,
  hasDisallowedExecChars,
  ENV_KEY_RE,
  ENV_VAL_FORBIDDEN_RE,
};
