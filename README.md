# Control Vehicular — Grupo Metelmex

App web de control de flota: panel, unidades y tarjetas, combustible (TOKA), cargas por asignar y prorrateo por centro de costo. Casetas: pendiente del formato de su plataforma.

- Se publica con GitHub Pages desde la rama `main`.
- Los datos viven en una Google Sheet privada y se leen con Apps Script con inicio de sesión; este repositorio solo contiene la parte visual.
- Nunca subir aquí: Excel de TOKA o de casetas, números de tarjeta, código de Apps Script, claves ni respaldos (ver `.gitignore`).

## Combustible (TOKA)
Se sube el "Reporte Consumos" tal como baja de la plataforma. Solo cuentan los movimientos `CONSUMO` con importe; dispersiones y decrementos se ignoran. Subir el mismo archivo o rangos encimados no duplica cargas. La tarjeta se guarda enmascarada (`5064********4139`).

## Archivos
- `index.html`: pantallas.
- `logica.js`: lectura del Excel de TOKA, asignación, prorrateo y alertas (sin pantalla).
- `prueba.js`: `node prueba.js "<Reporte Consumos de TOKA>.xlsx"` revisa `logica.js` con un archivo real.
- `xlsx.full.min.js`: SheetJS 0.20.3 (la misma copia del dashboard de RH).
- `apps-script/Codigo.gs`: backend; vive en el editor de Apps Script y no se sube (instrucciones al inicio del archivo).
