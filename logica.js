/* Lógica pura del Control Vehicular (sin pantalla ni red).
   La usan index.html y prueba.js, así que no debe tocar el DOM. */

// Columnas que se usan del "Reporte Consumos" de TOKA; si falta una, el archivo se rechaza.
const COLUMNAS_TOKA = ['Tarjeta', 'Fecha', 'Concepto', 'Ciudad', 'Consumo', 'Autorizacion', 'Producto', 'Nomina', 'Tipo', 'Numero_Tarjeta'];

// Nunca se guarda el número completo: solo los primeros 4 y últimos 4 dígitos.
function enmascararTarjeta(numeroTarjeta, tarjeta) {
  const ya = String(numeroTarjeta || '').trim();
  if (/^\d{4}\*+\d{4}$/.test(ya)) return ya;
  const d = String(tarjeta || '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(0, 4) + '********' + d.slice(-4) : '';
}

function textoFecha(v) {
  if (v instanceof Date) {
    const p = n => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
  }
  return String(v || '').trim();
}

function producto(p) {
  p = String(p || '').toUpperCase();
  return p.includes('DIESEL') ? 'Diésel' : p.includes('MAGNA') ? 'Magna' : p.includes('PREMIUM') ? 'Premium' : p;
}

// Convierte las filas crudas del Excel de TOKA (sheet_to_json) en cargas.
// Solo cuenta CONSUMO con importe > 0: DISPERSION (abonos) y DECREMENTO (retiros de saldo) no son gasto.
function leerToka(filas) {
  if (!filas.length) return { error: 'El archivo no tiene filas.' };
  const faltan = COLUMNAS_TOKA.filter(c => !(c in filas[0]));
  if (faltan.length) return { error: 'No parece el Reporte Consumos de TOKA. Faltan columnas: ' + faltan.join(', ') };
  const cargas = [], ignoradas = { abonos: 0, decrementos: 0, otros: 0 };
  for (const f of filas) {
    const importe = Number(f.Consumo) || 0;
    if (String(f.Tipo).trim().toUpperCase() !== 'CONSUMO' || importe <= 0) {
      const c = String(f.Concepto).trim().toUpperCase();
      if (c === 'DISPERSION') ignoradas.abonos++; else if (c === 'DECREMENTO') ignoradas.decrementos++; else ignoradas.otros++;
      continue;
    }
    const [fecha, horaTxt = ''] = textoFecha(f.Fecha).split(' ');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return { error: 'Fecha que no se entiende: "' + f.Fecha + '"' };
    const tarjeta = enmascararTarjeta(f.Numero_Tarjeta, f.Tarjeta);
    const autorizacion = String(f.Autorizacion).trim();
    cargas.push({
      // shortcut: la autorización de la terminal (6 dígitos) puede repetirse con el tiempo; por eso va junto con tarjeta y fecha-hora.
      id: [fecha, horaTxt, tarjeta.slice(-4), autorizacion].join('|'),
      fecha, hora: horaTxt === '00:00:00' ? '' : horaTxt.slice(0, 5), // 00:00 = carga sin hora (chip fuera de línea)
      mes: fecha.slice(0, 7),
      tarjeta, nombreToka: String(f.Nomina || '').trim(),
      estacion: String(f.Concepto || '').trim(), ciudad: String(f.Ciudad || '').trim(),
      producto: producto(f.Producto), autorizacion,
      importeToka: Math.round(importe * 100) / 100
    });
  }
  return { cargas, ignoradas };
}

// Unidad y centro de costo de una carga nueva según el catálogo. Comodines y tarjetas sin unidad quedan por asignar.
function asignarPorCatalogo(carga, tarjetasPorNum, unidadesPorNum) {
  const t = tarjetasPorNum[carga.tarjeta];
  const u = t && t.comodin !== 'SI' && t.unidad ? unidadesPorNum[t.unidad] : null;
  return u ? { unidad: u.noEconomico, centroCosto: String(u.centroCosto || '') } : { unidad: '', centroCosto: '' };
}

// Reparte las cifras de la factura del mes por el % de gasto de cada centro de costo.
function prorratear(cargas, cifras) {
  const porCentro = {};
  let total = 0;
  for (const c of cargas) {
    const k = c.centroCosto || '';
    porCentro[k] = (porCentro[k] || 0) + c.importe;
    total += c.importe;
  }
  const n = v => Number(v) || 0;
  return Object.entries(porCentro)
    .map(([centro, costo]) => {
      const pct = total ? costo / total : 0;
      return { centro, costo, pct, sinIva: n(cifras.neto) * pct, ieps: n(cifras.ieps) * pct, comision: n(cifras.comision) * pct };
    })
    .sort((a, b) => b.costo - a.costo);
}

// Alertas del mes. Las tarjetas comodín no cuentan como "varias unidades" porque así se usan.
function alertas(cargas, tarjetasPorNum) {
  const unidadesPorTarjeta = {}, cargasPorDia = {};
  for (const c of cargas) {
    const t = tarjetasPorNum[c.tarjeta];
    if (c.unidad && !(t && t.comodin === 'SI')) (unidadesPorTarjeta[c.tarjeta] = unidadesPorTarjeta[c.tarjeta] || new Set()).add(c.unidad);
    const k = (c.unidad || c.tarjeta) + '|' + c.fecha;
    cargasPorDia[k] = (cargasPorDia[k] || 0) + 1;
  }
  return {
    tarjetaVariasUnidades: Object.values(unidadesPorTarjeta).filter(s => s.size > 1).length,
    mismoDia: Object.values(cargasPorDia).filter(n => n > 1).length,
    porAsignar: cargas.filter(c => !c.unidad).length,
    ajustadas: cargas.filter(c => c.importe !== c.importeToka).length
  };
}

/* ---------- Análisis histórico (base sin IVA, como contabilidad) ---------- */

// Umbrales editables (hoja Config). Mismos valores que las celdas amarillas del análisis de Costos.
const CONFIG_INICIAL = { umbralPico: 1.75, picoMinimo: 25000, umbralYtd: 50000, umbralCrecimiento: 0.3, mesesInactiva: 3, presupuestoAviso: 1 };
const IVA = 1.16;
const COLUMNAS_CONTABLE = ['Año', 'Mes', 'Cargo', 'Dep', 'Zona', 'Tipo de gasto'];

const mesTxt = (a, n) => { const d = new Date(a, n - 1, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
const mesMas = (m, n) => mesTxt(+m.slice(0, 4), +m.slice(5, 7) + n);
const sumar = o => Object.values(o || {}).reduce((s, v) => s + v, 0);
function mediana(xs) {
  const a = xs.filter(v => v > 0).sort((x, y) => x - y);
  return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : 0;
}

// Histórico desde la hoja Base_Datos del auxiliar contable. Solo "Tarjeta TOKA": los reembolsos quedan fuera.
function historicoDesdeContable(filas) {
  if (!filas.length) return { error: 'La hoja Base_Datos está vacía.' };
  const faltan = COLUMNAS_CONTABLE.filter(c => !(c in filas[0]));
  if (faltan.length) return { error: 'No parece la hoja Base_Datos del análisis contable. Faltan columnas: ' + faltan.join(', ') };
  const acum = {}, centros = {};
  for (const f of filas) {
    if (String(f['Tipo de gasto']).trim() !== 'Tarjeta TOKA') continue;
    const zona = String(f.Dep).trim(), mes = mesTxt(+f['Año'], +f.Mes);
    if (!zona || !(+f['Año'] > 2000)) continue;
    centros[zona] = String(f.Zona).trim();
    acum[mes + '|' + zona] = (acum[mes + '|' + zona] || 0) + (Number(f.Cargo) || 0);
  }
  // Un mes sin factura TOKA registrada no trae filas "Tarjeta TOKA", así que no entra como mes en ceros.
  const meses = [...new Set(Object.keys(acum).map(k => k.split('|')[0]))].sort();
  const historico = Object.entries(acum).map(([k, v]) => ({ clave: k, mes: k.split('|')[0], zona: k.split('|')[1], importe: Math.round(v * 100) / 100 }));
  return { historico, meses, centros: Object.entries(centros).map(([zona, nombre]) => ({ zona, nombre })) };
}

// Gasto sin IVA por mes y centro. Por mes manda: histórico contable > factura capturada en Prorrateo > estimado (importe ÷ 1.16).
// Un mes "estimado" es parcial: se muestra, pero no entra en medianas, promedios ni comparativos.
function serieMensual(cargas, historico, prorrateo) {
  const valores = {}, origen = {};
  const sumarA = (m, z, v) => { (valores[m] = valores[m] || {})[z] = (valores[m][z] || 0) + v; };
  historico.forEach(h => { sumarA(h.mes, String(h.zona), Number(h.importe) || 0); origen[h.mes] = 'contable'; });
  const cifras = Object.fromEntries(prorrateo.map(p => [p.mes, p])), porMes = {};
  cargas.forEach(c => (porMes[c.mes] = porMes[c.mes] || []).push(c));
  for (const [m, cs] of Object.entries(porMes)) {
    if (origen[m]) continue;
    const p = cifras[m];
    if (p && Number(p.neto) > 0) { prorratear(cs, p).forEach(f => sumarA(m, f.centro, f.sinIva + f.ieps)); origen[m] = 'factura'; }
    else { cs.forEach(c => sumarA(m, c.centroCosto || '', c.importe / IVA)); origen[m] = 'estimado'; }
  }
  return { meses: Object.keys(valores).sort(), valores, origen };
}

// Indicadores y hallazgos al último mes cerrado. centro = '' para toda la empresa.
// centrosCat: [{zona, nombre, presupuesto}]; prorrateo: cifras de factura por mes (para revisar la comisión).
function analizar(serie, config, centro, centrosCat, prorrateo) {
  const cfg = { ...CONFIG_INICIAL };
  for (const k in cfg) if (config && Number(config[k]) > 0) cfg[k] = Number(config[k]);
  const cerrados = serie.meses.filter(m => serie.origen[m] !== 'estimado');
  const corte = cerrados[cerrados.length - 1];
  if (!corte) return { corte: null, cfg, hallazgos: [], medianas: {} };
  const ok = new Set(cerrados);
  const val = (m, z) => !ok.has(m) ? 0 : z === undefined ? (centro ? (serie.valores[m] || {})[centro] || 0 : sumar(serie.valores[m])) : (serie.valores[m] || {})[z] || 0;
  const rango = (desde, n, z) => { let s = 0; for (let i = 0; i < n; i++) s += val(mesMas(desde, i), z); return s; };
  const anio = +corte.slice(0, 4), mc = +corte.slice(5, 7), ene = anio + '-01', eneAnt = (anio - 1) + '-01', ult3 = mesMas(corte, -2);
  const k = {
    corte, totalPeriodo: cerrados.reduce((s, m) => s + val(m), 0),
    ytd: rango(ene, mc), ytdAnt: rango(eneAnt, mc), u3: rango(ult3, 3), u3Ant: rango(mesMas(ult3, -12), 3)
  };
  k.varYtd = k.ytdAnt ? k.ytd / k.ytdAnt - 1 : null;
  k.varU3 = k.u3Ant ? k.u3 / k.u3Ant - 1 : null;
  k.proyeccion = k.ytd + (12 - mc) * k.u3 / 3;

  const nombres = Object.fromEntries((centrosCat || []).map(c => [String(c.zona), c]));
  const nom = z => z ? (nombres[z] ? nombres[z].nombre : 'Zona ' + z) : 'Sin asignar';
  const zonas = [...new Set(serie.meses.flatMap(m => Object.keys(serie.valores[m])))].filter(z => !centro || z === centro);
  const ult12 = cerrados.slice(-12), medianas = {}, h = [];
  for (const z of zonas) {
    const med = medianas[z] = mediana(cerrados.map(m => val(m, z)));
    // Picos: mes >= umbral x su mediana y >= monto mínimo (últimos 12 meses cerrados).
    for (const m of ult12) {
      const v = val(m, z);
      if (!(med && v >= cfg.umbralPico * med && v >= cfg.picoMinimo)) continue;
      const previos = []; for (let i = 1; i < +m.slice(5, 7); i++) previos.push(val(mesTxt(+m.slice(0, 4), i), z));
      const prom = previos.length ? previos.reduce((s, x) => s + x, 0) / previos.length : 0;
      h.push({ tipo: 'Pico atípico', zona: z, mes: m, valor: v,
        detalle: `${(v / med).toFixed(1)} veces su mediana mensual` + (prom ? `; ${v > prom ? '+' : ''}${Math.round((v / prom - 1) * 100)}% vs su promedio del año (exceso a justificar ${Math.round(v - prom).toLocaleString('es-MX')})` : '') });
    }
    // Crecimiento del acumulado del año contra el mismo periodo del año anterior.
    const yz = rango(ene, mc, z), az = rango(eneAnt, mc, z);
    if (yz >= cfg.umbralYtd && (!az || yz / az - 1 >= cfg.umbralCrecimiento))
      h.push({ tipo: az ? 'Crecimiento' : 'Centro nuevo', zona: z, mes: corte, valor: yz - az,
        detalle: az ? `+${Math.round((yz / az - 1) * 100)}% en el año (${Math.round(az).toLocaleString('es-MX')} a ${Math.round(yz).toLocaleString('es-MX')})` : `Sin gasto el año anterior; ${Math.round(yz).toLocaleString('es-MX')} en el año` });
    // Sin consumo varios meses y luego un cargo (tarjetas de proyectos cerrados).
    for (let i = cfg.mesesInactiva; i < cerrados.length; i++) {
      const m = cerrados[i];
      if (ult12.includes(m) && val(m, z) > 0 && cerrados.slice(i - cfg.mesesInactiva, i).every(x => !val(x, z)) && cerrados.slice(0, i - cfg.mesesInactiva).some(x => val(x, z)))
        h.push({ tipo: 'Cargo tras inactividad', zona: z, mes: m, valor: val(m, z), detalle: `Sin consumo ${cfg.mesesInactiva} meses o más; confirmar si la tarjeta debe cancelarse` });
    }
    const ultimos = cerrados.slice(-cfg.mesesInactiva);
    if (ultimos.length === cfg.mesesInactiva && ultimos.every(m => !val(m, z)) && cerrados.some(m => val(m, z)))
      h.push({ tipo: 'Sin consumo', zona: z, mes: corte, valor: 0, detalle: `Sin gasto en los últimos ${cfg.mesesInactiva} meses; candidata a cancelar tarjetas` });
    // Presupuesto mensual (incluye el mes en curso aunque sea parcial).
    const pres = Number(nombres[z] && nombres[z].presupuesto) || 0;
    if (pres) for (const m of serie.meses.filter(x => x >= corte)) {
      const v = (serie.valores[m] || {})[z] || 0;
      if (v > pres * cfg.presupuestoAviso) h.push({ tipo: 'Sobre presupuesto', zona: z, mes: m, valor: v - pres,
        detalle: `${Math.round(v).toLocaleString('es-MX')} contra presupuesto de ${Math.round(pres).toLocaleString('es-MX')}` + (serie.origen[m] === 'estimado' ? ' (mes parcial)' : '') });
    }
  }
  // Concentración: si un centro explica la mayor parte del aumento de la empresa.
  if (!centro && k.ytd > k.ytdAnt) {
    const difs = zonas.map(z => [z, rango(ene, mc, z) - rango(eneAnt, mc, z)]).sort((a, b) => b[1] - a[1]);
    const [z, d] = difs[0], alza = k.ytd - k.ytdAnt;
    if (d >= alza / 2) {
      const resto = (k.ytd - rango(ene, mc, z)) / (k.ytdAnt - rango(eneAnt, mc, z)) - 1;
      h.push({ tipo: 'Concentración', zona: z, mes: corte, valor: d,
        detalle: `Explica ${Math.round(d / alza * 100)}% del aumento del año; sin este centro el resto varía ${resto > 0 ? '+' : ''}${(resto * 100).toFixed(1)}%` });
    }
  }
  // Comisión TOKA: % sobre el costo sin IVA de cada factura, contra la mediana de los meses capturados.
  const com = (prorrateo || []).filter(p => Number(p.neto) > 0 && Number(p.comision) > 0).map(p => [p.mes, p.comision / p.neto]);
  const medCom = mediana(com.map(c => c[1]));
  com.filter(([, pct]) => Math.abs(pct - medCom) > 0.005)
    .forEach(([m, pct]) => h.push({ tipo: 'Comisión fuera de rango', zona: '', mes: m, valor: pct, detalle: `${(pct * 100).toFixed(2)}% contra ${(medCom * 100).toFixed(2)}% habitual` }));

  const orden = ['Concentración', 'Pico atípico', 'Sobre presupuesto', 'Crecimiento', 'Centro nuevo', 'Cargo tras inactividad', 'Sin consumo', 'Comisión fuera de rango'];
  h.forEach(x => x.centro = nom(x.zona));
  h.sort((a, b) => orden.indexOf(a.tipo) - orden.indexOf(b.tipo) || b.mes.localeCompare(a.mes) || b.valor - a.valor);
  return { ...k, cfg, hallazgos: h, medianas, nombre: nom };
}

// Tarjetas TOKA nuevas, reactivadas o inactivas según los meses con cargas.
function hallazgosTarjetas(cargas, mesesInactiva) {
  const meses = [...new Set(cargas.map(c => c.mes))].sort(), porTarjeta = {}, h = [];
  if (meses.length <= mesesInactiva) return h; // hace falta historia para comparar
  cargas.forEach(c => (porTarjeta[c.tarjeta] = porTarjeta[c.tarjeta] || { nombre: c.nombreToka, meses: new Set() }).meses.add(c.mes));
  const ultimo = meses[meses.length - 1];
  for (const [t, d] of Object.entries(porTarjeta)) {
    const ms = [...d.meses].sort(), etiqueta = `${t.slice(-4)} · ${d.nombre}`;
    if (ms[0] > meses[0] && ms[0] >= mesMas(ultimo, -2)) h.push({ tipo: 'Tarjeta nueva', tarjeta: etiqueta, mes: ms[0] });
    for (let i = 1; i < ms.length; i++) if (ms[i] >= mesMas(ms[i - 1], mesesInactiva + 1)) h.push({ tipo: 'Tarjeta reactivada', tarjeta: etiqueta, mes: ms[i] });
    if (ms[ms.length - 1] <= mesMas(ultimo, -mesesInactiva)) h.push({ tipo: 'Tarjeta inactiva', tarjeta: etiqueta, mes: ms[ms.length - 1] });
  }
  return h;
}

if (typeof module !== 'undefined') module.exports = { COLUMNAS_TOKA, enmascararTarjeta, leerToka, asignarPorCatalogo, prorratear, alertas,
  CONFIG_INICIAL, historicoDesdeContable, serieMensual, analizar, hallazgosTarjetas, mediana, mesMas };
