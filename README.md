# Job de conversion de PDFs

Este job lee documentos pendientes en `cs_documentos`, descarga el PDF indicado por `url`, extrae texto y actualiza:

- `contenido_texto`
- `fecha_conversion`
- `num_intentos`
- `conversion_exitosa`

Primero intenta leer texto embebido del PDF. Si el documento es escaneado o viene como imagen, renderiza las paginas y aplica OCR con Tesseract (`spa+eng` por defecto).

## Ejecutar

Desde `carpeta de pdf/`:

```powershell
npm run dry-run
npm start
```

Para cargar de verdad y actualizar `cs_documentos`:

```powershell
npm run load-one
npm run load-five
.\cargar-documentos-pdf-real.ps1 -Limit 1
```

Desde la carpeta raiz del proyecto tambien puedes usar:

```powershell
.\cargar-documentos-pdf-real.cmd
.\cargar-documentos-pdf-real.cmd --limit=5
```

Tambien puedes usar el wrapper para Windows:

```powershell
.\run-documentos-pdf-job.ps1 -DryRun -Limit 1
.\run-documentos-pdf-job.ps1 -Limit 25
```

Para probar OCR forzado en un solo documento sin actualizar la base:

```powershell
npm run ocr-test
```

Para maxima extraccion, orientado a llegar a 100k caracteres si el documento lo permite:

```powershell
npm run max-quality-test
node .\documentos-pdf-job.mjs --id=123 --dry-run --max-quality
node .\documentos-pdf-job.mjs --id=123 --max-quality --require-target
```

Para probar un documento puntual:

```powershell
node .\documentos-pdf-job.mjs --id=123 --dry-run
node .\documentos-pdf-job.mjs --id=123
node .\documentos-pdf-job.mjs --id=123 --dry-run --force-ocr --ocr-max-pages=1
```

## Configuracion

Por defecto carga la conexion desde `../Back up central shop/.env` usando `PDF_JOB_DB_PROFILE=production`, que equivale a `MARIASQL_PRODUCTION_*`.

Si necesitas sobrescribir algo, copia `.env.example` como `.env` dentro de esta carpeta y ajusta los valores. No hace falta modificar la app principal.

Perfiles MariaDB disponibles, siguiendo los nombres del backup:

```bash
PDF_JOB_DB_PROFILE=production  # MARIASQL_PRODUCTION_*
PDF_JOB_DB_PROFILE=staging     # MARIASQL_STAGING_*; alias: dev
PDF_JOB_DB_PROFILE=localhost   # MARIASQL_LOCALHOST_*; alias: local
PDF_JOB_DB_PROFILE=replica     # MARIASQL_PRODUCTION_*_REPLICA
PDF_JOB_DB_PROFILE=principal   # MARIASQL_PRODUCTION_PRINCIPAL_*
PDF_JOB_DB_PROFILE=ph          # MARIASQL_PRODUCTION_PH_*
```

Tambien se puede cambiar por comando:

```powershell
node .\documentos-pdf-job.mjs --dry-run --limit=1 --db-profile=dev
node .\documentos-pdf-job.mjs --dry-run --limit=1 --db-profile=production
```

Si definis `PDF_JOB_DB_HOST`, `PDF_JOB_DB_USER`, `PDF_JOB_DB_PASSWORD`, `PDF_JOB_DB_NAME` o `PDF_JOB_DB_PORT`, esos valores pisan el perfil elegido.

En Linux/DigitalOcean, si la app principal esta en otra ruta, define:

```bash
PDF_JOB_APP_ROOT=/var/www/central-shop
```

Opciones OCR utiles:

```powershell
node .\documentos-pdf-job.mjs --ocr-lang=spa+eng --ocr-max-pages=25 --ocr-scale=2.4
node .\documentos-pdf-job.mjs --max-quality --target-text-chars=100000
node .\documentos-pdf-job.mjs --max-quality --target-text-chars=100000 --require-target
node .\documentos-pdf-job.mjs --no-ocr
```

`--max-quality` hace OCR de todas las paginas (`--ocr-max-pages=0`), usa escala alta, procesa de a una pagina por lote para no llenar memoria, y activa objetivo de 100k caracteres. No inventa texto: si el documento real no tiene 100k caracteres, solo falla si agregas `--require-target`.

## Progreso

Cada documento muestra progreso en consola y tambien lo guarda en `logs/documentos-pdf-job-YYYY-MM-DD.log`.

Fases principales:

```text
inicio -> descarga -> pdf_text -> ocr -> seleccion_texto -> db_update/finalizado
```

En `seleccion_texto` se ve el metodo final:

- `pdf-text`: uso solo texto embebido del PDF.
- `ocr`: uso OCR porque no habia texto suficiente o se forzo OCR.
- `pdf-text+ocr`: combino texto embebido y OCR, quitando lineas duplicadas.

Si `targetReached=false`, el documento no llego al objetivo configurado, por ejemplo 100000 caracteres. Eso no significa fallo salvo que uses `--require-target`.

## Cron / Programador de tareas

Windows:

```powershell
powershell.exe -ExecutionPolicy Bypass -File "C:\Users\Usuario\Desktop\cron + centralapp\carpeta de pdf\run-documentos-pdf-job.ps1" -Limit 25
```

Linux/DigitalOcean:

```bash
cd "/var/www/centralapp/carpeta de pdf"
npm install
chmod +x ./run-documentos-pdf-job.sh
./run-documentos-pdf-job.sh --dry-run --limit=1
```

Usa `npm install`, no `npm ci`, porque en el droplet conviene que npm instale/resuelva las dependencias nativas y el Chrome de Puppeteer para Linux.

Cron cada 10 minutos:

```cron
*/10 * * * * cd "/var/www/centralapp/carpeta de pdf" && /usr/bin/node documentos-pdf-job.mjs --limit=25 >> logs/cron.log 2>&1
```

Si Puppeteer no encuentra Chrome en Linux:

```bash
npx puppeteer browsers install chrome
```

La configuracion `.puppeteerrc.cjs` guarda ese Chrome dentro de `.cache/puppeteer` en esta misma carpeta, para que cron no dependa del home del usuario.

Si usas Chromium del sistema, agrega en `.env`:

```bash
PDF_JOB_CHROME_EXECUTABLE_PATH=/usr/bin/chromium
```

Los PDFs temporales se usan en `tmp/` y los logs quedan en `logs/`.
