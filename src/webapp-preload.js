// Keep site content isolated from Electron and expose no application APIs.
// WhatsApp checks User-Agent Client Hints in the page itself as well as on
// network requests. Provide a Chrome-shaped value only for WhatsApp domains.
const { webFrame } = require('electron');

const chromeVersion = process.versions.chrome || '100.0.0.0';
const chromeMajor = chromeVersion.split('.')[0];
const brands = [
  { brand: 'Chromium', version: chromeMajor },
  { brand: 'Not_A Brand', version: '24' },
  { brand: 'Google Chrome', version: chromeMajor }
];
const fullVersionList = [
  { brand: 'Chromium', version: chromeVersion },
  { brand: 'Not_A Brand', version: '24.0.0.0' },
  { brand: 'Google Chrome', version: chromeVersion }
];

const script = `(() => {
  if (!/(^|\\.)whatsapp\\.(com|net)$/i.test(location.hostname)) return;
  const brands = ${JSON.stringify(brands)};
  const fullVersionList = ${JSON.stringify(fullVersionList)};
  const values = {
    architecture: 'x86', bitness: '64', brands, mobile: false, model: '',
    platform: 'Linux', platformVersion: '', uaFullVersion: ${JSON.stringify(chromeVersion)},
    fullVersionList, wow64: false
  };
  const userAgentData = {
    brands, mobile: false, platform: 'Linux',
    getHighEntropyValues: async (hints = []) => {
      const result = { brands, mobile: false, platform: 'Linux' };
      for (const hint of hints) if (hint in values) result[hint] = values[hint];
      return result;
    },
    toJSON: () => ({ brands, mobile: false, platform: 'Linux' })
  };
  try {
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      configurable: true, get: () => userAgentData
    });
  } catch {}
})();`;

// World 0 is the page's main JavaScript world. Inject before remote page
// scripts run; the preload remains context-isolated and grants no Node access.
webFrame.executeJavaScriptInIsolatedWorld(0, [{ code: script }]).catch((error) => {
  console.warn('Could not apply WhatsApp browser compatibility:', error.message);
});
