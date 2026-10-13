# Notas por URL — app local

Servidor local (Electron) que guarda las notas de **todos** tus perfiles de Chrome y Edge en un solo lugar y las empuja en vivo a cada extensión. También sabe abrir una URL en el navegador y perfil correctos.

## Uso
```bash
cd app
npm install
npm start        # ventana + bandeja
npm run serve    # solo el servidor, sin ventana
npm test         # pruebas automáticas
```
Datos en `%APPDATA%\notas-por-url-app` (`notes.json`, `config.json`). Se escriben de forma atómica con copia `.bak`; si el archivo se corrompe la app no arranca en blanco, avisa.

## Diseño
- `src/core`: almacenamiento, autenticación y emparejamiento, detección de perfiles, lanzador, servidor HTTP + WebSocket (ver `../docs/protocolo.md`).
- `src/main` y `src/renderer`: ventana de Electron (`contextIsolation`, `sandbox`, CSP estricta).
- Almacenamiento en JSON en vez de SQLite: sin módulos nativos que compilar en Windows, suficiente para miles de notas.

## Respaldo en Firestore (opcional)
Ver `../docs/firebase.md`. Se activa en la ventana con **Elegir clave…**, o en modo servidor con `--firebase-key ruta.json` / `NOTAS_FIREBASE_KEY`.

## Seguridad
Solo escucha en 127.0.0.1; valida Host y Origin (solo extensiones); token por extensión guardado como hash y atado a su origen; código de emparejamiento de un solo uso. La revisión independiente encontró cuatro problemas menores ya corregidos. Pendiente conocido: cualquier extensión instalada puede gastar el código de emparejamiento activo con intentos fallidos (solo negación de servicio).

## Sin probar
Lanzar perfiles reales en Windows, la ventana de Electron y Firestore real no se han probado (el desarrollo fue en Linux, sin acceso a Firebase). Las pruebas simulan el lanzador y Firestore.
