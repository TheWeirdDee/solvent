# Browser runs — 2026-10-02

Real-browser evidence for the checks an independent audit could not run in its own browser: phone width (390×844) in Chromium **and** WebKit, drag-and-drop, the relay-outage → retry recovery, copy actions, and an independent check of each fresh Nostr event.

**What was tested:** a production build (`npm run build`, served by `vite preview`) of the source in the commit that adds this folder. It ran against the **live public backend**: the Railway CDK mint `https://solvent-production-2029.up.railway.app` (`cdk-mintd/0.18.1`, NUT-06 `0294d5b0…743dd7`, fakewallet Lightning) and its evidence service `https://solvent-production-9c92.up.railway.app`, public Nostr relays, and the Mutinynet reserve.

**What was not tested:** the Vercel deployment itself. Once this commit is deployed, `npm run verify:deployed-revision` shows which commit the site serves, and the same commands can be pointed at <https://solvent-ashen.vercel.app/>.

## Real mint, three browsers

```sh
npm run verify:real-mint:browser -- <site> - - --width 1363 --height 936 --screenshots real-mint
npm run verify:real-mint:browser -- <site> - - --width 390 --height 844 --screenshots real-mint
npm run verify:real-mint:browser -- <site> - - --browser webkit --width 390 --height 844 --screenshots real-mint
```

| Run | Checks | Log |
|---|---|---|
| Chromium 1363×936 | 33/33 | [real-mint-chromium-1363x936.txt](real-mint-chromium-1363x936.txt) |
| Chromium 390×844 (touch) | 33/33 | [real-mint-chromium-390x844.txt](real-mint-chromium-390x844.txt) |
| WebKit 390×844 (touch) | 33/33 | [real-mint-webkit-390x844.txt](real-mint-webkit-390x844.txt) |

Each run makes three small fakewallet issuances on the public demo mint:

- **A. Honest issuance** → `ACCEPT_VERIFIED`, accepted once. The run also checks:
  - the decision is brought into the top part of the screen;
  - the copy buttons confirm, and in Chromium the clipboard holds exactly the copied value;
  - the public-evidence and replay-bundle downloads complete (the replay bundle only after its warning; the test keeps neither file);
  - an immediate same-issuance retry stays ACCEPT with 0 new accept calls;
  - after a reload, the accepted state is restored and a retry still never accepts twice.
- **C. Broken promise** (omission registered before minting) → `REFUSE_ISSUANCE_OMITTED`.
  - Every other check is valid; 0 accept calls; no retry is offered.
  - The note under the result does not mention a retry.
- **D. Relay outage:** in this test browser only, WebSockets and the HTTPS relay fetch are blocked.
  - Result: amber "could not complete" (`REFUSE_NOSTR_UNAVAILABLE`), nothing accepted.
  - With the outage over, retrying the **same** issuance → `ACCEPT_VERIFIED`, accepted once, nothing minted.

**Independent event check.** Each fresh event was fetched from the public relays by a separate Node process, outside the browser and the app. It was checked with `nostr-tools`' `verifyEvent` (the id is the hash of the event; the Schnorr signature is valid). Its manifest digest and epoch were then compared with what the page showed:

| Run | Case | Epoch | Nostr event id | Manifest digest |
|---|---|---|---|---|
| Chromium 1363 | honest | 74 | `e6d085a701b3bf8bef6366f4768c9fe6998059bfbdbe01784f58d2b853af3016` | `b810c003fc86dd3a59f2f62e3f9c38267144584a7d5272de98adaac4d57a2c7b` |
| Chromium 1363 | broken promise | 75 | `f6eb44467c482125ab663da731f15d672ed35d1953920d5dab3f0f5f8fca624f` | `ff1f1103316db6e1c1f3c5d11ef916c96a51bbef45118dc2533872e8335177ab` |
| Chromium 390 | honest | 77 | `e95ce072197085a44c6ad61a13f806154ccf6755f014da51e2918df0015de16a` | `96ccb77684629f88bb5c0f1e1842281fe7c95976cb601656f72de228125c616d` |
| Chromium 390 | broken promise | 78 | `4176cf1e01982535fb0f4a2bfa6d77331776fe367679a9dce9be1ca803f09392` | `b1d94696f98f832772e96a602fb42a32d96a0909092430b8ba64c53e9c19446e` |
| WebKit 390 | honest | 80 | `d251ee5fe8b2493f6c77c40d67bb03cdf419a98223f7d80fb50b71bec0c69c14` | `7de67e49757e4c925c3f7127325fe3b4750dba4e20db4f65896b8a93e07bc002` |
| WebKit 390 | broken promise | 81 | `c606424589a86b30cf09ace9e65e67968d6b294ad5371120603b5a97c32b8a90` | `659a3b773601e6c39db1467ede5e5550c9bf37480941888594e11cd253803895` |

Anyone can fetch these ids from any of the current relays, and check them, while the relays keep them.

Screenshots of each result are in [`real-mint/`](real-mint/).

## Site UI, Chromium + WebKit

`npm run verify:ui:browser -- <site> --screenshots ui` passed **152/152**: [ui-chromium-webkit.txt](ui-chromium-webkit.txt). At 390×844, in both Chromium and WebKit, it covers:

- every route with no horizontal overflow;
- burger navigation and touch-target sizes;
- the Protocol jump menu: every section lands below the sticky header and is recorded in the URL; back returns to the previous section;
- landing anchors;
- JSON upload, and malformed, wrong-type and empty files;
- drag-and-drop;
- a result withdrawn when its input changes by typing or dropping;
- an acceptance that does not carry over to dropped evidence, which gets its own decision.

On desktop it adds:

- every Protocol entry, including rapid choices with smooth scrolling;
- direct section links;
- the README's Evidence link with refresh, back and forward;
- every footer destination;
- the build revision stamp;
- returning to the tab after the cache window re-fetches the live status and labels it LIVE.

Phone screenshots of every route, in both engines, are in [`ui/`](ui/).

## What these runs do not contain

No proof secrets, keys, mnemonics or tokens. The logs and screenshots hold only public identifiers. The honest issuances' ecash stayed in the test browsers' storage and was discarded with them.
