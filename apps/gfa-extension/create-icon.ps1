Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(128,128)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(234,88,12))
$g.FillRectangle($brush, 0, 0, 128, 128)
$font = New-Object System.Drawing.Font('Arial', 56, [System.Drawing.FontStyle]::Bold)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$rect = New-Object System.Drawing.RectangleF(0, 0, 128, 128)
$g.DrawString('B', $font, [System.Drawing.Brushes]::White, $rect, $sf)
$g.Dispose()
$bmp.Save("$PSScriptRoot\media\icon.png", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "Icon created successfully"
