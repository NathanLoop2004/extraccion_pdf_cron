import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..');
const requireFromJob = createRequire(path.join(__dirname, 'package.json'));
const dotenv = requireFromJob('dotenv');

dotenv.config({ path: path.join(__dirname, '.env'), quiet: true });

const appRoot = path.resolve(process.env.PDF_JOB_APP_ROOT || path.join(workspaceRoot, 'Back up central shop'));
const requireFromApp = createRequire(path.join(appRoot, 'package.json'));

if (fsSync.existsSync(path.join(appRoot, '.env'))) {
  dotenv.config({ path: path.join(appRoot, '.env'), quiet: true });
}
dotenv.config({ path: path.join(__dirname, '.env'), override: true, quiet: true });

const mysql = loadDependency('mysql2/promise');
const axios = loadDependency('axios');
const pdf2table = loadDependency('pdf2table');

const defaultConfig = {
  limit: readPositiveIntegerEnv('PDF_JOB_LIMIT', 25),
  maxAttempts: readPositiveIntegerEnv('PDF_JOB_MAX_ATTEMPTS', 3),
  minTextChars: readPositiveIntegerEnv('PDF_JOB_MIN_TEXT_CHARS', 20),
  requestTimeoutMs: readPositiveIntegerEnv('PDF_JOB_REQUEST_TIMEOUT_MS', 45000),
  keepFiles: false,
  dryRun: false,
  includeSuccessful: false,
  ocrEnabled: readBooleanEnv('PDF_JOB_OCR_ENABLED', true),
  ocrLanguage: process.env.PDF_JOB_OCR_LANGUAGE || 'spa+eng',
  ocrMaxPages: readNonNegativeIntegerEnv('PDF_JOB_OCR_MAX_PAGES', 25),
  ocrBatchPages: readPositiveIntegerEnv('PDF_JOB_OCR_BATCH_PAGES', 2),
  ocrScale: readPositiveFloatEnv('PDF_JOB_OCR_SCALE', 2.4),
  ocrDpi: readPositiveIntegerEnv('PDF_JOB_OCR_DPI', 300),
  ocrDebug: readBooleanEnv('PDF_JOB_OCR_DEBUG', false),
  targetTextChars: readNonNegativeIntegerEnv('PDF_JOB_TARGET_TEXT_CHARS', 0),
  requireTarget: readBooleanEnv('PDF_JOB_REQUIRE_TARGET', false),
  forceOcr: false,
  maxQuality: false,
  id: null,
};

const helpText = `
Job de conversion de PDFs para cs_documentos

Uso:
  node documentos-pdf-job.mjs [opciones]

Opciones:
  --limit=25                Cantidad maxima de documentos por corrida.
  --max-attempts=3          Reintentos maximos por documento.
  --id=123                  Procesa solo un documento.
  --include-successful      Incluye documentos ya convertidos.
  --dry-run                 Lee documentos, descarga y extrae, pero no actualiza DB.
  --keep-files              Conserva PDFs descargados en tmp/.
  --no-ocr                  Desactiva OCR para PDFs escaneados.
  --force-ocr               Fuerza OCR aunque el PDF tenga texto embebido.
  --ocr-lang=spa+eng        Idiomas OCR.
  --ocr-max-pages=25        Maximo de paginas OCR por documento. Usa 0 para todas.
  --ocr-batch-pages=2       Paginas renderizadas por lote OCR.
  --ocr-scale=2.4           Escala de renderizado para OCR.
  --db-profile=production   Perfil MariaDB: production, staging, localhost, replica, principal, ph.
  --target-text-chars=100000 Objetivo de caracteres extraidos.
  --require-target          Marca error si no llega al objetivo.
  --max-quality             OCR de maxima calidad/cantidad: todas las paginas, escala alta, objetivo 100k.
  --help                    Muestra esta ayuda.

Variables opcionales en carpeta de pdf/.env:
  PDF_JOB_TABLE=cs_documentos
  PDF_JOB_BASE_URL=https://tu-servidor.com
  PDF_JOB_DB_HOST=...
  PDF_JOB_DB_PORT=3306
  PDF_JOB_DB_USER=...
  PDF_JOB_DB_PASSWORD=...
  PDF_JOB_DB_NAME=ssss_emp1
  PDF_JOB_DB_PROFILE=production
  PDF_JOB_APP_ROOT=/ruta/a/central-shop
  PDF_JOB_CHROME_EXECUTABLE_PATH=/usr/bin/chromium
  PDF_JOB_OCR_ENABLED=true
  PDF_JOB_OCR_LANGUAGE=spa+eng
  PDF_JOB_OCR_MAX_PAGES=25
  PDF_JOB_OCR_BATCH_PAGES=2
  PDF_JOB_OCR_SCALE=2.4
  PDF_JOB_TARGET_TEXT_CHARS=100000
  PDF_JOB_REQUIRE_TARGET=false
`;

const config = readCliConfig(process.argv.slice(2));

if (config.help) {
  console.log(helpText.trim());
  process.exit(0);
}

const tmpDir = path.join(__dirname, 'tmp');
const logsDir = path.join(__dirname, 'logs');
const tessdataDir = path.join(__dirname, 'tessdata');
const tessdataCacheDir = path.join(__dirname, 'tessdata-cache');
const tableName = quoteIdentifierPath(process.env.PDF_JOB_TABLE || 'cs_documentos');
const baseUrl = normalizeBaseUrl(process.env.PDF_JOB_BASE_URL || '');

let connection;
let ocrWorker;
let ocrBrowser;
let rendererHtmlPath;
let processed = 0;
let converted = 0;
let failed = 0;

try {
  await ensureWorkDirs();
  connection = await createConnection();

  const documents = await getPendingDocuments(connection);
  await logLine({
    level: 'info',
    message: 'job_started',
    count: documents.length,
    dryRun: config.dryRun,
    limit: config.limit,
    maxAttempts: config.maxAttempts,
    dbProfile: getDbProfile(),
    targetTextChars: config.targetTextChars,
    maxQuality: config.maxQuality,
  });

  if (documents.length === 0) {
    console.log('No hay documentos pendientes para convertir.');
    process.exit(0);
  }

  for (const document of documents) {
    processed += 1;
    const result = await processDocument(document);

    if (result.ok) {
      converted += 1;
      console.log(`[OK] id=${document.id} metodo=${result.method} texto=${result.textLength} chars`);
    } else {
      failed += 1;
      console.log(`[ERROR] id=${document.id} ${result.error}`);
    }
  }

  console.log(`Finalizado. Procesados: ${processed}. Convertidos: ${converted}. Errores: ${failed}.`);
  await logLine({ level: 'info', message: 'job_finished', processed, converted, failed });
} catch (error) {
  failed += 1;
  console.error('Error fatal del job:', error.message);
  await logLine({ level: 'fatal', message: 'job_failed', error: serializeError(error) });
  process.exitCode = 1;
} finally {
  if (ocrWorker) {
    await ocrWorker.terminate();
  }
  if (ocrBrowser) {
    await ocrBrowser.close();
  }
  if (!config.keepFiles && rendererHtmlPath) {
    await removeIfExists(rendererHtmlPath);
  }
  if (connection) {
    await connection.end();
  }
}

async function processDocument(document) {
  const context = {
    id: document.id,
    titulo: document.titulo,
    url: document.url,
  };
  let pdfPath;

  try {
    await reportProgress(context, 1, 'inicio', {
      dryRun: config.dryRun,
      maxQuality: config.maxQuality,
      targetTextChars: config.targetTextChars,
    });

    pdfPath = path.join(tmpDir, `${document.id}.pdf`);
    await reportProgress(context, 5, 'descarga_inicio');
    const buffer = await loadPdfBuffer(document.url, pdfPath);
    await reportProgress(context, 10, 'descarga_ok', {
      bytes: buffer.length,
    });

    let text = '';
    let pdfText = '';
    let ocrText = '';
    let method = 'pdf-text';
    let ocrPages = 0;
    let ocrReason = null;

    if (!config.forceOcr) {
      await reportProgress(context, 20, 'pdf_text_inicio');
      pdfText = normalizeExtractedText(await extractTextFromPdf(buffer));
      text = pdfText;
      await reportProgress(context, 25, 'pdf_text_ok', {
        pdfTextChars: pdfText.length,
      });
    } else {
      ocrReason = 'forzado';
      await reportProgress(context, 25, 'pdf_text_saltado', {
        reason: '--force-ocr',
      });
    }

    const needsOcrForTarget = config.targetTextChars > 0 && text.length < config.targetTextChars;
    const needsOcrForMinimum = text.length < config.minTextChars;

    if (config.forceOcr || ((needsOcrForMinimum || needsOcrForTarget) && config.ocrEnabled)) {
      if (!ocrReason) {
        if (needsOcrForMinimum) {
          ocrReason = `texto_embebido_menor_minimo_${text.length}_de_${config.minTextChars}`;
        } else if (needsOcrForTarget) {
          ocrReason = `objetivo_no_alcanzado_${text.length}_de_${config.targetTextChars}`;
        }
      }

      await reportProgress(context, 30, 'ocr_inicio', {
        reason: ocrReason,
        ocrScale: config.ocrScale,
        ocrMaxPages: config.ocrMaxPages,
      });

      const ocrResult = await extractTextWithOcr(buffer, document.id, async (progress) => {
        await reportProgress(context, progress.percent, progress.phase, progress.details);
      });
      ocrText = normalizeExtractedText(ocrResult.text);
      text = chooseExtractedText(pdfText, ocrText);
      method = pdfText && ocrText ? 'pdf-text+ocr' : 'ocr';
      ocrPages = ocrResult.pages;

      await reportProgress(context, 92, 'ocr_ok', {
        ocrPages,
        ocrTextChars: ocrText.length,
      });
    } else {
      await reportProgress(context, 70, 'ocr_no_necesario', {
        pdfTextChars: pdfText.length,
        targetTextChars: config.targetTextChars,
      });
    }

    await reportProgress(context, 94, 'seleccion_texto', {
      method,
      reason: ocrReason || 'pdf_text_suficiente',
      pdfTextChars: pdfText.length,
      ocrTextChars: ocrText.length,
      finalTextChars: text.length,
      targetReached: config.targetTextChars > 0 ? text.length >= config.targetTextChars : null,
    });

    if (text.length < config.minTextChars) {
      const ocrHint = config.ocrEnabled ? 'OCR no encontro texto suficiente' : 'OCR desactivado';
      throw new Error(`PDF sin texto extraible suficiente (${text.length} caracteres). ${ocrHint}`);
    }

    if (config.requireTarget && config.targetTextChars > 0 && text.length < config.targetTextChars) {
      throw new Error(`Texto extraido insuficiente para el objetivo (${text.length}/${config.targetTextChars} caracteres)`);
    }

    if (!config.dryRun) {
      await reportProgress(context, 96, 'db_update_inicio', {
        method,
        finalTextChars: text.length,
      });
      await updateSuccess(connection, document.id, text);
      await reportProgress(context, 98, 'db_update_ok');
    } else {
      await reportProgress(context, 98, 'dry_run_db_saltado');
    }

    await logLine({
      level: 'info',
      message: config.dryRun ? 'document_converted_dry_run' : 'document_converted',
      ...context,
      textLength: text.length,
      method,
      ocrPages,
      ocrReason,
      pdfTextChars: pdfText.length,
      ocrTextChars: ocrText.length,
      targetTextChars: config.targetTextChars,
      targetReached: config.targetTextChars > 0 ? text.length >= config.targetTextChars : null,
    });

    await reportProgress(context, 100, 'finalizado', {
      method,
      finalTextChars: text.length,
      ocrPages,
    });

    return { ok: true, textLength: text.length, method };
  } catch (error) {
    await reportProgress(context, 100, 'error', {
      error: error.message,
    });

    if (!config.dryRun) {
      await updateFailure(connection, document.id);
    }

    await logLine({
      level: 'error',
      message: config.dryRun ? 'document_failed_dry_run' : 'document_failed',
      ...context,
      error: serializeError(error),
    });

    return { ok: false, error: error.message };
  } finally {
    if (!config.keepFiles && pdfPath) {
      await removeIfExists(pdfPath);
    }
  }
}

async function createConnection() {
  const dbConfig = resolveDbConfig();
  const host = dbConfig.host;
  const port = Number(dbConfig.port || 3306);
  const user = dbConfig.user;
  const password = dbConfig.password;
  const database = dbConfig.database;

  const missing = [];
  if (!host) missing.push('host');
  if (!user) missing.push('user');
  if (!database) missing.push('database');
  if (missing.length > 0) {
    throw new Error(`Faltan datos de conexion MariaDB: ${missing.join(', ')}`);
  }

  return mysql.createConnection({
    host,
    port,
    user,
    password,
    database,
    timezone: 'local',
    supportBigNumbers: true,
    dateStrings: false,
    connectTimeout: 15000,
  });
}

function resolveDbConfig() {
  const profileConfig = getDbProfileConfig(getDbProfile());

  return {
    profile: profileConfig.profile,
    host: process.env.PDF_JOB_DB_HOST || process.env[profileConfig.host],
    port: process.env.PDF_JOB_DB_PORT || process.env[profileConfig.port],
    user: process.env.PDF_JOB_DB_USER || process.env[profileConfig.user],
    password: process.env.PDF_JOB_DB_PASSWORD || process.env[profileConfig.password],
    database: process.env.PDF_JOB_DB_NAME || process.env[profileConfig.database],
  };
}

function getDbProfile() {
  return String(process.env.PDF_JOB_DB_PROFILE || 'production').trim().toLowerCase();
}

function getDbProfileConfig(profile) {
  const profiles = {
    production: {
      profile: 'production',
      host: 'MARIASQL_PRODUCTION_HOST',
      port: 'MARIASQL_PRODUCTION_PORT',
      user: 'MARIASQL_PRODUCTION_USER',
      password: 'MARIASQL_PRODUCTION_PASSWORD',
      database: 'MARIASQL_PRODUCTION_DATABASE',
    },
    staging: {
      profile: 'staging',
      host: 'MARIASQL_STAGING_HOST',
      port: 'MARIASQL_STAGING_PORT',
      user: 'MARIASQL_STAGING_USER',
      password: 'MARIASQL_STAGING_PASSWORD',
      database: 'MARIASQL_STAGING_DATABASE',
    },
    localhost: {
      profile: 'localhost',
      host: 'MARIASQL_LOCALHOST_HOST',
      port: 'MARIASQL_LOCALHOST_PORT',
      user: 'MARIASQL_LOCALHOST_USER',
      password: 'MARIASQL_LOCALHOST_PASSWORD',
      database: 'MARIASQL_LOCALHOST_DATABASE',
    },
    replica: {
      profile: 'replica',
      host: 'MARIASQL_PRODUCTION_HOST_REPLICA',
      port: 'MARIASQL_PRODUCTION_PORT_REPLICA',
      user: 'MARIASQL_PRODUCTION_USER_REPLICA',
      password: 'MARIASQL_PRODUCTION_PASSWORD_REPLICA',
      database: 'MARIASQL_LOCALHOST_DATABASE_REPLICA',
    },
    principal: {
      profile: 'principal',
      host: 'MARIASQL_PRODUCTION_PRINCIPAL_HOST',
      port: 'MARIASQL_PRODUCTION_PRINCIPAL_PORT',
      user: 'MARIASQL_PRODUCTION_PRINCIPAL_USER',
      password: 'MARIASQL_PRODUCTION_PRINCIPAL_PASSWORD',
      database: 'MARIASQL_PRODUCTION_PRINCIPAL_DATABASE',
    },
    ph: {
      profile: 'ph',
      host: 'MARIASQL_PRODUCTION_PH_HOST',
      port: 'MARIASQL_PRODUCTION_PH_PORT',
      user: 'MARIASQL_PRODUCTION_PH_USER',
      password: 'MARIASQL_PRODUCTION_PH_PASSWORD',
      database: 'MARIASQL_PRODUCTION_PH_DATABASE',
    },
  };

  const aliases = {
    prod: 'production',
    produccion: 'production',
    production: 'production',
    dev: 'staging',
    development: 'staging',
    staging: 'staging',
    testing: 'staging',
    test: 'staging',
    local: 'localhost',
    localhost: 'localhost',
    replica: 'replica',
    readonly: 'replica',
    read: 'replica',
    principal: 'principal',
    main: 'principal',
    ph: 'ph',
  };

  const normalized = aliases[profile] || profile;

  if (!profiles[normalized]) {
    throw new Error(`PDF_JOB_DB_PROFILE invalido: ${profile}. Usa production, staging, localhost, replica, principal o ph.`);
  }

  return profiles[normalized];
}

async function getPendingDocuments(db) {
  const params = [];
  const where = [
    'url IS NOT NULL',
    "TRIM(url) <> ''",
  ];

  if (config.id) {
    where.push('id = ?');
    params.push(config.id);
  }

  if (!config.includeSuccessful) {
    where.push('(conversion_exitosa IS NULL OR conversion_exitosa = 0 OR contenido_texto IS NULL OR TRIM(contenido_texto) = \'\')');
  }

  if (Number.isFinite(config.maxAttempts) && config.maxAttempts >= 0) {
    where.push('COALESCE(num_intentos, 0) < ?');
    params.push(config.maxAttempts);
  }

  params.push(config.limit);

  const [rows] = await db.execute(
    `SELECT id, titulo, url, conversion_exitosa, COALESCE(num_intentos, 0) AS num_intentos
     FROM ${tableName}
     WHERE ${where.join(' AND ')}
     ORDER BY fecha_conversion IS NULL DESC, fecha_conversion ASC, id ASC
     LIMIT ?`,
    params
  );

  return rows;
}

async function updateSuccess(db, id, text) {
  await db.execute(
    `UPDATE ${tableName}
     SET contenido_texto = ?,
         conversion_exitosa = 1,
         fecha_conversion = NOW(),
         num_intentos = COALESCE(num_intentos, 0) + 1
     WHERE id = ?`,
    [text, id]
  );
}

async function updateFailure(db, id) {
  await db.execute(
    `UPDATE ${tableName}
     SET conversion_exitosa = 0,
         fecha_conversion = NOW(),
         num_intentos = COALESCE(num_intentos, 0) + 1
     WHERE id = ?`,
    [id]
  );
}

async function loadPdfBuffer(rawUrl, outputPath) {
  const source = resolveDocumentSource(rawUrl);
  let buffer;

  if (source.kind === 'file') {
    buffer = await fs.readFile(source.path);
  } else {
    const response = await axios.get(source.url, {
      responseType: 'arraybuffer',
      timeout: config.requestTimeoutMs,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      headers: {
        'User-Agent': 'centralshop-documentos-pdf-job/1.0',
        Accept: 'application/pdf,application/octet-stream,*/*',
      },
    });
    buffer = Buffer.from(response.data);
  }

  if (buffer.length === 0) {
    throw new Error('Archivo PDF vacio');
  }

  await fs.writeFile(outputPath, buffer);
  return buffer;
}

function resolveDocumentSource(rawUrl) {
  const value = String(rawUrl || '').trim();

  if (!value) {
    throw new Error('URL vacia');
  }

  if (/^https?:\/\//i.test(value)) {
    return { kind: 'url', url: value };
  }

  if (value.startsWith('//')) {
    return { kind: 'url', url: `https:${value}` };
  }

  if (/^file:\/\//i.test(value)) {
    return { kind: 'file', path: fileURLToPath(value) };
  }

  if (path.isAbsolute(value)) {
    return { kind: 'file', path: value };
  }

  const localCandidates = [];
  const cleanValue = value.replace(/^\/+/, '').replace(/\\/g, '/');

  localCandidates.push(path.join(appRoot, 'public', cleanValue));
  localCandidates.push(path.join(appRoot, cleanValue));
  localCandidates.push(path.join(workspaceRoot, cleanValue));

  for (const candidate of localCandidates) {
    if (fileExistsSyncish(candidate)) {
      return { kind: 'file', path: candidate };
    }
  }

  if (baseUrl) {
    return { kind: 'url', url: new URL(value, baseUrl).toString() };
  }

  throw new Error(`No se pudo resolver la ruta del documento: ${value}`);
}

function extractTextFromPdf(buffer) {
  return new Promise((resolve, reject) => {
    pdf2table.parse(buffer, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      const text = rows
        .map((row) => row.filter(Boolean).join(' '))
        .join('\n');

      resolve(text);
    });
  });
}

async function extractTextWithOcr(buffer, documentId, onProgress = null) {
  const batchPages = Math.max(1, config.ocrBatchPages);
  const worker = await getOcrWorker();
  const pageTexts = [];
  let processedPages = 0;
  let totalPages = null;
  let pagesToProcess = null;

  for (let startPage = 1; pagesToProcess === null || startPage <= pagesToProcess; startPage += batchPages) {
    const configuredLimit = config.ocrMaxPages > 0 ? config.ocrMaxPages : Number.MAX_SAFE_INTEGER;
    const currentLimit = pagesToProcess ?? configuredLimit;
    const endPage = Math.min(startPage + batchPages - 1, currentLimit);
    const batch = await renderPdfPagesToImages(buffer, startPage, endPage);

    if (totalPages === null) {
      totalPages = batch.numPages;
      pagesToProcess = config.ocrMaxPages > 0 ? Math.min(totalPages, config.ocrMaxPages) : totalPages;

      if (onProgress) {
        await onProgress({
          percent: 32,
          phase: 'ocr_paginas_detectadas',
          details: {
            totalPages,
            pagesToProcess,
          },
        });
      }

      if (totalPages > pagesToProcess) {
        await logLine({
          level: 'warn',
          message: 'ocr_page_limit_reached',
          numPages: totalPages,
          renderedPages: pagesToProcess,
          maxPages: config.ocrMaxPages,
        });
      }
    }

    if (batch.pages.length === 0) {
      break;
    }

    for (const pageImage of batch.pages) {
      processedPages += 1;
      const pageNumber = String(pageImage.page).padStart(3, '0');
      const imagePath = path.join(tmpDir, `${documentId}-ocr-page-${pageNumber}.png`);

      await fs.writeFile(imagePath, pageImage.buffer);

      try {
        const result = await worker.recognize(imagePath);
        const pageText = normalizeExtractedText(result?.data?.text || '');

        if (pageText) {
          pageTexts.push(pageText);
        }

        if (onProgress) {
          const percent = 35 + Math.floor((processedPages / Math.max(1, pagesToProcess)) * 55);
          await onProgress({
            percent: Math.min(90, percent),
            phase: 'ocr_pagina_ok',
            details: {
              page: pageImage.page,
              pagesToProcess,
              pageTextChars: pageText.length,
              ocrTextChars: normalizeExtractedText(pageTexts.join('\n')).length,
            },
          });
        }
      } finally {
        if (!config.keepFiles) {
          await removeIfExists(imagePath);
        }
      }
    }
  }

  return {
    text: normalizeExtractedText(pageTexts.join('\n')),
    pages: processedPages,
  };
}

async function ensureOcrBrowserPageReady() {
  const puppeteer = loadPuppeteer();

  if (!ocrBrowser) {
    const executablePath = process.env.PDF_JOB_CHROME_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
    const launchOptions = {
      headless: 'new',
      args: [
        '--allow-file-access-from-files',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--no-sandbox',
      ],
    };

    if (executablePath) {
      launchOptions.executablePath = executablePath;
    }

    ocrBrowser = await puppeteer.launch(launchOptions);
  }
}

async function renderPdfPagesToImages(buffer, startPage, endPage) {
  await ensureOcrBrowserPageReady();

  const page = await ocrBrowser.newPage();
  page.setDefaultTimeout(Math.max(config.requestTimeoutMs, 120000));
  await page.setViewport({ width: 1400, height: 1800, deviceScaleFactor: 1 });

  try {
    await page.goto(pathToFileURL(await ensurePdfRendererHtml()).href, { waitUntil: 'load' });
    await page.waitForFunction('window.renderPdfToImages');

    const pdfWorkerUrl = pathToFileURL(requireFromJob.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
    const result = await page.evaluate(
      async ({ pdfWorkerUrl, pdfBase64, startPage, endPage, scale }) => window.renderPdfToImages({
        pdfWorkerUrl,
        pdfBase64,
        startPage,
        endPage,
        scale,
      }),
      {
        pdfWorkerUrl,
        pdfBase64: buffer.toString('base64'),
        startPage,
        endPage,
        scale: config.ocrScale,
      }
    );

    return {
      numPages: result.numPages,
      pages: result.pages.map((item) => ({
        page: item.page,
        width: item.width,
        height: item.height,
        buffer: Buffer.from(item.base64, 'base64'),
      })),
    };
  } finally {
    await page.close();
  }
}

async function ensurePdfRendererHtml() {
  if (rendererHtmlPath) {
    return rendererHtmlPath;
  }

  const pdfJsModuleUrl = pathToFileURL(requireFromJob.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href;
  rendererHtmlPath = path.join(tmpDir, 'pdf-renderer.html');

  await fs.writeFile(
    rendererHtmlPath,
    `<!doctype html>
<html>
<head><meta charset="utf-8"><title>PDF OCR Renderer</title></head>
<body>
<script type="module">
import * as pdfjsLib from ${JSON.stringify(pdfJsModuleUrl)};

window.loadPdfDocument = async ({ pdfWorkerUrl, pdfBase64 }) => {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

  const binary = atob(pdfBase64);
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    data[i] = binary.charCodeAt(i);
  }

  const loadingTask = pdfjsLib.getDocument({
    data,
    disableWorker: true,
    useWorkerFetch: false,
    isEvalSupported: false,
  });
  return { loadingTask, pdf: await loadingTask.promise };
};

window.closePdfDocument = async ({ loadingTask, pdf }) => {
  if (typeof pdf.destroy === 'function') {
    await pdf.destroy();
  } else if (typeof loadingTask.destroy === 'function') {
    await loadingTask.destroy();
  }
};

window.renderPdfToImages = async ({ pdfWorkerUrl, pdfBase64, startPage, endPage, scale }) => {
  const context = await window.loadPdfDocument({ pdfWorkerUrl, pdfBase64 });
  const { pdf } = context;
  const numPages = pdf.numPages;
  const lastPage = Math.min(endPage, numPages);
  const pages = [];

  for (let pageNumber = startPage; pageNumber <= lastPage; pageNumber += 1) {
    const pdfPage = await pdf.getPage(pageNumber);
    const viewport = pdfPage.getViewport({ scale });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { alpha: false });

    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await pdfPage.render({ canvasContext: context, viewport }).promise;

    pages.push({
      page: pageNumber,
      width: canvas.width,
      height: canvas.height,
      base64: canvas.toDataURL('image/png').split(',')[1],
    });

    pdfPage.cleanup();
    canvas.width = 0;
    canvas.height = 0;
  }

  await window.closePdfDocument(context);

  return {
    numPages,
    renderedPages: pages.length,
    pages,
  };
};
</script>
</body>
</html>
`,
    'utf8'
  );

  return rendererHtmlPath;
}

async function getOcrWorker() {
  if (ocrWorker) {
    return ocrWorker;
  }

  const { createWorker, PSM } = requireFromJob('tesseract.js');
  const languages = normalizeOcrLanguages(config.ocrLanguage);

  await prepareTessdata(languages);
  await fs.mkdir(tessdataCacheDir, { recursive: true });

  ocrWorker = await createWorker(languages.join('+'), 1, {
    langPath: tessdataDir,
    cachePath: tessdataCacheDir,
    gzip: true,
    logger: config.ocrDebug ? (message) => console.log('[OCR]', message) : () => {},
  });

  await ocrWorker.setParameters({
    tessedit_pageseg_mode: PSM.AUTO,
    preserve_interword_spaces: '1',
    user_defined_dpi: String(config.ocrDpi),
  });

  return ocrWorker;
}

async function prepareTessdata(languages) {
  await fs.mkdir(tessdataDir, { recursive: true });

  for (const language of languages) {
    let languagePackage;
    try {
      languagePackage = requireFromJob(`@tesseract.js-data/${language}`);
    } catch {
      throw new Error(`Falta paquete OCR para idioma "${language}". Instala @tesseract.js-data/${language}`);
    }

    const source = path.join(languagePackage.langPath, `${language}.traineddata.gz`);
    const destination = path.join(tessdataDir, `${language}.traineddata.gz`);

    if (!fileExistsSyncish(destination)) {
      await fs.copyFile(source, destination);
    }
  }
}

function normalizeOcrLanguages(value) {
  const languages = String(value || '')
    .split(/[+,]/)
    .map((language) => language.trim())
    .filter(Boolean);

  if (languages.length === 0) {
    throw new Error('Debe indicar al menos un idioma OCR');
  }

  return [...new Set(languages)];
}

function chooseExtractedText(pdfText, ocrText) {
  if (!pdfText) return ocrText;
  if (!ocrText) return pdfText;

  const combined = mergeTextCandidates([pdfText, ocrText]);

  if (config.targetTextChars > 0 && combined.length > Math.max(pdfText.length, ocrText.length)) {
    return combined;
  }

  return pdfText.length >= ocrText.length ? pdfText : ocrText;
}

function mergeTextCandidates(candidates) {
  const lines = [];
  const seen = new Set();

  for (const candidate of candidates) {
    for (const line of String(candidate || '').split('\n')) {
      const cleanLine = line.replace(/\s+/g, ' ').trim();
      if (!cleanLine) continue;

      const key = normalizeLineKey(cleanLine);
      if (key.length >= 8 && seen.has(key)) continue;

      if (key.length >= 8) {
        seen.add(key);
      }
      lines.push(cleanLine);
    }
  }

  return normalizeExtractedText(lines.join('\n'));
}

function normalizeLineKey(line) {
  return line
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeExtractedText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function readCliConfig(args) {
  const parsed = { ...defaultConfig, help: false };

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }

    if (arg === '--keep-files') {
      parsed.keepFiles = true;
      continue;
    }

    if (arg === '--include-successful') {
      parsed.includeSuccessful = true;
      continue;
    }

    if (arg === '--no-ocr') {
      parsed.ocrEnabled = false;
      continue;
    }

    if (arg === '--force-ocr') {
      parsed.forceOcr = true;
      parsed.ocrEnabled = true;
      continue;
    }

    if (arg === '--require-target') {
      parsed.requireTarget = true;
      continue;
    }

    if (arg === '--max-quality') {
      parsed.maxQuality = true;
      parsed.ocrEnabled = true;
      parsed.ocrMaxPages = 0;
      parsed.ocrBatchPages = 1;
      parsed.ocrScale = Math.max(parsed.ocrScale, 3.5);
      parsed.ocrDpi = Math.max(parsed.ocrDpi, 400);
      parsed.requestTimeoutMs = Math.max(parsed.requestTimeoutMs, 300000);
      parsed.targetTextChars = parsed.targetTextChars || 100000;
      continue;
    }

    const [name, rawValue] = arg.split('=');

    if (name === '--limit') {
      parsed.limit = parsePositiveInteger(rawValue, 'limit');
      continue;
    }

    if (name === '--max-attempts') {
      parsed.maxAttempts = parsePositiveInteger(rawValue, 'max-attempts');
      continue;
    }

    if (name === '--id') {
      parsed.id = parsePositiveInteger(rawValue, 'id');
      continue;
    }

    if (name === '--timeout-ms') {
      parsed.requestTimeoutMs = parsePositiveInteger(rawValue, 'timeout-ms');
      continue;
    }

    if (name === '--db-profile') {
      process.env.PDF_JOB_DB_PROFILE = rawValue;
      continue;
    }

    if (name === '--min-text-chars') {
      parsed.minTextChars = parsePositiveInteger(rawValue, 'min-text-chars');
      continue;
    }

    if (name === '--ocr-lang') {
      parsed.ocrLanguage = rawValue;
      continue;
    }

    if (name === '--ocr-max-pages') {
      parsed.ocrMaxPages = parseNonNegativeInteger(rawValue, 'ocr-max-pages');
      continue;
    }

    if (name === '--ocr-batch-pages') {
      parsed.ocrBatchPages = parsePositiveInteger(rawValue, 'ocr-batch-pages');
      continue;
    }

    if (name === '--ocr-scale') {
      parsed.ocrScale = parsePositiveFloat(rawValue, 'ocr-scale');
      continue;
    }

    if (name === '--ocr-dpi') {
      parsed.ocrDpi = parsePositiveInteger(rawValue, 'ocr-dpi');
      continue;
    }

    if (name === '--target-text-chars') {
      parsed.targetTextChars = parseNonNegativeInteger(rawValue, 'target-text-chars');
      continue;
    }

    throw new Error(`Opcion no reconocida: ${arg}`);
  }

  return parsed;
}

function readBooleanEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'si'].includes(String(value).trim().toLowerCase());
}

function readPositiveIntegerEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return parsePositiveInteger(value, name);
}

function readNonNegativeIntegerEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return parseNonNegativeInteger(value, name);
}

function readPositiveFloatEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return parsePositiveFloat(value, name);
}

function parsePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`--${name} debe ser un entero positivo`);
  }
  return number;
}

function parseNonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`--${name} debe ser un entero mayor o igual a 0`);
  }
  return number;
}

function parsePositiveFloat(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`--${name} debe ser un numero positivo`);
  }
  return number;
}

function quoteIdentifierPath(identifierPath) {
  const parts = String(identifierPath)
    .split('.')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0 || parts.length > 2) {
    throw new Error(`Nombre de tabla invalido: ${identifierPath}`);
  }

  for (const part of parts) {
    if (!/^[A-Za-z0-9_]+$/.test(part)) {
      throw new Error(`Identificador SQL invalido: ${part}`);
    }
  }

  return parts.map((part) => `\`${part}\``).join('.');
}

function normalizeBaseUrl(value) {
  if (!value) return '';
  try {
    return new URL(value.endsWith('/') ? value : `${value}/`).toString();
  } catch {
    throw new Error(`PDF_JOB_BASE_URL invalida: ${value}`);
  }
}

async function ensureWorkDirs() {
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });
}

async function removeIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function logLine(entry) {
  await fs.mkdir(logsDir, { recursive: true });
  const now = new Date();
  const fileName = `documentos-pdf-job-${now.toISOString().slice(0, 10)}.log`;
  const record = {
    timestamp: now.toISOString(),
    ...entry,
  };
  await fs.appendFile(path.join(logsDir, fileName), `${JSON.stringify(record)}\n`, 'utf8');
}

async function reportProgress(context, percent, phase, details = {}) {
  const safePercent = Math.max(1, Math.min(100, Math.round(percent)));
  const detailText = formatProgressDetails(details);
  const suffix = detailText ? ` ${detailText}` : '';

  console.log(`[${String(safePercent).padStart(3, ' ')}%] id=${context.id} fase=${phase}${suffix}`);

  await logLine({
    level: 'progress',
    message: 'document_progress',
    id: context.id,
    titulo: context.titulo,
    percent: safePercent,
    phase,
    ...details,
  });
}

function formatProgressDetails(details) {
  const entries = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      if (typeof value === 'number' || typeof value === 'boolean') {
        return `${key}=${value}`;
      }

      const text = String(value).replace(/\s+/g, '_');
      return `${key}=${text.length > 80 ? `${text.slice(0, 77)}...` : text}`;
    });

  return entries.join(' ');
}

function serializeError(error) {
  return {
    message: error?.message || String(error),
    code: error?.code,
    status: error?.response?.status,
    url: error?.config?.url,
  };
}

function fileExistsSyncish(filePath) {
  try {
    const stat = fsSync.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function loadDependency(name) {
  try {
    return requireFromJob(name);
  } catch (jobError) {
    try {
      return requireFromApp(name);
    } catch {
      throw jobError;
    }
  }
}

function loadPuppeteer() {
  try {
    return requireFromApp('puppeteer');
  } catch {
    return requireFromJob('puppeteer');
  }
}
