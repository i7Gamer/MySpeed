[CmdletBinding()]
param(
    [ValidateSet('Library','TestInstall','TestCleanup')]
    [string] $Mode='Library',
    [string] $BundlePath='',
    [string] $ExpectedBundleSha256='',
    [string] $ExpectedSourceSha='',
    [string] $ExpectedNonce='',
    [string] $DestinationRoot='',
    [string] $AllowedParent=''
)

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$script:RuntimeSchemaVersion=1
$script:RuntimeBundleKind='myspeed-windows-baseline-guest-runtime-bundle'
$script:RuntimeOwnershipKind='myspeed-windows-baseline-guest-runtime-root'
$script:RuntimeOwnershipMarker='.myspeed-runtime-owned.json'
$script:MaximumRuntimeBundleBytes=33554432
$script:MaximumRuntimeFileBytes=4194304
$script:MaximumRuntimeRawBytes=16777216
$script:RuntimePaths=@(
    'scripts/qualification/windows-baseline-guest-executor.mjs',
    'scripts/qualification/windows-baseline-guest-runner.mjs',
    'scripts/qualification/windows-baseline-guest-operations.mjs',
    'scripts/qualification/windows-baseline-guest-runtime.mjs',
    'scripts/qualification/windows-baseline-guest-materializer.mjs',
    'scripts/qualification/windows-baseline-guest-candidate-wrapper.ps1',
    'scripts/qualification/windows-native-candidate-controller.ps1',
    'scripts/qualification/windows-clean-stop-controller.ps1',
    'scripts/qualification/check-artifact.mjs',
    'scripts/qualification/safety.mjs',
    'scripts/qualification/fixture.mjs',
    'scripts/qualification/sqlite-check.mjs'
)

function Get-MyspeedRuntimeKeys {
    param([object]$Value)
    if($null -eq $Value -or $Value -is [string] -or $Value -is [array]){throw 'Value must be an object'}
    if($Value -is [Collections.IDictionary]){return @($Value.Keys)}
    return @($Value.PSObject.Properties.Name)
}

function Assert-MyspeedRuntimeKeys {
    param([object]$Value,[string[]]$Expected,[string]$Label)
    $actual=@(Get-MyspeedRuntimeKeys $Value|Sort-Object);$wanted=@($Expected|Sort-Object)
    if(($actual -join "`n") -cne ($wanted -join "`n")){throw "$Label schema differs"}
}

function Assert-MyspeedRuntimeString {
    param([object]$Value,[string]$Label,[string]$Pattern)
    if($Value -isnot [string] -or $Value -cnotmatch $Pattern){throw "$Label differs"};return [string]$Value
}

function Assert-MyspeedRuntimeDecimal {
    param([object]$Value,[string]$Label,[int64]$Maximum)
    [void](Assert-MyspeedRuntimeString $Value $Label '\A[1-9][0-9]*\z')
    $number=[int64]0;if(-not [int64]::TryParse($Value,[ref]$number) -or $number -gt $Maximum){throw "$Label differs"}
    return $number
}

function Get-MyspeedRuntimeSha256 {
    param([byte[]]$Bytes)
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try{return [BitConverter]::ToString($algorithm.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant()}
    finally{$algorithm.Dispose()}
}

function Read-MyspeedRuntimeFile {
    param([string]$Path,[string]$ExpectedSha256,[int64]$MaximumBytes,[string]$Label)
    $sha=Assert-MyspeedRuntimeString $ExpectedSha256 "$Label SHA" '\A[0-9a-f]{64}\z'
    $canonical=[IO.Path]::GetFullPath($Path);if($canonical -cne $Path){throw "$Label path differs"}
    $item=Get-Item -LiteralPath $canonical -Force
    if(-not $item.PSIsContainer -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0){
        $stream=[IO.File]::Open($canonical,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        try{
            if($stream.Length -lt 1 -or $stream.Length -gt $MaximumBytes){throw "$Label size differs"}
            $bytes=[byte[]]::new([int]$stream.Length);$offset=0
            while($offset -lt $bytes.Length){$count=$stream.Read($bytes,$offset,$bytes.Length-$offset)
                if($count -lt 1){throw "$Label read was truncated"};$offset+=$count}
            if((Get-MyspeedRuntimeSha256 $bytes) -cne $sha -or $stream.Length -ne $bytes.Length){throw "$Label content differs"}
            return $bytes
        }finally{$stream.Dispose()}
    }
    throw "$Label physical identity differs"
}

function ConvertFrom-MyspeedRuntimeBundle {
    param([byte[]]$Bytes,[string]$ExpectedSourceSha,[string]$ExpectedNonce)
    try{$value=([Text.UTF8Encoding]::new($false,$true).GetString($Bytes)|ConvertFrom-Json)}
    catch{throw 'Baseline runtime bundle is not valid UTF-8 JSON'}
    Assert-MyspeedRuntimeKeys $value @('schemaVersion','kind','sourceSha','nonce','totalBytes','files') 'Baseline runtime bundle'
    if($value.schemaVersion -isnot [int] -or $value.schemaVersion -ne $script:RuntimeSchemaVersion -or
        $value.kind -cne $script:RuntimeBundleKind -or
        (Assert-MyspeedRuntimeString $value.sourceSha 'Baseline runtime source SHA' '\A[0-9a-f]{40}\z') -cne $ExpectedSourceSha -or
        (Assert-MyspeedRuntimeString $value.nonce 'Baseline runtime nonce' '\A[0-9a-f]{32}\z') -cne $ExpectedNonce){
        throw 'Baseline runtime bundle identity differs'
    }
    $total=Assert-MyspeedRuntimeDecimal $value.totalBytes 'Baseline runtime total bytes' $script:MaximumRuntimeRawBytes
    $files=@($value.files);if($files.Count -ne $script:RuntimePaths.Count){throw 'Baseline runtime inventory differs'}
    $observedTotal=[int64]0;$validated=@()
    for($index=0;$index -lt $files.Count;$index++){
        $file=$files[$index];Assert-MyspeedRuntimeKeys $file @('path','bytes','sha256','bytesBase64') 'Baseline runtime file'
        if($file.path -cne $script:RuntimePaths[$index]){throw 'Baseline runtime file path differs'}
        $length=Assert-MyspeedRuntimeDecimal $file.bytes 'Baseline runtime file bytes' $script:MaximumRuntimeFileBytes
        $digest=Assert-MyspeedRuntimeString $file.sha256 'Baseline runtime file SHA' '\A[0-9a-f]{64}\z'
        [void](Assert-MyspeedRuntimeString $file.bytesBase64 'Baseline runtime file Base64' '\A(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\z')
        try{$decoded=[Convert]::FromBase64String($file.bytesBase64)}catch{throw 'Baseline runtime file Base64 differs'}
        if($decoded.Length -ne $length -or [Convert]::ToBase64String($decoded) -cne $file.bytesBase64 -or
            (Get-MyspeedRuntimeSha256 $decoded) -cne $digest){throw 'Baseline runtime file content differs'}
        $observedTotal+=$length;$validated+=,[pscustomobject]@{path=$file.path;bytes=$decoded;sha256=$digest}
    }
    if($observedTotal -ne $total){throw 'Baseline runtime byte total differs'}
    return $validated
}

function Get-MyspeedRuntimeRoot {
    param([string]$Root,[string]$Parent,[string]$Nonce)
    $checkedNonce=Assert-MyspeedRuntimeString $Nonce 'Baseline runtime nonce' '\A[0-9a-f]{32}\z'
    $canonicalParent=[IO.Path]::GetFullPath($Parent).TrimEnd('\')
    $expected=[IO.Path]::Combine($canonicalParent,"myspeed-baseline-runtime-$checkedNonce")
    $canonical=[IO.Path]::GetFullPath($Root)
    if($canonical -cne $Root -or $canonical -cne $expected){throw 'Baseline runtime destination differs'}
    return $canonical
}

function Get-MyspeedRuntimeMarkerBytes {
    param([string]$Root,[string]$SourceSha,[string]$Nonce)
    $record=[ordered]@{schemaVersion=$script:RuntimeSchemaVersion;kind=$script:RuntimeOwnershipKind
        sourceSha=$SourceSha;nonce=$Nonce;root=$Root}
    return [Text.UTF8Encoding]::new($false).GetBytes(($record|ConvertTo-Json -Compress))
}

function Write-MyspeedRuntimeFile {
    param([string]$Path,[byte[]]$Bytes,[string]$ExpectedSha256)
    $stream=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try{
        $stream.Write($Bytes,0,$Bytes.Length);$stream.Flush($true);$stream.Position=0
        $observed=[byte[]]::new($Bytes.Length);$offset=0
        while($offset -lt $observed.Length){$count=$stream.Read($observed,$offset,$observed.Length-$offset)
            if($count -lt 1){throw 'Baseline runtime write verification was truncated'};$offset+=$count}
        if($stream.Length -ne $Bytes.Length -or (Get-MyspeedRuntimeSha256 $observed) -cne $ExpectedSha256){
            throw 'Baseline runtime write verification differs'}
    }finally{$stream.Dispose()}
}

function Install-MyspeedBaselineRuntimeBundle {
    param([string]$Path,[string]$ExpectedSha256,[string]$SourceSha,[string]$Nonce,[string]$Root,[string]$Parent)
    $checkedSource=Assert-MyspeedRuntimeString $SourceSha 'Baseline runtime source SHA' '\A[0-9a-f]{40}\z'
    $checkedRoot=Get-MyspeedRuntimeRoot $Root $Parent $Nonce
    if([IO.Directory]::Exists($checkedRoot) -or [IO.File]::Exists($checkedRoot)){throw 'Baseline runtime destination is not fresh'}
    $bundle=Read-MyspeedRuntimeFile $Path $ExpectedSha256 $script:MaximumRuntimeBundleBytes 'Baseline runtime bundle'
    $files=@(ConvertFrom-MyspeedRuntimeBundle $bundle $checkedSource $Nonce)
    [void][IO.Directory]::CreateDirectory($checkedRoot)
    $marker=Get-MyspeedRuntimeMarkerBytes $checkedRoot $checkedSource $Nonce
    Write-MyspeedRuntimeFile ([IO.Path]::Combine($checkedRoot,$script:RuntimeOwnershipMarker)) $marker `
        (Get-MyspeedRuntimeSha256 $marker)
    foreach($directory in @('scripts','scripts/qualification')){
        [void][IO.Directory]::CreateDirectory([IO.Path]::Combine($checkedRoot,$directory.Replace('/','\')))
    }
    foreach($file in $files){
        $target=[IO.Path]::Combine($checkedRoot,$file.path.Replace('/','\'))
        Write-MyspeedRuntimeFile $target $file.bytes $file.sha256
    }
    return [pscustomobject][ordered]@{installed=$true;root=$checkedRoot;files=$files.Count}
}

function Remove-MyspeedBaselineRuntimeBundle {
    param([string]$SourceSha,[string]$Nonce,[string]$Root,[string]$Parent)
    $checkedSource=Assert-MyspeedRuntimeString $SourceSha 'Baseline runtime source SHA' '\A[0-9a-f]{40}\z'
    $checkedRoot=Get-MyspeedRuntimeRoot $Root $Parent $Nonce
    $expectedMarker=Get-MyspeedRuntimeMarkerBytes $checkedRoot $checkedSource $Nonce
    $markerPath=[IO.Path]::Combine($checkedRoot,$script:RuntimeOwnershipMarker)
    $marker=Read-MyspeedRuntimeFile $markerPath (Get-MyspeedRuntimeSha256 $expectedMarker) `
        $script:MaximumRuntimeFileBytes 'Baseline runtime ownership marker'
    if(-not [Collections.StructuralComparisons]::StructuralEqualityComparer.Equals($marker,$expectedMarker)){
        throw 'Baseline runtime ownership marker differs'}
    $allowed=@($script:RuntimeOwnershipMarker,'scripts','scripts\qualification')
    $allowed+=@($script:RuntimePaths|ForEach-Object{$_.Replace('/','\')})
    $observed=@(Get-ChildItem -LiteralPath $checkedRoot -Force -Recurse)
    if($observed.Count -ne $allowed.Count){throw 'Baseline runtime cleanup inventory differs'}
    foreach($entry in $observed){
        if(($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Baseline runtime cleanup found a reparse point'}
        $relative=$entry.FullName.Substring($checkedRoot.Length+1)
        if($relative -cnotin $allowed){throw 'Baseline runtime cleanup inventory differs'}
    }
    [IO.Directory]::Delete($checkedRoot,$true)
    return [pscustomobject][ordered]@{cleanupProven=(-not [IO.Directory]::Exists($checkedRoot))}
}

if($Mode -ceq 'Library'){return}
try{
    $result=if($Mode -ceq 'TestInstall'){
        Install-MyspeedBaselineRuntimeBundle $BundlePath $ExpectedBundleSha256 $ExpectedSourceSha $ExpectedNonce `
            $DestinationRoot $AllowedParent
    }else{Remove-MyspeedBaselineRuntimeBundle $ExpectedSourceSha $ExpectedNonce $DestinationRoot $AllowedParent}
    $result|ConvertTo-Json -Compress -Depth 6
}catch{[Console]::Error.WriteLine($_.Exception.Message);exit 1}

