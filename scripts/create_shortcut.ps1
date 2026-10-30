$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path $scriptDir -Parent
$desktopPath = [Environment]::GetFolderPath('Desktop')
Remove-Item (Join-Path $desktopPath '*Reproductor*') -Force -ErrorAction SilentlyContinue

$wsh = New-Object -ComObject WScript.Shell
$shortcutPath = Join-Path $desktopPath 'Reproductor de Musica.lnk'
$unpackedExe = Get-ChildItem -Path (Join-Path $projectRoot "dist\win-unpacked") -Filter "*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
$iconPath = Join-Path $projectRoot "build\icon.ico"

if ($unpackedExe) {
    $sc = $wsh.CreateShortcut($shortcutPath)
    $sc.TargetPath = $unpackedExe.FullName
    $sc.WorkingDirectory = $unpackedExe.DirectoryName
    if (Test-Path $iconPath) {
        $sc.IconLocation = "$iconPath,0"
    }
    $sc.Description = "Reproductor de Musica"
    $sc.Save()
    Write-Output "SHORTCUT_CREATED: $shortcutPath"
} else {
    Write-Warning "No se encontro el ejecutable en dist\win-unpacked"
}
