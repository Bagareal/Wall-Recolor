param([int]$Port = 8080, [switch]$NoBrowser)
# Tiny local web server for Wall Recolor (no install needed, Windows PowerShell only).
# Serving from localhost lets the app use the AI models in .\models\ if you downloaded them (see README).
$root = (Resolve-Path $PSScriptRoot).Path
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch { Write-Host "Could not start on port $Port. Is it already running?"; Read-Host "Press Enter to close"; exit 1 }
$url = "http://localhost:$Port/index.html"
Write-Host "Wall Recolor is running at $url"
Write-Host "Keep this window open while you use it. Close it to stop."
if (-not $NoBrowser) { Start-Process $url }
$mime = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript'; '.mjs'='text/javascript'; '.css'='text/css'; '.json'='application/json';
           '.txt'='text/plain'; '.onnx'='application/octet-stream'; '.wasm'='application/wasm'; '.png'='image/png'; '.jpg'='image/jpeg'; '.woff2'='font/woff2' }
while ($listener.IsListening) {
  $ctx = $listener.GetContext(); $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ($rel -eq '') { $rel = 'index.html' }
    $file = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if (-not $file.StartsWith($root) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { $res.StatusCode = 404 }
    else {
      $ext = [IO.Path]::GetExtension($file).ToLower()
      $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      if ($rel -like 'models/*') { $res.AddHeader('Cache-Control', 'public, max-age=31536000') }
      $fs = [IO.File]::OpenRead($file)
      $res.ContentLength64 = $fs.Length
      $fs.CopyTo($res.OutputStream); $fs.Close()
    }
  } catch { } finally { try { $res.Close() } catch { } }
}
