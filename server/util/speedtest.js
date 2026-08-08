import { spawn } from 'node:child_process';
import { parseCliOutput } from './providers/cliOutput.js';
import { parseProgressLine } from './providers/progress.js';
import * as interfacesModule from '../util/loadInterfaces.js';
import * as config from '../controller/config.js';
import fs from 'node:fs';
import path from 'node:path';

const CLI_TIMEOUT = 180000;

export default async (mode, serverId, serverUrl, onProgress) => {
    const binaryPath = mode === "ookla" ? './bin/speedtest' + (process.platform === "win32" ? ".exe" : "")
        : mode === "libre" ? './bin/librespeed-cli' + (process.platform === "win32" ? ".exe" : "")
            : './bin/cfspeedtest' + (process.platform === "win32" ? ".exe" : "");

    if (!interfacesModule.interfaces) throw new Error("No interfaces found");

    const currentInterface = await config.getValue("interface");
    const interfaceIp = interfacesModule.interfaces[currentInterface];

    const startTime = new Date().getTime();
    let args;

    if (mode === "ookla") {
        // jsonl rather than json: the CLI reports each phase as it goes instead
        // of only the finished result, which is what the interface follows a run
        // with. The final record is the same result either way.
        args = ['--accept-license', '--accept-gdpr', '--format=jsonl'];

        if (process.platform === "win32") {
            args.push('--ip=' + interfaceIp);
        } else {
            args.push('--interface=' + currentInterface);
        }

        if (serverId) args.push(`--server-id=${serverId}`);
    } else if (mode === "libre") {
        args = ['--json', '--duration=5', '--source=' + interfaceIp];
        if (serverUrl) {
            const customServerConfig = [{
                id: 1,
                name: "Custom Server",
                server: serverUrl,
                dlURL: "garbage.php",
                ulURL: "empty.php",
                pingURL: "empty.php",
                getIpURL: "getIP.php"
            }];
            const tempJsonPath = path.join('data', 'servers', 'libre_custom.json');
            fs.writeFileSync(tempJsonPath, JSON.stringify(customServerConfig));
            args.push(`--local-json=${tempJsonPath}`);
            args.push('--server=1');
        } else if (serverId) {
            args.push(`--server=${serverId}`);
        }
    } else if (mode === "cloudflare") {
        args = ['--output-format=json'];

        if (interfaceIp.includes(':')) {
            args.push('--ipv6=' + interfaceIp);
        } else {
            args.push('--ipv4=' + interfaceIp);
        }
    }

    let result;
    let stdout = '';
    let stderr = '';

    // A CLI that accepts the connection and then stalls would hold the run lock
    // for the lifetime of the process, and no scheduled test would ever run
    // again. spawn's own timeout sends SIGTERM and surfaces as an 'error'.
    const testProcess = spawn(binaryPath, args, {windowsHide: true, timeout: CLI_TIMEOUT});

    testProcess.stderr.on('data', (buffer) => {
        // Accumulated, not overwritten: stderr arrives in arbitrary chunks, so
        // keeping only the last one reported whatever fragment happened to
        // land last rather than the actual failure.
        stderr += buffer.toString();
    });

    // Holds the tail of a chunk that ended mid-line: the CLI writes one record
    // per line, but a read can split one anywhere.
    let incomplete = '';

    testProcess.stdout.on('data', (buffer) => {
        const text = buffer.toString();
        stdout += text;

        if (!onProgress) return;

        const lines = (incomplete + text).split('\n');
        incomplete = lines.pop();

        for (const line of lines) {
            const update = parseProgressLine(mode, line.trim());
            if (update) onProgress(update);
        }
    });

    await new Promise((resolve, reject) => {
        // Rejected as-is: wrapping it in {message: e} gave the wrapper a
        // `message` key holding an Error, which the caller then stored verbatim
        // in a string column.
        testProcess.on('error', reject);
        testProcess.on('exit', () => {
            result = parseCliOutput(mode, stdout, stderr);
            resolve();
        });
    });

    if (result.error) throw new Error(result.error);
    return {...result, elapsed: new Date().getTime() - startTime};
}