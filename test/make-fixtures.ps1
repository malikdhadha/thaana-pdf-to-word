# Builds test PDFs with Microsoft Word (Windows only) from test/fixtures.json.
#   pwsh test/make-fixtures.ps1        -> test/fixtures/typed.pdf, typed-noborders.pdf
# Then:  python test/make-fixtures.py  -> mixed.pdf (typed page + scanned page), form.pdf (text inside form XObjects)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$out = Join-Path $here 'fixtures'
New-Item -ItemType Directory -Force $out | Out-Null
$spec = Get-Content (Join-Path $here 'fixtures.json') -Raw -Encoding utf8 | ConvertFrom-Json

$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
  foreach ($borders in @($true, $false)) {
    $doc = $word.Documents.Add()
    $sel = $word.Selection
    $sel.ParagraphFormat.ReadingOrder = 0          # right-to-left
    $sel.ParagraphFormat.Alignment = 3             # justify
    $sel.Font.Name = 'Calibri'; $sel.Font.NameBi = 'MV Boli'; $sel.Font.Size = 12; $sel.Font.SizeBi = 14
    foreach ($p in $spec.paragraphs) { $sel.TypeText($p); $sel.TypeParagraph() }
    $rows = $spec.table.Count; $cols = $spec.table[0].Count
    $t = $doc.Tables.Add($sel.Range, $rows, $cols)
    $t.TableDirection = 0                          # right-to-left table
    $t.Borders.Enable = [int]$borders
    for ($r = 0; $r -lt $rows; $r++) { for ($c = 0; $c -lt $cols; $c++) {
      $cell = $t.Cell($r + 1, $c + 1).Range
      $cell.Text = $spec.table[$r][$c]
      $cell.ParagraphFormat.ReadingOrder = 0
      $cell.Font.NameBi = 'MV Boli'; $cell.Font.SizeBi = 14
    } }
    $sel.EndKey(6) | Out-Null                      # end of document
    $sel.TypeParagraph(); $sel.TypeText($spec.after)
    $name = if ($borders) { 'typed.pdf' } else { 'typed-noborders.pdf' }
    $doc.ExportAsFixedFormat((Join-Path $out $name), 17)
    $doc.Close(0)
    Write-Output "wrote $name"
  }
} finally { $word.Quit() }
