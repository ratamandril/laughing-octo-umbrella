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

## Conectar las extensiones
1. Abre la app y pulsa **Generar código**.
2. En cada perfil: carga `extension/`, abre **Ajustes → Conexión con la app**, escribe el código y elige a qué perfil corresponde ese navegador.
3. Si ese perfil ya tenía notas, aparece **Importar a la app** (se importan una sola vez; las originales quedan como copia).
4. Cada extensión guarda solo las notas de su perfil. Las de los demás perfiles las pide a la app al abrirse (necesita la app abierta); cada perfil elige si es privado, de solo lectura (por defecto) o editable por otros, en Ajustes de la extensión o en **Conexión** de la app. Si la app está cerrada, los cambios se guardan y se envían al volver.

## Papelera y estado
- Eliminar una nota la manda a la pestaña **Papelera** de la app (30 días); desde ahí se restaura o se elimina para siempre. Las extensiones nunca reciben su contenido.
- Una nota sin perfil no la ve ninguna extensión: en la pestaña **Notas** se le asigna uno con «Asignar perfil…».
- El estado (app, internet, nube) se ve en el popup, en cada nota sin subir, en la ventana y en el icono de la bandeja.

Prueba de extremo a extremo (dos Chromium con la extensión real contra la app): `node e2e/extension.e2e.js` (necesita Playwright y Chromium).

## Respaldo en Firestore (opcional)
Ver `../docs/firebase.md`. Se activa en la ventana con **Elegir clave…**, o en modo servidor con `--firebase-key ruta.json` / `NOTAS_FIREBASE_KEY`.

## Seguridad
Solo escucha en 127.0.0.1; valida Host y Origin (solo extensiones); token por extensión guardado como hash y atado a su origen; código de emparejamiento de un solo uso. La revisión independiente encontró cuatro problemas menores ya corregidos. Pendiente conocido: cualquier extensión instalada puede gastar el código de emparejamiento activo con intentos fallidos (solo negación de servicio).

## Sin probar
Lanzar perfiles reales en Windows, la ventana de Electron y Firestore real no se han probado (el desarrollo fue en Linux, sin acceso a Firebase). Las pruebas simulan el lanzador y Firestore.
