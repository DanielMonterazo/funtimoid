/* ramo soft: entrada suave dos blocos ao aparecerem na tela (IntersectionObserver, nunca scroll listener) */
(() => {
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const io = new IntersectionObserver((entries) => {
    let k = 0;
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target; io.unobserve(el);
      el.style.transitionDelay = (k++ * 80) + 'ms';
      requestAnimationFrame(() => el.classList.add('in'));
      el.addEventListener('transitionend', () => { el.style.transitionDelay = ''; el.classList.remove('reveal', 'in'); }, { once: true });
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
  const watch = (root) => root.querySelectorAll('.mast, .panel, .catsec').forEach(el => {
    if (el.dataset.rv) return; el.dataset.rv = '1'; el.classList.add('reveal'); io.observe(el);
  });
  watch(document);
  const cat = document.getElementById('catList');
  // só a primeira montagem do catálogo anima; buscas posteriores trocam o conteúdo sem efeito
  if (cat) { const mo = new MutationObserver(() => { if (cat.querySelector('.catsec:not(.skel)')) { watch(cat); mo.disconnect(); } }); mo.observe(cat, { childList: true }); }
})();
