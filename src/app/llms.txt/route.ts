// @polsia:framework-owned — DO NOT EDIT. Code installed by polsia/template-next@0.3.0.
//
// /llms.txt — the endpoint. Next has no metadata route for llms.txt, so this is a
// plain GET handler serving text/plain; charset=utf-8. Indexing is OPT-IN, exactly
// like robots.ts: only a deploy that sets SEO_INDEXABLE=true (the production
// deploy) serves it; previews, staging, and local builds leave it unset and get a
// 404, so non-production deploys never expose llms.txt (fail-closed).
//
// The document itself is built by renderLlmsTxt() in src/lib/llms.ts (the shape +
// renderer, framework-owned) — no construction lives here. Curate its content in
// the user-owned src/lib/llms-config.ts.
import { renderLlmsTxt } from '@/lib/llms';
import { llmsConfig } from '@/lib/llms-config';

export async function GET(): Promise<Response> {
  // Read SEO_INDEXABLE at request time (not module scope) so the fail-closed gate
  // matches robots.ts and stays stubbable in tests.
  if (process.env.SEO_INDEXABLE !== 'true') {
    return new Response('Not Found', { status: 404 });
  }
  return new Response(await renderLlmsTxt(llmsConfig), {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
