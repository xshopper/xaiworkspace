// Unit tests for workspace-base/lib.js. Uses Node's built-in test runner.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveUsername,
  isUrlTrusted,
  isUrlShellSafe,
  isSubdirSafe,
  SAFE_SLUG,
  SAFE_IDENTIFIER,
  VALID_ENV_KEY,
  isCommandAllowed,
  hasDisallowedExecChars,
} = require('../lib');

test('deriveUsername: normal chat id maps to xai<lowercased>', () => {
  assert.equal(deriveUsername('user123'), 'xaiuser123');
});

test('deriveUsername: strips non-alphanumeric characters', () => {
  assert.equal(deriveUsername('user@example.com'), 'xaiuserexamplecom');
  assert.equal(deriveUsername('a b c!'), 'xaiabc');
});

test('deriveUsername: preserves hyphen and underscore', () => {
  assert.equal(deriveUsername('user_name-42'), 'xaiuser_name-42');
});

test('deriveUsername: clamps long input to 28 characters of id', () => {
  const long = 'a'.repeat(100);
  const result = deriveUsername(long);
  // prefix 'xai' + up to 28 sanitized chars
  assert.equal(result.length, 3 + 28);
  assert.equal(result, 'xai' + 'a'.repeat(28));
});

test('deriveUsername: empty or all-stripped input falls back to xaidefault', () => {
  assert.equal(deriveUsername(''), 'xaidefault');
  assert.equal(deriveUsername('!!!'), 'xaidefault');
});

test('deriveUsername: coerces non-string input', () => {
  assert.equal(deriveUsername(42), 'xai42');
});

test('isUrlTrusted: accepts https://github.com and subdomains', () => {
  assert.equal(isUrlTrusted('https://github.com/foo/bar'), true);
  assert.equal(isUrlTrusted('https://raw.githubusercontent.com/foo/bar/main/x.zip'), true);
  assert.equal(isUrlTrusted('https://api.github.com/repos/foo/bar'), true);
});

test('isUrlTrusted: accepts npmjs registry', () => {
  assert.equal(isUrlTrusted('https://registry.npmjs.org/some-package'), true);
});

test('isUrlTrusted: rejects HTTP (non-TLS)', () => {
  assert.equal(isUrlTrusted('http://github.com/foo/bar'), false);
});

test('isUrlTrusted: rejects unknown hosts', () => {
  assert.equal(isUrlTrusted('https://evil.com/x'), false);
  assert.equal(isUrlTrusted('https://github.com.evil.com/x'), false);
  assert.equal(isUrlTrusted('https://fakegithub.com'), false);
});

test('isUrlTrusted: rejects malformed input', () => {
  assert.equal(isUrlTrusted('not a url'), false);
  assert.equal(isUrlTrusted(''), false);
  assert.equal(isUrlTrusted(null), false);
});

test('isUrlShellSafe: accepts normal paths and queries', () => {
  assert.equal(isUrlShellSafe('https://github.com/foo/bar/archive/refs/heads/main.zip'), true);
  assert.equal(isUrlShellSafe('https://x.com/a?b=1&c=2'.replace('&', '%26')), true);
});

test('isUrlShellSafe: rejects metacharacters that survive URL parsing', () => {
  // WHATWG URL parser leaves these characters unencoded in the path, so
  // isUrlShellSafe must catch them defensively. Backtick, quote, backslash,
  // and newline are percent-encoded or stripped by the parser and are
  // covered by the parser itself, not this check.
  for (const bad of ['$', '(', ')', '|', ';', '&']) {
    const url = `https://github.com/foo${bad}/bar`;
    assert.equal(isUrlShellSafe(url), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('isUrlShellSafe: rejects injection attempts with surviving metacharacters', () => {
  assert.equal(isUrlShellSafe('https://github.com/foo/bar$(rm -rf /)'), false);
  assert.equal(isUrlShellSafe('https://github.com/foo/bar;rm -rf /'), false);
  assert.equal(isUrlShellSafe('https://github.com/foo/bar|whoami'), false);
});

test('isUrlShellSafe: backticks/quotes/backslashes are normalized by URL parser', () => {
  // These are percent-encoded or stripped by the WHATWG URL parser, so the
  // resulting pathname is shell-safe even though the raw input looked scary.
  assert.equal(isUrlShellSafe('https://github.com/foo/`whoami`'), true);
  assert.equal(isUrlShellSafe('https://github.com/foo/bar"quote'), true);
});

test('isSubdirSafe: accepts sane relative paths', () => {
  assert.equal(isSubdirSafe('apps/foo'), true);
  assert.equal(isSubdirSafe('foo'), true);
  assert.equal(isSubdirSafe('foo-bar_baz.1/sub'), true);
});

test('isSubdirSafe: rejects path traversal', () => {
  assert.equal(isSubdirSafe('..'), false);
  assert.equal(isSubdirSafe('foo/../etc'), false);
  assert.equal(isSubdirSafe('foo/..'), false);
});

test('isSubdirSafe: rejects absolute or metacharacter-laden paths', () => {
  assert.equal(isSubdirSafe(''), false);
  assert.equal(isSubdirSafe('foo bar'), false);
  assert.equal(isSubdirSafe('foo;rm -rf /'), false);
  assert.equal(isSubdirSafe('foo\nbar'), false);
});

test('isSubdirSafe: rejects non-strings', () => {
  assert.equal(isSubdirSafe(null), false);
  assert.equal(isSubdirSafe(undefined), false);
  assert.equal(isSubdirSafe(42), false);
});

test('SAFE_SLUG: accepts lowercase slugs', () => {
  for (const s of ['foo', 'foo-bar', 'foo_bar', 'foo.bar', 'a1b2']) {
    assert.equal(SAFE_SLUG.test(s), true, `expected ${s} to be valid`);
  }
});

test('SAFE_SLUG: rejects invalid slugs', () => {
  for (const s of ['', '-foo', '.foo', '_foo', 'FOO', 'foo bar', 'foo/bar']) {
    assert.equal(SAFE_SLUG.test(s), false, `expected ${s} to be invalid`);
  }
});

test('SAFE_IDENTIFIER: accepts reverse-DNS-ish identifiers', () => {
  assert.equal(SAFE_IDENTIFIER.test('com.xshopper.openclaw'), true);
  assert.equal(SAFE_IDENTIFIER.test('foo-bar_baz'), true);
});

test('SAFE_IDENTIFIER: rejects path separators and metacharacters', () => {
  assert.equal(SAFE_IDENTIFIER.test('com/evil'), false);
  assert.equal(SAFE_IDENTIFIER.test('com;evil'), false);
  assert.equal(SAFE_IDENTIFIER.test(''), false);
});

test('VALID_ENV_KEY: accepts standard uppercase keys', () => {
  for (const k of ['FOO', 'FOO_BAR', '_PRIV', 'A1']) {
    assert.equal(VALID_ENV_KEY.test(k), true, `expected ${k} to be valid`);
  }
});

test('VALID_ENV_KEY: rejects lowercase and punctuation', () => {
  for (const k of ['foo', 'FOO-BAR', 'FOO.BAR', '1FOO', '']) {
    assert.equal(VALID_ENV_KEY.test(k), false, `expected ${k} to be invalid`);
  }
});

test('isCommandAllowed: accepts allowlisted prefixes', () => {
  assert.equal(isCommandAllowed('pm2 list'), true);
  assert.equal(isCommandAllowed('node index.js'), true);
  assert.equal(isCommandAllowed('bash scripts/install.sh'), true);
  assert.equal(isCommandAllowed('bash ./scripts/setup.sh'), true);
  assert.equal(isCommandAllowed('whoami'), true);
  assert.equal(isCommandAllowed('curl https://example.com'), true);
});

test('isCommandAllowed: rejects unknown commands', () => {
  assert.equal(isCommandAllowed('sudo reboot'), false);
  assert.equal(isCommandAllowed('rm -rf /'), false);
  assert.equal(isCommandAllowed('bash /etc/evil.sh'), false); // only scripts/ and ./scripts/ allowed
  assert.equal(isCommandAllowed(''), false);
});

test('isCommandAllowed: rejects non-strings', () => {
  assert.equal(isCommandAllowed(null), false);
  assert.equal(isCommandAllowed({}), false);
});

test('hasDisallowedExecChars: rejects semicolon and backtick', () => {
  assert.equal(hasDisallowedExecChars('pm2 list; rm -rf /'), true);
  assert.equal(hasDisallowedExecChars('pm2 list `id`'), true);
});

test('hasDisallowedExecChars: permits $(), |, >, < (router uses them)', () => {
  assert.equal(hasDisallowedExecChars('pm2 list | grep online'), false);
  assert.equal(hasDisallowedExecChars('pm2 list > /tmp/out'), false);
  assert.equal(hasDisallowedExecChars('pm2 list < /tmp/in'), false);
  assert.equal(hasDisallowedExecChars('echo $(whoami)'), false);
});

test('hasDisallowedExecChars: permits clean commands', () => {
  assert.equal(hasDisallowedExecChars('pm2 restart bridge'), false);
  assert.equal(hasDisallowedExecChars('node index.js'), false);
});
