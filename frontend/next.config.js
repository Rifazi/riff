const path = require('path');
const tiptapPmResolveBase = path.dirname(require.resolve('@tiptap/pm/model'));
const resolveFromTiptapPm = (pkg) =>
  require.resolve(pkg, { paths: [tiptapPmResolveBase] });

// Phone build (`pnpm build:mobile`): the same views, with Tauri's invoke/listen
// swapped for a WebSocket bridge to the Mac (src/lib/remote, src-tauri/src/remote).
const isMobile = process.env.RIFF_MOBILE === '1';
const remote = (file) => path.resolve(__dirname, 'src/lib/remote', file);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // trailingSlash: the bridge serves files as-is, so `/settings` must be `settings/index.html`.
  ...(isMobile ? { distDir: 'out-mobile', trailingSlash: true } : {}),
  // Same sources as the desktop build, whose own type check covers them.
  ...(isMobile ? { typescript: { ignoreBuildErrors: true } } : {}),
  env: { NEXT_PUBLIC_RIFF_MOBILE: isMobile ? '1' : '0' },
  reactStrictMode: false, // Disabled for BlockNote compatibility
  output: 'export',
  images: {
    unoptimized: true,
  },
  // Add basePath configuration
  basePath: '',
  assetPrefix: '/',

  // Add webpack configuration for Tauri
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        os: false,
      };

      if (isMobile) {
        config.resolve.alias = {
          ...config.resolve.alias,
          '@tauri-apps/api/core$': remote('core-shim.ts'),
          '@tauri-apps/api/event$': remote('event-shim.ts'),
          '@tauri-apps/api/app$': remote('app-shim.ts'),
          '@tauri-apps/api/window$': remote('window-shim.ts'),
        };
      }

      // Keep ProseMirror single-instanced for BlockNote/Tiptap.
      config.resolve.alias = {
        ...config.resolve.alias,
        '@blocknote/core$': require.resolve('@blocknote/core'),
        '@blocknote/react$': require.resolve('@blocknote/react'),
        '@blocknote/shadcn$': require.resolve('@blocknote/shadcn'),
        'prosemirror-model': resolveFromTiptapPm('prosemirror-model'),
        'prosemirror-state': resolveFromTiptapPm('prosemirror-state'),
        'prosemirror-view': resolveFromTiptapPm('prosemirror-view'),
        'prosemirror-transform': resolveFromTiptapPm('prosemirror-transform'),
        'prosemirror-tables': resolveFromTiptapPm('prosemirror-tables'),
        'prosemirror-schema-list': resolveFromTiptapPm('prosemirror-schema-list'),
        'prosemirror-keymap': resolveFromTiptapPm('prosemirror-keymap'),
        'prosemirror-commands': resolveFromTiptapPm('prosemirror-commands'),
        'prosemirror-history': resolveFromTiptapPm('prosemirror-history'),
        'prosemirror-inputrules': resolveFromTiptapPm('prosemirror-inputrules'),
        'prosemirror-gapcursor': resolveFromTiptapPm('prosemirror-gapcursor'),
        'prosemirror-dropcursor': resolveFromTiptapPm('prosemirror-dropcursor'),
      };
    }
    return config;
  },
}

module.exports = nextConfig
