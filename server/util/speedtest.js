import { spawn } from 'node:child_process';
import { parseCliOutput } from './providers/cliOutput.js';
import * as interfacesModule from '../util/loadInterfaces.js';
import * as config from '../controller/config.js';
import fs from 'node:fs';
import path from 'node:path';

const CLI_TIMEOUT = 180000;

export default async (mode, serverId, serverUrl) => {
    const binaryPath = mode === "ookla" ? './bin/speedtest' + (process.platform === "win32" ? ".exe" : "")
        : mode === "libre" ? './bin/librespeed-cli' + (process.platform === "win32" ? ".exe" : "")
            : './bin/cfspeedtest' + (process.platform === "win32" ? ".exe" : "");

    if (!interfacesModule.interfaces) throw new Error("No interfaces found");

    const currentInterface = await config.getValue("interface");
    const interfaceIp = interfacesModule.interfaces[currentInterface];

    const startTime = new Date().getTime();
    let args;

    if (mode === "ookla") {
        args = ['--accept-license', '--accept-gdpr', '--format=json'];

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

    testProcess.stdout.on('data', (buffer) => {
        stdout += buffer.toString();
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