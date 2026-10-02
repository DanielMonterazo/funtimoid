# FuntimoID

Identificador de tipos da **Funtimod S.A.** em capas de disco e outros impressos.

Envie a foto de uma capa, selecione o texto e ajuste a nitidez. Depois, detecte e rotule os caracteres: o FuntimoID compara cada letra com os glifos extraídos dos dois catálogos de tipos da Funtimod (catálogo 06 e catálogo 07) e ranqueia as famílias mais parecidas, com sobreposição visual e métricas (IoU, Chamfer, HD95, largura e peso).

## Como funciona

1. **Recorte e rótulos** — binarização (Multinível, Sauvola, Otsu ou manual), limpeza de manchas e fios, retoque com pincel e borracha, detecção automática dos caracteres.
2. **Identificação** — cada letra é normalizada e encaixada contra as referências, com compensação de ganho de tinta.
3. **Catálogo Funtimod** — 59 famílias, com tabela alfabética e as páginas originais dos catálogos.
4. **Meu acervo** — amostras e referências salvas ficam no `localStorage` do navegador.

Tudo roda no navegador; nenhuma imagem é enviada para servidor.

## Estrutura

- `index.html` — o site montado (é o que o GitHub Pages publica)
- `src/` — fontes: marcação, estilos, lógica de interface (`app.js`) e processamento de imagem (`core.js`)
- `funtimod.json` — glifos de referência extraídos dos catálogos
- `thumbs/` — páginas dos catálogos em baixa resolução
- `build.py` — remonta o `index.html` a partir de `src/`

Tipografia da interface: Rokkitt (alternativa livre à Memphis) e Host Grotesk, via Google Fonts. O logo usa contornos da Memphis.

Vetorização com [imagetracerjs](https://github.com/jankovicsandras/imagetracerjs) (domínio público).
