# red-tracking · Eye tracking web con webcam

Extensión de Chrome (Manifest V3) que convierte la webcam del participante en un eye tracker para
estudiar qué partes de una página web mira una persona, inspirada en los estudios de góndolas de
supermercado. Todo el análisis de la cara ocurre en el equipo del participante: **el video de la cámara
nunca se guarda ni se envía**. Solo se registran coordenadas de mirada y capturas de la página del estudio.

## Qué produce

- **Heatmap** de fijaciones sobre la página completa reconstruida a partir de capturas.
- **Métricas por zona de interés (AOI)**: tiempo hasta la primera mirada, tiempo total, fijaciones, visitas, orden.
- **Replay** en video (WebM) con el punto de mirada moviéndose sobre la página.
- **Vista de cámara** con malla facial y rayos de mirada para confirmar que el tracker funciona.
- **Paquete .zip** por sesión (`session.json`, `samples.csv`, tiles JPEG, heatmaps PNG, `aoi-metrics.csv`).

## Arquitectura (resumen)

| Pieza | Dónde | Qué hace |
|---|---|---|
| `packages/protocol` | TS puro | Tipos de dominio y unión de mensajes entre contextos |
| `packages/core` | TS puro, vitest | Features de iris/pose, ridge con CV, One-Euro, fijaciones I-DT, heatmap, stitching, métricas AOI, códigos de estudio |
| `apps/extension` | WXT + Svelte 5 | Service worker (máquina de sesión, capturas, IndexedDB), documento offscreen (cámara + MediaPipe Face Landmarker + regresión), content script (calibración, enriquecimiento, AOIs), side panel, onboarding, reporte |

Detalles de diseño: ver el plan en `docs/` (o el archivo de plan de la sesión) y los comentarios en cada módulo.

## Requisitos

- Node ≥ 22, pnpm ≥ 10 (`npm i -g pnpm`)
- Chrome ≥ 116

## Desarrollo

```bash
pnpm install                 # instala y descarga MediaPipe WASM + modelo a apps/extension/public
pnpm --filter @red-tracking/core test
pnpm --filter @red-tracking/extension dev      # build con recarga; cargar .output/chrome-mv3 en chrome://extensions
pnpm --filter @red-tracking/extension build    # build de producción → apps/extension/.output/chrome-mv3
pnpm --filter @red-tracking/extension zip      # paquete para Chrome Web Store
```

Cargar la extensión: `chrome://extensions` → Modo desarrollador → "Cargar descomprimida" → `apps/extension/.output/chrome-mv3`.

### Flujo de prueba manual

1. Al instalar se abre el onboarding: consentimiento → activar cámara → chequeo de posición → abrir panel.
2. En `report.html` (botón "Sesiones" del panel) → "Nuevo estudio": URL objetivo, instrucción, duración, selectores de AOI → **Generar código**.
3. En el panel lateral pega el código → **Unirse** → **Iniciar sesión**. Chrome pide permiso de acceso a sitios
   (necesario para capturar la pantalla de la pestaña; se retira al terminar la sesión).
4. Calibración (9 o 13 puntos) + validación (4 puntos) dentro de la pestaña del estudio, luego las instrucciones y la grabación.
5. **Terminar sesión** → se abre el reporte con heatmap, tabla AOI, replay y exportación.

### Página de prueba

`fixtures/pages/shelf.html` es una góndola virtual con 6 productos (`data-aoi="A".."F"`). Sírvela con cualquier
servidor estático (`npx serve fixtures/pages`) y úsala como URL objetivo del estudio.

## Tests

```bash
pnpm test                                        # unitarios (core + extensión)
pnpm --filter @red-tracking/extension e2e        # Playwright: sesión completa con cámara sintética
pnpm --filter @red-tracking/extension e2e:engine # Playwright: MediaPipe real en el documento offscreen
```

La primera vez: `pnpm --filter @red-tracking/extension exec playwright install chromium`.

Variables de build (`apps/extension/.env`, ver `.env.example`):

- `WXT_FAKE_CAMERA=1` usa una fuente de landmarks sintética (sin webcam) que sigue los puntos de calibración.
- `WXT_E2E=1` concede `<all_urls>` en el manifest para que las pruebas no necesiten aceptar prompts.

## Privacidad y permisos

- `offscreen`, `sidePanel`, `storage`, `unlimitedStorage`, `scripting`, `tabs`, `activeTab`.
- `optional_host_permissions: <all_urls>`: se solicita al **iniciar una sesión** porque `tabs.captureVisibleTab`
  lo exige para capturar la página; el content script solo se registra para el origen del estudio y el permiso
  se **retira** al terminar la sesión.
- El documento offscreen procesa los frames con MediaPipe Face Landmarker (WASM local, CSP `wasm-unsafe-eval`).
  No se guardan frames ni landmarks; solo predicciones de mirada, clics, scrolls y capturas de la página del estudio.
- Política de privacidad: `apps/extension/public/privacy.html`.

## Estado

- [x] M0 workspace, core con 45 tests
- [x] M1 cámara + Face Landmarker + preview con malla (offscreen, `MediaStreamTrackProcessor`)
- [x] M2 calibración 9/13 + validación + punto de mirada + offset por movimiento de ventana
- [x] M3 sesión, chunks, capturas por scroll-stop, AOIs, exportación zip
- [x] M4 stitching, heatmap, fijaciones, tabla AOI, replay WebM, importar zip, crear estudio/código
- [ ] M5 política de privacidad final, textos de la ficha de Web Store, `key` fijo, prueba en perfil limpio con cámara real
- [ ] M6 (fase 2) API en Cloudflare Workers + D1 + R2, códigos cortos, panel del investigador

## Limitaciones conocidas

- Precisión típica de webcam: 2–4 cm (~100–150 px). Las AOIs más pequeñas que 120 px se marcan en el reporte.
- Recalibrar si la persona se mueve mucho o si cambia el tamaño de la ventana; el panel avisa.
- La exportación WebM se renderiza en tiempo real (1×/2×/4×).
- Se empaquetan las tres variantes de WASM de MediaPipe (~35 MB); se puede recortar a la variante SIMD.
