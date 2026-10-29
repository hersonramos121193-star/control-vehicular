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

if (typeof module !== 'undefined') module.exports = { COLUMNAS_TOKA, enmascararTarjeta, leerToka, asignarPorCatalogo, prorratear, alertas };
