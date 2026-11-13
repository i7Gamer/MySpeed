# Makes a Windows installation's data directory belong to the machine's
# administrators before a LocalSystem service is started in it.
#
# C:\ProgramData lets every local account create a folder, and whoever creates
# one owns it. The installer's ACL is a DACL: it says who may touch
# ProgramData\MySpeed and nothing about who owns it, and an owner can rewrite a
# DACL whenever they like. So an account that made the folder before MySpeed
# was first installed kept control of everything the service then did in it -
# the database, the TLS key, .env, and bin, whose executables the server runs
# as it finds them. Releases 1.1.1 to 1.5.2 also created the folder under
# ProgramData's inherited ACL, which let any account add files to it, and what
# was added then is owned by whoever added it to this day.
#
# What this does about it: anything inside the directory that an account other
# than an administrator owns is moved to a quarantine folder beside it that
# only administrators can open, with a note saying what was moved and why.
# Moved, never deleted - a file this cannot vouch for may still be the
# operator's own. A directory that somebody else created is moved whole,
# because under a directory another account controls an owner of SYSTEM proves
# nothing about a file's contents.
#
# Loading this file runs nothing. The installer pipes it into a session and
# then calls Protect-MySpeedDataRoot with the directory it created, and the
# directory has no default: a caller that forgot to name one must get an error,
# not a walk through whatever installation happens to be on the machine.

# SIDs, not names: the group is Administratoren on a German Windows. SYSTEM is
# the service, the administrators group is what an elevated session creates
# files as, and the last is the Windows Modules Installer.
$script:MySpeedTrustedOwners = @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$script:MySpeedAdministrators = 'S-1-5-32-544'

# The DACL the installer's own PermissionEx elements state. Protected, so that
# nothing is inherited from ProgramData; full control for SYSTEM and for
# administrators, inherited by everything beneath; nobody else.
$script:MySpeedProtectedDacl = 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'

$script:MySpeedQuarantineInfix = '-quarantine-'
$script:MySpeedQuarantineTagLength = 8

# The new data root is built under this name and renamed into place, and the
# rename is tried this many times before the installation is given up on - see
# New-MySpeedDataRoot.
$script:MySpeedStagingInfix = '-new-'
$script:MySpeedRootAttempts = 5
$script:MySpeedReadmeName = 'README.txt'

# What the service writes into and the installer creates. Made again here
# because either may just have been moved away.
$script:MySpeedServiceFolders = @('data', 'logs')

function Get-MySpeedOwner {
    param([string]$Path)

    # Null for an owner that cannot be read, which no list of trusted owners
    # contains: a descriptor that hides from SYSTEM is not one to trust.
    try {
        return (Get-Acl -LiteralPath $Path).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        return $null
    }
}

function Get-MySpeedAdministratorMembers {
    # The accounts that are administrators in their own right. A file made by
    # an administrator who was not elevated at the time is owned by that
    # account rather than by the group - which is exactly what the installer's
    # own legacy migration produces, since it copies an old database in as the
    # installing user. Whoever can install this is one of these.
    $members = New-Object System.Collections.Generic.List[string]

    try {
        $group = (New-Object System.Security.Principal.SecurityIdentifier($script:MySpeedAdministrators)).Translate(
            [System.Security.Principal.NTAccount]).Value.Split('\')[-1]

        foreach ($member in @(([ADSI]"WinNT://./$group,group").psbase.Invoke('Members'))) {
            $sid = $member.GetType().InvokeMember('objectSid', 'GetProperty', $null, $member, $null)
            $members.Add((New-Object System.Security.Principal.SecurityIdentifier($sid, 0)).Value)
        }
    } catch {
        # A machine whose group cannot be listed trusts the well-known owners
        # only. That errs towards quarantining, which loses nothing.
        $members.Clear()
    }

    return $members
}

function Test-MySpeedLink {
    param($Item)

    # A junction or a symbolic link, to a directory or a file. A directory
    # carrying any other kind of reparse point is treated as one too, since
    # the only safe thing to do with a tag this does not know is not to walk
    # through it.
    $reparse = [bool]($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)

    return $reparse -and ($Item.PSIsContainer -or [bool]$Item.LinkType)
}

function Test-MySpeedHardLink {
    param($Item)

    # A second name for a file that also lives somewhere else. It has no
    # reparse point to give it away, and it shares one security descriptor with
    # its other names - so taking ownership of this name, or resetting its
    # DACL, would do the same to a file outside the directory.
    return (-not $Item.PSIsContainer) -and ($Item.LinkType -eq 'HardLink')
}

function Remove-MySpeedLink {
    param($Item)

    # The link itself: neither call descends, so what it points at is untouched,
    # and deleting one name of a hard-linked file leaves the others standing.
    if ($Item.PSIsContainer) {
        [System.IO.Directory]::Delete($Item.FullName, $false)
    } else {
        [System.IO.File]::Delete($Item.FullName)
    }
}

function Move-MySpeedItem {
    param($Item, [string]$Destination)

    # Fatal, and said in words. An item that cannot be moved cannot be left
    # where it is either - an open handle on a planted file, or a name too long
    # to exist under the quarantine's longer path, would otherwise be a way to
    # keep it in the directory - so the installation stops, and the log says
    # which item an administrator has to deal with before trying again.
    try {
        if ($Item.PSIsContainer) {
            [System.IO.Directory]::Move($Item.FullName, $Destination)
        } else {
            [System.IO.File]::Move($Item.FullName, $Destination)
        }
    } catch {
        throw ("MySpeed: $($Item.FullName) does not belong to an administrator and could not be moved out of the data " +
            "directory ($($_.Exception.Message)). Remove or rename it from an elevated prompt and run the installer again.")
    }
}

function Get-MySpeedOwnerLabel {
    param([string]$Owner)

    if (-not $Owner) { return 'an owner that could not be read' }

    try {
        $name = (New-Object System.Security.Principal.SecurityIdentifier($Owner)).Translate(
            [System.Security.Principal.NTAccount]).Value

        return "$Owner ($name)"
    } catch {
        return $Owner
    }
}

function New-MySpeedPrivateDirectory {
    param([string]$Path)

    # Owner and DACL at the moment of creation, so the directory never exists
    # in a state another account could have written into.
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetSecurityDescriptorSddlForm("O:BA$($script:MySpeedProtectedDacl)")

    [void][System.IO.Directory]::CreateDirectory($Path, $security)
}

function Set-MySpeedProtectedDacl {
    param([string]$Path)

    # Only the DACL - the owner has already been judged. Setting it re-applies
    # inheritance to what is beneath, which is what removes the grant a file
    # made before the DACL was protected still carries; an entry an
    # administrator added to one of them by hand is explicit and survives.
    $security = New-Object System.Security.AccessControl.DirectorySecurity
    $security.SetSecurityDescriptorSddlForm($script:MySpeedProtectedDacl,
        [System.Security.AccessControl.AccessControlSections]::Access)

    [System.IO.Directory]::SetAccessControl($Path, $security)
}

function New-MySpeedQuarantine {
    param([string]$Root)

    # A name nobody could have created in advance. ProgramData lets any account
    # make a folder, and creating a directory that already exists succeeds
    # without applying the security it was asked for - so a name that could be
    # predicted would be a quarantine its own contents' owner controlled.
    $stamp = [System.DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $tag = [System.Guid]::NewGuid().ToString('N').Substring(0, $script:MySpeedQuarantineTagLength)
    $path = "$Root$($script:MySpeedQuarantineInfix)$stamp-$tag"

    if (Test-Path -LiteralPath $path) { throw "The quarantine folder $path already exists." }

    New-MySpeedPrivateDirectory $path

    if ($script:MySpeedTrustedOwners -notcontains (Get-MySpeedOwner $path)) {
        throw "The quarantine folder $path was not created by this installation."
    }

    return $path
}

function Set-MySpeedAdministratorOwned {
    param([string]$Path)

    # takeown rather than a descriptor write, because it holds the privilege
    # that overrides a DACL written to keep administrators out. One item, by
    # full path, and never a link: the caller has checked.
    #
    # Its own preference, local to this function: Windows PowerShell turns a
    # native command's redirected error output into error records, and under
    # Stop the first of them would end the installation over a message.
    $ErrorActionPreference = 'Continue'

    & (Join-Path $env:SystemRoot 'System32\takeown.exe') /A /F $Path 2>&1 | Out-Null

    if ($LASTEXITCODE -ne 0) { throw "Could not take ownership of $Path." }
}

function Lock-MySpeedQuarantined {
    param([string]$Path, [System.Collections.Generic.List[string]]$Notes)

    # From the top down, one level at a time: once a directory answers to
    # administrators only, nobody else can add to it or swap what is in it
    # while the level below is being dealt with.
    try {
        $item = Get-Item -LiteralPath $Path -Force

        if (Test-MySpeedLink $item) {
            $Notes.Add("removed link  $Path  ->  $(@($item.Target) -join ', ')")
            Remove-MySpeedLink $item

            return
        }

        if (Test-MySpeedHardLink $item) {
            $Notes.Add("removed hard link  $Path  (the file keeps its other names)")
            Remove-MySpeedLink $item

            return
        }

        Set-MySpeedAdministratorOwned $Path

        # An empty DACL that inherits: whatever the previous owner wrote is
        # gone, and the quarantine folder's own applies.
        if ($item.PSIsContainer) {
            # The names in it that are links go first. Writing a directory's
            # DACL re-applies inheritance to its children, and a hard-linked
            # child shares its descriptor with a file somewhere else - which
            # would have its inherited entries rewritten along with it.
            try {
                foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force)) {
                    if ((Test-MySpeedLink $child) -or (Test-MySpeedHardLink $child)) {
                        Lock-MySpeedQuarantined -Path $child.FullName -Notes $Notes
                    }
                }
            } catch {
                # Its previous owner's DACL does not let it be listed yet. It
                # is listed below, once the DACL is this script's own.
                $Notes.Add("could not be read before it was locked  $Path")
            }

            $security = New-Object System.Security.AccessControl.DirectorySecurity
            $security.SetAccessRuleProtection($false, $false)
            [System.IO.Directory]::SetAccessControl($Path, $security)

            foreach ($child in @(Get-ChildItem -LiteralPath $Path -Force)) {
                Lock-MySpeedQuarantined -Path $child.FullName -Notes $Notes
            }
        } else {
            $security = New-Object System.Security.AccessControl.FileSecurity
            $security.SetAccessRuleProtection($false, $false)
            [System.IO.File]::SetAccessControl($Path, $security)
        }
    } catch {
        # Already out of the data directory, which is what the service's
        # safety rests on; a quarantined item that could not be locked is
        # reported, not allowed to fail the installation.
        $Notes.Add("COULD NOT LOCK  $Path  ($($_.Exception.Message))")
    }
}

function Get-MySpeedForeignItems {
    param([string]$Directory, [string[]]$Trusted)

    try {
        $children = @(Get-ChildItem -LiteralPath $Directory -Force)
    } catch {
        # A directory an administrator owns and has closed even to SYSTEM. The
        # service cannot use it either, and it is theirs to have closed.
        return
    }

    foreach ($item in $children) {
        $owner = Get-MySpeedOwner $item.FullName

        if ($Trusted -notcontains $owner) {
            # Not descended into: the whole of it goes, whoever owns the parts.
            [pscustomobject]@{ Item = $item; Owner = $owner }
        } elseif (-not (Test-MySpeedLink $item) -and $item.PSIsContainer) {
            # A link an administrator made is left alone and never followed:
            # the operator who moved the database to another volume did it on
            # purpose, as install.sh reads a symlinked data directory.
            Get-MySpeedForeignItems -Directory $item.FullName -Trusted $Trusted
        }
    }
}

function Move-MySpeedRootAside {
    param($RootItem, [string]$Owner, [string]$Quarantine, [string]$Name,
        [System.Collections.Generic.List[string]]$Notes)

    # Renamed before anything in it is read: a rename cannot be raced into
    # following a link, and what arrives in the quarantine is then judged there,
    # where nobody else can swap it.
    $label = Get-MySpeedOwnerLabel $Owner

    if (Test-MySpeedLink $RootItem) {
        $Notes.Add("removed link  $($RootItem.FullName)  ->  $(@($RootItem.Target) -join ', ')  (owner $label)")
        Remove-MySpeedLink $RootItem

        return
    }

    $destination = Join-Path $Quarantine $Name
    Move-MySpeedItem -Item $RootItem -Destination $destination

    $Notes.Add("moved the whole of $($RootItem.FullName) to $Name  (owner $label)")
    Lock-MySpeedQuarantined -Path $destination -Notes $Notes
}

function New-MySpeedDataRoot {
    param([string]$Root, [string]$Quarantine, [System.Collections.Generic.List[string]]$Notes)

    # Built under a name nobody could have predicted and then renamed into
    # place, because creating a directory that already exists succeeds and
    # applies none of the security it was asked for. The old directory has just
    # been moved away, ProgramData lets any account make a folder, and an
    # account that made this one again in that instant would otherwise own the
    # "new" data root exactly as it owned the old. A rename onto a name that is
    # taken fails instead - so whatever turned up is moved aside in its turn,
    # and the rename tried again.
    $leaf = Split-Path -Leaf $Root

    for ($attempt = 1; $attempt -le $script:MySpeedRootAttempts; $attempt++) {
        $staging = "$Root$($script:MySpeedStagingInfix)$([System.Guid]::NewGuid().ToString('N'))"

        if (Test-Path -LiteralPath $staging) { throw "The staging folder $staging already exists." }

        New-MySpeedPrivateDirectory $staging

        if ($script:MySpeedTrustedOwners -notcontains (Get-MySpeedOwner $staging)) {
            throw "The staging folder $staging was not created by this installation."
        }

        try {
            [System.IO.Directory]::Move($staging, $Root)

            return
        } catch {
            [System.IO.Directory]::Delete($staging, $false)

            if (-not (Test-Path -LiteralPath $Root)) { throw }

            Move-MySpeedRootAside -RootItem (Get-Item -LiteralPath $Root -Force) -Owner (Get-MySpeedOwner $Root) `
                -Quarantine $Quarantine -Name "$leaf-$($attempt + 1)" -Notes $Notes
        }
    }

    throw "MySpeed: $Root was created again by another account each of the $($script:MySpeedRootAttempts) times it was replaced."
}

function Write-MySpeedQuarantineReadme {
    param([string]$Quarantine, [string]$Root, [System.Collections.Generic.List[string]]$Notes)

    $lines = @(
        "MySpeed quarantine - $([System.DateTime]::UtcNow.ToString('u'))",
        '',
        "The MySpeed installer found items in $Root that are owned by an account which is not an administrator.",
        'The MySpeed service runs as LocalSystem and trusts that directory completely: it runs the programs in bin, serves what is in build, and reads its settings and its database from it.',
        'Something another account can write there is therefore a way for that account to run code as SYSTEM, so those items were moved here. Nothing was deleted, except links, which hold no data; where each one pointed is listed below.',
        'This folder is readable by administrators only.',
        '',
        'What was moved:',
        ''
    ) + @($Notes | ForEach-Object { "  $_" }) + @(
        '',
        'What to do:',
        '',
        '  If you do not recognise these items, delete this folder. If you did not put them there, somebody else on this machine did.',
        "  If one of them is yours, copy it back into $Root from an elevated prompt. Copy, do not move: a copy made by an administrator is owned by administrators, a moved file keeps its old owner and would be quarantined again by the next update.",
        '  If the whole directory was moved, your earlier data is in the folder of the same name inside this one, and MySpeed has started with an empty one.'
    )

    [System.IO.File]::WriteAllLines((Join-Path $Quarantine $script:MySpeedReadmeName), $lines)
}

function Protect-MySpeedDataRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DataRoot
    )

    Set-StrictMode -Version 2.0
    $ErrorActionPreference = 'Stop'

    # The installer's directory properties end in a separator.
    $root = [System.IO.Path]::GetFullPath($DataRoot).TrimEnd('\')

    if (-not (Test-Path -LiteralPath $root)) {
        Write-Output "MySpeed: $root does not exist yet, so there is nothing in it to check."

        return
    }

    $trusted = @($script:MySpeedTrustedOwners) + @(Get-MySpeedAdministratorMembers)
    $notes = New-Object System.Collections.Generic.List[string]
    $quarantine = $null

    $rootItem = Get-Item -LiteralPath $root -Force
    $rootOwner = Get-MySpeedOwner $root
    $rootIsLink = Test-MySpeedLink $rootItem
    $leaf = Split-Path -Leaf $root

    if ($trusted -contains $rootOwner) {
        if ($rootIsLink) {
            Write-Output "MySpeed: $root is a link an administrator created. It and what it points at were left as they are."

            return
        }

        $sweep = {
            foreach ($found in @(Get-MySpeedForeignItems -Directory $root -Trusted $trusted)) {
                if (-not $quarantine) { $quarantine = New-MySpeedQuarantine $root }

                $relative = $found.Item.FullName.Substring($root.Length).TrimStart('\')
                $owner = Get-MySpeedOwnerLabel $found.Owner

                if (Test-MySpeedLink $found.Item) {
                    $notes.Add("removed link  $relative  ->  $(@($found.Item.Target) -join ', ')  (owner $owner)")
                    Remove-MySpeedLink $found.Item

                    continue
                }

                if (Test-MySpeedHardLink $found.Item) {
                    $notes.Add("removed hard link  $relative  (owner $owner; the file keeps its other names)")
                    Remove-MySpeedLink $found.Item

                    continue
                }

                $destination = Join-Path (Join-Path $quarantine $leaf) $relative
                [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $destination))
                Move-MySpeedItem -Item $found.Item -Destination $destination

                $notes.Add("moved  $relative  (owner $owner)")
                Lock-MySpeedQuarantined -Path $destination -Notes $notes
            }
        }

        # Swept on both sides of the DACL. Before, because writing it re-applies
        # inheritance to everything beneath, and a planted hard link shares its
        # descriptor with a file somewhere else: that file's inherited entries
        # would be rewritten with it. After, because until the DACL is written
        # a directory left over from before 1.5.3 can still be added to, and
        # whatever arrived during the first sweep was not in it. Dot-sourced,
        # so that both sweeps share this function's quarantine.
        . $sweep
        Set-MySpeedProtectedDacl $root
        . $sweep
    } else {
        # Somebody else's directory, or somebody else's link standing where
        # the directory belongs: moved aside whole, and replaced by one that no
        # other account has ever been able to write to.
        $quarantine = New-MySpeedQuarantine $root

        Move-MySpeedRootAside -RootItem $rootItem -Owner $rootOwner -Quarantine $quarantine -Name $leaf -Notes $notes
        New-MySpeedDataRoot -Root $root -Quarantine $quarantine -Notes $notes
    }

    # Whichever way it got here, and before anything is created in it: the
    # service is started next, and it must not be started over a directory this
    # could not vouch for.
    if ((Test-MySpeedLink (Get-Item -LiteralPath $root -Force)) -or ($trusted -notcontains (Get-MySpeedOwner $root))) {
        throw "MySpeed: $root still does not belong to an administrator."
    }

    foreach ($folder in $script:MySpeedServiceFolders) {
        $path = Join-Path $root $folder

        if (-not (Test-Path -LiteralPath $path)) { [void][System.IO.Directory]::CreateDirectory($path) }
    }

    if (-not $quarantine) {
        Write-Output "MySpeed: everything in $root belongs to this machine's administrators."

        return
    }

    Write-MySpeedQuarantineReadme -Quarantine $quarantine -Root $root -Notes $notes

    Write-Output "MySpeed: $($notes.Count) item(s) in $root did not belong to an administrator and were quarantined in $quarantine."
    foreach ($note in $notes) { Write-Output "MySpeed:   $note" }
}
