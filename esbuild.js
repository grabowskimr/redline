// @ts-check
const esbuild = require('esbuild');

const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');

/** The panel is a webview, so it needs its own copy of the codicon font to show icons. */
function copyCodicons() {
  const from = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');
  const to = path.join(__dirname, 'media');
  for (const file of ['codicon.css', 'codicon.ttf']) {
    fs.copyFileSync(path.join(from, file), path.join(to, file));
  }
}
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').Plugin} */
const problemMatcherPlugin = {
  name: 'problem-matcher',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) console.error(`    ${location.file}:${location.line}:${location.column}:`);
      }
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  copyCodicons();
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'silent',
    plugins: [problemMatcherPlugin],
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
