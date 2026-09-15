[CmdletBinding()]
param(
    [ValidateSet('Library','Initialize','InspectPayload','BuildClone')][string]$Mode,
    [string]$InputJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$MaximumJsonBytes = 65536
$MaximumPayloadFiles = 128
$MaximumFileBytes = 1073741824
$RequiredPayloads = [ordered]@{exe='MySpeed.exe';configuration='MySpeedService.xml';wrapper='MySpeedService.exe'}

function Read-Request {
    if ([string]::IsNullOrEmpty($InputJson) -or [Text.Encoding]::UTF8.GetByteCount($InputJson) -gt $MaximumJsonBytes) {
        throw 'Hosted MSI fixture input differs'
    }
    return $InputJson | ConvertFrom-Json -ErrorAction Stop
}

function Assert-Path([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathFullyQualified($Value)) {
        throw 'Hosted MSI fixture path differs'
    }
    return [IO.Path]::GetFullPath($Value)
}

function Assert-Descendant([string]$Root,[string]$Value) {
    $rootPath = Assert-Path $Root
    $path = Assert-Path $Value
    $relative = [IO.Path]::GetRelativePath($rootPath,$path)
    if ([IO.Path]::IsPathRooted($relative) -or $relative -ceq '..' -or
        $relative.StartsWith("..$([IO.Path]::DirectorySeparatorChar)",[StringComparison]::Ordinal)) {
        throw 'Hosted MSI fixture payload path escapes its root'
    }
    return $path
}

function Get-FileIdentity([string]$Value) {
    $path = Assert-Path $Value
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $item.Length -lt 1 -or $item.Length -gt $MaximumFileBytes) { throw 'Hosted MSI fixture file differs' }
    return [ordered]@{path=$path;bytes=[long]$item.Length;
        sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
}

function Invoke-Tool([string]$ToolPath,[string[]]$Arguments,[string]$Label) {
    $tool = Get-FileIdentity $ToolPath
    & $tool.path @Arguments *> $null
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit $LASTEXITCODE" }
}

function New-EmptyDirectory([string]$Value) {
    $path = Assert-Path $Value
    if (Test-Path -LiteralPath $path) { throw 'Hosted MSI fixture directory collision' }
    [void](New-Item -ItemType Directory -Path $path -ErrorAction Stop)
    return $path
}

function Get-MsiPayloadSourceMap([string]$Source,[string]$PayloadRoot) {
    $rootPath=Assert-Path $PayloadRoot
    $fileRoot=Assert-Descendant $rootPath (Join-Path $rootPath 'File')
    $items = @(Get-ChildItem -LiteralPath $fileRoot -File -Recurse -Force -ErrorAction Stop)
    if ($items.Count -lt $RequiredPayloads.Count -or $items.Count -gt $MaximumPayloadFiles -or
        @($items | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count -ne 0) {
        throw 'MSI payload inventory differs'
    }
    [xml]$decompiled = Get-Content -LiteralPath (Assert-Path $Source) -Raw -ErrorAction Stop
    $manager = [Xml.XmlNamespaceManager]::new($decompiled.NameTable)
    $manager.AddNamespace('w','http://schemas.microsoft.com/wix/2006/wi')
    $nodes = @($decompiled.SelectNodes('//w:File',$manager))
    if ($nodes.Count -ne $items.Count) { throw 'MSI payload source map differs' }
    $byPath = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    $sourceByPath = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
    $sourcePaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $inventoryPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($item in $items){[void]$inventoryPaths.Add([IO.Path]::GetFullPath($item.FullName))}
    foreach ($node in $nodes) {
        $name=[string]$node.Name
        if ([string]::IsNullOrEmpty($name) -or [IO.Path]::GetFileName($name) -cne $name) {
            throw 'MSI payload logical name differs'
        }
        $sourcePath=Assert-Descendant $fileRoot ([string]$node.Source)
        if (-not $sourcePaths.Add($sourcePath)) { throw 'MSI payload source is duplicated' }
        $identity=Get-FileIdentity $sourcePath
        $logicalPath='File/'+$name
        if (-not $byPath.TryAdd($logicalPath,[pscustomobject][ordered]@{path=$logicalPath;
            bytes=$identity.bytes;sha256=$identity.sha256}) -or -not $sourceByPath.TryAdd($logicalPath,$sourcePath)) {
            throw 'MSI payload logical path is duplicated'
        }
    }
    if (-not $sourcePaths.SetEquals($inventoryPaths)) { throw 'MSI payload source map is incomplete' }
    [string[]]$relativePaths = @($byPath.Keys)
    [Array]::Sort($relativePaths,[StringComparer]::Ordinal)
    return [pscustomobject]@{byPath=$byPath;sourceByPath=$sourceByPath;
        inventory=@($relativePaths | ForEach-Object {$byPath[$_]})}
}

function Get-MsiProperties([string]$Value,
    [scriptblock]$CreateInstaller={New-Object -ComObject WindowsInstaller.Installer},
    [scriptblock]$ReleaseCom={param($Object)[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Object)}) {
    $path = (Get-FileIdentity $Value).path
    $installer = & $CreateInstaller
    $database = $null; $summary = $null
    try {
        $database = $installer.OpenDatabase($path, 0)
        $result = [ordered]@{}
        foreach ($name in @('ProductCode','ProductVersion','UpgradeCode')) {
            $view = $null; $record = $null
            try {
                $view = $database.OpenView("SELECT ``Value`` FROM ``Property`` WHERE ``Property``='$name'")
                [void]$view.Execute(); $record = $view.Fetch()
                if (-not $record) { throw "MSI $name is absent" }
                $result[$name] = [string]$record.StringData(1)
            } finally {
                if ($record) { [void](& $ReleaseCom $record) }
                if ($view) { [void]$view.Close(); [void](& $ReleaseCom $view) }
            }
        }
        $summary = $installer.SummaryInformation($path, 0)
        $result['PackageCode'] = [string]$summary.Property(9)
        return $result
    } finally {
        if ($summary) { [void](& $ReleaseCom $summary) }
        if ($database) { [void](& $ReleaseCom $database) }
        if ($installer) { [void](& $ReleaseCom $installer) }
    }
}

function Expand-MsiPayload([string]$MsiPath,[string]$DarkPath,[string]$OutputRoot) {
    $root = New-EmptyDirectory $OutputRoot
    $source = Join-Path $root 'decompiled.wxs'
    $payloadRoot = Join-Path $root 'payload'
    Invoke-Tool $DarkPath @('-nologo','-x',$payloadRoot,'-o',$source,(Assert-Path $MsiPath)) 'WiX decompiler'
    $map=Get-MsiPayloadSourceMap $source $payloadRoot
    $payload = [ordered]@{}
    foreach ($entry in $RequiredPayloads.GetEnumerator()) {
        $logicalPath='File/'+$entry.Value
        if (-not $map.byPath.ContainsKey($logicalPath)) { throw "MSI payload $($entry.Key) differs" }
        $identity = $map.byPath[$logicalPath]
        $record = [ordered]@{bytes=$identity.bytes;sha256=$identity.sha256}
        if ($entry.Key -ceq 'exe') {
            $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($map.sourceByPath[$logicalPath])
            $record['fileVersion'] = [string]$version.FileVersion
            $record['productVersion'] = [string]$version.ProductVersion
        }
        $payload[$entry.Key] = $record
    }
    $payload['inventory'] = @($map.inventory)
    return [ordered]@{root=$root;source=$source;payloadRoot=$payloadRoot;payload=$payload}
}

function Assert-Guid([string]$Value,[string]$Label) {
    if ($Value -cnotmatch '^\{[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$') { throw "$Label differs" }
}

if($Mode -ceq 'Library'){return}
$request = Read-Request
switch ($Mode) {
    'Initialize' {
        [void](New-EmptyDirectory ([string]$request.root))
        [ordered]@{} | ConvertTo-Json -Compress
    }
    'InspectPayload' {
        $identity = Get-FileIdentity ([string]$request.path)
        if ($identity.sha256 -cne [string]$request.expectedSha256) { throw 'Candidate MSI hash differs' }
        $expanded = Expand-MsiPayload $identity.path ([string]$request.darkPath) ([string]$request.outputRoot)
        $expanded.payload | ConvertTo-Json -Compress -Depth 4
    }
    'BuildClone' {
        foreach ($name in @('productCode','packageCode','upgradeCode')) {
            Assert-Guid ([string]$request.$name) "Fixture $name"
        }
        if ([string]$request.productVersion -cnotmatch '^[0-9]{1,3}(?:\.[0-9]{1,5}){2,3}$') {
            throw 'Fixture ProductVersion differs'
        }
        $candidate = Get-FileIdentity ([string]$request.sourceMsiPath)
        if ($candidate.sha256 -cne [string]$request.sourceMsiSha256) { throw 'Source MSI hash differs' }
        $expanded = Expand-MsiPayload $candidate.path ([string]$request.darkPath) ([string]$request.outputRoot)
        [xml]$xml = Get-Content -LiteralPath $expanded.source -Raw -ErrorAction Stop
        $manager = [Xml.XmlNamespaceManager]::new($xml.NameTable)
        $manager.AddNamespace('w','http://schemas.microsoft.com/wix/2006/wi')
        $products = @($xml.SelectNodes('//w:Product',$manager))
        $packages = @($xml.SelectNodes('//w:Product/w:Package',$manager))
        if ($products.Count -ne 1 -or $packages.Count -ne 1 -or
            [string]$products[0].UpgradeCode -cne [string]$request.upgradeCode) {
            throw 'Decompiled candidate identity differs'
        }
        $products[0].SetAttribute('Id',[string]$request.productCode)
        $products[0].SetAttribute('Version',[string]$request.productVersion)
        $packages[0].SetAttribute('Id',[string]$request.packageCode)
        $encoding = [Text.UTF8Encoding]::new($false)
        $settings = [Xml.XmlWriterSettings]@{Encoding=$encoding;Indent=$true;OmitXmlDeclaration=$false}
        $writer = [Xml.XmlWriter]::Create($expanded.source,$settings)
        try { $xml.Save($writer) } finally { $writer.Dispose() }
        $objectPath = Join-Path $expanded.root 'fixture.wixobj'
        Invoke-Tool ([string]$request.candlePath) @('-nologo','-ext','WixUtilExtension','-out',$objectPath,
            $expanded.source) 'WiX compiler'
        $destination = Assert-Path ([string]$request.destinationPath)
        if (Test-Path -LiteralPath $destination) { throw 'Fixture MSI collision' }
        Invoke-Tool ([string]$request.lightPath) @('-nologo','-spdb','-ext','WixUtilExtension','-b',
            $expanded.payloadRoot,'-out',$destination,$objectPath) 'WiX linker'
        $built = Get-FileIdentity $destination
        $verificationRoot = Join-Path $expanded.root 'verification'
        $verified = Expand-MsiPayload $built.path ([string]$request.darkPath) $verificationRoot
        [ordered]@{bindingId=[string]$request.bindingId;path=$built.path;bytes=$built.bytes;sha256=$built.sha256;
            properties=(Get-MsiProperties $built.path);payload=$verified.payload} |
            ConvertTo-Json -Compress -Depth 5
    }
}
