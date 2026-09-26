param([Parameter(Mandatory = $true)][string]$IdentityBase64)

$ErrorActionPreference = 'Stop'
$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($IdentityBase64)) | ConvertFrom-Json

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class BrowserProcessHandle {
    private const uint Access = 0x00101001; // SYNCHRONIZE | QUERY_LIMITED_INFORMATION | TERMINATE
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr handle, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);

    public static IntPtr Open(int pid) {
        var handle = OpenProcess(Access, false, pid);
        if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot retain browser process handle");
        return handle;
    }
    public static void Terminate(IntPtr handle) {
        // All retries address this handle, never a PID looked up after validation.
        for (int attempt = 0; attempt < 4; attempt++) {
            if (WaitForSingleObject(handle, 0) == 0) return;
            if (!TerminateProcess(handle, 1) && WaitForSingleObject(handle, 0) != 0)
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Owned browser termination failed");
            if (WaitForSingleObject(handle, 1000) == 0) return;
        }
        throw new TimeoutException("Owned browser process did not terminate within the cleanup bound");
    }
    public static long Created(IntPtr handle) {
        long creation, exit, kernel, user;
        if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot read retained browser process creation time");
        return DateTime.FromFileTimeUtc(creation).Ticks;
    }
    public static void Close(IntPtr handle) { if (handle != IntPtr.Zero) CloseHandle(handle); }
}
'@

function Assert-Identity($actual, $reference) {
    if ($null -eq $actual -or
        [int]$actual.ProcessId -ne [int]$reference.pid -or
        [int]$actual.ParentProcessId -ne [int]$reference.parentPid -or
        [string]$actual.CreationDate -cne [string]$reference.creationDate -or
        ([long]$reference.creationTicks - [long]$actual.CreationDate.ToUniversalTime().Ticks) -lt 0 -or
        ([long]$reference.creationTicks - [long]$actual.CreationDate.ToUniversalTime().Ticks) -ge 10 -or
        [string]$actual.ExecutablePath -ine [string]$reference.executablePath -or
        [string]$actual.CommandLine -cne [string]$reference.commandLine) {
        throw 'Browser process identity changed before handle-bound termination.'
    }
}

$handles = [Collections.Generic.List[System.IntPtr]]::new()
try {
    try { $rootHandle = [BrowserProcessHandle]::Open([int]$expected.pid) }
    catch [ComponentModel.Win32Exception] {
        if ($_.Exception.NativeErrorCode -eq 87) { return } # The original process no longer exists.
        throw
    }
    $handles.Add($rootHandle)
    if ([BrowserProcessHandle]::Created($rootHandle) -ne [long]$expected.creationTicks) {
        throw 'Browser process identity changed before handle-bound termination.'
    }
    $root = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$expected.pid)"
    if ($null -ne $root) { Assert-Identity $root $expected }
    # The original can exit between inspection and this query. Its retained
    # handle and exact creation time still pin the parent PID for child lookup.

    # Hold each ancestor before discovering its children. This pins every PID in
    # the lineage until all validated process handles have been terminated.
    $known = @{}
    $known[[int]$expected.pid] = [long]$expected.creationTicks
    [BrowserProcessHandle]::Terminate($rootHandle)
    # Each parent is stopped before discovering its children. Retained handles
    # keep the parent PIDs unavailable for reuse throughout the traversal.
    for ($depth = 1; $depth -le 8; $depth++) {
        $added = 0
        $inventory = @(Get-CimInstance Win32_Process)
        foreach ($candidate in $inventory) {
            $pidValue = [int]$candidate.ProcessId
            if ($known.ContainsKey($pidValue) -or -not $known.ContainsKey([int]$candidate.ParentProcessId)) { continue }
            if ([string]$candidate.ExecutablePath -ine [string]$expected.executablePath) { continue }
            try { $childHandle = [BrowserProcessHandle]::Open($pidValue) }
            catch [ComponentModel.Win32Exception] {
                if ($_.Exception.NativeErrorCode -eq 87) { continue }
                throw
            }
            $handles.Add($childHandle)
            $current = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue"
            if ($null -eq $current) { continue }
            if ([int]$current.ParentProcessId -ne [int]$candidate.ParentProcessId -or
                [string]$current.CreationDate.ToUniversalTime().Ticks -cne [string]$candidate.CreationDate.ToUniversalTime().Ticks -or
                [string]$current.ExecutablePath -ine [string]$expected.executablePath -or
                [string]$current.CommandLine -cne [string]$candidate.CommandLine) {
                throw 'Browser descendant identity changed before handle-bound termination.'
            }
            $created = [BrowserProcessHandle]::Created($childHandle)
            if (($created - [long]$current.CreationDate.ToUniversalTime().Ticks) -lt 0 -or
                ($created - [long]$current.CreationDate.ToUniversalTime().Ticks) -ge 10) {
                throw 'Browser descendant creation identity is not bound to its retained parent.'
            }
            if ($created -le [long]$known[[int]$current.ParentProcessId]) { continue }
            $known[$pidValue] = $created
            [BrowserProcessHandle]::Terminate($childHandle)
            $added++
        }
        if ($added -eq 0) { break }
    }
    if ($depth -gt 8) { throw 'Browser descendant depth exceeds the cleanup bound.' }
} finally {
    foreach ($handle in $handles) { [BrowserProcessHandle]::Close($handle) }
}
