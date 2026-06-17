const path = require('path');
const fs = require('fs');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');

// Tiny .env reader — avoids pulling in `dotenv` just to parse 3 keys.
// Lines beginning with `#` are comments; surrounding quotes are stripped.
function loadDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i === -1) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

const dotenv = loadDotEnv(path.resolve(__dirname, '.env'));
// process.env takes precedence so CI can override without editing the file.
const AZURE_PAT = process.env.AZURE_PAT || dotenv.AZURE_PAT || '';
const AZURE_ORG_URL = process.env.AZURE_ORG_URL || dotenv.AZURE_ORG_URL || '';
const AZURE_PROJECT = process.env.AZURE_PROJECT || dotenv.AZURE_PROJECT || '';

if (!AZURE_PAT || !AZURE_ORG_URL || !AZURE_PROJECT) {
  console.warn(
    '\n[bugscribe] One or more Azure DevOps env vars are missing — the ' +
    '"Create Bug in Azure DevOps" flow will be disabled in this build.\n' +
    '  AZURE_PAT:     ' + (AZURE_PAT ? 'set' : 'MISSING') + '\n' +
    '  AZURE_ORG_URL: ' + (AZURE_ORG_URL || 'MISSING') + '\n' +
    '  AZURE_PROJECT: ' + (AZURE_PROJECT || 'MISSING') + '\n' +
    'See .env.example for the expected format.\n'
  );
}

module.exports = {
  entry: {
    popup: './src/popup.js',
    background: './src/background.js',
    offscreen: './src/offscreen.js',
    permissions: './src/permissions.js',
    content: './src/content.js'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true
  },
  resolve: {
    extensions: ['.js']
  },
  experiments: {
    asyncWebAssembly: true
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env.AZURE_PAT': JSON.stringify(AZURE_PAT),
      'process.env.AZURE_ORG_URL': JSON.stringify(AZURE_ORG_URL),
      'process.env.AZURE_PROJECT': JSON.stringify(AZURE_PROJECT)
    }),
    new CopyPlugin({
      patterns: [
        { from: 'public', to: '.' },
        // Use the ESM build: @ffmpeg/ffmpeg spawns a `type: "module"` worker,
        // so importScripts is unavailable and it falls back to dynamic import().
        {
          from: 'node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js',
          to: 'ffmpeg-core/ffmpeg-core.js'
        },
        {
          from: 'node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm',
          to: 'ffmpeg-core/ffmpeg-core.wasm'
        }
      ]
    })
  ],
  performance: {
    // ffmpeg-core worker bundle is large; silence warnings.
    hints: false
  },
  devtool: 'cheap-source-map'
};
