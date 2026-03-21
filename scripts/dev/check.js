const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let defaultTypeFlag = null;
try {
    execFileSync(process.execPath, ['--experimental-default-type=module', '-v'], { stdio: 'ignore' });
    defaultTypeFlag = '--experimental-default-type=module';
} catch (e) {
    try {
        execFileSync(process.execPath, ['--default-type=module', '-v'], { stdio: 'ignore' });
        defaultTypeFlag = '--default-type=module';
    } catch (e2) {}
}

const ROOT_DIR = path.join(__dirname, '..', '..');
const TARGETS = [
    'server.js',
    path.join('src', 'config'),
    path.join('src', 'services'),
    path.join('src', 'utils'),
    path.join('public', 'app'),
    'scripts',
];

const filesToCheck = [];
const isFrontEndModule = (filePath) => filePath.includes(`${path.sep}public${path.sep}app${path.sep}`);

const walk = (relativePath) => {
    const absolutePath = path.join(ROOT_DIR, relativePath);
    const stat = fs.statSync(absolutePath);

    if (stat.isFile()) {
        if (absolutePath.endsWith('.js')) filesToCheck.push(absolutePath);
        return;
    }

    for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        walk(path.join(relativePath, entry.name));
    }
};

for (const target of TARGETS) {
    walk(target);
}

for (const filePath of filesToCheck) {
    const args = isFrontEndModule(filePath) && defaultTypeFlag
        ? [defaultTypeFlag, '--check', filePath]
        : ['--check', filePath];
    execFileSync(process.execPath, args, { stdio: 'inherit' });
}

console.log(`Checked ${filesToCheck.length} JavaScript file(s) successfully.`);
