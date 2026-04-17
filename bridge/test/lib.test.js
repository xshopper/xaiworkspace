// Unit tests for bridge/lib.js. Runs under Node's built-in test runner
// (`node --test`) so no external test framework is required.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  safeCompare,
  isAllowedRouterUrl,
  esc,
  isCommandAllowed,
  hasDisallowedExecChars,
  ENV_KEY_RE,
  ENV_VAL_FORBIDDEN_RE,
} = require('../lib');

test('safeCompare: equal strings match', () => {
  assert.equal(safeCompare('secret-abc', 'secret-abc'), true);
});

test('safeCompare: different strings do not match', () => {
  assert.equal(safeCompare('secret-abc', 'secret-xyz'), false);
});

test('safeCompare: different-length strings do not match', () => {
  assert.equal(safeCompare('abc', 'abcd'), false);
});

test('safeCompare: empty/missing values always fail', () => {
  assert.equal(safeCompare('', ''), false);
  assert.equal(safeCompare(null, 'x'), false);
  assert.equal(safeCompare('x', undefined), false);
  assert.equal(safeCompare(undefined, null), false);
});

test('safeCompare: coerces numeric inputs without throwing', () => {
  assert.equal(safeCompare(123, 123), true);
  assert.equal(safeCompare(123, 124), false);
});

test('isAllowedRouterUrl: accepts subdomains under xaiworkspace.com', () => {
  assert.equal(isAllowedRouterUrl('https://router.xaiworkspace.com'), true);
  assert.equal(isAllowedRouterUrl('https://xaiworkspace.com'), true);
  assert.equal(isAllowedRouterUrl('https://deep.nested.xaiworkspace.com'), true);
});

test('isAllowedRouterUrl: accepts xshopper.com subdomains', () => {
  assert.equal(isAllowedRouterUrl('https://api.xshopper.com'), true);
  assert.equal(isAllowedRouterUrl('https://xshopper.com'), true);
});

test('isAllowedRouterUrl: accepts localhost (bare)', () => {
  assert.equal(isAllowedRouterUrl('http://localhost:4000'), true);
});

test('isAllowedRouterUrl: rejects unknown domains', () => {
  assert.equal(isAllowedRouterUrl('https://evil.example.com'), false);
  assert.equal(isAllowedRouterUrl('https://xaiworkspace.com.evil.com'), false);
  assert.equal(isAllowedRouterUrl('https://fakexaiworkspace.com'), false);
});

test('isAllowedRouterUrl: rejects malformed URLs', () => {
  assert.equal(isAllowedRouterUrl('not a url'), false);
  assert.equal(isAllowedRouterUrl(''), false);
  assert.equal(isAllowedRouterUrl(null), false);
});

test('esc: escapes the five HTML special characters', () => {
  assert.equal(
    esc(`<img src=x onerror=alert('xss')>&"`),
    '&lt;img src=x onerror=alert(&#39;xss&#39;)&gt;&amp;&quot;',
  );
});

test('esc: handles empty/null input safely', () => {
  assert.equal(esc(''), '');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});

test('esc: coerces non-strings', () => {
  assert.equal(esc(42), '42');
});

test('isCommandAllowed: accepts allowlisted prefixes', () => {
  assert.equal(isCommandAllowed('docker ps -a'), true);
  assert.equal(isCommandAllowed('docker compose up -d'), true);
  assert.equal(isCommandAllowed('pm2 list'), true);
  assert.equal(isCommandAllowed('cat /data/routers.json'), true);
  assert.equal(isCommandAllowed('whoami'), true);
  assert.equal(isCommandAllowed('hostname'), true);
});

test('isCommandAllowed: tolerates leading whitespace', () => {
  assert.equal(isCommandAllowed('   docker ps'), true);
});

test('isCommandAllowed: rejects commands not in allowlist', () => {
  assert.equal(isCommandAllowed('rm -rf /'), false);
  assert.equal(isCommandAllowed('bash -c evil'), false);
  assert.equal(isCommandAllowed('sudo reboot'), false);
  assert.equal(isCommandAllowed(''), false);
});

test('isCommandAllowed: rejects allowlist prefix used as path segment', () => {
  // "dockerfile" must not match "docker " because the allowlist requires the
  // trailing space (or exact match for bare commands).
  assert.equal(isCommandAllowed('dockerfile'), false);
});

test('isCommandAllowed: rejects non-string input', () => {
  assert.equal(isCommandAllowed(undefined), false);
  assert.equal(isCommandAllowed(null), false);
  assert.equal(isCommandAllowed(123), false);
  assert.equal(isCommandAllowed({}), false);
});

test('isCommandAllowed: reads /data/ but not /etc/', () => {
  assert.equal(isCommandAllowed('cat /data/routers.json'), true);
  assert.equal(isCommandAllowed('cat /etc/passwd'), false);
});

test('hasDisallowedExecChars: flags each forbidden metacharacter', () => {
  for (const bad of [';', '`', '|', '$', '(', ')', '>', '<', '&', '\n', '\r']) {
    assert.equal(hasDisallowedExecChars(`docker ps ${bad}`), true, `should reject ${JSON.stringify(bad)}`);
  }
});

test('hasDisallowedExecChars: permits harmless strings', () => {
  assert.equal(hasDisallowedExecChars('docker ps -a'), false);
  assert.equal(hasDisallowedExecChars('pm2 restart bridge'), false);
});

test('hasDisallowedExecChars: catches common injection payloads', () => {
  assert.equal(hasDisallowedExecChars('docker ps; rm -rf /'), true);
  assert.equal(hasDisallowedExecChars('docker ps && curl evil.com'), true);
  assert.equal(hasDisallowedExecChars('docker $(id)'), true);
  assert.equal(hasDisallowedExecChars('docker `id`'), true);
  assert.equal(hasDisallowedExecChars('docker ps > /tmp/out'), true);
  assert.equal(hasDisallowedExecChars('docker ps\nrm -rf /'), true);
});

test('ENV_KEY_RE: valid env keys', () => {
  for (const k of ['FOO', 'FOO_BAR', '_X', 'a', 'name1', 'A1B2']) {
    assert.equal(ENV_KEY_RE.test(k), true, `expected ${k} to be valid`);
  }
});

test('ENV_KEY_RE: invalid env keys', () => {
  for (const k of ['1FOO', 'FOO-BAR', 'FOO BAR', '', 'F.O', 'FOO=x']) {
    assert.equal(ENV_KEY_RE.test(k), false, `expected ${k} to be invalid`);
  }
});

test('ENV_VAL_FORBIDDEN_RE: rejects ASCII control characters', () => {
  assert.equal(ENV_VAL_FORBIDDEN_RE.test('\x00'), true);
  assert.equal(ENV_VAL_FORBIDDEN_RE.test('\x01'), true);
  assert.equal(ENV_VAL_FORBIDDEN_RE.test('\x1f'), true);
  assert.equal(ENV_VAL_FORBIDDEN_RE.test('\x7f'), true);
});

test('ENV_VAL_FORBIDDEN_RE: permits printable characters and whitespace', () => {
  // Tab (0x09), LF (0x0a), CR (0x0d) are intentionally allowed by the range
  // so multi-line values can still be passed as env records. The Docker env
  // record will fail on newlines separately; this regex only catches the
  // non-whitespace control bytes.
  assert.equal(ENV_VAL_FORBIDDEN_RE.test('hello world'), false);
  assert.equal(ENV_VAL_FORBIDDEN_RE.test('value=x;y'), false);
  assert.equal(ENV_VAL_FORBIDDEN_RE.test('\t'), false);
  assert.equal(ENV_VAL_FORBIDDEN_RE.test('\n'), false);
});
