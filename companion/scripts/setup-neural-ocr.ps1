param([Parameter(Mandatory=$true)][string]$PythonPath)
$ErrorActionPreference = 'Stop'
# All packages are private to this project. Existing Expo/Node dependencies are never touched.
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$targetRoot = Join-Path $projectRoot '.tools/neural-ocr'
$runtimeDir = Join-Path $targetRoot 'runtime'
$modelDir = Join-Path $targetRoot 'models'
$pythonExe = (Resolve-Path -LiteralPath $PythonPath).Path
New-Item -ItemType Directory -Force -Path $runtimeDir,$modelDir | Out-Null
& $pythonExe -m pip install --disable-pip-version-check --target $runtimeDir 'onnxruntime==1.23.2' 'numpy==2.2.6' 'Pillow==11.3.0'
if ($LASTEXITCODE -ne 0) { throw 'Local OCR packages could not be prepared.' }
$modelFile = Join-Path $modelDir 'ch_PP-OCRv5_rec_mobile.onnx'
$expectedHash = '5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5'
if (!(Test-Path -LiteralPath $modelFile) -or (Get-FileHash -LiteralPath $modelFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
  $downloadFile = $modelFile + '.download'
  Invoke-WebRequest -Uri 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile.onnx' -OutFile $downloadFile
  if ((Get-FileHash -LiteralPath $downloadFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'Model checksum mismatch; existing model preserved.' }
  Move-Item -LiteralPath $downloadFile -Destination $modelFile -Force
}
$configFile = Join-Path $targetRoot 'config.json'
[IO.File]::WriteAllText($configFile, (@{python=$pythonExe} | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Write-Output 'Local OCR prepared. Restart the companion service to enable it.'
