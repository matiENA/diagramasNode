const { spawn, execSync } = require('child_process');
const path = require('path');
const readline = require('readline');

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';
const rootDir = path.resolve(__dirname, '..');

console.log('\x1b[36m%s\x1b[0m', '=====================================================');
console.log('\x1b[36m%s\x1b[0m', '🚀 Iniciando EOR v1 (Backend + Frontend) en simultáneo');
console.log('\x1b[36m%s\x1b[0m', '=====================================================');

function pipeOutput(child, prefix, colorCode) {
    const rlOut = readline.createInterface({ input: child.stdout });
    rlOut.on('line', (line) => {
        console.log(`\x1b[${colorCode}m[${prefix}]\x1b[0m ${line}`);
    });

    const rlErr = readline.createInterface({ input: child.stderr });
    rlErr.on('line', (line) => {
        console.error(`\x1b[${colorCode}m[${prefix}]\x1b[0m \x1b[31m${line}\x1b[0m`);
    });
}

const backend = spawn(npmCmd, ['--prefix', 'apps/backend', 'run', 'dev'], {
    cwd: rootDir,
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: isWin
});
pipeOutput(backend, 'BACKEND', '34'); // Blue

const frontend = spawn(npmCmd, ['--prefix', 'apps/frontend', 'run', 'dev'], {
    cwd: rootDir,
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: isWin
});
pipeOutput(frontend, 'FRONTEND', '32'); // Green

function cleanExit() {
    console.log('\n\x1b[33m%s\x1b[0m', '🛑 Deteniendo servicios...');
    const killTree = (child) => {
        if (!child || !child.pid) return;
        try {
            if (isWin) {
                execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
            } else {
                child.kill('SIGTERM');
            }
        } catch (_) {}
    };

    killTree(backend);
    killTree(frontend);
    process.exit(0);
}

process.on('SIGINT', cleanExit);
process.on('SIGTERM', cleanExit);
process.on('exit', cleanExit);

backend.on('close', (code) => {
    if (code !== 0 && code !== null) {
        console.error(`\x1b[31m[BACKEND] Proceso finalizado con código ${code}\x1b[0m`);
    }
});

frontend.on('close', (code) => {
    if (code !== 0 && code !== null) {
        console.error(`\x1b[31m[FRONTEND] Proceso finalizado con código ${code}\x1b[0m`);
    }
});
