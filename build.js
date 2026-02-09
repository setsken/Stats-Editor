/**
 * Build script — obfuscates JS files and copies assets to dist/
 * Usage: node build.js
 */

const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

// JS files that need obfuscation (from manifest.json)
const JS_FILES = [
    'background.js',
    'content.js',
    'popup.js',
    'inject-early.js',
    'page-interceptor.js',
    'chart-drawer.js',
];

// Files to copy as-is (no obfuscation needed)
const COPY_FILES = [
    'manifest.json',
    'popup.html',
    'popup.css',
    'content.css',
    'chart.min.js', // already minified library — don't touch
];

// Folders to copy
const COPY_DIRS = [
    'icons',
];

// Obfuscation settings — strong, for files WITHOUT executeScript callbacks
const OBFUSCATION_FULL = {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.4,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.3,
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    selfDefending: false,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
};

// Lighter settings for popup.js — has chrome.scripting.executeScript callbacks
// that Chrome serializes and runs in ISOLATED page context.
//
// ALL of these MUST be disabled for executeScript to work:
//   - stringArray: creates a decoder function that doesn't exist in page context
//   - deadCodeInjection: implicitly forces stringArray=true
//   - controlFlowFlattening: creates wrapper objects OUTSIDE the callback that
//     are referenced INSIDE; Chrome serializes only the callback body, so
//     those outer references become undefined → silent crash
//
// Protection is still provided by hexadecimal identifier names.
const OBFUSCATION_POPUP = {
    compact: true,
    controlFlowFlattening: false,    // MUST be false — creates outer-scope refs inside callbacks
    deadCodeInjection: false,        // MUST be false — forces stringArray=true
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    selfDefending: false,
    stringArray: false,              // MUST be false — decoder doesn't exist in page context
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
};

// Safer profile for inject-early.js — the 330KB core file handling
// chart/preset flow. stringArray is OK (runs in own context), but
// controlFlowFlattening must be low — high threshold breaks complex
// conditional chains (preset fromPreset checks, earningStats loading, etc.)
const OBFUSCATION_INJECT = {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.15,   // very low — preserve logic flow
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.2,
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    renameGlobals: false,
    selfDefending: false,
    stringArray: true,
    stringArrayCallsTransform: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    transformObjectKeys: false,
    unicodeEscapeSequence: false,
};

// Map files to their obfuscation profile
const FILE_OPTIONS = {
    'popup.js': OBFUSCATION_POPUP,       // has executeScript callbacks
    'background.js': OBFUSCATION_POPUP,  // has executeScript callbacks too
    'inject-early.js': OBFUSCATION_INJECT, // core chart/preset logic — needs safe CFG
};

// ——— Helpers ———

function cleanDir(dir) {
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(dir, { recursive: true });
}

function copyFileSync(src, dest) {
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest);
}

function copyDirSync(src, dest) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirSync(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// ——— Build ———

console.log('=== Stats Editor — Obfuscated Build ===\n');

// 1. Clean dist/
console.log('1. Cleaning dist/ ...');
cleanDir(DIST);

// 2. Obfuscate JS files
console.log('2. Obfuscating JS files ...');
for (const file of JS_FILES) {
    const srcPath = path.join(ROOT, file);
    const destPath = path.join(DIST, file);
    if (!fs.existsSync(srcPath)) {
        console.log(`   SKIP (not found): ${file}`);
        continue;
    }
    const code = fs.readFileSync(srcPath, 'utf8');
    const originalSize = Buffer.byteLength(code, 'utf8');

    const obfuscated = JavaScriptObfuscator.obfuscate(code, FILE_OPTIONS[file] || OBFUSCATION_FULL);
    const result = obfuscated.getObfuscatedCode();
    const newSize = Buffer.byteLength(result, 'utf8');

    fs.writeFileSync(destPath, result, 'utf8');
    console.log(`   OK: ${file}  (${(originalSize/1024).toFixed(1)}KB → ${(newSize/1024).toFixed(1)}KB)`);
}

// 3. Copy static files
console.log('3. Copying static files ...');
for (const file of COPY_FILES) {
    const srcPath = path.join(ROOT, file);
    const destPath = path.join(DIST, file);
    if (!fs.existsSync(srcPath)) {
        console.log(`   SKIP (not found): ${file}`);
        continue;
    }
    copyFileSync(srcPath, destPath);
    console.log(`   OK: ${file}`);
}

// 4. Copy directories
console.log('4. Copying directories ...');
for (const dir of COPY_DIRS) {
    const srcPath = path.join(ROOT, dir);
    const destPath = path.join(DIST, dir);
    if (!fs.existsSync(srcPath)) {
        console.log(`   SKIP (not found): ${dir}/`);
        continue;
    }
    copyDirSync(srcPath, destPath);
    console.log(`   OK: ${dir}/`);
}

// 5. Summary
const distFiles = [];
function listFiles(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.isDirectory()) listFiles(path.join(dir, entry.name), rel);
        else distFiles.push(rel);
    }
}
listFiles(DIST, '');

console.log(`\n=== BUILD COMPLETE ===`);
console.log(`Files in dist/: ${distFiles.length}`);
console.log(`\nNext steps:`);
console.log(`  1. Open chrome://extensions`);
console.log(`  2. Enable "Developer mode"`);
console.log(`  3. Click "Pack extension" → select the dist/ folder`);
console.log(`  4. Chrome will create .crx file — send it to the client`);
console.log(`  5. KEEP the .pem file (private key) safe!\n`);
