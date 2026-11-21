// Small interactions: reveal on scroll, nav highlight, button arrow polish.
document.documentElement.classList.add('js-ready');
// Real flag images for the 71 countries in the app's country database.
const COUNTRIES = [
  ['ng','Nigeria'],['gh','Ghana'],['ke','Kenya'],['tz','Tanzania'],['ug','Uganda'],['za','South Africa'],['zw','Zimbabwe'],['zm','Zambia'],['mw','Malawi'],['et','Ethiopia'],['eg','Egypt'],['ma','Morocco'],['dz','Algeria'],['tn','Tunisia'],['sn','Senegal'],['ci',"Côte d'Ivoire"],['cm','Cameroon'],['cd','DR Congo'],['ao','Angola'],['mz','Mozambique'],['rw','Rwanda'],
  ['gb','United Kingdom'],['ie','Ireland'],['fr','France'],['de','Germany'],['es','Spain'],['it','Italy'],['pt','Portugal'],['nl','Netherlands'],['be','Belgium'],['ch','Switzerland'],['at','Austria'],['pl','Poland'],['se','Sweden'],['no','Norway'],['dk','Denmark'],['fi','Finland'],['gr','Greece'],['ru','Russia'],['ua','Ukraine'],['tr','Türkiye'],['ro','Romania'],['hu','Hungary'],['cz','Czechia'],
  ['us','United States'],['ca','Canada'],['mx','Mexico'],['br','Brazil'],['ar','Argentina'],['cl','Chile'],['co','Colombia'],['pe','Peru'],
  ['ae','United Arab Emirates'],['sa','Saudi Arabia'],['il','Israel'],['in','India'],['pk','Pakistan'],['bd','Bangladesh'],['lk','Sri Lanka'],['np','Nepal'],['cn','China'],['jp','Japan'],['kr','South Korea'],['id','Indonesia'],['my','Malaysia'],['sg','Singapore'],['th','Thailand'],['vn','Vietnam'],['ph','Philippines'],['au','Australia'],['nz','New Zealand']
];
const flagTrack = document.querySelector('.flag-track');
if (flagTrack) {
  let html = '';
  for (let pass = 0; pass < 2; pass++) {
    COUNTRIES.forEach(([code, name], i) => {
      html += '<span class="flag-item" style="--i:' + i + '" data-name="' + name.replace(/"/g, '&quot;') + '"' + (pass === 1 ? ' aria-hidden="true"' : '') + '><img src="https://flagcdn.com/w80/' + code + '.png" srcset="https://flagcdn.com/w160/' + code + '.png 2x" alt="' + (pass === 0 ? name + ' flag' : '') + '"></span>';
    });
  }
  flagTrack.innerHTML = html;
}

const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
}, { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

const counters = document.querySelectorAll('.count');
if (counters.length && 'IntersectionObserver' in window) {
  const ci = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target;
      const to = Number(el.dataset.to);
      let n = 0;
      const step = Math.max(1, Math.round(to / 26));
      const tick = setInterval(() => {
        n = Math.min(to, n + step);
        el.textContent = String(n);
        if (n >= to) clearInterval(tick);
      }, 28);
      ci.unobserve(el);
    }
  }, { threshold: 0.6 });
  counters.forEach((c) => ci.observe(c));
}

const links = [...document.querySelectorAll('.links a')];
const sections = links.map((a) => document.querySelector(a.getAttribute('href'))).filter(Boolean);
if ('IntersectionObserver' in window && sections.length) {
  const spy = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        links.forEach((a) => { a.style.color = a.getAttribute('href') === '#' + e.target.id ? '#13FF47' : ''; });
      }
    }
  }, { rootMargin: '-40% 0px -55% 0px' });
  sections.forEach((s) => spy.observe(s));
}
