"""Monta o index.html a partir de src/. Uso: python3 build.py"""
from pathlib import Path
S = Path('src')
head = (S / 'head.html').read_text().replace('</style>', (S / 'soft.css').read_text() + '\n</style>')
body = (S / 'body.html').read_text()
js = lambda f: f'<script>\n{(S / f).read_text()}</script>\n'
html = ('<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        + head + '\n</head>\n<body>\n' + body
        + js('imagetracer.min.js') + js('core.js') + js('app.js') + js('soft.js') + '</body>\n</html>\n')
Path('index.html').write_text(html)
print('index.html', len(html), 'bytes')
