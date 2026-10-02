# FuntimoID

Identificador de tipos da **Funtimod S.A.** em capas de disco e outros impressos.

Envie a foto de uma capa, selecione o texto e ajuste a nitidez. Depois, detecte e rotule os caracteres: o FuntimoID compara cada letra com os glifos extraídos dos dois catálogos de tipos da Funtimod (catálogo 06 e catálogo 07) e ranqueia as famílias mais parecidas, com sobreposição visual e métricas (IoU, Chamfer, HD95, largura e peso).

## Como funciona

1. **Recorte e rótulos** — binarização (Multinível, Sauvola, Otsu ou manual), limpeza de manchas e fios, retoque com pincel e borracha, detecção automática dos caracteres e editor de vetor com caneta para completar ou corrigir cada caractere.
2. **Identificação** — cada letra é normalizada e encaixada contra as referências, com compensação de ganho de tinta.
3. **Catálogo Funtimod** — 59 famílias, com tabela alfabética e as páginas originais dos catálogos.
4. **Meu acervo** — amostras e referências salvas ficam no `localStorage` do navegador.

Tudo roda no navegador; nenhuma imagem é enviada para servidor.

## Estrutura

- `index.html` — marcação da página (é o que o GitHub Pages publica)
- `src/base.css` — estilos base da interface
- `src/soft.css` — camada visual da versão soft (moldura dupla, navegação flutuante, títulos em Rokkitt)
- `src/app.js` — lógica de interface e editor de vetor; `src/core.js` — processamento de imagem e métricas; `src/soft.js` — animações de entrada
- `src/paper-core.min.js` — [Paper.js](http://paperjs.org) 0.12.18 (MIT), base do editor de vetor com caneta
- `funtimod.json` — glifos de referência extraídos dos catálogos
- `thumbs/` — páginas dos catálogos em baixa resolução

Não há etapa de build: é só editar os arquivos e publicar.

Tipografia da interface: Rokkitt (alternativa livre à Memphis) e Host Grotesk, via Google Fonts. O logo usa contornos da Memphis.

Vetorização com [imagetracerjs](https://github.com/jankovicsandras/imagetracerjs) (domínio público).
