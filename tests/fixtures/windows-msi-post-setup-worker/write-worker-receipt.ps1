$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$dispatcher = $args[0]
$outputRoot = $args[1]
$message = $args[2]

# Shadow only the two OS operations the writer uses to reach a volume: the volume lookup itself and
# the path join that turns its drive letter into a root. Everything else - the record shape, the
# control-character sanitisation, the bounded truncation, the UTF-8 encoding and the exclusive
# CreateNew write with an explicit flush - is the real generated code.
function Get-Volume {
    param([string]$FileSystemLabel)
    if ($FileSystemLabel -ne 'MYSPEEDOUT') { throw "unexpected label $FileSystemLabel" }
    return [pscustomobject]@{DriveLetter = 'Q'; DriveType = 'Fixed'}
}
function Join-Path {
    param([string]$Path, [string]$ChildPath)
    if ($Path -ne 'Q:\') { throw "unexpected root $Path" }
    return [IO.Path]::Combine($outputRoot, $ChildPath)
}

. $dispatcher -LibraryMode

Write-MyspeedPostSetupFailure ([pscustomobject]@{Exception = [pscustomobject]@{Message = $message}})
