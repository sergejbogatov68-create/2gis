param([string]$DesktopPath = [Environment]::GetFolderPath('Desktop'))
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskStart = Join-Path $taskRoot 'Start.cmd'
if (-not (Test-Path -LiteralPath $taskStart)) { throw 'Не найден Start.cmd рядом с приложением.' }
if (-not (Test-Path -LiteralPath $DesktopPath -PathType Container)) { throw 'Папка рабочего стола не найдена.' }
$taskIcon = Join-Path $taskRoot 'public\app.ico'
if (-not (Test-Path -LiteralPath $taskIcon)) {
    Add-Type -AssemblyName System.Drawing
    $taskBitmap = New-Object Drawing.Bitmap 64,64
    $taskGraphics = [Drawing.Graphics]::FromImage($taskBitmap)
    $taskPen = New-Object Drawing.Pen ([Drawing.ColorTranslator]::FromHtml('#D2E9A8')),5
    try {
        $taskGraphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $taskGraphics.Clear([Drawing.ColorTranslator]::FromHtml('#202923'))
        $taskPen.StartCap = [Drawing.Drawing2D.LineCap]::Round
        $taskPen.EndCap = [Drawing.Drawing2D.LineCap]::Round
        $taskGraphics.DrawArc($taskPen,15,15,34,34,180,270)
        $taskGraphics.DrawArc($taskPen,23,23,18,18,180,270)
        $taskBrush = New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml('#D2E9A8'))
        try { $taskGraphics.FillEllipse($taskBrush,29,29,6,6) } finally { $taskBrush.Dispose() }
        $taskNativeIcon = [Drawing.Icon]::FromHandle($taskBitmap.GetHicon())
        $taskStream = [IO.File]::Create($taskIcon)
        try { $taskNativeIcon.Save($taskStream) } finally { $taskStream.Dispose(); $taskNativeIcon.Dispose() }
    } finally { $taskPen.Dispose(); $taskGraphics.Dispose(); $taskBitmap.Dispose() }
}
$taskLink = Join-Path $DesktopPath 'Контур.lnk'
if (Test-Path -LiteralPath $taskLink) {
    $taskExistingShell = New-Object -ComObject WScript.Shell
    $taskExisting = $taskExistingShell.CreateShortcut($taskLink)
    if ($taskExisting.Arguments -notlike "*$taskStart*") {
        $taskLink = Join-Path $DesktopPath 'Контур — локальные агенты.lnk'
        if (Test-Path -LiteralPath $taskLink) { throw 'Ярлыки с обоими именами уже существуют. Существующие ярлыки не изменены.' }
    }
}
$taskShell = New-Object -ComObject WScript.Shell
$taskShortcut = $taskShell.CreateShortcut($taskLink)
$taskShortcut.TargetPath = $env:ComSpec
$taskShortcut.Arguments = '/d /c ""' + $taskStart + '""'
$taskShortcut.WorkingDirectory = $taskRoot
$taskShortcut.IconLocation = $taskIcon + ',0'
$taskShortcut.Description = 'Контур — локальная студия агентов и база компаний'
$taskShortcut.WindowStyle = 7
$taskShortcut.Save()
$taskVerified = $taskShell.CreateShortcut($taskLink)
[pscustomobject]@{ Shortcut = $taskLink; Target = $taskVerified.TargetPath; Arguments = $taskVerified.Arguments; WorkingDirectory = $taskVerified.WorkingDirectory; Icon = $taskVerified.IconLocation }
