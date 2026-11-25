import { describe, expect, it } from 'vitest';
import { runRules } from '../src/rules.js';
import type { AppModel, Finding } from '../src/types.js';

// Fake secrets are assembled at runtime so no file contains a complete key pattern.
const STRIPE_LIVE = 'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7dc';
const STRIPE_TEST = 'sk_' + 'test_' + '4eC39HqLyjWDarjtT1zdp7dc';
const STRIPE_PUBLISHABLE = 'pk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7dc';
const GOOGLE_KEY = 'AI' + 'za' + 'SyD-0123456789abcdefghijklmnopqrstu';
const AWS_KEY = 'AK' + 'IA' + 'IOSFODNN7EXAMPLE';
const OPENAI_KEY = 'sk-' + 'proj-' + 'abcdefghijklmnopqrstuvwxyz0123456789';
const PEM = '-----BEGIN ' + 'RSA PRIVATE KEY-----\n' + 'MIIEowIBAAKCAQEA'.repeat(4) + '\n' + 'w'.repeat(64) + '\n-----END RSA PRIVATE KEY-----';
const jwt = (payload: object) =>
  ['{"alg":"HS256","typ":"JWT"}', JSON.stringify(payload)].map((part) => Buffer.from(part).toString('base64url')).join('.') + '.' + 'x'.repeat(43);

const app = (fields: Partial<AppModel> = {}): AppModel => ({
  platform: 'ios',
  file: 'demo.ipa',
  appId: 'com.example.demo',
  version: '1.4.0',
  build: '42',
  flags: {},
  deepLinks: [],
  sourceMaps: [],
  problems: [],
  ...fields,
});
const BUNDLE = 'Payload/Demo.app/main.jsbundle';
const withBundle = (...strings: string[]) => app({ bundle: { file: BUNDLE, kind: 'hermes', hermesVersion: 98, approximate: false, strings } });
const run = (model: AppModel, allowHosts: string[] = []) => runRules(model, { allowHosts });
const ids = (findings: Finding[]) => findings.map((f) => f.ruleId);

describe('runRules', () => {
  it('finds nothing in a clean app', () => {
    expect(run(withBundle('https://api.example.com/v1', 'Hello', 'react-native'))).toEqual([]);
  });

  it('sorts errors before warnings before info', () => {
    const findings = run(withBundle(GOOGLE_KEY, 'http://localhost:3000', STRIPE_LIVE));
    expect(findings.map((f) => f.severity)).toEqual(['error', 'warning', 'info']);
  });
});

describe('secret rules', () => {
  it('reports a live Stripe secret key as an error and masks it', () => {
    const [finding] = run(withBundle(`const key = "${STRIPE_LIVE}";`));
    expect(finding).toMatchObject({ ruleId: 'secret/stripe-secret-key', severity: 'error', location: BUNDLE });
    expect(finding?.evidence).not.toContain(STRIPE_LIVE);
    expect(finding?.evidence).toMatch(/^sk_live_.*7dc$/);
  });

  it('reports each secret once even when it appears many times', () => {
    expect(run(withBundle(STRIPE_LIVE, STRIPE_LIVE, `x${STRIPE_LIVE}`))).toHaveLength(1);
  });

  it('reports a Stripe test secret key as a warning', () => {
    expect(run(withBundle(STRIPE_TEST))).toMatchObject([{ ruleId: 'secret/stripe-test-secret-key', severity: 'warning' }]);
  });

  it('reports AWS keys, private keys and OpenAI keys as errors', () => {
    expect(ids(run(withBundle(AWS_KEY, PEM, OPENAI_KEY))).sort()).toEqual(['secret/aws-access-key', 'secret/openai-api-key', 'secret/private-key']);
  });

  it('never reports keys that are public by design', () => {
    expect(run(withBundle(STRIPE_PUBLISHABLE, jwt({ role: 'anon', iss: 'supabase' })))).toEqual([]);
  });

  it('notes a Google API key as info only', () => {
    expect(run(withBundle(GOOGLE_KEY))).toMatchObject([{ ruleId: 'secret/google-api-key', severity: 'info' }]);
  });

  it('reports a Supabase service_role key', () => {
    expect(run(withBundle(jwt({ role: 'service_role', iss: 'supabase' })))).toMatchObject([{ ruleId: 'secret/supabase-service-role', severity: 'error' }]);
  });

  it('finds secrets in the Expo config and names the config path', () => {
    const model = app({ expoConfig: { file: 'app.config', value: { name: 'Demo', extra: { payments: { stripeKey: STRIPE_LIVE } } } } });
    expect(run(model)).toMatchObject([{ ruleId: 'secret/stripe-secret-key', location: 'app.config (extra.payments.stripeKey)' }]);
  });
});

describe('host rules', () => {
  it('flags localhost, private addresses, the emulator alias and tunnels in the bundle as warnings', () => {
    const findings = run(
      withBundle('http://localhost:3000/api', 'http://192.168.1.20:3000/api', 'http://10.0.2.2:8080', 'https://ab12.ngrok-free.app/hook', 'ws://127.0.0.1:8081'),
    );
    expect(findings.map((f) => [f.ruleId, f.severity, f.evidence])).toEqual([
      ['host/localhost', 'warning', 'http://localhost:3000/api'],
      ['host/private-network', 'warning', 'http://192.168.1.20:3000/api'],
      ['host/private-network', 'warning', 'http://10.0.2.2:8080'],
      ['host/tunnel', 'warning', 'https://ab12.ngrok-free.app/hook'],
      ['host/localhost', 'warning', 'ws://127.0.0.1:8081'],
    ]);
    expect(findings[2]?.message).toMatch(/emulator/);
  });

  it("ignores React Native's built-in dev server default, found in every release bundle", () => {
    expect(run(withBundle('http://localhost:8081/', 'localhost'))).toEqual([]);
    expect(ids(run(withBundle('http://localhost:8081/api')))).toEqual(['host/localhost']);
  });

  it("ignores the Sentry SDK's built-in Spotlight URL and Sentry's own domains", () => {
    expect(run(withBundle('http://localhost:8969/stream', 'https://develop.sentry.dev/sdk/expected-features/#feature-flags', 'https://o1.ingest.sentry.io/api/1/'))).toEqual([]);
    expect(ids(run(withBundle('http://localhost:8969/api')))).toEqual(['host/localhost']);
  });

  it("ignores axios's URL-parsing base, found in every bundle that uses axios, but not longer localhost URLs", () => {
    expect(run(withBundle('http://localhost', 'localhost'))).toEqual([]);
    const js = "var origin=n&&window.location.href||'http://localhost';";
    expect(run(app({ bundle: { file: BUNDLE, kind: 'javascript', approximate: false, strings: [js] } }))).toEqual([]);
    for (const url of ['http://localhost/', 'http://localhost/api', 'http://localhost:3000', 'https://localhost']) {
      expect(ids(run(withBundle(url)))).toEqual(['host/localhost']);
    }
  });

  it('still reports a bare http://localhost set in the app config', () => {
    const model = app({ expoConfig: { file: 'app.config', value: { extra: { apiUrl: 'http://localhost' } } } });
    expect(run(model)).toMatchObject([{ ruleId: 'host/localhost', severity: 'error', evidence: 'http://localhost' }]);
  });

  it('ignores framework URLs inside a plain JavaScript bundle too, but not the app’s own URLs next to them', () => {
    const js = 'var a="http://localhost:8081/",b="http://localhost:8969/stream",c="http://localhost:3000/api";';
    const model = app({ bundle: { file: BUNDLE, kind: 'javascript', approximate: false, strings: [js] } });
    expect(run(model).map((f) => f.evidence)).toEqual(['http://localhost:3000/api']);
  });

  it('flags a bare host:port', () => {
    expect(ids(run(withBundle('localhost:8081')))).toEqual(['host/localhost']);
  });

  it('does not treat version numbers as addresses', () => {
    expect(run(withBundle('10.0.0.1', 'v192.168.1.1', 'Version 10.0.2.2 released'))).toEqual([]);
  });

  it('flags staging and dev hosts', () => {
    const hosts = ['https://api.staging.example.com', 'https://staging-api.example.com', 'https://dev.api.example.com', 'https://myapp-staging.com', 'https://uat.example.co.uk/x'];
    expect(ids(run(withBundle(...hosts)))).toEqual(Array(hosts.length).fill('host/non-production'));
  });

  it('does not flag production hosts that only look similar', () => {
    expect(run(withBundle('https://dev.to/post', 'https://developer.apple.com', 'https://www.testflight.apple.com', 'https://devices.example.com', 'https://latest.example.com'))).toEqual([]);
  });

  it('does not flag sandbox hosts of payment and platform SDKs', () => {
    expect(run(withBundle('https://sandbox.itunes.apple.com/verifyReceipt', 'https://api.sandbox.paypal.com', 'https://sandbox.plaid.com'))).toEqual([]);
  });

  it('flags local-only domains', () => {
    expect(ids(run(withBundle('http://myapp.local:3000', 'https://api.myapp.test')))).toEqual(['host/local-only-domain', 'host/local-only-domain']);
  });

  it('treats a non-production host in the Expo config as an error', () => {
    const model = app({ expoConfig: { file: 'app.config', value: { extra: { apiUrl: 'https://api.staging.example.com' } } } });
    expect(run(model)).toMatchObject([{ ruleId: 'host/non-production', severity: 'error', location: 'app.config (extra.apiUrl)' }]);
  });

  it('skips allowed hosts, exact or by suffix', () => {
    const model = withBundle('https://api.staging.example.com', 'https://cdn.dev.example.org');
    expect(run(model, ['api.staging.example.com', '*.example.org'])).toEqual([]);
  });
});

describe('review regressions', () => {
  it('stays fast on hostile strings built to make the patterns backtrack', () => {
    const hostile = ['http://["', '-eyJ', 'sk-proj-', 'xoxb-', 'http://a'].map((unit) => unit.repeat(40_000));
    const start = performance.now();
    run(withBundle(...hostile));
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it('finds the real host behind userinfo and keeps tokens out of the evidence', () => {
    expect(run(withBundle('http://user:pw@staging.example.com/cb?token=abc#frag'))).toMatchObject([
      { ruleId: 'host/non-production', evidence: 'http://staging.example.com/cb' },
    ]);
  });

  it('shortens long URL evidence', () => {
    const [finding] = run(withBundle(`http://localhost:3000/${'a'.repeat(500)}`));
    expect(finding?.evidence.length).toBeLessThanOrEqual(121);
  });

  it('never prints an inline source map', () => {
    const model = app({ bundle: { file: BUNDLE, kind: 'javascript', approximate: false, strings: [`x();\n//# sourceMappingURL=data:application/json;base64,${'A'.repeat(400)}`] } });
    expect(run(model)).toMatchObject([{ ruleId: 'sourcemap/url', evidence: 'sourceMappingURL=data:… (inline)' }]);
  });

  it('finds keys that end in a dash', () => {
    expect(ids(run(withBundle(`${GOOGLE_KEY.slice(0, -1)}-`)))).toEqual(['secret/google-api-key']);
  });
});

describe('deep link rules', () => {
  it('reports a staging domain in iOS associated domains as an error', () => {
    const model = app({ deepLinks: [{ host: 'staging.example.com', kind: 'applinks', file: 'Payload/Demo.app/Demo' }] });
    expect(run(model)).toMatchObject([
      { ruleId: 'deeplink/non-production-host', severity: 'error', evidence: 'applinks:staging.example.com', location: 'Payload/Demo.app/Demo' },
    ]);
  });

  it('reports a localhost App Links host on Android', () => {
    const model = app({ platform: 'android', deepLinks: [{ host: 'localhost', kind: 'app-link', file: 'base/manifest/AndroidManifest.xml' }] });
    expect(run(model)).toMatchObject([{ ruleId: 'deeplink/non-production-host', evidence: 'app-link host localhost' }]);
  });

  it('accepts production and wildcard production domains', () => {
    const file = 'Payload/Demo.app/Demo';
    expect(run(app({ deepLinks: [{ host: 'example.com', kind: 'applinks', file }, { host: '*.example.com', kind: 'applinks', file }] }))).toEqual([]);
  });

  it('notes a host that is an unresolved resource reference', () => {
    const model = app({ deepLinks: [{ host: '@0x7f120001', kind: 'app-link', file: 'base/manifest/AndroidManifest.xml' }] });
    expect(run(model)).toMatchObject([{ ruleId: 'deeplink/unresolved-host', severity: 'info' }]);
  });

  it('respects allowHosts', () => {
    const model = app({ deepLinks: [{ host: 'staging.example.com', kind: 'applinks', file: 'x' }] });
    expect(run(model, ['staging.example.com'])).toEqual([]);
  });
});

describe('release rules', () => {
  it('reports shipped source map files and a sourceMappingURL', () => {
    const model = app({
      sourceMaps: ['Payload/Demo.app/main.jsbundle.map'],
      bundle: { file: BUNDLE, kind: 'javascript', approximate: false, strings: ['x();\n//# sourceMappingURL=main.jsbundle.map'] },
    });
    expect(ids(run(model))).toEqual(['sourcemap/file', 'sourcemap/url']);
  });

  it('reports a development JavaScript bundle', () => {
    const dev = app({ bundle: { file: BUNDLE, kind: 'javascript', approximate: false, strings: ['var __DEV__=true,__BUNDLE_START_TIME__=1;'] } });
    const prod = app({ bundle: { file: BUNDLE, kind: 'javascript', approximate: false, strings: ['var __DEV__=false,__BUNDLE_START_TIME__=1;'] } });
    expect(ids(run(dev))).toEqual(['debug/dev-bundle']);
    expect(run(prod)).toEqual([]);
  });

  it('reports debuggable builds per platform', () => {
    expect(run(app({ flags: { debuggable: true } }))).toMatchObject([{ ruleId: 'debug/debuggable', severity: 'error', evidence: 'get-task-allow = true' }]);
    expect(run(app({ platform: 'android', flags: { debuggable: true } }))).toMatchObject([{ evidence: 'android:debuggable="true"' }]);
    expect(run(app({ flags: { debuggable: false } }))).toEqual([]);
  });

  it('reports cleartext traffic and disabled App Transport Security as warnings', () => {
    expect(run(app({ flags: { usesCleartextTraffic: true, allowsArbitraryLoads: true } })).map((f) => [f.ruleId, f.severity])).toEqual([
      ['debug/cleartext-traffic', 'warning'],
      ['debug/arbitrary-loads', 'warning'],
    ]);
  });

  it('reports unreadable parts and approximate Hermes strings', () => {
    const model = app({
      problems: ['Payload/Demo.app/Demo: The app executable is truncated'],
      bundle: { file: BUNDLE, kind: 'hermes', hermesVersion: 120, approximate: true, strings: [] },
    });
    expect(run(model).map((f) => [f.ruleId, f.severity])).toEqual([
      ['scan/unreadable', 'error'],
      ['scan/hermes-approximate', 'info'],
    ]);
  });
});
