param(
  [Parameter(Mandatory=$true)][string]$Action,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 0,
  [int]$H = 0,
  [string]$Text = "",
  [string]$Key = "",
  [int]$Amount = 0,
  [int]$Button = 1,
  [string]$Out = "",
  [int]$X2 = 0,
  [int]$Y2 = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32Ops {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

function Out-Json($obj) {
  $obj | ConvertTo-Json -Compress -Depth 4
}

switch ($Action.ToLower()) {
  'info' {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $h = [Win32Ops]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 512
    [void][Win32Ops]::GetWindowText($h, $sb, 512)
    $r = New-Object Win32Ops+RECT
    [void][Win32Ops]::GetWindowRect($h, [ref]$r)
    Out-Json @{
      screen = @{ width = $b.Width; height = $b.Height }
      foreground = @{
        title = $sb.ToString()
        left = $r.Left; top = $r.Top
        width = $r.Right - $r.Left
        height = $r.Bottom - $r.Top
      }
      dpi = @{ x = [System.Windows.Forms.SystemInformation]::PrimaryMonitorSize.Width }
    }
  }

  'screenshot' {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    if ($W -le 0) { $W = $b.Width }
    if ($H -le 0) { $H = $b.Height }
    if ($X -lt 0) { $X = 0 }
    if ($Y -lt 0) { $Y = 0 }
    if (($X + $W) -gt $b.Width)  { $W = $b.Width - $X }
    if (($Y + $H) -gt $b.Height) { $H = $b.Height - $Y }
    $bmp = New-Object System.Drawing.Bitmap $W, $H
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($X, $Y, 0, 0, $bmp.Size)
    $g.Dispose()
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Out-Json @{ ok = $true; path = $Out; x = $X; y = $Y; width = $W; height = $H }
  }

  'move' {
    [void][Win32Ops]::SetCursorPos($X, $Y)
    Out-Json @{ ok = $true; x = $X; y = $Y }
  }

  'click' {
    [void][Win32Ops]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 60
    if ($Button -eq 2) {
      [Win32Ops]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
      [Win32Ops]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
    } else {
      [Win32Ops]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      [Win32Ops]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    }
    Out-Json @{ ok = $true; x = $X; y = $Y; button = $Button }
  }

  'doubleclick' {
    [void][Win32Ops]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 60
    [Win32Ops]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [Win32Ops]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    [Win32Ops]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [Win32Ops]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Out-Json @{ ok = $true; x = $X; y = $Y; double = $true }
  }

  'drag' {
    [void][Win32Ops]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 80
    [Win32Ops]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    $steps = 12
    for ($i = 1; $i -le $steps; $i++) {
      $nx = [int]($X + ($X2 - $X) * $i / $steps)
      $ny = [int]($Y + ($Y2 - $Y) * $i / $steps)
      [void][Win32Ops]::SetCursorPos($nx, $ny)
      Start-Sleep -Milliseconds 20
    }
    [Win32Ops]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Out-Json @{ ok = $true; from = @{ x = $X; y = $Y }; to = @{ x = $X2; y = $Y2 } }
  }

  'scroll' {
    [void][Win32Ops]::SetCursorPos($X, $Y)
    $n = [Math]::Abs($Amount)
    for ($i = 0; $i -lt $n; $i++) {
      if ($Amount -gt 0) {
        [Win32Ops]::mouse_event(0x0800, 0, 0, 120, [UIntPtr]::Zero)
      } else {
        [Win32Ops]::mouse_event(0x0800, 0, 0, -120, [UIntPtr]::Zero)
      }
      Start-Sleep -Milliseconds 25
    }
    Out-Json @{ ok = $true; amount = $Amount }
  }

  'type' {
    # Clipboard + Ctrl+V handles CJK; per-char keybd_event does not.
    # 先存下用户原来的剪贴板，粘贴完再放回去（原版会直接覆盖）。
    $old = $null
    try { $old = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
    Set-Clipboard -Value $Text
    Start-Sleep -Milliseconds 120
    [Win32Ops]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
    [Win32Ops]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)
    [Win32Ops]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero)
    [Win32Ops]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 200
    if ($null -ne $old) { try { Set-Clipboard -Value $old } catch {} }
    Out-Json @{ ok = $true; typed = $Text.Length }
  }

  'key' {
    $map = @{
      'enter' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B; 'space' = 0x20
      'backspace' = 0x08; 'delete' = 0x2E; 'up' = 0x26; 'down' = 0x28
      'left' = 0x25; 'right' = 0x27; 'home' = 0x24; 'end' = 0x23
      'pageup' = 0x21; 'pagedown' = 0x22; 'win' = 0x5B
    }
    $k = $Key.ToLower()
    if ($k -match '^f(\d+)$') {
      $vk = 0x6F + [int]$Matches[1]
    } elseif ($map.ContainsKey($k)) {
      $vk = $map[$k]
    } else {
      $vk = [int][char]$k.ToUpper()[0]
    }
    [Win32Ops]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
    [Win32Ops]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
    Out-Json @{ ok = $true; key = $Key; vk = $vk }
  }

  'sendliteral' {
    [System.Windows.Forms.SendKeys]::SendWait($Text)
    Out-Json @{ ok = $true; sent = $Text }
  }

  default {
    Out-Json @{ error = "unknown action: $Action" }
    exit 1
  }
}
