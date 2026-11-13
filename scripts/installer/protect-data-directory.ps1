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

# What a quarantined item is given: administrators as its owner and a DACL of
# its own that names SYSTEM and administrators and inherits from nobody.
$script:MySpeedLockedDirectory = "O:BA$($script:MySpeedProtectedDacl)"
$script:MySpeedLockedFile = 'O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)'

# Held by SYSTEM and by an elevated administrator, and switched off until asked
# for. With them an item can be opened whatever its previous owner wrote into
# its DACL, including one written to keep administrators out.
$script:MySpeedPrivileges = @('SeBackupPrivilege', 'SeRestorePrivilege')

# Everything done to an item somebody else may control is done through one
# handle to it, because a path is only a name and can be made to mean something
# else between two uses of it. The account that planted a directory can still
# reach it once it has been moved and closed - through a handle opened
# beforehand, or by path, since passing through a folder one cannot read is a
# right every account has - and can empty it and turn it into a junction. From
# then on "directory\child" names a file in another service's folder, and a
# path is followed through every component but its last.
#
# So an item is opened once, without following it if it is a link itself, and
# the handle is asked where the item really is. Only when that is where it was
# expected to be - which no path through a link can be - is anything read from
# it or done to it, and then on that same handle: its owner, whether it is a
# link, its security, its removal, its new name.
#
# Compiled only when something has to be quarantined; an installation that
# finds nothing never loads it.
$script:MySpeedNativeSource = @'
    using System;
    using System.ComponentModel;
    using System.Runtime.InteropServices;
    using System.Security.Principal;
    using System.Text;
    using Microsoft.Win32.SafeHandles;

    public sealed class MySpeedHandle : IDisposable
    {
        const uint DeleteAccess = 0x00010000;
        const uint ReadControl = 0x00020000;
        const uint WriteDac = 0x00040000;
        const uint WriteOwner = 0x00080000;
        const uint FileReadAttributes = 0x00000080;

        public const uint ForReading = ReadControl | FileReadAttributes;
        public const uint ForSecuring = ForReading | WriteDac | WriteOwner;
        public const uint ForRemoving = ForReading | DeleteAccess;

        const uint ShareReadWriteDelete = 0x00000007;
        const uint OpenExisting = 3;
        const uint FlagBackupSemantics = 0x02000000;
        const uint FlagOpenReparsePoint = 0x00200000;
        const uint AttributeDirectory = 0x00000010;
        const uint AttributeReparsePoint = 0x00000400;
        const uint ReparseTagNameSurrogate = 0x20000000;
        const int FileRenameInfo = 3;
        const int FileDispositionInfo = 4;
        const int FileDispositionInfoEx = 21;
        const uint DispositionDelete = 0x00000001;
        const uint DispositionPosixSemantics = 0x00000002;
        const uint DispositionIgnoreReadOnly = 0x00000010;
        const uint VolumeNameDos = 0x0;
        const uint VolumeNameGuid = 0x1;
        const int FileAttributeTagInfo = 9;
        const int FileObject = 1;
        const uint OwnerInformation = 0x00000001;
        const uint DaclInformation = 0x00000004;
        const uint SddlRevision = 1;
        const uint TokenAdjustPrivileges = 0x0020;
        const uint TokenQuery = 0x0008;
        const uint PrivilegeEnabled = 0x00000002;
        const int InitialPathCapacity = 512;
        const string ExtendedPrefix = @"\\?\";
        const string NetworkPrefix = @"\\";

        [StructLayout(LayoutKind.Sequential)]
        struct FileInformation
        {
            public uint Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME Created;
            public System.Runtime.InteropServices.ComTypes.FILETIME Accessed;
            public System.Runtime.InteropServices.ComTypes.FILETIME Written;
            public uint VolumeSerial;
            public uint SizeHigh;
            public uint SizeLow;
            public uint Links;
            public uint IndexHigh;
            public uint IndexLow;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct AttributeTag
        {
            public uint Attributes;
            public uint ReparseTag;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 4)]
        struct TokenPrivilege
        {
            public uint Count;
            public long Luid;
            public uint Attributes;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out AttributeTag information, uint size);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint capacity, uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, IntPtr information, uint size);

        [DllImport("kernel32.dll")]
        static extern IntPtr LocalFree(IntPtr memory);

        [DllImport("kernel32.dll")]
        static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll")]
        static extern bool CloseHandle(IntPtr handle);

        [DllImport("advapi32.dll")]
        static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint information, out IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr descriptor);

        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool SetKernelObjectSecurity(SafeFileHandle handle, uint information, IntPtr descriptor);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, IntPtr size);

        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool LookupPrivilegeValueW(string system, string name, out long luid);

        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref TokenPrivilege state, uint length, IntPtr previous, IntPtr returned);

        readonly SafeFileHandle handle;

        public string FinalPath { get; private set; }
        public string Owner { get; private set; }
        public bool IsDirectory { get; private set; }
        public bool IsLink { get; private set; }
        public bool IsHardLink { get; private set; }

        // The exact name, with none of the rewriting a plain path is given: a
        // name ending in a dot or a space would otherwise open its neighbour.
        static string Extended(string path)
        {
            return path.StartsWith(NetworkPrefix, StringComparison.Ordinal) ? path : ExtendedPrefix + path;
        }

        static Win32Exception LastError()
        {
            return new Win32Exception(Marshal.GetLastWin32Error());
        }

        // Best effort: a privilege the account does not hold stays off, and
        // the open that needed it then fails and says so.
        public static void EnablePrivileges(string[] names)
        {
            IntPtr token;
            if (!OpenProcessToken(GetCurrentProcess(), TokenAdjustPrivileges | TokenQuery, out token)) return;

            try
            {
                foreach (string name in names)
                {
                    TokenPrivilege state = new TokenPrivilege();
                    state.Count = 1;
                    state.Attributes = PrivilegeEnabled;

                    if (LookupPrivilegeValueW(null, name, out state.Luid))
                        AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero);
                }
            }
            finally
            {
                CloseHandle(token);
            }
        }

        // The item the path names, and never what it points at: a link is
        // opened as the link.
        public static MySpeedHandle Open(string path, uint access)
        {
            SafeFileHandle handle = CreateFileW(Extended(path), access, ShareReadWriteDelete, IntPtr.Zero, OpenExisting,
                FlagBackupSemantics | FlagOpenReparsePoint, IntPtr.Zero);

            if (handle.IsInvalid) throw LastError();

            try
            {
                return new MySpeedHandle(handle);
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }

        MySpeedHandle(SafeFileHandle opened)
        {
            handle = opened;

            FileInformation information;
            AttributeTag tag;

            if (!GetFileInformationByHandle(handle, out information)) throw LastError();
            if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, out tag, (uint)Marshal.SizeOf(typeof(AttributeTag)))) throw LastError();

            bool reparse = (information.Attributes & AttributeReparsePoint) != 0;

            // A directory carrying a reparse point of any kind is a link here:
            // the only safe thing to do with a tag this does not know is not
            // to walk through it. A file is one when its tag stands for
            // another name.
            IsDirectory = (information.Attributes & AttributeDirectory) != 0;
            IsLink = reparse && (IsDirectory || (tag.ReparseTag & ReparseTagNameSurrogate) != 0);
            IsHardLink = !IsDirectory && information.Links > 1;
            FinalPath = ReadFinalPath();
            Owner = ReadOwner();
        }

        // By drive letter, or by volume where the volume has none: the same
        // form for every item on it, which is all a comparison needs.
        string ReadFinalPath()
        {
            string path = QueryFinalPath(VolumeNameDos) ?? QueryFinalPath(VolumeNameGuid);

            if (path == null) throw LastError();

            return path;
        }

        string QueryFinalPath(uint form)
        {
            StringBuilder path = new StringBuilder(InitialPathCapacity);
            uint length = GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, form);

            if (length > path.Capacity)
            {
                path = new StringBuilder((int)length);
                length = GetFinalPathNameByHandleW(handle, path, (uint)path.Capacity, form);
            }

            return length == 0 || length > path.Capacity ? null : path.ToString();
        }

        // Null for an owner that cannot be read, which no list of trusted
        // owners contains.
        string ReadOwner()
        {
            IntPtr owner;
            IntPtr descriptor;

            if (GetSecurityInfo(handle, FileObject, OwnerInformation, out owner, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out descriptor) != 0) return null;

            try
            {
                return new SecurityIdentifier(owner).Value;
            }
            finally
            {
                LocalFree(descriptor);
            }
        }

        // Owner and DACL of this one item, exactly as stated. Nothing is
        // handed down to what is beneath it, so a file that has a second name
        // somewhere else cannot have its security rewritten from here.
        public void Secure(string sddl)
        {
            IntPtr descriptor;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SddlRevision, out descriptor, IntPtr.Zero)) throw LastError();

            try
            {
                if (!SetKernelObjectSecurity(handle, OwnerInformation | DaclInformation, descriptor)) throw LastError();
            }
            finally
            {
                LocalFree(descriptor);
            }
        }

        // The name this handle was opened by. A link goes and what it points
        // at stays; a file with other names keeps them, and its read-only
        // attribute, which belongs to all of them, is left as it is.
        //
        // Gone the moment this handle closes, where the file system can do
        // that. The older kind of deletion waits for every other handle to
        // close as well, and any of them may call it off in the meantime.
        public void Delete()
        {
            if (SetDisposition(FileDispositionInfoEx, sizeof(uint), DispositionDelete | DispositionPosixSemantics | DispositionIgnoreReadOnly)) return;
            if (!SetDisposition(FileDispositionInfo, sizeof(byte), DispositionDelete)) throw LastError();
        }

        bool SetDisposition(int kind, int size, uint value)
        {
            IntPtr flags = Marshal.AllocHGlobal(sizeof(uint));

            try
            {
                Marshal.WriteInt32(flags, (int)value);

                return SetFileInformationByHandle(handle, kind, flags, (uint)size);
            }
            finally
            {
                Marshal.FreeHGlobal(flags);
            }
        }

        // Fails where the destination exists. The layout is FILE_RENAME_INFO's:
        // a flag, a root handle that stays empty, the name's length in bytes,
        // the name.
        public void Rename(string destination)
        {
            byte[] name = Encoding.Unicode.GetBytes(Extended(destination));
            int lengthOffset = 2 * IntPtr.Size;
            int nameOffset = lengthOffset + sizeof(int);
            int size = nameOffset + name.Length + sizeof(char);
            IntPtr buffer = Marshal.AllocHGlobal(size);

            try
            {
                for (int offset = 0; offset < size; offset++) Marshal.WriteByte(buffer, offset, 0);

                Marshal.WriteInt32(buffer, lengthOffset, name.Length);
                Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);

                if (!SetFileInformationByHandle(handle, FileRenameInfo, buffer, (uint)size)) throw LastError();
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        public void Dispose()
        {
            handle.Dispose();
        }
    }
'@

function Get-MySpeedOwner {
    param([string]$Path)

    # Null for an owner that cannot be read, which no list of trusted owners
    # contains: a descriptor that hides from SYSTEM is not one to trust.
    #
    # Of a link, this is the owner of the link and not of what it points at -
    # for a junction and for a symbolic link to a directory or a file. Whether
    # a link is one an administrator made rests on that, and the tests hold it
    # to it.
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

function Remove-MySpeedLink {
    param($Item)

    # For the data root only, whose path runs through nothing another account
    # can rearrange. The link itself: neither call descends, so what it points
    # at is untouched.
    if ($Item.PSIsContainer) {
        [System.IO.Directory]::Delete($Item.FullName, $false)
    } else {
        [System.IO.File]::Delete($Item.FullName)
    }
}

function Move-MySpeedItem {
    param($Item, [string]$Destination)

    # For the data root only, whose path runs through nothing another account
    # can rearrange, and a rename does not follow the name it is given.
    #
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

function Import-MySpeedNative {
    if ('MySpeedHandle' -as [type]) { return }

    Add-Type -TypeDefinition $script:MySpeedNativeSource
    [MySpeedHandle]::EnablePrivileges($script:MySpeedPrivileges)
}

function Open-MySpeedVerified {
    param([string]$Path, [string]$ExpectedFinal, [uint32]$Access)

    # The one way an item somebody else may control is ever opened. What comes
    # back is a handle to the item that is really at $ExpectedFinal; a path
    # that reached anything else - through a parent that was swapped for a
    # link - is refused before a thing is read from it. The caller closes it.
    $opened = [MySpeedHandle]::Open($Path, $Access)

    if (-not [string]::Equals($opened.FinalPath, $ExpectedFinal, [System.StringComparison]::OrdinalIgnoreCase)) {
        $final = $opened.FinalPath
        $opened.Dispose()

        throw "$Path changed while it was being checked: the name now leads to $final."
    }

    return $opened
}

function Get-MySpeedFinalPath {
    param([string]$Path)

    # Where a directory this script vouches for really is, in the form a
    # handle reports it - which is what the items in it are compared against.
    Import-MySpeedNative
    $opened = [MySpeedHandle]::Open($Path, [MySpeedHandle]::ForReading)

    try {
        return $opened.FinalPath
    } finally {
        $opened.Dispose()
    }
}

function Get-MySpeedLinkTarget {
    param([string]$Path)

    # For the note only. Read by path, so it is never acted on.
    try {
        return @((Get-Item -LiteralPath $Path -Force).Target) -join ', '
    } catch {
        return 'a target that could not be read'
    }
}

function Remove-MySpeedVerifiedLink {
    param([string]$Path, [string]$ExpectedFinal)

    # Opened again, because removing needs a right that locking does not ask
    # for, and judged again on the new handle: it is the link that is removed,
    # or nothing is.
    $opened = Open-MySpeedVerified -Path $Path -ExpectedFinal $ExpectedFinal -Access ([MySpeedHandle]::ForRemoving)

    try {
        if (-not ($opened.IsLink -or $opened.IsHardLink)) {
            throw "$Path changed while it was being checked: it is no longer a link."
        }

        $opened.Delete()
    } finally {
        $opened.Dispose()
    }
}

function Lock-MySpeedQuarantined {
    param([string]$Path, [string]$ExpectedFinal, [System.Collections.Generic.List[string]]$Notes)

    # From the top down, every item through a handle of its own - see the note
    # on the native source for why a path will not do. $ExpectedFinal is where
    # the item must really be: its parent's own location and its name.
    try {
        Import-MySpeedNative
        $opened = Open-MySpeedVerified -Path $Path -ExpectedFinal $ExpectedFinal -Access ([MySpeedHandle]::ForSecuring)

        try {
            $isDirectory = $opened.IsDirectory
            $isLink = $opened.IsLink
            $isHardLink = $opened.IsHardLink

            # A link is not locked but removed, below: a hard link shares its
            # security with the file's other names, and a junction is nothing
            # an administrator should find themselves walking through.
            if (-not ($isLink -or $isHardLink)) {
                $opened.Secure($(if ($isDirectory) { $script:MySpeedLockedDirectory } else { $script:MySpeedLockedFile }))
            }
        } finally {
            $opened.Dispose()
        }

        if ($isLink) {
            $target = Get-MySpeedLinkTarget $Path
            Remove-MySpeedVerifiedLink -Path $Path -ExpectedFinal $ExpectedFinal
            $Notes.Add("removed link  $Path  ->  $target")

            return
        }

        if ($isHardLink) {
            Remove-MySpeedVerifiedLink -Path $Path -ExpectedFinal $ExpectedFinal
            $Notes.Add("removed hard link  $Path  (the file keeps its other names)")

            return
        }

        if (-not $isDirectory) { return }

        # Listed by path, which can be made to list some other directory - so
        # the names are only candidates, and each is refused by its own check
        # unless it really is in this one.
        foreach ($entry in [System.IO.Directory]::GetFileSystemEntries($Path)) {
            $name = [System.IO.Path]::GetFileName($entry)

            Lock-MySpeedQuarantined -Path "$Path\$name" -ExpectedFinal "$ExpectedFinal\$name" -Notes $Notes
        }
    } catch {
        # Already out of the data directory, which is what the service's
        # safety rests on; a quarantined item that could not be locked is
        # reported, not allowed to fail the installation.
        $Notes.Add("COULD NOT LOCK  $Path  ($($_.Exception.Message))")
    }
}

function Lock-MySpeedQuarantinedTree {
    param([string]$Quarantine, [string]$Relative, [System.Collections.Generic.List[string]]$Notes)

    # The quarantine folder was made by this installation moments ago, under a
    # name nobody could predict and closed from its first instant, so where it
    # is can be taken from it and everything beneath measured against that.
    try {
        $final = Get-MySpeedFinalPath $Quarantine
    } catch {
        $Notes.Add("COULD NOT LOCK  $Quarantine\$Relative  ($($_.Exception.Message))")

        return
    }

    Lock-MySpeedQuarantined -Path "$Quarantine\$Relative" -ExpectedFinal "$final\$Relative" -Notes $Notes
}

function Move-MySpeedForeignItem {
    param([string]$Path, [string]$ExpectedFinal, [string]$Destination, [string]$Relative,
        [string[]]$Trusted, [System.Collections.Generic.List[string]]$Notes)

    # Out of the data directory, through one handle: the item is judged again
    # on it - the search that found it went by path - and then renamed, or
    # removed if it is a link, by that handle and not by its name. True when
    # it now stands in the quarantine and is still to be locked.
    #
    # Fatal, and said in words. An item that cannot be moved cannot be left
    # where it is either - an open handle on a planted file would otherwise be
    # a way to keep it in the directory - and a name that stopped meaning what
    # it meant a moment ago is somebody rearranging the directory under the
    # check. Either way the installation stops, and the log says over what.
    $problem = "MySpeed: {0} does not belong to an administrator and could not be taken out of the data directory ({1}). " +
        'Remove or rename it from an elevated prompt and run the installer again.'

    try {
        Import-MySpeedNative
        $opened = Open-MySpeedVerified -Path $Path -ExpectedFinal $ExpectedFinal -Access ([MySpeedHandle]::ForRemoving)
    } catch {
        throw ($problem -f $Path, $_.Exception.Message)
    }

    try {
        # Changed hands since the search: an administrator's now, and theirs
        # to keep.
        if ($Trusted -contains $opened.Owner) { return $false }

        $owner = Get-MySpeedOwnerLabel $opened.Owner

        # A link is renamed out like anything else and removed where it lands,
        # by the step that locks what was moved. A rename takes effect at once
        # whoever else holds the item open; a deletion may be left waiting for
        # them, and a link waiting to be deleted is a link still in the
        # directory.
        $kind = ''
        if ($opened.IsLink) {
            $kind = " link to $(Get-MySpeedLinkTarget $Path)"
        } elseif ($opened.IsHardLink) {
            $kind = ' hard link'
        }

        [void][System.IO.Directory]::CreateDirectory((Split-Path -Parent $Destination))
        $opened.Rename($Destination)
        $Notes.Add("moved$kind  $Relative  (owner $owner)")

        return $true
    } catch {
        throw ($problem -f $Path, $_.Exception.Message)
    } finally {
        $opened.Dispose()
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
    # following a link, and what arrives in the quarantine is then judged
    # there, each item through a handle of its own.
    $label = Get-MySpeedOwnerLabel $Owner

    if (Test-MySpeedLink $RootItem) {
        $Notes.Add("removed link  $($RootItem.FullName)  ->  $(@($RootItem.Target) -join ', ')  (owner $label)")
        Remove-MySpeedLink $RootItem

        return
    }

    $destination = Join-Path $Quarantine $Name
    Move-MySpeedItem -Item $RootItem -Destination $destination

    $Notes.Add("moved the whole of $($RootItem.FullName) to $Name  (owner $label)")
    Lock-MySpeedQuarantinedTree -Quarantine $Quarantine -Relative $Name -Notes $Notes
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
        '  If the whole directory was moved, your earlier data is in the folder of the same name inside this one, and MySpeed has started with an empty one.',
        '  Whatever is in this folder was made by an account this installation did not trust. Should a folder in it turn out to be a link, do not open it or copy from it.'
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

        $rootFinal = $null

        $sweep = {
            # The search goes by path and only reads, so what it returns are
            # candidates: each is opened and judged again before it is touched.
            foreach ($found in @(Get-MySpeedForeignItems -Directory $root -Trusted $trusted)) {
                if (-not $quarantine) {
                    $rootFinal = Get-MySpeedFinalPath $root
                    $quarantine = New-MySpeedQuarantine $root
                }

                $relative = $found.Item.FullName.Substring($root.Length).TrimStart('\')

                $moved = Move-MySpeedForeignItem -Path $found.Item.FullName -ExpectedFinal "$rootFinal\$relative" `
                    -Destination (Join-Path (Join-Path $quarantine $leaf) $relative) -Relative $relative `
                    -Trusted $trusted -Notes $notes

                if ($moved) {
                    Lock-MySpeedQuarantinedTree -Quarantine $quarantine -Relative "$leaf\$relative" -Notes $notes
                }
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
