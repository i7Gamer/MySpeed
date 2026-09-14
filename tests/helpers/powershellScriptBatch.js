import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const POWERSHELL_ARGUMENTS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand"];

export const invokePowerShellScriptBatch = ({powershell, script, requests, timeout}) => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-powershell-batch-"));
    try {
        const requestPath = path.join(temporaryDirectory, "requests.json");
        fs.writeFileSync(requestPath, JSON.stringify(requests), {encoding: "utf8", flag: "wx"});
        const command = `
$ErrorActionPreference='Stop'
$successStatus=0
$failureStatus=1
$jsonDepth=4
$scriptPath='${script.replaceAll("'", "''")}'
$requests=[IO.File]::ReadAllText('${requestPath.replaceAll("'", "''")}',[Text.UTF8Encoding]::new($false))|ConvertFrom-Json
$results=@($requests|ForEach-Object {
  try {
    $output=@(& $scriptPath -Mode ([string]$_.mode) -InputJson ([string]$_.inputJson) 2>&1)
    [pscustomobject]@{status=$successStatus;stdout=($output -join [Environment]::NewLine);stderr=''}
  } catch {
    [pscustomobject]@{status=$failureStatus;stdout='';stderr=$_.Exception.ToString()}
  }
})
ConvertTo-Json -InputObject $results -Depth $jsonDepth -Compress
`;
        const encoded = Buffer.from(command, "utf16le").toString("base64");
        const result = childProcess.spawnSync(powershell, [...POWERSHELL_ARGUMENTS, encoded],
            {encoding: "utf8", timeout});
        if (result.error !== undefined || result.status !== 0) return {result, cases: null};
        return {result, cases: JSON.parse(result.stdout)};
    } finally {
        fs.rmSync(temporaryDirectory, {recursive: true, force: true});
    }
};
