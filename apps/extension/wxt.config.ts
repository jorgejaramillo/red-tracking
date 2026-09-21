import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
// E2E builds get host permissions for the local fixture server up front so
// chrome.permissions.request() resolves without a prompt.
const e2e = process.env.WXT_E2E === '1';

export default defineConfig({
  srcDir: 'src',
  outDir: process.env.WXT_OUT_DIR ?? (e2e ? '.output-e2e' : '.output'),
  modules: ['@wxt-dev/module-svelte', '@wxt-dev/i18n/module'],
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      // WXT copies the runtime-registered content script's `matches` (<all_urls>)
      // into host_permissions. We request host access at runtime per study
      // instead, so keep only the e2e localhost grants.
      if (e2e) manifest.host_permissions = ['<all_urls>'];
      else delete manifest.host_permissions;
    },
  },
  manifest: {
    ...(e2e ? { host_permissions: ['<all_urls>'] } : {}),
    name: '__MSG_ext_name__',
    description: '__MSG_ext_description__',
    default_locale: 'es',
    minimum_chrome_version: '116',
    permissions: ['offscreen', 'sidePanel', 'storage', 'unlimitedStorage', 'scripting', 'tabs', 'activeTab'],
    optional_host_permissions: ['<all_urls>'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    action: {
      default_title: '__MSG_ext_name__',
    },
    // Keep the extension id stable across dev machines (needed for share links).
    // Generated with: openssl genrsa 2048 | openssl rsa -pubout -outform DER | openssl base64 -A
    // Replace before publishing to the Chrome Web Store.
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
  },
  vite: () => ({
    build: {
      // MediaPipe WASM glue is large; silence the size warning.
      chunkSizeWarningLimit: 2000,
    },
  }),
});
