$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path $scriptDir -Parent

$distDir = Join-Path $projectRoot "dist"
$targetDir = Join-Path $projectRoot "Aplicacion_Compilada"
$installerDir = Join-Path $targetDir "Instalador"
$portableDir = Join-Path $targetDir "Version_Portable"

New-Item -ItemType Directory -Force -Path $installerDir | Out-Null
New-Item -ItemType Directory -Force -Path $portableDir | Out-Null

# Copiar instalador
$setupExe = Get-ChildItem -Path $distDir -Filter "*Setup*.exe" | Select-Object -First 1
if ($setupExe) {
    Copy-Item $setupExe.FullName (Join-Path $installerDir "Instalador_Reproductor_de_Musica.exe") -Force
}

# Copiar ejecutable portable
$portableExe = Get-ChildItem -Path $distDir -Filter "*.exe" | Where-Object { $_.Name -notmatch "Setup" } | Select-Object -First 1
if ($portableExe) {
    Copy-Item $portableExe.FullName (Join-Path $portableDir "Reproductor_de_Musica_Portable.exe") -Force
}

# Crear acceso directo en la raiz de Aplicacion_Compilada
$wsh = New-Object -ComObject WScript.Shell
$shortcutPath = Join-Path $targetDir "Iniciar Reproductor.lnk"
$unpackedExe = Get-ChildItem -Path (Join-Path $projectRoot "dist\win-unpacked") -Filter "*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
$iconPath = Join-Path $projectRoot "build\icon.ico"

if ($unpackedExe) {
    $sc = $wsh.CreateShortcut($shortcutPath)
    $sc.TargetPath = $unpackedExe.FullName
    $sc.WorkingDirectory = $unpackedExe.DirectoryName
    if (Test-Path $iconPath) {
        $sc.IconLocation = "$iconPath,0"
    }
    $sc.Description = "Iniciar Reproductor de Musica"
    $sc.Save()
}

# Crear LEEME.txt
$readmeContent = @"
========================================================================
                      REPRODUCTOR DE MUSICA
                 Archivos de la Aplicacion Compilada
========================================================================

Esta carpeta contiene la aplicacion lista para ser utilizada por el usuario final,
completamente independiente del entorno de desarrollo.

CONTENIDO:
------------------------------------------------------------------------
1. "Iniciar Reproductor.lnk"
   - Acceso directo rapido para ejecutar la aplicacion inmediatamente
     sin necesidad de instalar nada.

2. Carpeta "Instalador/"
   - "Instalador_Reproductor_de_Musica.exe"
   - Instalador estandar para Windows (.exe con NSIS).
   - Crea accesos directos en el Escritorio y en el Menu Inicio.

3. Carpeta "Version_Portable/"
   - "Reproductor_de_Musica_Portable.exe"
   - Version standalone que no requiere instalacion. Ideal para llevar
     en un pendrive o ejecutar en cualquier PC con Windows.

DONDE GUARDAR TU MUSICA:
------------------------------------------------------------------------
Por defecto, el reproductor buscara tus canciones en:
C:\Users\$($env:USERNAME)\Music\canciones_organizadas
o en la carpeta "canciones_organizadas" de este proyecto.
Puedes cambiar esta carpeta en cualquier momento desde el menu de Ajustes
en la barra superior del reproductor.
"@

Set-Content -Path (Join-Path $targetDir "LEEME.txt") -Value $readmeContent -Encoding UTF8

Write-Output "APLICACION_COMPILADA_ACTUALIZADA_EXITOSAMENTE"
