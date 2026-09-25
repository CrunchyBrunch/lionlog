param([Parameter(Mandatory = $true)][int]$ProcessIdValue)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class NativeWindowsArguments {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr pointer);

    public static string[] Parse(string commandLine) {
        int count;
        IntPtr block = CommandLineToArgvW(commandLine, out count);
        if (block == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot parse browser command line");
        try {
            string[] result = new string[count];
            for (int index = 0; index < count; index++)
                result[index] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(block, index * IntPtr.Size));
            return result;
        } finally {
            LocalFree(block);
        }
    }
}
'@

$value = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessIdValue"
if ($null -eq $value) { return }
$created = [Diagnostics.Process]::GetProcessById($ProcessIdValue).StartTime.ToUniversalTime().Ticks
$rounded = [long]$value.CreationDate.ToUniversalTime().Ticks
if ($created -lt $rounded -or $created - $rounded -ge 10) {
    throw 'Browser process identity changed during inspection.'
}
$argumentsValue = [NativeWindowsArguments]::Parse([string]$value.CommandLine)
[pscustomobject]@{
    pid = [int]$value.ProcessId
    parentPid = [int]$value.ParentProcessId
    creationDate = [string]$value.CreationDate
    creationTicks = [string]$created
    executablePath = [string]$value.ExecutablePath
    commandLine = [string]$value.CommandLine
    arguments = $argumentsValue
} | ConvertTo-Json -Compress
