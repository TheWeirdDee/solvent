// npm run verify:deployed -- <deployed-url>   (or DEPLOYED_URL=... npm run verify:deployed)
//
// Confirms a DEPLOYED SOLVENT build is actually serving the CURRENT
// canonical Live Public Demo evidence — not a stale cached bundle from
// before the last regeneration. This is deliberately distinct from `npm
// run verify:live-demo` (which proves the local evidence file is live and
// fresh) and `npm run verify:submission` (which proves the local
// mechanism is correct): neither of those touches the actual deployed
// site. The success condition here is specifically "the public URL is
// serving the refreshed canonical demo," not "the local dist/ is correct."
//
// Works by exploiting the same fact docs/trust-boundaries.md's "Making
// regeneration safe" section documents: evidence/nostr/live-demo.json is
// bundled into the production JS at build time (a static `with {type:
// "json"}` import), so its exact Nostr event id ends up literally present
// in the built/deployed bundle text. Fetches the deployed index.html,
// extracts its <script src> references, fetches those, and checks for the
// current live-demo.json's event id.
//
// Uses process.exitCode (never a forced process.exit()) so the event loop
// drains naturally after fetch()'s keep-alive connections close — avoids a
// known Node/libuv shutdown race that a forced exit right after fetch can
// trigger on some platforms.
import { readFileSync } from 'node:fs';
import path from 'node:path';

async function main(): Promise<boolean> {
  const url = process.argv[2] || process.env.DEPLOYED_URL;
  if (!url) {
    console.error('Usage: npm run verify:deployed -- <deployed-url>  (or set DEPLOYED_URL)');
    return false;
  }

  const liveDemoPath = path.resolve(import.meta.dirname, '..', '..', 'evidence', 'nostr', 'live-demo.json');
  const liveDemo = JSON.parse(readFileSync(liveDemoPath, 'utf8')) as { bundle: { nostrEvent: { id: string } }; publishedAt: string };
  const expectedEventId = liveDemo.bundle.nostrEvent.id;

  console.log('SOLVENT — deployed-site verifier\n');
  console.log(`Deployed URL:                 ${url}`);
  console.log(`Expected canonical event id:  ${expectedEventId}`);
  console.log(`Expected published at:        ${liveDemo.publishedAt}\n`);

  const base = url.endsWith('/') ? url : `${url}/`;

  let indexRes: Response;
  try {
    indexRes = await fetch(base);
  } catch (err) {
    console.log(`FAIL — could not reach deployed index: ${(err as Error).message}`);
    return false;
  }
  if (!indexRes.ok) {
    console.log(`FAIL — deployed index returned HTTP ${indexRes.status}`);
    return false;
  }
  const html = await indexRes.text();
  const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]!);
  if (scriptSrcs.length === 0) {
    console.log('FAIL — no <script src> tags found in the deployed index.html (unexpected build output shape)');
    return false;
  }

  let found = false;
  for (const src of scriptSrcs) {
    const scriptUrl = new URL(src, base).toString();
    console.log(`Checking deployed bundle: ${scriptUrl}`);
    try {
      const res = await fetch(scriptUrl);
      if (!res.ok) {
        console.log(`  HTTP ${res.status} — skipping`);
        continue;
      }
      const body = await res.text();
      if (body.includes(expectedEventId)) {
        found = true;
        break;
      }
    } catch (err) {
      console.log(`  fetch failed: ${(err as Error).message} — skipping`);
    }
  }

  console.log('');
  if (found) {
    console.log('DEPLOYED SITE VERIFIED — serving the current canonical Live Public Demo evidence.');
    return true;
  }
  console.log('DEPLOYED SITE STALE OR MISMATCHED — the deployed bundle does not contain the current canonical live-demo event id. Either the deployment has not propagated yet, or it picked up a build from before the last `npm run live-demo` regeneration.');
  return false;
}

main()
  .then((ok) => {
    process.exitCode = ok ? 0 : 1;
  })
  .catch((err) => {
    console.error('verify-deployed crashed:', err);
    process.exitCode = 1;
  });
