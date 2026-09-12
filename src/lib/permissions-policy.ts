// @polsia:framework-owned — DO NOT EDIT. Builds the Permissions-Policy header
// value applied to every route in next.config.ts.
//
// SECURITY POSTURE (platform decision — not the agent's to change):
//   - Every powerful feature defaults to `()` — an EMPTY allow-list, i.e.
//     disabled for ALL origins including this one. With `microphone=()` the app
//     cannot even call getUserMedia: recording never starts. That is the secure
//     default and the reason apps that need audio must opt in.
//   - An app opts a feature IN by flipping it in `appCapabilities`
//     (next.user-config.ts), which emits `<feature>=(self)`.
//   - `(self)` does NOT grant access. It only lets THIS origin *request* the
//     feature; the browser's native permission prompt is still the real gate
//     (the user must click Allow). So opting in is low-risk — but stay opted OUT
//     for features you don't use: declaring unused device permissions is flagged
//     by security audits and drops a defense-in-depth layer against XSS.
//   - `browsing-topics` stays hard-OFF: it is an ad-tracking API, never opened
//     through this seam.

/** Browser capabilities an app can opt into via next.user-config.ts. */
export type AppCapabilities = {
  /** getUserMedia({ audio }), MediaRecorder — voice recording. */
  microphone?: boolean;
  /** getUserMedia({ video }) — video calls, QR scan, photo capture. */
  camera?: boolean;
  /** navigator.geolocation — "near me", maps. */
  geolocation?: boolean;
};

/**
 * Build the `Permissions-Policy` header value. With no opt-ins this returns the
 * fully locked-down default: `camera=(), microphone=(), geolocation=(),
 * browsing-topics=()`. Each capability set to `true` becomes `<feature>=(self)`.
 */
export function buildPermissionsPolicy(caps: AppCapabilities = {}): string {
  const token = (on: boolean | undefined) => (on ? '(self)' : '()');
  return [
    `camera=${token(caps.camera)}`,
    `microphone=${token(caps.microphone)}`,
    `geolocation=${token(caps.geolocation)}`,
    'browsing-topics=()',
  ].join(', ');
}
