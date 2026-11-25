import { describe, expect, it } from 'vitest';
import { parseAxml } from '../src/formats/axml.js';
import { readApp } from '../src/formats/app.js';
import { parseProtoXml } from '../src/formats/proto.js';
import { runRules } from '../src/rules.js';
import type { AppModel, NetworkException } from '../src/types.js';
import { aab, androidManifest, apk, axml, ipa, networkSecurityConfig, protoXml, writeTemp } from './helpers/fixtures.js';

const AAB_CONFIG = 'base/res/xml/network_security_config.xml';
/** Release APKs often have shortened resource paths, so the file is found by its root element, not its name. */
const APK_CONFIG = 'res/zq.xml';

const expectedExceptions = (file: string): NetworkException[] => [
  { kind: 'user-ca', host: '*', evidence: '<base-config> trusts <certificates src="user">', file },
  { kind: 'cleartext', host: '10.0.2.2', evidence: '<domain-config cleartextTrafficPermitted="true"> 10.0.2.2', file },
  { kind: 'cleartext', host: 'api.staging.example.com', evidence: '<domain-config cleartextTrafficPermitted="true"> api.staging.example.com', file },
  { kind: 'user-ca', host: '*', evidence: '<debug-overrides> trusts <certificates src="user">', file, debugOverrides: true },
];

describe('XML text nodes', () => {
  it('keeps element text in protobuf XML (.aab)', () => {
    const root = parseProtoXml(protoXml(networkSecurityConfig()));
    expect(root.children[1]?.children.map((d) => d.text)).toEqual(['10.0.2.2', 'api.staging.example.com']);
  });

  it('keeps element text in binary XML (.apk) and reads roots other than <manifest> when asked', () => {
    const buf = axml(networkSecurityConfig());
    expect(() => parseAxml(buf)).toThrow('does not start with <manifest>');
    const root = parseAxml(buf, { root: 'network-security-config' });
    expect(root.children[1]?.children.map((d) => d.text)).toEqual(['10.0.2.2', 'api.staging.example.com']);
  });
});

describe('reading network security settings', () => {
  it('reads the network security config of an .aab, marking what only applies to debuggable builds', async () => {
    const path = await writeTemp('demo.aab', aab({ extra: { [AAB_CONFIG]: protoXml(networkSecurityConfig()) } }));
    expect((await readApp(path)).networkExceptions).toEqual(expectedExceptions(AAB_CONFIG));
  });

  it('finds the config of an .apk under a shortened path, next to layouts and raw text XML', async () => {
    const layout = axml({ name: 'LinearLayout', attrs: [{ name: 'orientation', android: true, value: 'vertical' }] });
    const rawXml = Buffer.from('<?xml version="1.0"?><note>network-security-config is not compiled here</note>');
    const path = await writeTemp('demo.apk', apk({ extra: { [APK_CONFIG]: axml(networkSecurityConfig()), 'res/a1.xml': layout, 'res/b2.xml': rawXml } }));
    const model = await readApp(path);
    expect(model.networkExceptions).toEqual(expectedExceptions(APK_CONFIG));
    expect(model.problems).toEqual([]);
  });

  it('follows cleartextTrafficPermitted into nested domain-configs, and reads a whole-app base-config', async () => {
    const config = {
      name: 'network-security-config',
      children: [
        { name: 'base-config', attrs: [{ name: 'cleartextTrafficPermitted', bool: true }] },
        {
          name: 'domain-config',
          attrs: [{ name: 'cleartextTrafficPermitted', bool: true }],
          children: [
            { name: 'domain', text: ' dev.example.com ' },
            { name: 'domain-config', attrs: [{ name: 'cleartextTrafficPermitted', bool: false }], children: [{ name: 'domain', text: 'secure.dev.example.com' }] },
            { name: 'domain-config', children: [{ name: 'domain', text: 'inherits.dev.example.com' }] },
          ],
        },
      ],
    };
    const path = await writeTemp('demo.aab', aab({ extra: { [AAB_CONFIG]: protoXml(config) } }));
    expect((await readApp(path)).networkExceptions?.map((e) => [e.kind, e.host])).toEqual([
      ['cleartext', '*'],
      ['cleartext', 'dev.example.com'],
      ['cleartext', 'inherits.dev.example.com'],
    ]);
  });

  it('reads a config larger than 8 MiB with 65k+ hosts, as BlueWallet ships one', async () => {
    // Like BlueWallet's: short LAN addresses in an aapt2-style UTF-16 pool; the size comes from per-element overhead.
    const hosts = Array.from({ length: 70_000 }, (_, i) => `192.168.${i >> 8}.${i & 255}.example`);
    const big = axml(networkSecurityConfig(hosts));
    expect(big.length).toBeGreaterThan(8 * 1024 * 1024);
    const model = await readApp(await writeTemp('big.apk', apk({ extra: { [APK_CONFIG]: big } })));
    expect(model.problems).toEqual([]);
    expect(model.networkExceptions?.filter((e) => e.kind === 'cleartext')).toHaveLength(hosts.length);
  });

  it('reports an XML resource too large to check instead of skipping it silently', async () => {
    const huge = Buffer.concat([Buffer.from('network-security-config'), Buffer.alloc(33 * 1024 * 1024)]);
    const model = await readApp(await writeTemp('huge.apk', apk({ extra: { 'res/zz.xml': huge } })));
    expect(model.problems).toEqual([expect.stringMatching(/^res\/zz\.xml: .*larger than/)]);
  });

  it('records whether the manifest names a network security config, and the minimum SDK', async () => {
    const manifest = (minSdk: string) => ({
      ...androidManifest([{ name: 'networkSecurityConfig', android: true, refId: 0x7f140008 }]),
      children: [
        { name: 'uses-sdk', attrs: [{ name: 'minSdkVersion', android: true, value: minSdk }] },
        { name: 'application', attrs: [{ name: 'networkSecurityConfig', android: true, refId: 0x7f140008 }] },
      ],
    });
    const fromApk = await readApp(await writeTemp('m.apk', apk({ manifest: manifest('24') })));
    expect([fromApk.flags.networkSecurityConfig, fromApk.minSdk]).toEqual([true, 24]);
    const fromAab = await readApp(await writeTemp('m.aab', aab({ manifest: manifest('21') })));
    expect([fromAab.flags.networkSecurityConfig, fromAab.minSdk]).toEqual([true, 21]);
    const plain = await readApp(await writeTemp('p.apk', apk()));
    expect([plain.flags.networkSecurityConfig, plain.minSdk]).toEqual([undefined, undefined]);
  });

  it('reports a broken config instead of skipping it', async () => {
    const broken = Buffer.concat([axml(networkSecurityConfig()).subarray(0, 60), Buffer.from('network-security-config')]);
    const model = await readApp(await writeTemp('demo.apk', apk({ extra: { [APK_CONFIG]: broken } })));
    expect(model.problems).toEqual([expect.stringContaining(`${APK_CONFIG}: `)]);
  });

  it('reads NSExceptionDomains that allow plain HTTP from the iOS Info.plist', async () => {
    const info = {
      NSAppTransportSecurity: {
        NSAllowsLocalNetworking: true,
        NSExceptionDomains: {
          '192.168.1.20': { NSExceptionAllowsInsecureHTTPLoads: true },
          'cdn.example.com': { NSIncludesSubdomains: true },
          'legacy.example.com': { NSTemporaryExceptionAllowsInsecureHTTPLoads: true },
        },
      },
    };
    const model = await readApp(await writeTemp('demo.ipa', ipa({ info })));
    const file = 'Payload/Demo.app/Info.plist';
    expect(model.networkExceptions).toEqual([
      { kind: 'cleartext', host: '192.168.1.20', evidence: 'NSExceptionDomains → 192.168.1.20: NSExceptionAllowsInsecureHTTPLoads = true', file },
      { kind: 'cleartext', host: 'legacy.example.com', evidence: 'NSExceptionDomains → legacy.example.com: NSTemporaryExceptionAllowsInsecureHTTPLoads = true', file },
    ]);
  });

  it('leaves the model unchanged for apps without exceptions', async () => {
    expect(await readApp(await writeTemp('demo.aab', aab({ manifest: androidManifest() })))).not.toHaveProperty('networkExceptions');
    expect(await readApp(await writeTemp('demo.ipa', ipa()))).not.toHaveProperty('networkExceptions');
  });
});

describe('android:usesCleartextTraffic', () => {
  const app = (flags: AppModel['flags'], minSdk?: number): AppModel => ({
    platform: 'android', file: 'demo.apk', appId: 'com.example.demo', version: '1.0.0', build: '1',
    flags: { usesCleartextTraffic: true, ...flags }, deepLinks: [], sourceMaps: [], problems: [], ...(minSdk === undefined ? {} : { minSdk }),
  });
  const cleartext = (model: AppModel) => runRules(model, { allowHosts: [] }).filter((f) => f.ruleId === 'debug/cleartext-traffic');

  it('is reported when the app has no network security config', () => {
    expect(cleartext(app({}, 24)).map((f) => f.message)).toEqual(['Plain HTTP is allowed to every host']);
  });

  it('is ignored by Android 7+ when a network security config exists, so it is not reported for minSdk 24 and up', () => {
    expect(cleartext(app({ networkSecurityConfig: true }, 24))).toEqual([]);
  });

  it('still applies on Android 6 and older when minSdk is below 24 (or unknown)', () => {
    for (const minSdk of [23, undefined]) {
      expect(cleartext(app({ networkSecurityConfig: true }, minSdk)).map((f) => f.message)).toEqual([
        'Plain HTTP is allowed to every host on Android 6 and older (Android 7+ follows the network security config instead)',
      ]);
    }
  });
});

describe('network security rules', () => {
  const app = (platform: 'ios' | 'android', networkExceptions: NetworkException[]): AppModel => ({
    platform,
    file: 'demo',
    appId: 'com.example.demo',
    version: '1.0.0',
    build: '1',
    flags: {},
    deepLinks: [],
    sourceMaps: [],
    problems: [],
    networkExceptions,
  });

  it('reports user CAs and plain HTTP per host, naming dev hosts', () => {
    const findings = runRules(app('android', expectedExceptions(AAB_CONFIG)), { allowHosts: [] });
    expect(findings.map((f) => [f.ruleId, f.severity, f.message])).toEqual([
      ['debug/user-ca-trusted', 'warning', "Trusts user-installed CA certificates: anyone who adds one to their phone can read the app's HTTPS traffic"],
      ['debug/cleartext-exception', 'warning', "Plain HTTP is allowed for a development host. Points at 10.0.2.2, the Android emulator's alias for the development machine"],
      ['debug/cleartext-exception', 'warning', 'Plain HTTP is allowed for a development host. Points at what looks like a staging or development host'],
    ]);
    expect(findings.every((f) => f.location === AAB_CONFIG && f.fix.length > 0)).toBe(true);
  });

  it('reports debug-overrides only when the build is debuggable, which turns them on', () => {
    const exceptions = expectedExceptions(AAB_CONFIG).filter((e) => e.debugOverrides);
    expect(runRules(app('android', exceptions), { allowHosts: [] })).toEqual([]);
    const debuggable = { ...app('android', exceptions), flags: { debuggable: true } };
    const findings = runRules(debuggable, { allowHosts: [] });
    expect(findings.map((f) => [f.ruleId, f.severity])).toEqual([
      ['debug/debuggable', 'error'],
      ['debug/user-ca-trusted', 'warning'],
    ]);
    expect(findings[1]?.message).toContain('this build is debuggable');
    expect(findings[1]?.evidence).toBe('<debug-overrides> trusts <certificates src="user">');
  });

  it('skips certificate revocation hosts (CRL and OCSP use plain HTTP by design)', () => {
    const file = AAB_CONFIG;
    const hosts = ['c.lencr.org', 'o.pki.goog', 'ocsp.sectigo.com', 'crl.certum.pl', 'legacy.example.com'];
    const findings = runRules(app('android', hosts.map((host) => ({ kind: 'cleartext', host, evidence: host, file }))), { allowHosts: [] });
    expect(findings.map((f) => f.evidence)).toEqual(['legacy.example.com']);
  });

  it('sums up a long host list in one finding, development hosts first', () => {
    const hosts = [...Array.from({ length: 48 }, (_, i) => `site${i}.example.com`), 'localhost', '10.0.2.2'];
    const exceptions = hosts.map((host): NetworkException => ({ kind: 'cleartext', host, evidence: `<domain> ${host}`, file: AAB_CONFIG }));
    const findings = runRules(app('android', exceptions), { allowHosts: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: 'debug/cleartext-exception', severity: 'warning', location: AAB_CONFIG });
    expect(findings[0]?.message).toBe('Plain HTTP is allowed for 50 hosts, 2 of them local or development hosts');
    expect(findings[0]?.evidence).toMatch(/^localhost, 10\.0\.2\.2, site0\.example\.com, .* \(\+45 more\)$/);
  });

  it('reports a production host neutrally, skips allowHosts, and maps a whole-app exception to debug/cleartext-traffic', () => {
    const file = 'Payload/Demo.app/Info.plist';
    const findings = runRules(
      app('ios', [
        { kind: 'cleartext', host: 'legacy.example.com', evidence: 'e1', file },
        { kind: 'cleartext', host: '10.0.2.2', evidence: 'e2', file },
        { kind: 'cleartext', host: '*', evidence: 'e3', file },
      ]),
      { allowHosts: ['10.0.2.2'] },
    );
    expect(findings.map((f) => [f.ruleId, f.message, f.evidence])).toEqual([
      ['debug/cleartext-exception', 'Plain HTTP is allowed for this host', 'e1'],
      ['debug/cleartext-traffic', 'Plain HTTP is allowed to every host', 'e3'],
    ]);
    expect(findings[0]?.fix).toContain('NSExceptionDomains');
  });
});
