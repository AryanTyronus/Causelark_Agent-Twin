// @polsia:user-owned — extra <head> rendered by the framework layout (null by default).
// Add <meta>/<link> here (verification, preconnect) — React hoists them. For scripts use
// next/script with the passed `nonce` (CSP-safe). Edit freely.

export function HeadContent({ nonce }: { nonce?: string }) {
  void nonce;
  return null;
}
