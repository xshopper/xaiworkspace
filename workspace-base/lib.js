// Pure validation helpers used by the workspace agent. Isolated from any side
// effects (no fs, no child_process, no network) so they can be unit-tested.

// Derive a Linux username from an arbitrary chat id. Strips any character that
// is not alphanumeric, hyphen, or underscore, clamps length, and lowercases.
function deriveUsername(chatId) {
  const sanitized = String(chatId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28);
  return `xai${sanitized || 'default'}`.toLowerCase();
}

// Domains the workspace agent is permitted to fetch app artifacts and source
// from. Anything outside this list (or fetched over non-HTTPS) is rejected.
const TRUSTED_DOMAINS = new Set([
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'registry.npmjs.org',
  'xaiworkspace.com',
  'router.xaiworkspace.com',
]);

function isUrlTrusted(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return TRUSTED_DOMAINS.has(parsed.hostname)
      || [...TRUSTED_DOMAINS].some(d => parsed.hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

// Reject URLs whose path/query/hash would break out of the double-quoted shell
// arguments used in curl/git execAsync calls.
const SHELL_UNSAFE = /[$`"()|;&\n\r\\]/;

function isUrlShellSafe(url) {
  try {
    const parsed = new URL(url);
    return !SHELL_UNSAFE.test(parsed.pathname + parsed.search + parsed.hash);
  } catch {
    return false;
  }
}

// Relative subdirectory: letters, digits, dots, hyphens, underscores, slashes.
// Must not contain '..' so it cannot escape the extraction root.
const SAFE_SUBDIR = /^[a-zA-Z0-9._\-/]+$/;

function isSubdirSafe(s) {
  return typeof s === 'string' && SAFE_SUBDIR.test(s) && !s.includes('..');
}

// Input validation patterns mirrored from bridge.js so tests can assert
// against the canonical definitions.
const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_IDENTIFIER = /^[a-zA-Z0-9._-]+$/;
const VALID_ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

// Allowlisted command prefixes — only these commands can be executed via the
// router. Any command not matching one of these prefixes (or equal to a bare
// keyword) is rejected before reaching the shell.
const EXEC_ALLOWLIST = [
  'node ',
  'pm2 ',
  'bash scripts/',
  'bash ./scripts/',
  'cat ',
  'ls ',
  'echo ',
  'whoami',
  'hostname',
  'uname ',
  'df ',
  'free ',
  'ps ',
  'npm ',
  'npx ',
  'curl ',
  'tail ',
  'head ',
  'grep ',
  'wc ',
];

function isCommandAllowed(command) {
  if (typeof command !== 'string') return false;
  const trimmed = command.trimStart();
  return EXEC_ALLOWLIST.some(prefix => trimmed.startsWith(prefix) || trimmed === prefix.trim());
}

// Command chaining (`;`) and command substitution via backticks are always
// rejected. $(), |, >, < are allowed because the router legitimately uses them.
const EXEC_FORBIDDEN_CHAR_RE = /[;`]/;

function hasDisallowedExecChars(command) {
  return EXEC_FORBIDDEN_CHAR_RE.test(String(command));
}

module.exports = {
  deriveUsername,
  TRUSTED_DOMAINS,
  isUrlTrusted,
  SHELL_UNSAFE,
  isUrlShellSafe,
  SAFE_SUBDIR,
  isSubdirSafe,
  SAFE_SLUG,
  SAFE_IDENTIFIER,
  VALID_ENV_KEY,
  EXEC_ALLOWLIST,
  isCommandAllowed,
  EXEC_FORBIDDEN_CHAR_RE,
  hasDisallowedExecChars,
};
