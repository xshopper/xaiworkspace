/**
 * Allowlist for docker images the bridge is permitted to `docker pull` / `docker run`.
 *
 * Only images from the official xAI Workspace ECR Public repository are permitted.
 * This mirrors the Tauri-side `is_allowed_image()` check in `src-tauri/src/lib.rs`
 * so an attacker who controls a router-forwarded `provision` message (or the body
 * of `POST /api/instances`) cannot make the bridge pull and execute an arbitrary
 * image from a hostile registry. The bridge container itself has the Docker socket
 * mounted, so this is an RCE boundary on the host.
 *
 * The bridge is intentionally more permissive than the Tauri image check: it
 * accepts any tag under the official repo (workspace containers use tags like
 * `latest`, `v1.2.3`, `bridge-vX.Y.Z`), whereas the Tauri-side check is bridge-only
 * and requires a strict `bridge-v<semver>` tag.
 */

const ALLOWED_REGISTRY_PREFIX = 'public.ecr.aws/s3b3q6t2/xaiworkspace-docker:';

// Docker tag grammar: [A-Za-z0-9_][A-Za-z0-9_.-]{0,127}
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function isAllowedImage(image) {
  if (typeof image !== 'string' || image.length === 0) return false;
  if (!image.startsWith(ALLOWED_REGISTRY_PREFIX)) return false;
  const tag = image.slice(ALLOWED_REGISTRY_PREFIX.length);
  return TAG_RE.test(tag);
}

module.exports = { isAllowedImage, ALLOWED_REGISTRY_PREFIX };
