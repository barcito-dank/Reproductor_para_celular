Add-Type -AssemblyName System.Drawing
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path $scriptDir -Parent
$resourcesDir = Join-Path $projectRoot "resources"
$buildDir = Join-Path $projectRoot "build"

New-Item -ItemType Directory -Force -Path $resourcesDir | Out-Null
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

$size = 256
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

$g.Clear([System.Drawing.Color]::Transparent)

$rect = New-Object System.Drawing.Rectangle 12, 12, 232, 232
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.ColorTranslator]::FromHtml('#1e1b4b')), ([System.Drawing.ColorTranslator]::FromHtml('#09090b')), 45.0
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
[float]$d = 56
$path.AddArc([float]$rect.X, [float]$rect.Y, $d, $d, 180, 90)
$path.AddArc([float]($rect.Right - $d), [float]$rect.Y, $d, $d, 270, 90)
$path.AddArc([float]($rect.Right - $d), [float]($rect.Bottom - $d), $d, $d, 0, 90)
$path.AddArc([float]$rect.X, [float]($rect.Bottom - $d), $d, $d, 90, 90)
$path.CloseFigure()

$g.FillPath($brush, $path)

$pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#8b5cf6')), 6
$g.DrawPath($pen, $path)

$font = [System.Drawing.Font]::new("Segoe UI Symbol", [float]96.0, [System.Drawing.FontStyle]::Bold)
$noteBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.ColorTranslator]::FromHtml('#ec4899')), ([System.Drawing.ColorTranslator]::FromHtml('#8b5cf6')), 45.0
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center

$g.DrawString([char]0x266B, $font, $noteBrush, (New-Object System.Drawing.RectangleF 12, 20, 232, 220), $sf)

$pngPath = Join-Path $resourcesDir "icon.png"
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
Copy-Item $pngPath (Join-Path $buildDir "icon.png") -Force

$hIcon = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hIcon)
$icoPath = Join-Path $resourcesDir "icon.ico"
$fs1 = New-Object System.IO.FileStream ($icoPath), ([System.IO.FileMode]::Create)
$icon.Save($fs1)
$fs1.Close()

Copy-Item $icoPath (Join-Path $buildDir "icon.ico") -Force

$icon.Dispose()
$bmp.Dispose()
$g.Dispose()

Write-Output "ICONS_GENERATED_SUCCESSFULLY"
