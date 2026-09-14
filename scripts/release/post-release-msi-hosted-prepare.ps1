[CmdletBinding()]
param(
    [ValidateSet('Initialize','Download','Observe','ExtractZipMember','InspectMsi')]
    [string]$Mode,
    [string]$InputJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$MaximumJsonBytes = 65536
$MaximumRedirects = 5

function Read-Request {
    if ([string]::IsNullOrEmpty($InputJson) -or [Text.Encoding]::UTF8.GetByteCount($InputJson) -gt $MaximumJsonBytes) {
        throw 'Hosted preparation input differs'
    }
    return $InputJson | ConvertFrom-Json -ErrorAction Stop
}

function Write-Result($Value) {
    $Value | ConvertTo-Json -Compress -Depth 5
}

function Assert-FilePath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathFullyQualified($Value)) {
        throw 'Hosted preparation path differs'
    }
    return [IO.Path]::GetFullPath($Value)
}

function Get-Identity([string]$FilePath, [long]$MaximumBytes) {
    $full = Assert-FilePath $FilePath
    $item = Get-Item -LiteralPath $full -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $item.Length -lt 1 -or $item.Length -gt $MaximumBytes) { throw 'Hosted preparation file differs' }
    return [ordered]@{path=$full;bytes=[long]$item.Length;
        sha256=(Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()}
}

$request = Read-Request
switch ($Mode) {
    'Initialize' {
        $root = Assert-FilePath ([string]$request.root)
        if (Test-Path -LiteralPath $root) { throw 'Hosted preparation root collision' }
        [void](New-Item -ItemType Directory -Path $root -ErrorAction Stop)
        Write-Result ([ordered]@{})
    }
    'Download' {
        $destination = Assert-FilePath ([string]$request.path)
        $maximum = [long]$request.maximumBytes
        if ($maximum -lt 1) { throw 'Hosted preparation download bound differs' }
        $uri = [Uri]$request.url
        if ($uri.Scheme -cne 'https') { throw 'Hosted preparation URL differs' }
        if (Test-Path -LiteralPath $destination) { throw 'Hosted preparation download collision' }
        $client = [Net.Http.HttpClient]::new([Net.Http.HttpClientHandler]@{MaxAutomaticRedirections=$MaximumRedirects})
        $response = $null; $input = $null; $output = $null; $created = $false
        try {
            $response = $client.GetAsync($uri, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
            [void]$response.EnsureSuccessStatusCode()
            if ($response.RequestMessage.RequestUri.Scheme -cne 'https') {
                throw 'Hosted preparation redirect scheme differs'
            }
            if ($response.Content.Headers.ContentLength -and $response.Content.Headers.ContentLength -gt $maximum) {
                throw 'Hosted preparation response exceeds its bound'
            }
            $input = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            $output = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
                [IO.FileShare]::None)
            $created = $true
            $buffer = [byte[]]::new(1048576); [long]$total = 0
            while (($count = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $total += $count
                if ($total -gt $maximum) { throw 'Hosted preparation download exceeds its bound' }
                $output.Write($buffer, 0, $count)
            }
            $output.Flush($true)
        } catch {
            if ($output) { $output.Dispose(); $output = $null }
            if ($created -and (Test-Path -LiteralPath $destination)) {
                Remove-Item -LiteralPath $destination -Force
            }
            throw
        } finally {
            if ($output) { $output.Dispose() }; if ($input) { $input.Dispose() }
            if ($response) { $response.Dispose() }; $client.Dispose()
        }
        Write-Result ([ordered]@{})
    }
    'Observe' {
        Write-Result (Get-Identity ([string]$request.path) ([long]$request.maximumBytes))
    }
    'ExtractZipMember' {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $archive = Assert-FilePath ([string]$request.archivePath)
        $destination = Assert-FilePath ([string]$request.destinationPath)
        if (Test-Path -LiteralPath $destination) { throw 'Hosted preparation extraction collision' }
        $zip = [IO.Compression.ZipFile]::OpenRead($archive); $created = $false
        try {
            $entries = @($zip.Entries | Where-Object FullName -CEQ ([string]$request.member))
            if ($entries.Count -ne 1 -or $entries[0].Length -lt 1 -or
                $entries[0].Length -gt [long]$request.maximumBytes) { throw 'Hosted preparation ZIP member differs' }
            [void](New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -ErrorAction Stop)
            $source = $entries[0].Open(); $target = $null
            try {
                $target = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write,
                    [IO.FileShare]::None); $created = $true
                $buffer = [byte[]]::new(1048576); [long]$total = 0
                while (($count = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $total += $count
                    if ($total -gt [long]$request.maximumBytes) {
                        throw 'Hosted preparation ZIP member exceeds its bound'
                    }
                    $target.Write($buffer, 0, $count)
                }
                if ($total -ne $entries[0].Length) { throw 'Hosted preparation ZIP member length differs' }
                $target.Flush($true)
            } finally { if ($target) { $target.Dispose() }; $source.Dispose() }
        } catch {
            if ($created -and (Test-Path -LiteralPath $destination)) {
                Remove-Item -LiteralPath $destination -Force
            }
            throw
        } finally { $zip.Dispose() }
        Write-Result ([ordered]@{})
    }
    'InspectMsi' {
        $msi = Assert-FilePath ([string]$request.path)
        $expected = @('ProductCode','ProductVersion','UpgradeCode')
        if (@($request.properties).Count -ne $expected.Count) { throw 'MSI property request differs' }
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $database = $null
        try {
            $database = $installer.OpenDatabase($msi, 0)
            $result = [ordered]@{}
            foreach ($name in $expected) {
                if ([string]$request.properties[$result.Count] -cne $name) { throw 'MSI property order differs' }
                $record = $null
                $view = $database.OpenView("SELECT ``Value`` FROM ``Property`` WHERE ``Property``='$name'")
                try { $view.Execute(); $record = $view.Fetch(); if (-not $record) { throw "MSI $name is absent" }
                    $result[$name] = [string]$record.StringData(1) } finally {
                    if ($record) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) }
                    if ($view) { $view.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) }
                }
            }
            Write-Result $result
        } finally {
            if ($database) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database) }
            if ($installer) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) }
        }
    }
}
