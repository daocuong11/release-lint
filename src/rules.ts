import { SECRET_PATTERNS } from './secret-patterns.js';
import { SEVERITIES, type AppModel, type Finding, type RuleOptions, type Severity } from './types.js';

/** A string the rules scan, with where it came from. Expo config values count as explicit config. */
interface Text {
  value: string;
  location: string;
  fromConfig: boolean;
}

/** Runs every rule and returns the findings, errors first. */
export function runRules(app: AppModel, options: RuleOptions): Finding[] {
  const texts = collectTexts(app);
  const findings = [...secretRules(texts), ...hostRules(texts, options), ...deepLinkRules(app, options), ...networkRules(app, options), ...updatesRules(app), ...releaseRules(app)];
  const rank = (s: Severity) => SEVERITIES.indexOf(s);
  return findings.map((f, i) => ({ f, i })).sort((a, b) => rank(b.f.severity) - rank(a.f.severity) || a.i - b.i).map(({ f }) => f);
}

function collectTexts(app: AppModel): Text[] {
  const bundle = app.bundle;
  const fromBundle = (bundle?.strings ?? []).map((value) => ({ value, location: bundle?.file ?? '', fromConfig: false }));
  const config = app.expoConfig;
  const fromConfig = config
    ? configStrings(config.value, []).map(([path, value]) => ({ value, location: `${config.file} (${path.join('.')})`, fromConfig: true }))
    : [];
  return [...fromBundle, ...fromConfig];
}

function configStrings(value: unknown, path: string[]): Array<[string[], string]> {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => configStrings(item, [...path, String(i)]));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => configStrings(item, [...path, key]));
  return [];
}

// ---------------------------------------------------------------- secrets

const MASK_PREFIX = 8;
const MASK_SUFFIX = 4;


const mask = (value: string): string =>
  value.length <= MASK_PREFIX + MASK_SUFFIX ? '••••' : `${value.slice(0, MASK_PREFIX)}••••${value.slice(-MASK_SUFFIX)}`;

function secretRules(texts: Text[]): Finding[] {
  const seen = new Set<string>();
  return texts.flatMap(({ value, location }) =>
    SECRET_PATTERNS.flatMap((p) =>
      [...value.matchAll(p.pattern)]
        .map((m) => m[0])
        .filter((match) => (p.isSecret ? p.isSecret(match) : true))
        .filter((match) => !seen.has(`${p.id}\0${match}`) && Boolean(seen.add(`${p.id}\0${match}`)))
        .map((match) => ({
          ruleId: p.id,
          severity: p.severity,
          message: p.message,
          evidence: p.evidence ? p.evidence(match) : mask(match),
          location,
          fix: p.fix,
        })),
    ),
  );
}

// ---------------------------------------------------------------- hosts

interface HostIssue {
  rule: 'localhost' | 'private-network' | 'tunnel' | 'local-only-domain' | 'non-production';
  message: string;
}

/**
 * scheme://[userinfo@]host[:port][rest]. Userinfo is skipped so `user:pw@staging.example.com` yields the real host.
 * All repeats are bounded (hostile input must not make this quadratic); IPv6 literals are hex, ':' and '.' only.
 */
const URL_PATTERN = /\b(?:https?|wss?):\/\/(?:[^\s"'`<>\\/?#@]{0,256}@)?(\[[0-9A-Fa-f:.]{2,45}\]|[^\s"'`<>\\/?#:@]{1,253})(?::\d{1,5})?([^\s"'`<>\\]{0,512})/gi;
const MAX_EVIDENCE = 120;

/** scheme://host[:port]/path only: userinfo, query and fragment may hold tokens and must not reach CI logs. */
function urlEvidence(url: string): string {
  const clean = url.replace(/^([a-z]+:\/\/)[^\s/?#@]*@/i, '$1').split(/[?#]/)[0]?.replace(/[),.;]+$/, '') ?? '';
  return clean.length > MAX_EVIDENCE ? `${clean.slice(0, MAX_EVIDENCE)}…` : clean;
}
/** `localhost:8081` or `192.168.1.5:3000` without a scheme. A port is required so version numbers never match. */
const BARE_HOST_PORT = /(?<![\w.:/@-])(localhost|(?:\d{1,3}\.){3}\d{1,3}):\d{2,5}\b/g;
const TUNNEL_SUFFIXES = ['ngrok.io', 'ngrok.app', 'ngrok-free.app', 'ngrok-free.dev', 'loca.lt', 'localtunnel.me', 'trycloudflare.com', 'serveo.net', 'localhost.run', 'lhr.life'];
const LOCAL_ONLY_TLDS = ['local', 'test', 'internal', 'lan'];
/** SDKs ship their vendor's sandbox URLs on purpose (receipt validation, payments). */
const VENDOR_DOMAINS = ['apple.com', 'paypal.com', 'paypalobjects.com', 'braintreegateway.com', 'plaid.com', 'adyen.com', 'stripe.com', 'klarna.com', 'mollie.com', 'checkout.com', 'squareupsandbox.com', 'google.com', 'googleapis.com', 'facebook.com', 'sentry.io', 'sentry.dev'];
const ENV_WORDS = new Set(['staging', 'stage', 'stg', 'dev', 'develop', 'development', 'qa', 'uat', 'test', 'testing', 'preprod', 'sandbox']);
/** Words that mark an environment even inside the registrable name (`myapp-staging.com`); "dev" and "test" are too common there. */
const STRONG_ENV_WORDS = new Set(['staging', 'stg', 'preprod', 'uat', 'qa', 'sandbox']);
const COUNTRY_SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu']);

const isUnder = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

function isAllowed(host: string, allowHosts: readonly string[]): boolean {
  const h = normalizeHost(host);
  return allowHosts.some((a) => (a.startsWith('*.') ? isUnder(h, a.slice(2).toLowerCase()) : h === a.toLowerCase()));
}

const normalizeHost = (host: string) => host.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '').replace(/^\[(.*)\]$/, '$1');

function privateIpv4(host: string): HostIssue | undefined {
  const parts = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  if (!parts || parts.some((n) => n > 255)) return undefined;
  const [a = 0, b = 0] = parts;
  if (a === 127 || host === '0.0.0.0') return { rule: 'localhost', message: 'Points at localhost: it only works on the developer machine' };
  if (host === '10.0.2.2') return { rule: 'private-network', message: "Points at 10.0.2.2, the Android emulator's alias for the development machine" };
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
    return { rule: 'private-network', message: 'Points at a private network address' };
  }
  return undefined;
}

function looksNonProduction(host: string): boolean {
  const labels = host.split('.');
  const last = labels.length - 1;
  const ccSecondLevel = labels.length >= 3 && (labels[last]?.length ?? 0) === 2 && COUNTRY_SECOND_LEVEL.has(labels[last - 1] ?? '');
  const registrable = labels.length - (ccSecondLevel ? 3 : 2);
  const subdomainHit = labels.slice(0, Math.max(registrable, 0)).some((label) => label.split('-').some((part) => ENV_WORDS.has(part)));
  const nameParts = (labels[registrable] ?? '').split('-');
  return subdomainHit || (nameParts.length > 1 && nameParts.some((part) => STRONG_ENV_WORDS.has(part)));
}

/** Classifies a host as a release problem, or `undefined` when it looks like production. */
export function classifyHost(rawHost: string): HostIssue | undefined {
  const host = normalizeHost(rawHost);
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') {
    return { rule: 'localhost', message: 'Points at localhost: it only works on the developer machine' };
  }
  const ip = privateIpv4(host);
  if (ip || /^\d+(\.\d+){3}$/.test(host)) return ip;
  if (TUNNEL_SUFFIXES.some((s) => isUnder(host, s))) {
    return { rule: 'tunnel', message: 'Points at a temporary tunnel (ngrok, localtunnel, Cloudflare quick tunnel, …)' };
  }
  if (LOCAL_ONLY_TLDS.includes(host.split('.').pop() ?? '')) {
    return { rule: 'local-only-domain', message: 'Points at a local-only domain (.local, .test, .internal, .lan)' };
  }
  if (VENDOR_DOMAINS.some((d) => isUnder(host, d))) return undefined;
  if (looksNonProduction(host)) return { rule: 'non-production', message: 'Points at what looks like a staging or development host' };
  return undefined;
}

/**
 * URLs that frameworks and SDKs put in every release bundle, found by scanning real release builds and the public
 * packages: React Native's dev server default and the Sentry SDK's Spotlight sidecar. Matched as whole URLs, in
 * Hermes and plain JavaScript bundles alike, so an app's own `http://localhost:8081/api` is still reported.
 */
const FRAMEWORK_URLS = new Set(['http://localhost:8081/', 'http://localhost:8969/stream']);

const HOST_FIX ='Make sure release builds use production URLs (check env-based config such as EXPO_PUBLIC_* or app.config.ts). If this host is intended, add it to allowHosts in release-lint.config.json.';

function hostRules(texts: Text[], { allowHosts }: RuleOptions): Finding[] {
  const seen = new Set<string>();
  return texts.flatMap(({ value, location, fromConfig }) => {
    const urls = [...value.matchAll(URL_PATTERN)]
      .map((m) => ({ host: m[1] ?? '', evidence: urlEvidence(m[0]) }))
      .filter(({ evidence }) => fromConfig || !FRAMEWORK_URLS.has(evidence));
    const bare = [...value.matchAll(BARE_HOST_PORT)].map((m) => ({ host: m[1] ?? '', evidence: m[0] }));
    return [...urls, ...bare].flatMap(({ host, evidence }) => {
      const issue = classifyHost(host);
      const key = `${issue?.rule}\0${normalizeHost(host)}\0${location}`;
      if (!issue || isAllowed(host, allowHosts) || seen.has(key)) return [];
      seen.add(key);
      return [{ ruleId: `host/${issue.rule}`, severity: fromConfig ? 'error' : 'warning', message: issue.message, evidence, location, fix: HOST_FIX } satisfies Finding];
    });
  });
}

// ---------------------------------------------------------------- deep links

function deepLinkRules(app: AppModel, { allowHosts }: RuleOptions): Finding[] {
  return app.deepLinks.flatMap(({ host, kind, file }): Finding[] => {
    const evidence = app.platform === 'ios' ? `${kind}:${host}` : `${kind} host ${host}`;
    if (host.startsWith('@')) {
      return [{ ruleId: 'deeplink/unresolved-host', severity: 'info', message: 'Deep link host is a resource reference; release-lint 0.1 cannot resolve it yet', evidence, location: file, fix: 'Check the value of this resource in your release build, or use a literal host.' }];
    }
    const issue = classifyHost(host);
    if (!issue || isAllowed(host, allowHosts)) return [];
    return [
      {
        ruleId: 'deeplink/non-production-host',
        severity: 'error',
        message: `Release build links to a non-production domain. ${issue.message}`,
        evidence,
        location: file,
        fix: 'Release builds must only claim production domains. Check associatedDomains / intentFilters in your app config (often switched by APP_VARIANT or an env var) and the Release entitlements.',
      },
    ];
  });
}

// ---------------------------------------------------------------- network security

const CLEARTEXT_FIX = {
  android: 'Remove this domain from the network security config, or keep it in a debug-only copy (android/app/src/debug/res/xml/). In Expo, check the config plugin that writes the file.',
  ios: 'Remove this host from NSAppTransportSecurity → NSExceptionDomains for release builds (in Expo: ios.infoPlist in app.config). App Review asks for a reason for every exception.',
};
const USER_CA_FIX = 'Move <certificates src="user"/> into <debug-overrides>, which only applies to debuggable builds.';
const BASE_CLEARTEXT_FIX = 'Remove cleartextTrafficPermitted from <base-config>, or allow plain HTTP only for the hosts that need it with a <domain-config>.';

function networkRules(app: AppModel, { allowHosts }: RuleOptions): Finding[] {
  return (app.networkExceptions ?? []).flatMap(({ kind, host, evidence, file, debugOverrides }): Finding[] => {
    const at = { evidence, location: file };
    // <debug-overrides> is harmless in a release build, but a debuggable build (debug/debuggable) turns it on.
    if (debugOverrides && !app.flags.debuggable) return [];
    if (kind === 'user-ca' && debugOverrides) {
      return [{ ruleId: 'debug/user-ca-trusted', severity: 'warning', message: "Trusts user-installed CA certificates, because this build is debuggable and <debug-overrides> applies to it: anyone who adds one to their phone can read the app's HTTPS traffic", ...at, fix: 'Build the release variant without android:debuggable; <debug-overrides> then no longer applies.' }];
    }
    if (kind === 'user-ca') {
      return [{ ruleId: 'debug/user-ca-trusted', severity: 'warning', message: "Trusts user-installed CA certificates: anyone who adds one to their phone can read the app's HTTPS traffic", ...at, fix: USER_CA_FIX }];
    }
    if (host === '*') {
      return [{ ruleId: 'debug/cleartext-traffic', severity: 'warning', message: 'Plain HTTP is allowed to every host', ...at, fix: BASE_CLEARTEXT_FIX }];
    }
    if (isAllowed(host, allowHosts)) return [];
    const issue = classifyHost(host);
    const message = issue ? `Plain HTTP is allowed for a development host. ${issue.message}` : 'Plain HTTP is allowed for this host';
    return [{ ruleId: 'debug/cleartext-exception', severity: 'warning', message, ...at, fix: CLEARTEXT_FIX[app.platform] }];
  });
}

// ---------------------------------------------------------------- over-the-air updates

/** Channel names for testers: the environment words, plus the ones EAS projects use for test builds. */
const TEST_CHANNEL_WORDS = new Set([...ENV_WORDS, 'preview', 'beta', 'internal']);

function updatesRules({ updates }: AppModel): Finding[] {
  if (!updates || !updates.channel.toLowerCase().split(/[^a-z0-9]+/).some((word) => TEST_CHANNEL_WORDS.has(word))) return [];
  return [
    {
      ruleId: 'updates/non-production-channel',
      severity: 'error',
      message: `Store build gets over-the-air updates from the "${updates.channel}" channel: updates meant for testers reach your users, and production fixes never do`,
      evidence: `expo-channel-name: ${updates.channel}`,
      location: updates.file,
      fix: 'Build the store version with your production EAS build profile (eas.json → build.production.channel), or set updates.requestHeaders["expo-channel-name"] for release builds. A build for testers only: --ignore updates/non-production-channel.',
    },
  ];
}

// ---------------------------------------------------------------- release settings

function releaseRules(app: AppModel): Finding[] {
  const { bundle, flags } = app;
  const js = bundle?.kind === 'javascript' ? (bundle.strings[0] ?? '') : '';
  const findings: Finding[] = app.sourceMaps.map((file) => ({
    ruleId: 'sourcemap/file',
    severity: 'warning',
    message: 'Source map shipped inside the app: it gives away your original source code',
    evidence: file,
    location: file,
    fix: 'Keep .map files out of the app and upload them to your crash reporter (Sentry, Bugsnag, …) instead.',
  }));
  const mapUrl = js.match(/\/\/[#@] sourceMappingURL=(\S{1,512})/)?.[1];
  if (bundle && mapUrl) {
    // An inline data: map holds the whole source, so never print it.
    const inline = mapUrl.startsWith('data:');
    findings.push({
      ruleId: 'sourcemap/url',
      severity: 'warning',
      message: inline ? 'The bundle contains an inline source map: your whole original source ships with the app' : 'The bundle points to a source map',
      evidence: inline ? 'sourceMappingURL=data:… (inline)' : `sourceMappingURL=${mapUrl.length > MAX_EVIDENCE ? `${mapUrl.slice(0, MAX_EVIDENCE)}…` : mapUrl}`,
      location: bundle.file,
      fix: 'Build the release bundle without a sourceMappingURL comment.',
    });
  }
  if (bundle && /\b__DEV__\s*=\s*true\b/.test(js)) {
    findings.push({ ruleId: 'debug/dev-bundle', severity: 'error', message: 'Development JavaScript bundle shipped (__DEV__ is true): slow, verbose and full of debug code', evidence: '__DEV__=true', location: bundle.file, fix: 'Bundle in release mode (react-native bundle --dev false, or a Release / production build).' });
  }
  if (flags.debuggable) {
    findings.push(
      app.platform === 'ios'
        ? { ruleId: 'debug/debuggable', severity: 'error', message: 'Development-signed build (get-task-allow): the App Store rejects it', evidence: 'get-task-allow = true', location: 'entitlements', fix: 'Export with an App Store or Ad Hoc distribution profile (for EAS: a production build profile).' }
        : { ruleId: 'debug/debuggable', severity: 'error', message: 'Debuggable build: anyone can attach a debugger and read app data', evidence: 'android:debuggable="true"', location: 'AndroidManifest.xml', fix: 'Build the release variant (./gradlew bundleRelease) and never set android:debuggable in the manifest.' },
    );
  }
  if (flags.simulator) {
    findings.push({ ruleId: 'debug/simulator-build', severity: 'error', message: 'Simulator build: the App Store and TestFlight only accept device builds, so this says little about your release', evidence: 'DTPlatformName = iphonesimulator', location: 'Info.plist', fix: 'Archive for "Any iOS Device" in the Release configuration, export it, and scan the .ipa (or the .xcarchive).' });
  }
  if (app.unexported) {
    findings.push({ ruleId: 'scan/signing-not-checked', severity: 'info', message: 'Signing not checked: Xcode signs the app again when you export it', evidence: 'iOS .app / .xcarchive', location: app.file, fix: 'To check development signing (get-task-allow) too, export the archive (Distribute App) and scan the .ipa.' });
  }
  if (flags.usesCleartextTraffic) {
    findings.push({ ruleId: 'debug/cleartext-traffic', severity: 'warning', message: 'Plain HTTP is allowed to every host', evidence: 'android:usesCleartextTraffic="true"', location: 'AndroidManifest.xml', fix: 'Remove usesCleartextTraffic, or allow HTTP only for specific hosts with a network security config.' });
  }
  if (flags.allowsArbitraryLoads) {
    findings.push({ ruleId: 'debug/arbitrary-loads', severity: 'warning', message: 'App Transport Security is turned off for every host', evidence: 'NSAllowsArbitraryLoads = true', location: 'Info.plist', fix: 'Remove NSAllowsArbitraryLoads, or use NSExceptionDomains for the few hosts that need it. App Review asks for a reason.' });
  }
  for (const problem of app.problems) {
    // An error, not a warning: a part we could not read was not checked, so the scan must not pass silently (fail closed).
    findings.push({ ruleId: 'scan/unreadable', severity: 'error', message: 'Part of the app could not be read, so it was not checked', evidence: problem, location: problem.split(': ')[0] ?? '', fix: 'If this is a normal release build, please open an issue. To accept it anyway: --ignore scan/unreadable.' });
  }
  if (bundle?.approximate) {
    findings.push({ ruleId: 'scan/hermes-approximate', severity: 'info', message: `Unknown Hermes bytecode version ${bundle.hermesVersion}: strings were extracted approximately`, evidence: `Hermes bytecode v${bundle.hermesVersion}`, location: bundle.file, fix: 'Please open an issue with your React Native version so this version gets exact support.' });
  }
  return findings;
}
