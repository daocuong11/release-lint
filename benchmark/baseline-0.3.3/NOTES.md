# Benchmark notes: tool problems found

Bugs, gaps and false-alarm patterns found while running the benchmark. Per the benchmark rules, none of these are
fixed yet: the results show release-lint 0.3.3 (commit 6a1184f) as it is. Each entry says which builds showed it.

## 1. Hermes string tables often fall back to approximate decoding (high priority)

- Bytecode v96 (React Native 0.83.9): mattermost `Mattermost-unsigned.apk`, joplin `joplin-v3.7.12.apk`.
- Bytecode v98, the version the code says it supports: rocketchat `android-release.apk` and `ios-release.ipa`,
  pocketpal `app-prod-release.apk`. Other v98 bundles (bluewallet, streamyfin, …) decode exactly, so the v98 layout
  check fails on some real files too.
- Neither known function-header size (12 or 16 bytes) validates, so `readHermesStrings` falls back to printable byte
  runs and reports `scan/hermes-approximate`. In the fallback, neighbouring strings run together, so URLs can merge
  with the next string, and host and secret checks may miss or mangle findings.
- 5 of 33 React Native builds were affected. `src/formats/hermes.ts` (`FUNCTION_HEADER_SIZES`, `tryLayout`).

## 2. A network security config over 8 MiB is skipped silently (fail-open)

- Seen in: bluewallet `BlueWallet-8.0.2.apk` only (checked all Android builds). Its compiled config `res/8G.xml` is
  8,464,280 bytes, just over `MAX_CONFIG_BYTES` (8,388,608).
- `readNetworkExceptions` filters candidate XML files with `e.size <= MAX_CONFIG_BYTES` before reading them
  (`src/formats/android.ts:123`), so an oversized file is dropped with no `scan/unreadable` finding. Everywhere
  else the tool fails closed; here it fails open.
- What was missed: one `<domain-config cleartextTrafficPermitted="true">` listing `localhost`, `10.0.2.2`, `onion`,
  `tailscale.net` and all 65,536 `192.168.x.x` addresses (source:
  `android/app/src/main/res/xml/network_security_config.xml`, 4.2 MB). Those exceptions look intended (users' own
  nodes on LAN or Tor), but the tool should report them or say the file was not checked.
- Related: element-x has 386 cleartext domains and got 386 separate findings. Long host lists should be summarized.

## 3. `usesCleartextTraffic` is reported even when a network security config overrides it

- On Android 7+ (API 24), when `android:networkSecurityConfig` is set, Android ignores
  `android:usesCleartextTraffic`. The finding should only apply without a network security config, or for
  minSdk < 24.
- False alarm: bluewallet (minSdk 24, config without `<base-config>`, so plain HTTP is *not* allowed to every host,
  yet the tool says "Plain HTTP is allowed to every host").
- Duplicate of the `<base-config>` finding: chatterui, immich, mattermost, streamyfin (.apk and .aab).
- thunderbird has minSdk 23, so its flag does apply on Android 6.

## 4. An `.ipa` without `Payload/` is refused with a misleading message

- Seen in: mattermost `Mattermost-unsigned.ipa`. The zip has `Mattermost.app/` at its root instead of
  `Payload/Mattermost.app/`.
- The tool says "Not an .ipa, .aab or .apk file" (exit 2). The file is a zipped `.app` rather than a standard
  .ipa, so refusing it is defensible, but the message could name the real problem, or the reader could accept a
  root-level `<Name>.app/` the way it accepts an `.app` folder.
- Recorded as outcome `unreadable`. It is the only build of 39 that could not be read; none crashed.

## 5. Host false alarms: SDK defaults per network, and UI placeholder text

- SDK defaults: `@arkade-os/sdk` maps `regtest` to `http://localhost:3000/api` (bluewallet); ethers' default
  JSON-RPC URL `http://localhost:8545` (peach); zeus's regtest option `http://localhost:3000`. Same class as the
  React Native and Sentry URLs already in `FRAMEWORK_URLS`.
- Placeholder or example text: `https://10.20.30.40:3000` (bluewallet), `http://192.168.1.100:8096` (streamyfin),
  `http://192.168.1.100:1234` (pocketpal), `192.168.0.1:50001` (peach), `*.mynode.local` (zeus).
- Origins never fetched: `https://file-preview.local/` and `https://dev-mock.local/v1` (cherry-studio).
- All are warnings (they come from the bundle), but they are the largest group of real misreads after #6.

## 6. `secret/private-key` matches the PEM header alone (error severity)

- Seen in: rocketchat (.apk and .ipa), edge, joplin, peach, cherry-studio: 6 rows, 6 apps, all errors.
- Every hit is a bare `-----BEGIN … PRIVATE KEY-----` string (27 to 77 characters) with no base64 key body after
  it: constants that crypto libraries (PEM parsers) ship. Checked without printing any key bytes.
- This is the only error-level secret finding in the whole run, and it is always wrong. The pattern should require
  a base64 body (for example 64+ characters) after the header, or the END line.

## 7. Grouping per rule can mix verdicts in one row

- `findings.csv` groups per app, build, rule and severity, as specified. A few rows hold hosts with different
  verdicts: blixt `host/private-network` (one real developer LAN server plus regtest and dev values),
  cherry-studio `host/localhost` (Ollama default plus an unidentified bare localhost). The suggestion follows the
  most important host; the reason column names each one.

## 8. CRL and OCSP hosts are reported as cleartext exceptions

- bitwarden (`c.lencr.org`, `c.pki.goog`, `o.pki.goog`, `ocsp.sectigo.com`, …), peach (`lencr.org`), element-x
  (CRL hosts imported from rustls-platform-verifier). Revocation data is signed and served over HTTP by design;
  Android needs the exception for revocation checks. A built-in list of well-known CRL/OCSP domains would remove
  these.

## 9. A bare `http://localhost` appears in 7 React Native builds

- rocketchat (.apk, .ipa), jellify (.apk, .ipa), musicfree, pixelfed, streamyfin (.apk, .aab, .ipa), cherry-studio.
- Exactly `http://localhost`, no port or path, next to React Native's `http://localhost:8081/` in the string
  table. Not found in react-native 0.81, expo 54, expo-router 6, expo-linking 8, reanimated 3/4 or worklets 0.5.
  Likely a library's URL-parsing base. Worth identifying: if it is a framework constant, it belongs in
  `FRAMEWORK_URLS`. Marked can't tell until then.

## 10. The "dev" subdomain heuristic hits public sites

- cherry-studio: `open-dev.dingtalk.com` (DingTalk's public developer portal) and `dev.w3.org/csswg/cssom` (a W3C
  spec URL). "dev" in a subdomain is weak evidence on its own, especially for URLs from library strings.

## Found outside the benchmark

- `src/find-build.ts`: with Gradle product flavors, APKs are in `outputs/apk/<flavor>/release/`, one level deeper
  than the search, so they are not found when no file is given. Not exercised by the benchmark (files are passed
  explicitly).
