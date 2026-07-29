# 2026-07-28 — ADR-037: drop legacy bare-token auth

Owner's call, taken while reviewing PR #42: any device must use the ADR-035 flow. ADR-035 had kept
pre-0.1.8 bare tokens working so upgrading forced nobody to re-pair; that compatibility is now removed.

## Blast radius, measured before touching anything

```
argonite  devices: 0   legacy bare tokens: 0     (its store was wiped earlier this cycle)
quartz    devices: 0   legacy bare tokens: 6
```

So this de-authorises **6 devices on quartz** and nothing on argonite. Every client of that bridge must
pair again. Said up front rather than discovered later — nothing recovers those tokens, and a `tokens.json`
restored from backup is ignored just the same.

## What went

- `AuthManager`: `legacyTokens`, `LEGACY_DEVICE_ID`, the synthetic list row, the legacy `revoke` branch,
  and the flat-timing scan in `authenticate()`. Auth is one shape now — split on `.`, O(1) lookup, one
  constant-time compare. The O(n) scan that ADR-035 was supposed to replace had in fact been running
  *beside* the new lookup on every request all along.
- `persist()` no longer writes a `tokens` key, so a legacy store sheds the dead entries on its next write.
- App: `DeviceSummary.legacy`, `LEGACY_DEVICE_ID`, the "Revoke all" label, the "Revoke all legacy tokens?"
  confirm, the "this device is part of the legacy group" explanation, and the legacy subtitle.
  `deviceIdOf` now returns `""` for a dotless token rather than `"legacy"` — returning the old id would
  match a *stale* bridge's synthetic row and withhold a Revoke the operator is entitled to.
- Three comments that would have become false: `audit.ts` and `liveChannel.ts` both explained behaviour
  in terms of the shared `legacy` id. Left uncorrected they would have been the fourth, fifth and sixth
  instances this cycle of prose describing code that no longer exists.

## What stayed, deliberately

`load()` still *counts* bare tokens, purely so boot can say how many devices just stopped working:

```
WARNING: /var/lib/gitview-bridge/tokens.json holds 6 pre-0.1.8 token(s), which are NO LONGER ACCEPTED.
         6 device(s) must pair again: gitview-bridgectl pair
         They are dropped from the store on its next write.
```

Without it the bridge starts with fewer devices than the file appears to hold and the log looks like a
healthy boot — the exact silent-failure shape the "unreadable store" warning already exists to prevent,
and the shape that made the store wipe so hard to diagnose.

## Verified

Bridge suite **170 pass**; app unit tests pass; `npm ci --dry-run` agrees with the bumped lock.

Live, against a scratch bridge seeded with two bare tokens (never production):

```
GET /v1/repos with a bare legacy token: 401
GET /v1/repos with the new token:       200
devices: ["dv_1bxt-blj/new phone"]
store:   {"devices":[{...,"tokenHash":"d2a4632b…"}]}   <- the `tokens` array is gone
```

On the phone emulator against the deployed 0.1.11 bridge: paired fresh, `devices` lists the real device,
and the **Paired devices** dialog shows two real rows — "this device" with its Revoke withheld (the 403
rule), "other laptop" with a plain **Revoke**, no synthetic row, no legacy explanation. The confirm reads
*"Revoke device?"* rather than *"Revoke all legacy tokens?"*, and revoking from the app removed the row.

## Not done / notes

- **Only the phone form factor was exercised.** The device dialog is the one UI this touched and it is a
  text/branch change to an existing dialog already verified on all three; the tablet and e-ink runs were
  skipped for time. Worth a pass before release.
- **quartz is untouched** — still on the pre-socket build, still holding its 6 legacy tokens. Upgrading it
  is what actually cuts those devices off, so it should be done deliberately, with someone able to re-pair.
- A socket path longer than ~107 bytes (unix `sun_path`) fails to bind and reports only
  `Host admin socket UNAVAILABLE`, without saying why. Hit it while using a deep scratch directory. The
  default path is short so it does not bite in practice; the message could carry the errno.

## Versions

Bridge **0.1.11**, app **0.1.9** (`versionCode` 10) — both changed, so both bump; the release tag would be
`v0.1.11`. Note this stacks on PR #42, which carries bridge 0.1.10.

## The gap the owner caught: I tested the wrong device

The first emulator pass verified what a *newly paired* device sees. The devices ADR-037 actually affects
are the 6 on quartz holding legacy tokens, and that state was never reproduced.

Checking it turned up a dependency, not just a missing test:

```
liveChannel.ts:101-107   auth fails → conn.ws.close(4401, "unauthorized")
liveChannel.ts:178       revoke     → conn.ws.close(4401, "device revoked")
```

A de-authorised device does not merely get HTTP `401` — its **live channel closes with `4401`**, which the
app treated as an ordinary drop. Shipping ADR-037 alone would have pushed **all 6 quartz devices into the
permanent "Connection lost — reconnecting…" loop at once**: the `4401` bug's worst case, triggered
deliberately, on every affected device simultaneously. The two were never independent.

So the `4401` fix moved into this change (its branch is deleted), and its PLAN entry is marked done here.

**Verified the actual upgrade experience** on the phone emulator — pair, open the workspace so the live
channel is up (`CONNECTED yes`), then make the credential stop verifying, which is exactly what the
upgrade does to a legacy holder:

```
Revoked dv_ZSVAxFwv — 1 credential, 1 connection(s) closed.
→ banner "Access revoked — pair again to reconnect." + the pairing dialog, immediately
```

Then the operator's remedy, end to end: `gitview-bridgectl pair` → enter the code → back to the repo list,
new device id `dv_Njaz7mCE`. That is the full round trip a quartz owner will walk through, and it works.

## Re-run on all three form factors, same build

The owner asked for the whole sequence on every device rather than the phone alone. Each run is a full
round trip: clean app → add bridge → pair → second credential paired out-of-band → **Paired devices**
dialog → open a repo so the live channel is up (`CONNECTED yes`) → de-authorise from the host → re-pair.

| | devices dialog | de-authorised while connected | recovery |
|---|---|---|---|
| **Phone** 1080×2340 | two real rows, no synthetic row; "this device" Revoke withheld; peer shows plain **Revoke** | `1 connection(s) closed` → banner + pairing dialog | re-paired, back to the repo list |
| **Tab S8** 2560×1600 landscape | same, two-pane behind it | `1 connection(s) closed` → banner spans both panes | re-paired |
| **Bigme B7** 1264×1680, **Color E-Ink profile ON** | same, hue-free — **Revoke** renders near-black, not red | `1 connection(s) closed` → banner + dialog | re-paired |

Every de-authorisation reported `1 connection(s) closed`, so the `4401` path — not just HTTP `401` — was
exercised on all three. The confirm dialog reads *"Revoke device?"* everywhere; nothing says "Revoke all"
or mentions a legacy group.

### Two harness bugs that made the first attempts lie

Both were stale-file traps, and both initially read as "the app is broken":

- `screenrecord` wrote `/sdcard/s.mp4`, but I only deleted the **local** copy. A failed recording left the
  *previous* capture on the device to be pulled, so screenshots showed an earlier screen. The flow had
  worked; the verification hadn't.
- `uiautomator dump /sdcard/ui.xml` from an earlier run was owned by another uid, so `rm` failed with
  `Permission denied`, the dump did not overwrite, and the pull returned the **previous screen's**
  hierarchy — which is why the tablet appeared to be stuck on a diff view from a previous session.

Both helpers now delete the on-device file first and the dump uses a unique filename per call. Worth
remembering: on this box an emulator screenshot is guilty until proven fresh.
