"""Builds the scan-type test files (run after make-fixtures.ps1, Windows with Microsoft Edge).
  python test/make-fixtures.py
    fixtures/line.png    one line of Thaana, for the reading-model smoke test
    fixtures/page.png    a page of Thaana text, as a 'scan'
    fixtures/mixed.pdf   page 1 typed (from typed.pdf), page 2 a scanned picture
    fixtures/form.pdf    typed.pdf drawn twice, each copy inside a form XObject (two-up)
"""
import json, os, subprocess, tempfile
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, FloatObject, NameObject, DictionaryObject

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'fixtures')
EDGE = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
spec = json.load(open(os.path.join(HERE, 'fixtures.json'), encoding='utf8'))


def shot(html, png, w, h):
    with tempfile.TemporaryDirectory() as d:
        f = os.path.join(d, 'p.html')
        open(f, 'w', encoding='utf8').write(html)
        subprocess.run([EDGE, '--headless', '--disable-gpu', '--hide-scrollbars', f'--user-data-dir={d}\\prof',
                        f'--screenshot={png}', f'--window-size={w},{h}', 'file:///' + f.replace('\\', '/')],
                       check=True, capture_output=True, timeout=60)


css = "body{margin:40px;background:#fff;color:#000;font-family:'MV Boli';direction:rtl;text-align:justify}"
shot(f"<html><body style=\"{css};font-size:40px\">ޤައުމުގައި ގާތްގަނޑަކަށް ރަށް ހުރެއެވެ</body></html>", os.path.join(OUT, 'line.png'), 900, 140)
page = ''.join(f'<p>{p}</p>' for p in spec['paragraphs'] * 3)
shot(f"<html><body style=\"{css};font-size:30px;line-height:1.9\">{page}</body></html>", os.path.join(OUT, 'page.png'), 1240, 1754)

# mixed.pdf: typed page + scanned page
scan_pdf = os.path.join(OUT, '_scan.pdf')
Image.open(os.path.join(OUT, 'page.png')).convert('L').convert('P').save(scan_pdf, resolution=150)
w = PdfWriter()
w.add_page(PdfReader(os.path.join(OUT, 'typed.pdf')).pages[0])
w.add_page(PdfReader(scan_pdf).pages[0])
w.write(os.path.join(OUT, 'mixed.pdf'))
os.remove(scan_pdf)

# form.pdf: the typed page as a form XObject, drawn twice at half size side by side
w = PdfWriter()
page = w.add_page(PdfReader(os.path.join(OUT, 'typed.pdf')).pages[0])   # copied properly, fonts and all
W, H = float(page.mediabox.width), float(page.mediabox.height)
res, data = page['/Resources'], page.get_contents().get_data()
forms = {}
for name, dx in (('/Fx1', 0), ('/Fx2', W * 0.5 + 20)):      # the offset is in the form's own /Matrix
    form = DecodedStreamObject()
    form.set_data(data)
    form.update({NameObject('/Type'): NameObject('/XObject'), NameObject('/Subtype'): NameObject('/Form'),
                 NameObject('/BBox'): ArrayObject([FloatObject(0), FloatObject(0), FloatObject(W), FloatObject(H)]),
                 NameObject('/Matrix'): ArrayObject([FloatObject(v) for v in (0.5, 0, 0, 0.5, dx, 0)]),
                 NameObject('/Resources'): res})
    forms[NameObject(name)] = w._add_object(form)
page[NameObject('/Resources')] = DictionaryObject({NameObject('/XObject'): DictionaryObject(forms)})
body = DecodedStreamObject()
body.set_data(b'/Fx1 Do /Fx2 Do')
page[NameObject('/Contents')] = w._add_object(body)
page.mediabox.upper_right = (W + 20, H * 0.5)
w.write(os.path.join(OUT, 'form.pdf'))
print('wrote line.png page.png mixed.pdf form.pdf')

# columns.png: a two-column newspaper-style page (different text in each column)
words = ' '.join(spec['paragraphs'] + [spec['after']] + [c for r in spec['table'] for c in r]).split()
import random
rnd = random.Random(7)
col = lambda: ' '.join(rnd.choice(words) for _ in range(120))
shot(f"<html><body style=\"{css};font-size:28px;line-height:1.7\"><h1 style='font-size:44px;text-align:center'>{spec['after']}</h1>"
     f"<div style='columns:2;column-gap:60px'><p>{col()}</p><p>{col()}</p></div></body></html>", os.path.join(OUT, 'columns.png'), 1240, 1754)
print('wrote columns.png')
