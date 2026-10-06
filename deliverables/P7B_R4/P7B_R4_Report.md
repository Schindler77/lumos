# Lumos v402 P7-B R4 — File-Origin Safe Google Drive Write Transport — Candidate Report

**Result: H-P7B-01..38 = 38/38 PASS** · Status: Candidate (not OFFICIAL) · No real Google Drive write performed · page errors 0

## Identity
| | Bytes | SHA-256 |
|---|---|---|
| Direct parent `Lumos_v401_P7A_Canonical_State_Fingerprint_R5_OFFICIAL.html` | 4,663,880 | `48bc0e57d6256aef189086548d3061add6c8a9cee5683f401dbf4b291f77d17d` |
| Candidate `Lumos_v402_P7B_Manual_Sync_V7_R4_Candidate.html` | 4,722,828 | `2c9a0416b48656e7c21cc7c70540e077d3f1591e30e297bdef6e851803a373f3` |
| `P7B_R4_correction.diff` (R5 OFFICIAL → R4) | | `2f6df74614b125e3c7ade080c292fb2963e62f6694aff8981132ffc97252099c` |
| Semantic source R3 Candidate (not the parent) | 4,717,093 | `858acdc55edaec381efe2e89a9527f500d6d7b9fb9e39346ec08b8d4fada6e93` |

Built deterministically by `build_p7b_candidate.py` from the exact R5 OFFICIAL bytes plus `p7b_v7_block.js`. The builder asserts the parent SHA, the R5 v136 SHA and the reviewed R4 v136 SHA.

## Scope (vs R5 OFFICIAL)
| Item | Result |
|---|---|
| scripts | 257 → 257 |
| changed scripts | `lumos-v379-version-authority` (one constant line), `lumos-v136-drive-sync-script` |
| v136 body | `ca59900f2dcbfed271b937a4c42a4586130045b2ea2ca3910527162589d11537` → `f93bbfbbacf00b97a4caf18c82b92154bfbda8ec6b9ae20a63a1bc612cebf9e1` |
| P7-A module `lumos-p7-canonical-state-v401a` | exact R5 body `4e4bd81b01404cdb7344a117d8718a1f5422efad4579fab4dfea9d7d7ba0630c` |
| other 255 scripts | byte-identical to R5 (v161, v391, v140 runtime, main, v134 Provider Core, v245 extension owner, Universal Relay) |
| non-script changes | `<title>`, `<meta name="lumos-build">` only |
| release identity | `VERSION v402 R4`, `BUILD v402-p7b-manual-sync-v7-r4`, `TITLE Lumos 3.0 · v402 R4 P7-B Manual Sync v7` (historical v390/v161/v245/v391 ids unchanged) |

R4 v136 = R5 v136 + the R3 v7 block + the R4 transport changes, with the same two R3 integration anchors (public API, Manual Sync routing) plus the `p7TransportV402D` export and a `multipart` test hook. `P7B_R4_block_vs_R3.diff` shows the complete R3 → R4 block delta.

## What changed in the v7 block (R3 → R4)
1. **`p7DriveWriteV402D(url, options, interactive)`**, the single P7 write helper.
   - On `location.protocol === 'file:'` it calls the existing `window.LumosUniversalRelay106.fetch` from the first write. There is no direct-first attempt and no direct fallback.
   - On `http:`/`https:` it is the R3 `driveFetch` path, unchanged.
   - It gets the token from the existing `requestToken(interactive)`, which is sent only as the transient upstream `Authorization` header. A 401 clears the token and retries once.
   - Non-2xx, upstream 5xx, a relay throw or a network error throws a redacted transport error.
2. **Folder creation on the P7 path.** `p7EnsureRootV402D` keeps the legacy `findFolder` lookup and creates `Rumos` only if absent, with the identical legacy metadata. The three P7 subfolders are also created through the helper. Legacy `ensureFolder`/`createFolder` are untouched. GET/LIST lookups stay direct.
3. **Explicit multipart/related string body** (`p7MultipartV402D`) on `file:` for objects, manifests and secret snapshots. It uses a random `lumos_p7_` boundary that never occurs in either part, and both parts are `application/json; charset=UTF-8`. No `FormData` reaches the relay. The R3 FormData body is kept for http(s).
4. **Readiness gate.** `p7TransportV402D()` returns `{origin, write, relayAvailable, ready}`. If no relay is present on `file:`, sync returns `TRANSPORT_UNAVAILABLE` before any Drive request. The dry-run and `p7StatusV402B()` report the transport (it is not part of `planId`).
5. **Provider Core priming (bug found by this harness).**
   - The relay entry point is the v134 monitored fetch. Its first call normalizes `SETTINGS.providerCoreV134`, which is a canonical INCLUDE settings field under P7-A R5.
   - When the profile is loaded after boot, as in the settled real-profile fixture, that normalization moved the local canonical root mid-sync. The R3 apply guard then aborted every join with "로컬 상태가 동기화 중 변경되어 적용을 중단했습니다", and a fresh-tab live migration could fail the same way.
   - R4 calls the public, idempotent `LumosProviderCore134.settings()` once on the relay path. This happens after the acceptance checks and before the mutation lock and the local-state read. Regression is in H-P7B-33 and in every join of H-P7B-03..31.

Everything else (manifest-first transfer, SAME zero-body, fork/conflict preservation, fence, sibling convergence, pagination, migration gate, secrets/tombstones, v245 composition, no GC, no half-apply) is the R3 code, unchanged.

## Gate changes vs R3
- **Load path.** The harness loads the candidate from `file://`, so H-P7B-01..32 now exercise the relay for every P7 write. The relay is served by the synthetic Universal Relay fixture in `p7b_device.py`, which decodes the v106 envelope, forwards to DriveSim and mirrors the status.
- **H-P7B-01** checks the reviewed R4 v136 SHA and that the build comes from exact R5, not from R3.
- **H-P7B-02** also counts relay requests during load: 0.
- **H-P7B-13** keeps the manifest write failing for the whole run. The relay entry point (v134) retries a one-shot 5xx at most twice, so a one-shot failure is absorbed; the assertion is unchanged.
- **H-P7B-27** also checks that every relayed upstream is a Drive v3 files/upload path and that the relay proxy token header was present (its value is never recorded).
- **H-P7B-32** checks the v402 R4 identity.
- **H-P7B-33..38** are new.

## Gates
| ID | Gate | Result | Evidence |
|---|---|---|---|
| H-P7B-01 | exact parent / scope | PASS | parent R5 OFFICIAL 4,663,880 B 48bc0e57d625… ; scripts 257→257 ; changed=['lumos-v379-version-authority', 'lumos-v136-drive-sync-script'] ; v136 ca59900f2dcb…→f93bbfbbacf0… (= reviewed R4 v136 = R2/R3 v136 + R4 write transport) ; P7-A module = R5 body 4e4bd81b0140… ; v161/v391/v140/main byte-identical ; non-script changes = <title> + <meta lumos-build> only ; built from exact R5, not from R3 True |
| H-P7B-02 | startup remains OFF | PASS | Drive + relay requests during load (new + existing install) = 0 ; startupSync() → false ; v7 block top-level statements other than declarations = 0 ; v7 inactive until migration gate |
| H-P7B-03 | SAME | PASS | result=SAME bodyUp=0 bodyDown=0 manifestWrites=0 (metadata lists=26) |
| H-P7B-04 | one local object (100 novels) | PASS | uploads=['nov-005'] bodyUploads=1 (2535 B) manifest=1 |
| H-P7B-05 | one remote object | PASS | downloads=['nov-005'] bodyDownloads=1 unrelated=0 ; roots equal |
| H-P7B-06 | same novel divergence | PASS | remote text kept at nov-010, local preserved as fork-311feb94f41e6fb360080dc0 "이야기 10 (기기 분기본)" ; no sentence merge ; devices converge |
| H-P7B-07 | disjoint bidirectional edits | PASS | B: upload ['nov-030'] + download ['nov-020'] ; forks=0 ; converged |
| H-P7B-08 | item conflict | PASS | item fork ids=['custom_prompt_pm-1', 'custom_prompt_pm-1__conflict_cbbbc0d73fb1'] ; both versions kept ; converged |
| H-P7B-09 | long authored field conflict | PASS | conflict record 022bf6ff3a7b9ef38129199d: winner=wa6ec4834c785f27f loser=w9a24b3866e54a62d (both texts verbatim) ; record identical on both devices ; no secrets |
| H-P7B-10 | ordinary scalar field | PASS | newer field clock wins (temperature=1.4 on both), no conflict record for scalar ; equal-clock tie → lexically greater writer (wa6ec4834c785f27f) (rule in p7ResolveV402B; exercised for secrets in H-P7B-21) |
| H-P7B-11 | cache / body integrity | PASS | poisoned cache rejected (1) → authoritative body fetched & verified ; tampered remote body → INVALID_REMOTE ; B DB/SETTINGS byte-identical |
| H-P7B-12 | compare-at-commit fence | PASS | remote advanced between inspect and commit → attempt 1 aborted at fence, re-evaluated, committed rev 3 with both changes ; trail=idle>inspecting>uploading>retryable>inspecting>downloading>uploading>validating>success |
| H-P7B-13 | partial / crash | PASS | body uploaded (relay), manifest write failed (every relayed try 500) → FAILED, head unchanged ; retry reuses content-addressed body (uploads 0, manifest 1) |
| H-P7B-14 | same-revision sibling race | PASS | A loses: post-verify sees winner, siblingsLost=1, no success until later rev ; B reported success but lost total order: next sync resolves base via common ancestor → its change re-committed ; both rev2 siblings preserved, deletes 0 ; converged |
| H-P7B-15 | pagination | PASS | Drive page size forced to 10: histories 25/100/150 (+1 invalid top manifest) → head revs [26, 101, 151] = expected [26, 101, 151] ; invalid top skipped |
| H-P7B-16 | v6 migration dry-run | PASS | plan mode=migrate, legacy settings+novels found, uploadCount=192 (315,929 B), secret count=6 (values 0) ; Drive writes/creates=0 ; local DB/SETTINGS unchanged |
| H-P7B-17 | v6 migration commit | PASS | rev1 0000000001-wff1ca3b285d053a9-00mux6qpcb0001.json valid (every body hash verified independently) ; head 0000000002-wff1ca3b285d053a9-00mux6qtls0002.json (settle=True, parent=rev1) ; legacy lumos-settings/lumos-novels bytes unchanged ; merged: legacy-only novel present + local edit kept ; local root == head root |
| H-P7B-18 | real-profile unclassified gate | PASS | dry-run lists 19 paths (e.g. ['DB.futureRootA', 'DB.futureRootB']…) without secret values ; commit without acceptUnclassified → ACCEPTANCE_REQUIRED (Drive requests 0, local unchanged) ; after explicit acceptance → MIGRATED |
| H-P7B-19 | secret channel defaults / disclosure | PASS | new install → OFF ; existing install → ON + disclosure required (commit blocked without it) ; disabled before commit → secret writes 0 ; acknowledged → 1 secret snapshot |
| H-P7B-20 | secret isolation | PASS | changing only a provider key: canonical root identical, sync SAME (bodies 0, manifest 0), secret snapshot 1 ; secrets in object/manifest bytes or any filename = 0 ; Drive OAuth/relay material in any Drive file = 0 ; report contains no secret values |
| H-P7B-21 | secret concurrent merge | PASS | different paths from two writers converge on both devices ; same path, equal clock → deterministic writer tie-break (wfff… wins) on both devices |
| H-P7B-22 | naiCharacterRefImage | PASS | object store + manifests across every run: image bytes/data URLs/store keys = 0 ; device without the image joins → marker kept remote (pending asset), no bytes transferred, next sync SAME with 0 uploads (no ping-pong) |
| H-P7B-23 | transfer metrics | PASS | 73/73 sync runs: planned object count/bytes == DriveSim-measured body uploads/downloads (manifest bytes counted separately) |
| H-P7B-24 | no GC / legacy preservation | PASS | DELETE/trash calls across all 24 synthetic Drives = 0 ; v7 writes to legacy v6 files = 0 ; legacy bytes unchanged through migration |
| H-P7B-25 | status machine | PASS | SAME: idle>inspecting>same>success / upload-one: idle>inspecting>uploading>validating>success / download-one: idle>inspecting>downloading>validating>success / fork: idle>inspecting>fork-required>downloading>uploading>validating>settling>inspecting>uploading>validating>success / stale-retry: idle>inspecting>uploading>retryable>inspecting>downloading>uploading>validating>success |
| H-P7B-26 | failed attempt no local half-apply | PASS | network 503 during body download → FAILED, DB/SETTINGS byte-identical ; tampered body (H-P7B-11) → INVALID_REMOTE, byte-identical ; crash before manifest (H-P7B-13) → local root unchanged |
| H-P7B-27 | real Drive request shape / allowlist | PASS | googleapis paths used (direct + relayed) = ['/drive/v3/files', '/drive/v3/files/{id}', '/upload/drive/v3/files'] (⊆ Drive v3 files + upload) ; relay upstreams = ['https://www.googleapis.com/drive/v3/files', 'https://www.googleapis.com/upload/drive/v3/files'] (existing Universal Relay endpoint only) ; other attempted requests = pre-existing app-shell CDN tags only (6) ; URL literals in v7 block = 0 (uses existing API_ROOT/UPLOAD_ROOT + driveFetch/LumosUniversalRelay106) |
| H-P7B-28 | syntax / diff / protected owners | PASS | node --check 253/253 ; correction.diff roundtrip=True ; deterministic rebuild=True ; protected owners exact ; eval/new Function 1→1 ; page errors=0 |
| H-P7B-29 | secret deletion convergence | PASS | 29A clear → A stays cleared in the same sync, value-free tombstone {'segs': ['apiKey'], 'deleted': True}, B cleared, following syncs secretWrites=0 ; 29B fresh device adopts remote live value, tombstones emitted 0 ; 29C newer-live>older-delete=True, newer-delete>older-live=True, equal-clock writer tie (wfff… tombstone vs live, both directions)=True, then secretWrites=0 ; 29D root unchanged=True, core SAME (P7 objects 0 / manifests 0), old value leaks=[] (objects, manifests, filenames, tombstone, reports, console, status, local config) |
| H-P7B-30 | extension owner composition | PASS | 30A core SAME → owner upload({quiet,integrated}) ×1, overall success ; 30B upload/download success → ×1 each (real v245 owner run ok=True, wrote ['lumos-extensions.json'] outside P7 folders) ; 30C core failure → owner ×0, overall false ; 30D owner failure → overall false, status extension-failed, core committed once (manifest 1) and next run SAME with 0 manifest/body writes ; 30E pre-migration legacy Manual Sync owner calls parent=1 candidate=1 (identical, v7 inactive) ; 30F risuPlugin objects/bytes in P7 store = 0 |
| H-P7B-31 | R5 canonical integration | PASS | P7-A body = R5 4e4bd81b0140… ; real-profile-shaped fixture (16 R5 fields on 12 chats): 7 INCLUDE in canonical, 9 EXCLUDE absent + reported excluded (R5), chat unclassified=[] DB unclassified=[] ; dry-run plan unclassified=[], plan.localRoot == plan.proposedRoot == P7-A root ; rev1 manifest objects/root == P7-A fingerprints exactly ; EXCLUDE-only edits → SAME (bodies 0, manifests 0) ; INCLUDE edit (novelTurnCounterV216) → uploads ['nov-000'] ; v136 shadow-filter tokens (16 field names / classification sets) = 0 ; v136 extractCanonical call sites = 5 (inputs {DB,SETTINGS} or legacy payload only) |
| H-P7B-32 | global release identity | PASS | loaded app: title/meta/badge/LUMOS_PATCH_VERSION/__LUMOS_PATCH_VERSION__/LUMOS_BUILD_LABEL/data-lumos-version = v402 R4 identity (re-asserted after tamper) ; parent shows v390 R12 (control) ; v379 change = 1 constant line ; document change = <title> + <meta lumos-build> only ; historical component ids (lumos-v390-eil-core, lumos-v390-release-marker, v161, v391, LumosExtensionSyncV245) unchanged |
| H-P7B-33 | file-origin transport selection | PASS | file:// (origin null) across every scenario of this run: P7 writes via Universal Relay = 3843, direct Google P7 write fetches = 0 ; P7 reads/lists direct = 5719 (relayed reads 0) ; relay absent → TRANSPORT_UNAVAILABLE before any Drive request (requests 0), migrated/base unchanged, local byte-identical ; http(s) origin control → MIGRATED via R3 direct path (relay writes 0, direct writes 197) ; un-normalized providerCoreV134 ['routing'] primed before local read → MIGRATED, head root == local root |
| H-P7B-34 | relayed folder creation | PASS | fresh Drive: Rumos root + 3 P7 folders created through the relay write transport (4 creates, direct 0) ; metadata exact (root parents=['root'] appProperties lumos=drive-sync-v136 ; P7 folders parents=[root] appProperties lumos=p7-v402b/kind) ; metrics.folderCreates=3 (+ root) ; config.folderId = created root ; 2nd device joins → folder creates 0 ; R3-failed-attempt Drive (existing root + P7 folders + 1 uncertain object) → MIGRATED, folder creates 0, existing object reused (not re-uploaded), deletes 0, no manual cleanup |
| H-P7B-35 | multipart/related exactness | PASS | 193/193 relayed uploads decoded byte-exactly from the relay envelope (objects 191, manifests 1, secrets 1) : metadata JSON / parent folder / appProperties / file name exact ; content bytes == stored Drive bytes, object SHA-256 == content-addressed name, sizes == manifest ; Korean content parts 114 intact ; relay body types seen by LumosUniversalRelay106.fetch = ['string'] (no FormData/Blob) ; envelope = bodyText ; builder unit (Korean/emoji/CRLF/boundary-like text) exact=True ; problems=[] |
| H-P7B-36 | object/manifest/secret write routing | PASS | file origin, secret sync acknowledged: objects 191 + manifests 1 + secret snapshot 1 all via relay (direct 0) ; disableSecretSync:true device: secret writes 0 at migration and 0 after a provider-key edit (core SYNCED) ; one-object edit → 1 object + 1 manifest via relay |
| H-P7B-37 | failure safety | PASS | relay throw on first body upload → core-failed (error: P7 Relay 전송 실패: 범용 Relay 연결 실패: Failed to fetch), migrated false, active false, base null, extension 0, head absent, direct fallback 0, local DB/SETTINGS byte-identical (relay runtime marker aside) → next attempt MIGRATED ; relay 502 on first body upload → core-failed (error: Google Drive 502 (relay): {"error": "synthetic relay upstrea), migrated false, active false, base null, extension 0, head absent, direct fallback 0, local DB/SETTINGS byte-identical (relay runtime marker aside) → next attempt MIGRATED ; relay 502-after on first body upload → core-failed (error: Google Drive 502 (relay): {"error": "synthetic relay 502 aft), migrated false, active false, base null, extension 0, head absent, direct fallback 0, local DB/SETTINGS byte-identical (relay runtime marker aside) → next attempt MIGRATED, already-present object reused (uploads 190 = planned 190) ; transient single 502 → absorbed by the relay wrapper's bounded retry in the same attempt (MIGRATED, no duplicate logical upload) |
| H-P7B-38 | transport credential/log safety | PASS | bearer value present only as the transient upstream Authorization header of 5435 relayed requests (url/body/other headers 0) ; Drive file bytes + filenames 0 ; console 0 ; canonical / manifest / object / P7 report / trail / status / localStorage config / DB+SETTINGS / DOM incl. Provider Core monitor = [] on 7 live devices (Provider Core monitor rows 375) ; harness reports [] ; relay runtime marker = {'at': 1791322019716, 'target': 'https://www.googleapis.com/upload/drive/v3/files', 'relayVersion': 'sim-relay-1', 'upstreamStatus': '200', 'ok': True} |

## Residual risks for the live gate (not changed by R4, by scope)
- **v245 extension owner on `file://`.** `LumosExtensionSyncV245` is byte-identical and still writes `lumos-extensions.json` directly: PATCH if the file exists, FormData multipart create if not. If Google rejects that direct write from origin `null`, Manual Sync reports `extension-failed`. That is the existing D16 contract: the P7 core commit stands, the run is not reported as full success, and the next run is core SAME. Routing v245 through the relay would need a separate decision, because v245 is outside R4's authorized change set.
- **Synthetic relay vs. real relay.** The real Universal Relay Worker's handling of `bodyText` multipart bodies and the `Authorization` header is evidenced only by the client contract (`lumosFetchExternalV106`) and by existing AI-provider traffic, which sends UTF-8 JSON `bodyText` and `Authorization` headers. The first controlled live migration is the real proof.
- **Provider Core retry.** Relayed P7 writes inherit the v134 bounded retry (≤2 tries, 5 s / 10 s) and appear as "기타" rows in the in-tab AI request monitor (target path only). The duplicate files a retry can cause are harmless by P7 naming; see the Transport contract.

## Next
R4 Candidate → Architect independent preflight → bundled real-Drive test (one ZIP: Candidate + README + controlled console script + post-verify + SHA256SUMS, prepared separately) → controlled live migration → post-verify → P7-B OFFICIAL → P7-C.
