#!/usr/bin/env node
// Bundles the extension into dist/. No framework, no transpile step beyond esbuild.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

const entryPoints = {
  'background/service-worker': 'src/background/service-worker.ts',
  'sidepanel/main': 'src/sidepanel/main.ts',
  'options/options': 'src/options/options.ts',
};

// Content scripts are injected programmatically via chrome.scripting.executeScript,
// so they are bundled as classic IIFE scripts rather than ES modules.
const contentEntryPoints = {
  'content/page-agent': 'src/content/page-agent.ts',
};

async function copyStatic() {
  await cp(resolve(root, 'src/manifest.json'), resolve(outdir, 'manifest.json'));
  await cp(resolve(root, 'src/sidepanel/index.html'), resolve(outdir, 'sidepanel/index.html'));
  await cp(resolve(root, 'src/sidepanel/sidepanel.css'), resolve(outdir, 'sidepanel/sidepanel.css'));
  await cp(resolve(root, 'src/options/index.html'), resolve(outdir, 'options/index.html'));
  await cp(resolve(root, 'src/options/options.css'), resolve(outdir, 'options/options.css'));
  await cp(resolve(root, 'icons'), resolve(outdir, 'icons'), { recursive: true });
}

const shared = {
  bundle: true,
  target: 'chrome120',
  logLevel: 'info',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
};

async function main() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  const configs = [
    { ...shared, entryPoints, outdir, format: 'esm', splitting: false },
    { ...shared, entryPoints: contentEntryPoints, outdir, format: 'iife' },
  ];

  if (watch) {
    for (const config of configs) {
      const ctx = await esbuild.context(config);
      await ctx.watch();
    }
    await copyStatic();
    console.log('watching...');
    return;
  }

  await Promise.all(configs.map((config) => esbuild.build(config)));
  await copyStatic();
  console.log(`built -> ${outdir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
